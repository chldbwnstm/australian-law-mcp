/**
 * `get_three_tier` — Act → the delegated legislation made under it.
 *
 * Australia's hierarchy is two tiers where Korea's is three: an Act, then
 * legislative instruments (regulations, rules, determinations, standards) made
 * under it. There is no separate "enforcement decree / enforcement rule"
 * layer, so this tool groups the instruments by `subCollection`
 * (Regulations / Rules / Court Rules / By-Laws / other) rather than inventing
 * a tier that Australian drafting does not have.
 *
 * **Discovery result (live-verified 2026-09-04, see statute-helpers/instruments.ts):**
 * the relation is a real, first-class one — the undocumented criteria function
 * `authorises("<actId>")` returns the instruments, and `$expand=authorisedBy`
 * on each result returns the *enabling provision* of the Act (`s 172`,
 * `s 134(1) of sch 2`). Nothing here is name-matched or heuristic.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import { truncateResponse } from "../lib/schemas.js"
import type { ToolResponse } from "../lib/types.js"
import { collectionLabel, titleAnnotations } from "./statute-helpers/format.js"
import { enabledInstruments, enablingProvisionFor, type RelatedTitle } from "./statute-helpers/instruments.js"
import { resolveTitle } from "./statute-helpers/title-lookup.js"

export const GetThreeTierSchema = z.object({
  registerId: z.string().optional().describe("Act register id, e.g. C2004A00109 (from search_law)."),
  query: z.string().optional().describe("Act name or alias, if you have no registerId."),
  includeRepealed: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include instruments no longer in force (the CCA authorises 647 titles in total, far fewer in force)."),
  includeGazetteNotices: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Also include notifiable instruments, gazette notices and other authorised documents. Off by default — " +
        "appointments and price notifications are authorised by the Act but are not legislation.",
    ),
  limit: z.number().int().min(1).max(100).optional().default(30).describe("Instruments to list (default 30, max 100)."),
  skip: z.number().int().min(0).optional().describe("Offset, for paging through a long list."),
})

export type GetThreeTierInput = z.infer<typeof GetThreeTierSchema>

export const getThreeTierDescription =
  "List the delegated legislation made under a Commonwealth Act — regulations, rules, determinations, standards — " +
  "with the enabling provision of the Act for each. Use when a question turns on detail an Act delegates " +
  "('what are the prescribed thresholds?'), which in Australia normally lives in an instrument, not the Act. " +
  "Grouped by instrument kind; in force only unless includeRepealed is set.";

export async function getThreeTier(apiClient: AuApiClient, input: GetThreeTierInput): Promise<ToolResponse> {
  try {
    const lookup = await resolveTitle(apiClient, {
      ...(input.registerId ? { registerId: input.registerId } : {}),
      ...(input.query ? { query: input.query } : {}),
    })
    const act = lookup.title

    const found = await enabledInstruments(apiClient, act.id, {
      inForceOnly: !input.includeRepealed,
      ...(input.includeGazetteNotices ? { collections: [] } : {}),
      top: input.limit,
      ...(input.skip !== undefined ? { skip: input.skip } : {}),
    })

    const lines: string[] = []
    lines.push(`Delegated legislation made under ${act.name} [${act.id}]`)
    for (const note of lookup.notes) lines.push(note)
    for (const note of titleAnnotations(act)) lines.push(note)
    lines.push("")

    if (found.count === 0) {
      lines.push(
        `[NOT_FOUND] The Federal Register records no ${input.includeRepealed ? "" : "in-force "}instruments made under this title.`,
      )
      lines.push("")
      lines.push(
        "That is the Register's own authorisation relation, so it is good evidence — but two ordinary explanations " +
          "come before 'this Act delegates nothing':",
      )
      lines.push("  • the Act may genuinely contain no regulation-making power;")
      lines.push(
        input.includeRepealed
          ? "  • the id may belong to an amending Act rather than the principal Act (check isPrincipal in search_law)."
          : "  • every instrument under it may have been repealed — retry with includeRepealed:true.",
      )
      return ok(lines.join("\n"))
    }

    const shown = found.titles
    lines.push(
      `${found.count} instrument(s)${input.includeRepealed ? "" : " in force"}; showing ${shown.length}` +
        (input.skip ? ` from offset ${input.skip}` : "") +
        ".",
    )
    lines.push("")

    for (const [group, members] of groupByKind(shown)) {
      lines.push(`── ${group} (${members.length}) ──`)
      for (const instrument of members) {
        const provision = enablingProvisionFor(instrument.authorisedBy ?? [], act.id)
        lines.push(`  • ${instrument.name} [${instrument.id}]`)
        const facts = [instrument.status ?? "status unknown"]
        if (instrument.year) facts.push(`${instrument.year}`)
        lines.push(`      ${facts.join(" | ")}${provision ? ` | made under ${act.name} ${provision}` : ""}`)
      }
      lines.push("")
    }

    if (found.count > shown.length + (input.skip ?? 0)) {
      lines.push(
        `… ${found.count - shown.length - (input.skip ?? 0)} more. Page with skip=${(input.skip ?? 0) + shown.length}.`,
      )
      lines.push("")
    }
    lines.push(
      "Next: get_instrument_provisions({registerId:\"<instrument id>\"}) for an instrument's contents, " +
        "instrument_radar to check whether the Act has been amended since an instrument was last compiled.",
    )

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "get_three_tier")
  }
}

/** Group by `subCollection`, which is what actually distinguishes Regulations from Rules. */
export function groupByKind(titles: readonly RelatedTitle[]): Array<[string, RelatedTitle[]]> {
  const groups = new Map<string, RelatedTitle[]>()
  for (const title of titles) {
    const key = title.subCollection ?? collectionLabel(title)
    const list = groups.get(key)
    if (list) list.push(title)
    else groups.set(key, [title])
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}
