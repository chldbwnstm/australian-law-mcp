/**
 * `search_law` — find Commonwealth legislation by name or alias.
 *
 * Three things this tool refuses to do, each because the naive version is
 * confidently wrong rather than merely unhelpful:
 *
 *  1. Take FRL relevance order on trust. "competition and consumer act" puts
 *     three repealed price-notification instruments above the CCA itself
 *     (verified live 2026-09-04), so results are re-ranked: exact name, then
 *     principal, then `collection=Act`.
 *  2. Report a rename as a repeal. A `Trade Practices Act 1974` query returns
 *     `C2004A00109` under its current name; the annotation says "matched former
 *     name … a rename, NOT a repeal".
 *  3. Return an unrelated result set as an answer. When nothing overlaps the
 *     query (`hasRelatedHit`), the tool says the search did not connect.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError, noResultHint } from "../lib/errors.js"
import { hasRelatedHit, resolveLawAlias } from "../lib/law-alias.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { formatTitleBlock, moreHint } from "./statute-helpers/format.js"
import { TITLE_SELECT, looksLikeRegisterId, rankTitles } from "./statute-helpers/title-lookup.js"

export const SearchLawSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      "Act or instrument name, or a lawyer's abbreviation (CCA, ACL, FW Act, TPA). " +
        "Former names work too — 'Trade Practices Act 1974' resolves to the CCA.",
    ),
  collection: z
    .enum(["Act", "LegislativeInstrument", "NotifiableInstrument", "Constitution", "Gazette"])
    .optional()
    .describe("Restrict the collection. Use 'Act' for statutes, 'LegislativeInstrument' for regulations/rules."),
  status: z
    .enum(["InForce", "Repealed", "Ceased", "NeverEffective"])
    .optional()
    .describe("Restrict by status. Omit to see repealed titles too (they are annotated with what repealed them)."),
  pointInTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD — search the law as it stood on that date rather than today."),
  searchText: z
    .boolean()
    .optional()
    .describe("Search the full text of legislation as well as titles (default: titles only). Slower and much broader."),
  limit: z.number().int().min(1).max(50).optional().default(10).describe("Results to show (default 10, max 50)."),
})

export type SearchLawInput = z.infer<typeof SearchLawSchema>

export const searchLawDescription =
  "Search Australian Commonwealth legislation on the Federal Register by name or common abbreviation " +
  "(CCA, ACL, FW Act, TPA all resolve). Returns each match with its registerId — the id every other tool needs — " +
  "plus repeal/rename/commencement warnings. Use this first whenever you have a law NAME and need an id. " +
  "For full-text or multi-facet queries use advanced_search; for a prefix list use suggest_law_names.";

export async function searchLaw(apiClient: AuApiClient, input: SearchLawInput): Promise<ToolResponse> {
  try {
    const query = input.query.trim()
    const notes: string[] = []

    // A register id typed into the search box is a lookup, not a search.
    if (looksLikeRegisterId(query)) {
      const title = await apiClient.getTitle(query)
      return ok(
        [`"${query}" is a register id, so it was looked up directly.`, "", formatTitleBlock(title, 1, query)].join("\n"),
      )
    }

    const alias = resolveLawAlias(query)
    if (alias.needsJurisdiction) {
      const list = alias.candidates.map((c) => `  • ${c.official} (${c.jurisdiction})`).join("\n")
      return {
        content: [
          {
            type: "text",
            text:
              `[AMBIGUOUS] "${query}" names Acts in more than one jurisdiction:\n${list}\n\n` +
              'Ask which jurisdiction is meant, then re-search with it, e.g. "Evidence Act (NSW)".\n' +
              "Only Commonwealth law is on the Federal Register — for a state Act, use get_state_equivalents.",
          },
        ],
        isError: true,
      }
    }
    if (alias.candidates.length > 0 && alias.searchText !== query) {
      const hit = alias.candidates[0]
      notes.push(
        `Alias "${query}" resolved to ${hit.official} (${hit.jurisdiction})${hit.sch ? `, sch ${hit.sch}` : ""}.` +
          (hit.notes ? ` ${hit.notes}` : ""),
      )
    }

    const searchText = alias.searchText || query
    const searchType = input.searchText ? "nameAndText" : "name"
    let found = await apiClient.searchTitles({
      text: searchText,
      searchType,
      ...(input.collection ? { collection: input.collection } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.pointInTime ? { pointInTime: input.pointInTime } : {}),
      top: Math.min(input.limit * 2, 50),
      select: TITLE_SELECT,
    })

    if (found.titles.length === 0 && searchType === "name") {
      found = await apiClient.searchTitles({
        text: searchText,
        searchType: "nameAndText",
        ...(input.collection ? { collection: input.collection } : {}),
        top: Math.min(input.limit * 2, 50),
        select: TITLE_SELECT,
      })
      if (found.titles.length > 0) notes.push("No title-name match — these come from a full-text search instead.")
    }

    if (found.titles.length === 0) return noResultHint(query, "search_law:")

    if (!isRelated(searchText, found.titles)) {
      return {
        content: [
          {
            type: "text",
            text:
              `[NOT_FOUND] The Federal Register answered "${searchText}" with ${found.count} titles, ` +
              "but none of them shares a name with the query.\n\n" +
              "⚠️ That pattern means the search did not connect, not that these titles are the answer. Do not report them as matches.\n" +
              `Top unrelated hit: ${found.titles[0].name} [${found.titles[0].id}]\n\n` +
              "Retry suggestions:\n" +
              "  - Use the official short title with its year.\n" +
              "  - Set searchText=true to search inside the text of legislation.\n" +
              "  - State/territory Acts are not on this register — try get_state_equivalents.",
          },
        ],
        isError: true,
      }
    }

    const ranked = rankTitles(searchText, found.titles)
    const shown = ranked.slice(0, input.limit)
    const lines: string[] = []
    lines.push(`Federal Register search: "${query}"${input.pointInTime ? ` as at ${input.pointInTime}` : ""}`)
    lines.push(`${found.count} matching title(s); showing ${shown.length}, principal Acts ranked first.`)
    for (const note of notes) lines.push(note)
    lines.push("")
    // The user's own wording, not the alias expansion: "matched former name"
    // is an explanation of what THEY typed, and comparing against the expanded
    // official title would never fire.
    shown.forEach((title, index) => lines.push(formatTitleBlock(title, index + 1, query), ""))
    lines.push(
      moreHint(shown.length, found.count, "Raise `limit` (max 50) or narrow with `collection`/`status`.").trim(),
    )
    lines.push("")
    lines.push("Next: get_law_text(registerId) for text, get_law_tree for structure, get_law_history for amendments.")

    return ok(lines.filter((line) => line !== undefined).join("\n"))
  } catch (error) {
    return formatToolError(error, "search_law")
  }
}

function isRelated(query: string, titles: readonly FrlTitle[]): boolean {
  return hasRelatedHit(
    query,
    titles.map((title) => ({
      name: title.name,
      altName: title.nameHistory?.map((entry) => entry.name).join(" "),
    })),
  )
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}
