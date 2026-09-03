/**
 * Two reference utilities that need no network at all.
 *
 * `parse_section_ref` exists because the single most expensive mistake this
 * server can make is silent: **`sch 2 s 18` and `s 18` are different
 * provisions of the same Act.** CCA s 18 is "Meetings of Commission"; ACL
 * (= CCA sch 2) s 18 is "Misleading or deceptive conduct" — the provision half
 * of Australian consumer law rests on. A caller that drops the schedule
 * prefix gets a confident, correct-looking answer about the wrong section, so
 * this tool makes the distinction explicit and inspectable before any fetch.
 *
 * `get_law_abbreviations` publishes the alias table, which exists because the
 * Federal Register has no abbreviation field at all (reference §7): "CCA",
 * "ACL" and "FW Act" match nothing upstream.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { LAW_ALIAS_ENTRIES, JURISDICTIONS, normaliseAliasKey, resolveLawAlias } from "../lib/law-alias.js"
import { truncateResponse } from "../lib/schemas.js"
import { extractSectionRefs, formatRef, parseSectionRef } from "../lib/section-ref.js"
import { KIND_VOCAB } from "../lib/section-ref-vocab.js"
import type { ToolResponse } from "../lib/types.js"

export const ParseSectionRefSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe('A provision reference ("sch 2 s 18", "s 355-25", "ss 5-6", "pt IVA") or prose to scan for references.'),
  mode: z
    .enum(["parse", "extract", "explain"])
    .optional()
    .default("parse")
    .describe("'parse' = one reference; 'extract' = every reference in a block of prose; 'explain' = parse plus what the parts mean."),
})

export type ParseSectionRefInput = z.infer<typeof ParseSectionRefSchema>

export const parseSectionRefDescription =
  "Parse and normalise an Australian provision reference to AGLC form, or extract every reference from a block of " +
  'prose. Crucially it keeps the schedule prefix: "sch 2 s 18" (Australian Consumer Law s 18) is NOT "s 18" of the ' +
  "same Act. Use mode:'explain' when a citation looks ambiguous, and to check a reference before passing it to " +
  "get_law_text. No network calls.";

/** Signature matches every other tool so the registry needs no special case; no upstream is touched. */
export async function parseSectionRefTool(_apiClient: AuApiClient, input: ParseSectionRefInput): Promise<ToolResponse> {
  try {
    if (input.mode === "extract") {
      const refs = extractSectionRefs(input.text)
      if (refs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "[NOT_FOUND] No provision reference found in that text.\n\n" +
                "A designation word is required — bare numbers and years are deliberately not harvested, because " +
                '"Acts 2010" and "s 2010" mean different things. Try text containing "s 18", "sch 2", "pt IV" etc.',
            },
          ],
          isError: true,
        }
      }
      const lines = [`${refs.length} provision reference(s) found:`, ""]
      for (const ref of refs) lines.push(`  ${ref.raw}  →  ${formatRef(ref)}`)
      return ok(lines.join("\n"))
    }

    const ref = parseSectionRef(input.text)
    if (!ref) {
      return {
        content: [
          {
            type: "text",
            text:
              `[INVALID_PARAMETER] "${input.text}" is not a recognisable provision reference.\n\n` +
              "⚠️ Nothing was guessed — a guessed reference is how a tool ends up 'verifying' a provision that was " +
              "never cited.\n\n" +
              "Accepted forms: s 18, ss 5-6, s 10AA, s 355-25, sub-s (2), para (a), pt IVA, div 2, ch 3, " +
              "sch 2, sch 1 item 4, sch 2 s 18, reg 2.01, r 5.\n" +
              `Designations understood: ${KIND_VOCAB.map((entry) => entry.singular).join(", ")}.`,
          },
        ],
        isError: true,
      }
    }

    const lines = [`Input:      ${input.text.trim()}`, `AGLC form:  ${formatRef(ref)}`, `Kind:       ${ref.kind}`, `Number:     ${ref.number}${ref.letterSuffix ?? ""}`]
    if (ref.schedule) lines.push(`Schedule:   ${ref.schedule}`)
    if (ref.item) lines.push(`Item:       ${ref.item}`)
    if (ref.subsections.length > 0) lines.push(`Subdivisions: ${ref.subsections.map((part) => `(${part})`).join("")}`)
    if (ref.rangeEnd) lines.push(`Range end:  ${ref.rangeEnd}`)
    if (ref.plural) lines.push("Plural:     yes (the source used a plural designation)")

    if (input.mode === "explain") {
      lines.push("")
      lines.push(...explain(ref.schedule, ref.kind, `${ref.number}${ref.letterSuffix ?? ""}`, ref.rangeEnd))
    }
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "parse_section_ref")
  }
}

function explain(schedule: string | undefined, kind: string, number: string, rangeEnd?: string): string[] {
  const lines: string[] = ["What this means:"]
  if (schedule) {
    lines.push(
      `  • The reference is INSIDE schedule ${schedule}. It is not ${kind} ${number} of the Act's body — those are ` +
        "two different provisions that may both exist.",
    )
    lines.push(
      `  • Example: in the Competition and Consumer Act 2010, "s 18" is Meetings of Commission, while ` +
        `"sch 2 s 18" is the Australian Consumer Law's misleading or deceptive conduct provision.`,
    )
    lines.push(`  • Pass it to get_law_text exactly as "sch ${schedule} ${kind === "section" ? "s" : kind} ${number}".`)
  } else {
    lines.push(`  • No schedule was given, so this addresses ${kind} ${number} of the Act's BODY.`)
    lines.push(
      "  • If the user meant a schedule-based law (the Australian Consumer Law, a Criminal Code, a model law), the " +
        'reference needs a "sch N " prefix — get_schedules lists the schedules and their numbers.',
    )
  }
  if (rangeEnd) {
    lines.push(
      `  • This is a RANGE ending at ${rangeEnd}. A hyphen only reads as a range after a plural designation — ` +
        '"s 355-25" is one ITAA-style section number, "ss 5-6" is two sections.',
    )
  }
  return lines
}

export const GetLawAbbreviationsSchema = z.object({
  filter: z.string().optional().describe("Show only entries whose abbreviation or official title matches, e.g. 'consumer', 'FW'."),
  jurisdiction: z
    .enum(["Cth", "NSW", "Vic", "Qld", "SA", "WA", "Tas", "ACT", "NT"])
    .optional()
    .describe("Show only one jurisdiction's entries."),
  resolve: z.string().optional().describe("Resolve one abbreviation exactly as the search tools would, including ambiguity warnings."),
})

export type GetLawAbbreviationsInput = z.infer<typeof GetLawAbbreviationsSchema>

export const getLawAbbreviationsDescription =
  "List the statute abbreviations this server understands (CCA, ACL, FW Act, Corps Act, …) with their official " +
  "titles, jurisdictions and register ids. The Federal Register has NO abbreviation field, so these mappings are the " +
  "only way those forms resolve. Use `resolve` to see how one abbreviation would be handled — including whether it " +
  "is ambiguous across jurisdictions.";

/** Signature matches every other tool so the registry needs no special case; no upstream is touched. */
export async function getLawAbbreviations(_apiClient: AuApiClient, input: GetLawAbbreviationsInput): Promise<ToolResponse> {
  try {
    if (input.resolve) {
      const resolution = resolveLawAlias(input.resolve)
      const lines = [`Resolving "${input.resolve}"`]
      if (resolution.jurisdiction) lines.push(`Jurisdiction read from the query: ${resolution.jurisdiction}`)
      if (resolution.candidates.length === 0) {
        lines.push("")
        lines.push("[NOT_FOUND] No entry in the abbreviation table matches.")
        lines.push("")
        lines.push(
          "⚠️ A miss here means this table does not know the abbreviation — it is NOT evidence that no such Act " +
            "exists. search_law queries the Register directly.",
        )
        return ok(lines.join("\n"))
      }
      lines.push("")
      for (const candidate of resolution.candidates) {
        lines.push(
          `  • ${candidate.official} (${candidate.jurisdiction})` +
            `${candidate.sch ? `, sch ${candidate.sch}` : ""}${candidate.titleId ? ` [${candidate.titleId}]` : ""}` +
            ` — matched by ${candidate.matchedBy}`,
        )
        if (candidate.notes) lines.push(`      ${candidate.notes}`)
      }
      lines.push("")
      lines.push(
        resolution.needsJurisdiction
          ? "⚠️ AMBIGUOUS across jurisdictions. The search tools will ask rather than pick — add '(NSW)', '(Cth)' etc."
          : `Search text the tools would use upstream: "${resolution.searchText}"`,
      )
      return ok(lines.join("\n"))
    }

    const key = input.filter ? normaliseAliasKey(input.filter) : ""
    const entries = LAW_ALIAS_ENTRIES.filter((entry) => {
      if (input.jurisdiction && entry.jurisdiction !== input.jurisdiction) return false
      if (!key) return true
      return normaliseAliasKey(entry.alias).includes(key) || normaliseAliasKey(entry.official).includes(key)
    })

    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `[NOT_FOUND] No abbreviation matches ${input.filter ? `"${input.filter}"` : "that jurisdiction"}.\n\n` +
              `The table holds ${LAW_ALIAS_ENTRIES.length} entries across ${JURISDICTIONS.join(", ")}. ` +
              "A miss is a gap in this table, not evidence about the law — use search_law to query the Register.",
          },
        ],
        isError: true,
      }
    }

    const byJurisdiction = new Map<string, typeof entries>()
    for (const entry of entries) {
      const list = byJurisdiction.get(entry.jurisdiction)
      if (list) list.push(entry)
      else byJurisdiction.set(entry.jurisdiction, [entry])
    }

    const lines = [
      `Statute abbreviations (${entries.length} of ${LAW_ALIAS_ENTRIES.length} entries` +
        `${input.filter ? `, filtered by "${input.filter}"` : ""}${input.jurisdiction ? `, ${input.jurisdiction} only` : ""}):`,
      "",
    ]
    for (const jurisdiction of JURISDICTIONS) {
      const list = byJurisdiction.get(jurisdiction)
      if (!list || list.length === 0) continue
      lines.push(`── ${jurisdiction} (${list.length}) ──`)
      for (const entry of list) {
        lines.push(
          `  ${entry.alias}` +
            ` → ${entry.official}${entry.sch ? ` sch ${entry.sch}` : ""}${entry.titleId ? ` [${entry.titleId}]` : ""}` +
            `${entry.body ? " (a body/agency, not a statute)" : ""}`,
        )
        if (entry.notes) lines.push(`      ${entry.notes}`)
      }
      lines.push("")
    }
    lines.push("Only Commonwealth entries carry Federal Register ids — state law is on each state's own register.")
    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_law_abbreviations")
  }
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}
