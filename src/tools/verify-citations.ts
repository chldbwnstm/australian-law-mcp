/**
 * `verify_citations` — check the citations in a block of text against the
 * sources, before anyone relies on them.
 *
 * The hallucination this tool exists for is not the invented section number,
 * which is easy: it is the **real** section carrying a description of a
 * different provision. *Competition and Consumer Act 2010* (Cth) s 18 exists,
 * and it is "Meetings of Commission" — misleading or deceptive conduct is
 * sch 2 s 18, the Australian Consumer Law. An existence-only verifier ticks
 * that citation off, so this one compares what the text *claims* against the
 * Register's own heading (docs/research §4.5, §8.1).
 *
 * Two rules govern every line of output, both inherited from the reference
 * implementation's hard-won failures:
 *
 *  - **A verification that never ran must never look like one that passed.**
 *    Every citation extracted gets a line, including the ones nothing could be
 *    done with, and the summary counts them separately.
 *  - **"I could not check" is not "this is wrong."** ✗ is reserved for
 *    citations a source that authoritatively covers them says are absent, or
 *    whose stated content belongs to a different provision. Ambiguity, a
 *    blocked source, a state Act, an upstream failure — all ⚠.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { extractCaseCitations, type CaseCitation } from "../lib/case-citation.js"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { ToolResponse } from "../lib/types.js"
import { locateCase, renderCaseVerdict, type CaseVerdict } from "./analysis-helpers/case-check.js"
import { extractStatuteCitations } from "./analysis-helpers/statute-citations.js"
import {
  checkStatuteCitation,
  newStatuteCheckContext,
  type StatuteVerdict,
} from "./analysis-helpers/statute-check.js"

export const VerifyCitationsSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The text to check — a drafted advice, a model's answer, a contract, a submission. " +
        "Statute citations (AGLC or loose) and case citations (medium-neutral or reported) are both extracted.",
    ),
  maxCitations: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .default(15)
    .describe("Maximum citations of each kind to check (default 15). Higher values cost more upstream calls."),
})

export type VerifyCitationsInput = z.infer<typeof VerifyCitationsSchema>

export const verifyCitationsDescription =
  "Check the legal citations in a block of text against the Federal Register and the reachable case-law sources. " +
  "Catches invented sections, invented cases, and — the dangerous one — a real section cited for something it does " +
  "not say (CCA s 18 is 'Meetings of Commission'; misleading or deceptive conduct is sch 2 s 18, the ACL). " +
  "Handles AGLC form, markdown italics, 'the Act' anaphora within a paragraph, and citations with the jurisdiction " +
  "left off. Run this over any drafted advice before it is relied on. ✗ means the citation cannot be right; " +
  "⚠ means it could not be checked here and is NOT a finding that it is wrong.";

/** Upstream case lookups one call may make. Each is one or more HTTP requests. */
const MAX_CASE_LOOKUPS = 8
/** Distinct Acts one call may resolve on the Register. */
const MAX_TITLE_LOOKUPS = 6
/**
 * Extraction ceiling, deliberately independent of `maxCitations`.
 *
 * `maxCitations` governs how many citations are *checked*. How many were
 * *found* has to be counted separately and honestly: a citation dropped at the
 * cap is a citation this report says nothing about, and a summary that counts
 * only the prefix describes a text the caller did not submit. The ceiling
 * bounds the work of counting; hitting it is printed as `N+`.
 */
const EXTRACTION_CEILING = 200

interface Tally {
  ok: number
  bad: number
  warn: number
}

function tally(marks: readonly string[]): Tally {
  return {
    ok: marks.filter((mark) => mark === "✓").length,
    bad: marks.filter((mark) => mark === "✗").length,
    warn: marks.filter((mark) => mark === "⚠").length,
  }
}

/** `201` printed as `200+`, so a count at the ceiling is never read as exact. */
function foundCount(total: number): string {
  return total >= EXTRACTION_CEILING ? `${EXTRACTION_CEILING}+` : String(total)
}

export async function verifyCitations(
  apiClient: AuApiClient,
  input: VerifyCitationsInput,
): Promise<ToolResponse> {
  try {
    const max = input.maxCitations ?? 15
    const foundStatutes = extractStatuteCitations(input.text, EXTRACTION_CEILING)
    const foundCases = extractCaseCitations(input.text)
    const statutes = foundStatutes.slice(0, max)
    const cases = foundCases.slice(0, max)
    const skippedStatutes = foundStatutes.slice(max)
    const skippedCases = foundCases.slice(max)
    const skipped = skippedStatutes.length + skippedCases.length

    if (statutes.length === 0 && cases.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "[NO_CITATIONS_FOUND] No statute or case citations were found in this text.\n\n" +
              "Recognised forms: 'Competition and Consumer Act 2010 (Cth) s 18', '*Fair Work Act 2009* (Cth) s 394', " +
              "'s 18 of the CCA', 'ACL s 18', 'the Act s 394' (after a full citation in the same paragraph), " +
              "'[2020] HCA 41', '(1992) 175 CLR 1'.\n\n" +
              "⚠️ This is NOT a clean bill of health. Nothing was checked because nothing was found to check. " +
              "Do not report the text as verified.",
          },
        ],
      }
    }

    const context = newStatuteCheckContext(MAX_TITLE_LOOKUPS)
    const statuteVerdicts: StatuteVerdict[] = []
    for (const citation of statutes) {
      statuteVerdicts.push(await checkStatuteCitation(apiClient, citation, context))
    }

    const caseVerdicts: CaseVerdict[] = []
    let lookups = 0
    for (const result of cases) {
      if (!result.ok) {
        caseVerdicts.push({
          mark: "⚠",
          line:
            `⚠ ${result.raw} — ${result.reason}${result.token ? ` ("${result.token}")` : ""}. ` +
            "An unrecognised court identifier means this server has not been taught that court, NOT that the case does not exist.",
        })
        continue
      }
      const citation: CaseCitation = result.citation
      if (citation.kind === "report") {
        caseVerdicts.push(renderCaseVerdict(citation, undefined))
        continue
      }
      if (lookups >= MAX_CASE_LOOKUPS) {
        caseVerdicts.push({
          mark: "⚠",
          line: `⚠ ${citation.raw} — NOT checked: this call's case-lookup budget (${MAX_CASE_LOOKUPS}) was spent on earlier citations.`,
        })
        continue
      }
      lookups++
      caseVerdicts.push(renderCaseVerdict(citation, await locateCase(apiClient, citation)))
    }

    const statuteTally = tally(statuteVerdicts.map((verdict) => verdict.mark))
    const caseTally = tally(caseVerdicts.map((verdict) => verdict.mark))
    const impossible =
      statuteVerdicts.filter((verdict) => verdict.impossible).length +
      caseVerdicts.filter((verdict) => verdict.impossible).length

    const banner =
      impossible > 0
        ? "[CITATION_ERRORS_FOUND]"
        : // Citations left unchecked at the cap are exactly as unverified as a
          // blocked source's: a text this tool only read the first part of has
          // not been verified, and [VERIFIED] would say it had.
          skipped > 0 || statuteTally.warn + caseTally.warn > 0
          ? "[PARTIALLY_VERIFIED]"
          : "[VERIFIED]"

    const lines: string[] = []
    lines.push(`${banner} Citation check`)
    // The first number stays the number of lines printed below; "of N found"
    // is what the cap used to hide.
    //
    // The ⚠ column counts **every** citation this report does not stand behind,
    // which is the checked-but-inconclusive ones *plus* the ones dropped at
    // `maxCitations`. Counting only the first set printed `⚠ 0 not checked here`
    // directly above two `⚠ … NOT checked` lines and a banner saying two were
    // never looked at — a summary that contradicts its own body is read as the
    // summary, which is the failure this column exists to prevent.
    lines.push(
      `Statute citations: ${statuteVerdicts.length} checked of ${foundCount(foundStatutes.length)} found | ` +
        `✓ ${statuteTally.ok} verified | ✗ ${statuteTally.bad} cannot be right | ` +
        `⚠ ${statuteTally.warn + skippedStatutes.length} not checked here`,
    )
    lines.push(
      `Case citations: ${caseVerdicts.length} checked of ${foundCount(foundCases.length)} found | ` +
        `✓ ${caseTally.ok} verified | ✗ ${caseTally.bad} cannot be right | ` +
        `⚠ ${caseTally.warn + skippedCases.length} not checked here`,
    )
    if (skipped > 0) {
      lines.push(
        `⚠️ NOT CHECKED: ${skipped} citation(s) in this text were never looked at — this call checks at most ` +
          `${max} of each kind (maxCitations=${max}) and they fell past that limit. They are listed below. This ` +
          `report covers PART of the text only: a wrong or invented citation among them would not appear here. ` +
          `Re-run with a higher maxCitations (maximum 30) or split the text, and do not report the text as verified.`,
      )
    }

    if (statuteVerdicts.length > 0 || skippedStatutes.length > 0) {
      lines.push("")
      lines.push("▶ Statute citations")
      for (const verdict of statuteVerdicts) lines.push(verdict.line)
      for (const citation of skippedStatutes) {
        lines.push(`⚠ ${citation.raw} — NOT checked: past this call's maxCitations limit (${max}).`)
      }
    }
    if (caseVerdicts.length > 0 || skippedCases.length > 0) {
      lines.push("")
      lines.push("▶ Case citations")
      for (const verdict of caseVerdicts) lines.push(verdict.line)
      for (const result of skippedCases) {
        const raw = result.ok ? result.citation.raw : result.raw
        lines.push(`⚠ ${raw} — NOT checked: past this call's maxCitations limit (${max}).`)
      }
    }

    lines.push("")
    if (impossible > 0) {
      lines.push(
        `⚠️ ${impossible} citation(s) cannot be right as written — either the provision/case does not exist, or the ` +
          "text describes a provision other than the one it cites. Correct the text or tell the user explicitly that " +
          'the citations are wrong. Do NOT answer "verified".',
      )
    }
    if (statuteTally.warn + caseTally.warn > 0) {
      lines.push(
        `ℹ️ ${statuteTally.warn + caseTally.warn} citation(s) carry ⚠: unclear jurisdiction, state legislation, a ` +
          "blocked source, or an upstream failure. ⚠ is NOT a finding that the citation is wrong — it means this " +
          "server did not establish either way. Say so rather than implying they passed.",
      )
    }
    lines.push(
      "Coverage: Commonwealth legislation via the Federal Register; case law via NSW Caselaw, Queensland Judgments " +
        "and the High Court's own list only. Federal Court, Victorian, SA, WA, Tasmanian, ACT and NT judgments, and " +
        "all reported (CLR/FCR/NSWLR…) citations, are reachable only through AustLII/LawCite, which this server does not fetch.",
    )

    return {
      content: [{ type: "text", text: truncateResponse(lines.join("\n")) }],
      ...(impossible > 0 ? { isError: true } : {}),
    }
  } catch (error) {
    return formatToolError(error, "verify_citations")
  }
}
