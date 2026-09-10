/**
 * `legal_analysis` — one entry point for the four verification tools.
 *
 * The four are exposed together because they answer one question between them
 * ("can I rely on this?") and because the MCP tool list has to stay small. The
 * individual tools remain callable directly; nothing here adds behaviour.
 *
 * Two things it does add, both learned from the reference implementation's
 * v4.7.1:
 *
 *  - **Tolerant parameter aliasing.** A caller that has just used another tool
 *    reaches for `query`, `citation`, `section` or `asAt`, and rejecting those
 *    outright turns a naming mismatch into a failed legal check. They are
 *    mapped, and the mapping is described in the schema rather than hidden.
 *  - **Per-mode validation with the fix in the message.** "lawName is required"
 *    is useless; naming the mode, the missing parameter and a working example
 *    is what lets a caller retry once instead of guessing.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import type { ToolResponse } from "../lib/types.js"
import { FollowupPolicySchema } from "../lib/research-followup.js"
import { applicableLaw } from "./applicable-law.js"
import { citeCheck } from "./cite-check.js"
import { impactMap } from "./impact-map.js"
import { verifyCitations } from "./verify-citations.js"

/**
 * Parameter notes are terse on purpose: this schema is advertised on every
 * session through ListTools, and the payload has a size budget the whole tool
 * set shares. What each mode needs is in the tool description; the notes here
 * only disambiguate.
 */
export const LegalAnalysisSchema = z.object({
  mode: z.enum(["verify_citations", "cite_check", "applicable_law", "impact_map"]).describe("Which check to run."),
  text: z.string().optional().describe("verify_citations: the passage to check."),
  caseNumber: z.string().optional().describe("cite_check: a citation or a sentence containing one."),
  lawName: z.string().optional().describe("applicable_law/impact_map: Act name, alias or register id."),
  provision: z.string().optional().describe('e.g. "s 18", "sch 2 s 18" (the ACL).'),
  date: z.string().optional().describe("applicable_law: when the conduct happened."),
  maxCitations: z.number().int().min(1).max(30).optional().describe("verify_citations: default 15."),
  display: z.number().int().min(1).max(50).optional().describe("cite_check: citing cases listed, default 20."),
  deepScan: z.boolean().optional().describe("cite_check: read top citing judgments, default true."),
  includeInstruments: z.boolean().optional().describe("impact_map: default true."),
  includeMermaid: z.boolean().optional().describe("impact_map: default true."),
  followup: FollowupPolicySchema.optional().describe("Optional matter policy consumed by the host companion after this stateless law call."),

  // Tolerated aliases, declared so a caller can see they exist rather than
  // discovering them by having a legal check rejected over a parameter name.
  query: z.string().optional().describe("Alias for caseNumber / lawName / text, by mode."),
  citation: z.string().optional().describe("Alias for caseNumber."),
  section: z.string().optional().describe("Alias for provision."),
  asAt: z.string().optional().describe("Alias for date."),
  registerId: z.string().optional().describe("Alias for lawName."),
})

export type LegalAnalysisInput = z.infer<typeof LegalAnalysisSchema>

export const legalAnalysisDescription =
  "Four verification modes. verify_citations: check every statute and case citation in a passage (catches CCA s 18 " +
  "cited for misleading conduct — that is sch 2 s 18, the ACL). cite_check: is this case still good law — citation " +
  "graph, overruling-language scan, and whether its section was amended since. applicable_law: the version of an Act " +
  "in force on a date, diffed against today, with transitional provisions. impact_map: what depends on one provision " +
  "— citing judgments, instruments, state counterparts, amendments. Every mode separates 'wrong' from 'not checked'.";

function inputError(message: string, examples: string[]): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: `[INVALID_PARAMETER] ${message}\n\nExamples:\n${examples.map((line) => `  ${line}`).join("\n")}`,
      },
    ],
    isError: true,
  }
}

export async function legalAnalysis(apiClient: AuApiClient, input: LegalAnalysisInput): Promise<ToolResponse> {
  const caseNumber = input.caseNumber ?? input.citation ?? (input.mode === "cite_check" ? input.query : undefined)
  const lawName =
    input.lawName ??
    input.registerId ??
    (input.mode === "applicable_law" || input.mode === "impact_map" ? input.query : undefined)
  const provision = input.provision ?? input.section
  const date = input.date ?? input.asAt
  const text = input.text ?? (input.mode === "verify_citations" ? input.query : undefined)

  switch (input.mode) {
    case "verify_citations": {
      if (!text) {
        return inputError("mode=verify_citations needs `text` — the passage whose citations should be checked.", [
          'legal_analysis({mode:"verify_citations", text:"The CCA s 18 prohibits misleading or deceptive conduct."})',
        ])
      }
      return verifyCitations(apiClient, { text, maxCitations: input.maxCitations ?? 15 })
    }

    case "cite_check": {
      if (!caseNumber) {
        return inputError("mode=cite_check needs `caseNumber` — a citation, or a sentence containing one.", [
          'legal_analysis({mode:"cite_check", caseNumber:"[2010] NSWCCA 333"})',
          'legal_analysis({mode:"cite_check", query:"Is Dela Cruz v R [2010] NSWCCA 333 still good law?"})',
        ])
      }
      return citeCheck(apiClient, {
        caseNumber,
        display: input.display ?? 20,
        deepScan: input.deepScan ?? true,
      })
    }

    case "applicable_law": {
      if (!lawName || !date) {
        return inputError(
          `mode=applicable_law needs both \`lawName\` and \`date\`${lawName ? " (date is missing)" : date ? " (lawName is missing)" : ""}.`,
          [
            'legal_analysis({mode:"applicable_law", lawName:"CCA", date:"2010-12-15", provision:"s 52"})',
            'legal_analysis({mode:"applicable_law", query:"Fair Work Act", asAt:"15 March 2019"})',
          ],
        )
      }
      return applicableLaw(apiClient, { lawName, date, ...(provision ? { provision } : {}) })
    }

    case "impact_map": {
      if (!lawName || !provision) {
        return inputError(
          `mode=impact_map needs both \`lawName\` and \`provision\`${lawName ? " (provision is missing)" : provision ? " (lawName is missing)" : ""}.`,
          [
            'legal_analysis({mode:"impact_map", lawName:"CCA", provision:"sch 2 s 18"})',
            'legal_analysis({mode:"impact_map", query:"Fair Work Act", section:"s 394"})',
          ],
        )
      }
      return impactMap(apiClient, {
        lawName,
        provision,
        includeInstruments: input.includeInstruments ?? true,
        includeMermaid: input.includeMermaid ?? true,
      })
    }
  }
}
