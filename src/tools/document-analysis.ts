/**
 * `analyze_document` — offline triage of a contract, policy or court document.
 *
 * Pure text analysis: no upstream call, so it works when every source is down
 * and it never spends the request budget. The output is deliberately shaped
 * as *questions to check*, not conclusions: a regex cannot know whether a
 * contract is standard form, whether the buyer is a consumer within ACL s 3,
 * or which state's law governs, and each of those decides whether a flagged
 * clause is actually a problem.
 */

import { z } from "zod"
import {
  DOC_LABELS,
  SEARCH_SUGGESTIONS,
  classifyDocument,
  detectConflicts,
  detectConflictsInText,
  extractClauses,
  type Clause,
} from "../lib/document-profile.js"
import {
  RISK_RULES,
  computeRiskScore,
  extractAmounts,
  extractPeriods,
  matchRule,
  type RiskRule,
} from "../lib/risk-rules.js"
import { truncateResponse } from "../lib/schemas.js"
import type { LooseToolResponse } from "../lib/types.js"
import { followupEnvelope, makeGap } from "../lib/research-followup.js"

export const analyzeDocumentSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe("Full text of the contract, terms of service, letter or court document to triage"),
  maxClauses: z
    .number()
    .min(1)
    .max(60)
    .default(30)
    .describe("Maximum numbered clauses to analyse separately (default 30)"),
})
export type AnalyzeDocumentInput = z.infer<typeof analyzeDocumentSchema>

const MIN_LENGTH = 40

interface Finding {
  rule: RiskRule
  clause?: string
}

/** Rule scan: per clause when the document is numbered, else over the whole text. */
function scan(text: string, clauses: readonly Clause[]): Finding[] {
  const findings: Finding[] = []
  if (clauses.length === 0) {
    for (const rule of RISK_RULES) if (matchRule(rule, text)) findings.push({ rule })
    return findings
  }
  const seen = new Set<string>()
  for (const clause of clauses) {
    for (const rule of RISK_RULES) {
      const key = `${rule.id}:${clause.label}`
      if (seen.has(key) || !matchRule(rule, clause.body)) continue
      seen.add(key)
      findings.push({ rule, clause: clause.label })
    }
  }
  // A rule can live in unnumbered preamble text; catch it once at document level.
  for (const rule of RISK_RULES) {
    if (findings.some((finding) => finding.rule.id === rule.id)) continue
    if (matchRule(rule, text)) findings.push({ rule })
  }
  return findings
}

const SEVERITY_MARK = { high: "[HIGH]", medium: "[MEDIUM]", low: "[NOTE]" } as const

export async function analyzeDocument(
  _apiClient: unknown,
  input: AnalyzeDocumentInput,
): Promise<LooseToolResponse> {
  const { text, maxClauses } = input
  if (text.trim().length < MIN_LENGTH) {
    return {
      content: [{
        type: "text",
        text: `[INVALID_PARAMETER] Text too short to analyse (${text.trim().length} characters, minimum ${MIN_LENGTH}). Paste the full document.`,
      }],
      isError: true,
    }
  }

  const docType = classifyDocument(text)
  const clauses = extractClauses(text, maxClauses)
  const findings = scan(text, clauses)
  const { score, gradeLabel } = computeRiskScore(findings.map((finding) => finding.rule))
  const amounts = extractAmounts(text)
  const periods = extractPeriods(text)
  const conflicts = clauses.length >= 2 ? detectConflicts(clauses) : detectConflictsInText(text)

  const out: string[] = ["=== Document risk triage ===", ""]
  out.push(`Document type: ${DOC_LABELS[docType]}`)
  out.push(`Numbered clauses found: ${clauses.length}${clauses.length === 0 ? " (unnumbered — scanned as one block)" : ""}`)
  out.push(`Signals raised: ${findings.length}`)
  out.push(`Triage score: ${score} (${gradeLabel})`)
  out.push("")

  if (amounts.length > 0 || periods.length > 0) {
    out.push("--- Key numbers ---")
    for (const amount of amounts.slice(0, 20)) out.push(`  [${amount.label}] ${amount.value}`)
    for (const period of periods.slice(0, 20)) out.push(`  [${period.label}] ${period.value}`)
    out.push("")
  }

  if (findings.length === 0) {
    out.push("No rule in the bundled set matched.")
    out.push("That means the patterns did not fire — it is NOT a clearance. The rules cover a fixed list of signals and cannot see context, drafting subtleties or omissions.")
    out.push("")
  } else {
    out.push("--- Signals ---")
    const order = { high: 0, medium: 1, low: 2 } as const
    const sorted = [...findings].sort((a, b) => order[a.rule.severity] - order[b.rule.severity])
    for (const finding of sorted) {
      const where = finding.clause ? ` (clause ${finding.clause})` : ""
      out.push(`${SEVERITY_MARK[finding.rule.severity]} ${finding.rule.name}${where}`)
      out.push(`  ${finding.rule.explanation}`)
      out.push(`  Next: ${finding.rule.suggestion}`)
      if (finding.rule.references.length > 0) out.push(`  Read: ${finding.rule.references.join("; ")}`)
      out.push("")
    }
  }

  if (conflicts.length > 0) {
    out.push("--- Possible internal conflicts ---")
    for (const conflict of conflicts) {
      const where = conflict.clauseA && conflict.clauseB ? ` (clause ${conflict.clauseA} vs clause ${conflict.clauseB})` : ""
      out.push(`[CONFLICT] ${conflict.type}${where}`)
      out.push(`  ${conflict.description}`)
    }
    out.push("")
  }

  out.push("--- Suggested follow-up searches ---")
  for (const suggestion of SEARCH_SUGGESTIONS[docType]) out.push(`  - ${suggestion}`)
  out.push("")
  out.push("This is pattern-matching triage, not legal advice, and it never establishes that a clause is void or enforceable. Confirm every flagged provision against the current text (get_law_text / get_term_provisions) and note that the governing jurisdiction changes the answer.")

  const gap = makeGap({
    kind: "legal_interpretation", originTool: "analyze_document",
    target: { query: `${DOC_LABELS[docType]}:${findings.map((finding) => finding.rule.id).sort().join(",")}` },
    reason: "Pattern-matching triage cannot determine enforceability, governing law, missing facts or professional legal conclusions.",
    sourceUrls: [], sourceAccess: "permitted",
    evidenceNeeded: ["The governing jurisdiction and relevant facts", "Current primary law for each material signal", "A host-model assessment separating evidence from interpretation"],
  })
  return { content: [{ type: "text", text: truncateResponse(out.join("\n")) }], structuredContent: { followup: followupEnvelope([gap], { pending: true }) } }
}
