/**
 * `advanced_search` — the Federal Register's criteria DSL, exposed deliberately.
 *
 * `search_law` is for "I know roughly what it is called". This is for the rest:
 * full-text phrases, several collections at once, OR combinations, and
 * point-in-time searching ("which Acts contained this phrase in 2015?").
 *
 * The DSL's traps are handled by `lib/frl-criteria.ts` (double encoding,
 * function-style `and()`/`or()`, unquoted enums) — the ones this tool has to
 * handle itself are the **silent** ones, and they are documented in the
 * parameter text rather than hidden:
 *
 *  - `$search` is ignored by the server, so it is never sent.
 *  - `$orderby=makingDate` is a 500; only the working sort keys are offered.
 *  - `year ge …` does not combine with `collection eq …` (a 500, verified
 *    2026-09-04), so a year *range* is applied locally to the page and the
 *    response says so instead of quietly returning a filtered subset as if it
 *    were the whole answer.
 *
 * Unlike `search_law`, results are NOT re-ranked and the `hasRelatedHit` guard
 * is not applied. Both would be wrong here: a full-text query legitimately
 * returns titles whose names have nothing to do with the phrase, and reordering
 * them would destroy the relevance signal the caller asked for. The output says
 * which order it is in rather than leaving that to be inferred.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import {
  and,
  collection as criteriaCollection,
  or,
  pointintime,
  status as criteriaStatus,
  text as criteriaText,
  titlesSearchPath,
  type Criteria,
  type FrlCollection,
  type FrlStatus,
  type MatchType,
  type SearchType,
} from "../lib/frl-criteria.js"
import { truncateResponse } from "../lib/schemas.js"
import type { FrlTitle, ToolResponse } from "../lib/types.js"
import { formatTitleBlock, moreHint } from "./statute-helpers/format.js"
import { TITLE_SELECT } from "./statute-helpers/title-lookup.js"

const COLLECTIONS = [
  "Act",
  "LegislativeInstrument",
  "NotifiableInstrument",
  "AdministrativeArrangementsOrder",
  "Constitution",
  "ContinuedLaw",
  "Gazette",
  "PrerogativeInstrument",
] as const

export const AdvancedSearchSchema = z.object({
  text: z.string().optional().describe("Search phrase. `contains` treats it as a PHRASE, not a bag of words."),
  searchType: z
    .enum(["nameAndText", "name", "id"])
    .optional()
    .default("nameAndText")
    .describe("Which index to search: 'name' = titles only, 'nameAndText' = titles and the text of legislation."),
  matchType: z
    .enum(["contains", "exact", "startswith", "excludes", "any", "all"])
    .optional()
    .default("contains")
    .describe("'contains' = phrase match; 'any'/'all' = word-wise; 'excludes' = must NOT contain."),
  collections: z.array(z.enum(COLLECTIONS)).optional().describe("One or more collections, e.g. ['Act','LegislativeInstrument']."),
  statuses: z
    .array(z.enum(["InForce", "Ceased", "Repealed", "NeverEffective"]))
    .optional()
    .describe("One or more statuses. Omit to include repealed titles (they come annotated)."),
  pointInTime: z
    .string()
    .optional()
    .describe("'YYYY-MM-DD' or 'Latest' — search the law as it stood then. Combines with full-text search."),
  combine: z
    .enum(["and", "or"])
    .optional()
    .default("and")
    .describe("How to join the facets. 'or' widens (text OR collection); 'and' narrows. Default 'and'."),
  year: z.number().int().min(1900).max(2100).optional().describe("Exact year of enactment/making."),
  yearFrom: z.number().int().min(1900).max(2100).optional().describe("Year range start (applied locally — see note in the output)."),
  yearTo: z.number().int().min(1900).max(2100).optional().describe("Year range end (applied locally)."),
  orderBy: z
    .enum(["relevance", "name", "year", "asMadeRegisteredAt"])
    .optional()
    .default("relevance")
    .describe("Sort key. 'relevance' only applies to text searches. ('makingDate' is a server error and is not offered.)"),
  limit: z.number().int().min(1).max(100).optional().default(20).describe("Results per page (max 100 upstream)."),
  skip: z.number().int().min(0).optional().describe("Offset. Page manually — the server's nextLink drops the filter."),
})

export type AdvancedSearchInput = z.infer<typeof AdvancedSearchSchema>

export const advancedSearchDescription =
  "Full-power search of the Federal Register: full-text phrases, multiple collections, status and point-in-time " +
  'facets, AND/OR. Examples: {text:"misleading or deceptive", searchType:"nameAndText", collections:["Act"]}; ' +
  '{text:"carbon", pointInTime:"2015-06-30"} for the law as it stood then. Use search_law for a plain name lookup ' +
  "and this when the query has facets or is a phrase inside the text of legislation.";

interface ODataTitles {
  "@odata.count"?: number
  value?: FrlTitle[]
}

export async function advancedSearch(apiClient: AuApiClient, input: AdvancedSearchInput): Promise<ToolResponse> {
  try {
    const hasCriteria = Boolean(input.text || input.collections?.length || input.statuses?.length || input.pointInTime)
    if (!hasCriteria && input.year === undefined && input.yearFrom === undefined && input.yearTo === undefined) {
      throw new LawApiError("Give at least one of: text, collections, statuses, pointInTime, year", ErrorCodes.INVALID_PARAM, [
        'e.g. {"text":"misleading or deceptive","collections":["Act"]}',
      ])
    }

    const query: Record<string, string | number> = {
      $count: "true",
      $top: input.limit,
      $select: TITLE_SELECT,
    }
    if (input.skip !== undefined) query.$skip = input.skip
    if (input.orderBy !== "relevance") query.$orderby = `${input.orderBy} asc`

    let path: string
    let described: string
    if (hasCriteria) {
      const parts: Criteria[] = []
      if (input.text) parts.push(criteriaText(input.text, input.searchType as SearchType, input.matchType as MatchType))
      if (input.collections?.length) parts.push(criteriaCollection(...(input.collections as FrlCollection[])))
      if (input.statuses?.length) parts.push(criteriaStatus(...(input.statuses as FrlStatus[])))
      if (input.pointInTime) parts.push(pointintime(input.pointInTime))
      const criteria = input.combine === "or" ? or(...parts) : and(...parts)
      path = titlesSearchPath(criteria)
      described = criteria
      if (input.year !== undefined) query.$filter = `year eq ${input.year}`
    } else {
      path = "Titles"
      const filters: string[] = []
      if (input.year !== undefined) filters.push(`year eq ${input.year}`)
      else {
        if (input.yearFrom !== undefined) filters.push(`year ge ${input.yearFrom}`)
        if (input.yearTo !== undefined) filters.push(`year le ${input.yearTo}`)
      }
      query.$filter = filters.join(" and ")
      described = `$filter=${query.$filter}`
    }

    const json = (await apiClient.fetchJson("frlApi", path, { query })) as ODataTitles
    const count = json["@odata.count"] ?? json.value?.length ?? 0
    let titles = json.value ?? []

    const localYearFilter = hasCriteria && (input.yearFrom !== undefined || input.yearTo !== undefined)
    const beforeLocal = titles.length
    if (localYearFilter) {
      titles = titles.filter((title) => {
        const year = title.year ?? undefined
        if (year === undefined) return false
        if (input.yearFrom !== undefined && year < input.yearFrom) return false
        if (input.yearTo !== undefined && year > input.yearTo) return false
        return true
      })
    }

    const lines: string[] = []
    lines.push("Advanced search of the Federal Register")
    lines.push(`Criteria: ${described}`)
    if (input.pointInTime) {
      lines.push(
        `Point in time: ${input.pointInTime} — the MATCH is against the law as it stood then. ` +
          `To read that text, pass the same date to get_law_text.`,
      )
    }
    lines.push(
      input.orderBy === "relevance" && input.text
        ? "Order: upstream relevance, NOT re-ranked — an amending Act can outrank the principal Act it amends. " +
            "Use search_law when you want principal Acts first."
        : `Order: ${input.orderBy} ascending.`,
    )
    lines.push(`${count} matching title(s) upstream; ${titles.length} shown${input.skip ? ` from offset ${input.skip}` : ""}.`)
    if (localYearFilter) {
      lines.push(
        `⚠️ The year RANGE was applied to this page only (${beforeLocal} → ${titles.length} rows). The upstream ` +
          "server rejects a year range combined with other facets, so `count` above is the unfiltered total — page " +
          "through with `skip`, or use `year` for an exact year, which the server does support.",
      )
    }
    lines.push("")

    if (titles.length === 0) {
      lines.push("[NOT_FOUND] No titles matched.")
      lines.push("")
      lines.push("⚠️ Do not fill this in from memory. Things that commonly cause an empty result here:")
      lines.push("  - matchType 'contains' is a PHRASE match — try 'all' or 'any' for a word-wise search.")
      lines.push("  - searchType 'name' only looks at titles; use 'nameAndText' to search inside legislation.")
      lines.push("  - a status/collection facet may be excluding the answer — drop one and retry.")
      return ok(lines.join("\n"))
    }

    titles.forEach((title, index) => lines.push(formatTitleBlock(title, (input.skip ?? 0) + index + 1, input.text), ""))
    lines.push(moreHint(titles.length + (input.skip ?? 0), count, `Page with skip=${(input.skip ?? 0) + titles.length}.`).trim())

    return ok(lines.join("\n"))
  } catch (error) {
    return formatToolError(error, "advanced_search")
  }
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text: truncateResponse(text) }] }
}
