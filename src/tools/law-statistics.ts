/**
 * `get_law_statistics` — real counts, straight from the Register.
 *
 * Every number here is an `@odata.count` on a query the caller could run
 * themselves; nothing is estimated or summed from a sampled page. That is the
 * whole design constraint, because a statistic that looks authoritative and
 * was actually inferred is the least checkable kind of wrong answer.
 *
 * Two upstream quirks shape the implementation (both verified 2026-09-04):
 *
 *  - `GET /Titles/$count` returns `-9223372036854775808` — a broken endpoint,
 *    not a count. `$top=1&$count=true` is used instead and the count is read
 *    from `@odata.count`.
 *  - `collection eq 'Act' and year ge 2020` is a 500, but
 *    `collection eq 'Act' and year eq 2020` is fine. Year buckets are
 *    therefore one query per year, and the year span is capped.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { SEARCH_CACHE_TTL, lawCache } from "../lib/cache.js"
import {
  and,
  collection as criteriaCollection,
  status as criteriaStatus,
  titlesSearchPath,
  type FrlCollection,
  type FrlStatus,
} from "../lib/frl-criteria.js"
import { truncateResponse } from "../lib/schemas.js"
import type { ToolResponse } from "../lib/types.js"

const COLLECTIONS: readonly FrlCollection[] = [
  "Act",
  "LegislativeInstrument",
  "NotifiableInstrument",
  "AdministrativeArrangementsOrder",
  "Constitution",
  "ContinuedLaw",
  "Gazette",
  "PrerogativeInstrument",
]
const STATUSES: readonly FrlStatus[] = ["InForce", "Ceased", "Repealed", "NeverEffective"]

/** One query per year, so the span is bounded rather than trusted. */
const MAX_YEARS = 25

export const GetLawStatisticsSchema = z.object({
  breakdown: z
    .enum(["collection", "status", "year", "all"])
    .optional()
    .default("collection")
    .describe("'collection' = how many Acts/instruments/gazettes; 'status' = in force vs repealed; 'year' = per-year counts."),
  collection: z
    .enum(["Act", "LegislativeInstrument", "NotifiableInstrument", "AdministrativeArrangementsOrder", "Constitution", "ContinuedLaw", "Gazette", "PrerogativeInstrument"])
    .optional()
    .describe("Restrict status/year breakdowns to one collection, e.g. 'Act'."),
  yearFrom: z.number().int().min(1900).max(2100).optional().describe("First year for a 'year' breakdown."),
  yearTo: z.number().int().min(1900).max(2100).optional().describe(`Last year for a 'year' breakdown (at most ${MAX_YEARS} years).`),
})

export type GetLawStatisticsInput = z.infer<typeof GetLawStatisticsSchema>

export const getLawStatisticsDescription =
  "Counts of Commonwealth legislation from the Federal Register: by collection (Acts vs legislative instruments vs " +
  "gazettes), by status (in force vs repealed), or per year. Every figure is a live @odata.count, not an estimate. " +
  "Use for 'how many Acts are in force' style questions and for sizing a search before you run it.";

export async function getLawStatistics(apiClient: AuApiClient, input: GetLawStatisticsInput): Promise<ToolResponse> {
  try {
    const lines: string[] = ["Federal Register of Legislation — counts", ""]
    const wants = input.breakdown

    if (wants === "collection" || wants === "all") {
      lines.push("By collection:")
      const rows = await Promise.all(
        COLLECTIONS.map(async (collection) => ({ collection, count: await countCriteria(apiClient, [criteriaCollection(collection)]) })),
      )
      const total = rows.reduce((sum, row) => sum + row.count, 0)
      for (const row of rows.sort((a, b) => b.count - a.count)) {
        lines.push(`  ${row.collection.padEnd(34)} ${row.count.toLocaleString().padStart(9)}`)
      }
      lines.push(`  ${"(sum of the above)".padEnd(34)} ${total.toLocaleString().padStart(9)}`)
      lines.push("")
    }

    if (wants === "status" || wants === "all") {
      const scope = input.collection ?? "Act"
      lines.push(`By status${input.collection || wants === "all" ? ` (collection: ${scope})` : ""}:`)
      const rows = await Promise.all(
        STATUSES.map(async (status) => ({
          status,
          count: await countCriteria(apiClient, [criteriaCollection(scope as FrlCollection), criteriaStatus(status)]),
        })),
      )
      for (const row of rows.sort((a, b) => b.count - a.count)) {
        lines.push(`  ${row.status.padEnd(34)} ${row.count.toLocaleString().padStart(9)}`)
      }
      lines.push(
        "  Note: a title counts once, under its CURRENT status. 'Repealed' includes titles repealed decades ago.",
      )
      lines.push("")
    }

    if (wants === "year" || wants === "all") {
      const to = input.yearTo ?? new Date().getFullYear()
      const from = input.yearFrom ?? to - 9
      if (from > to) {
        throw new LawApiError(`Year range runs backwards: ${from} to ${to}`, ErrorCodes.INVALID_PARAM, ["Swap yearFrom and yearTo."])
      }
      if (to - from + 1 > MAX_YEARS) {
        throw new LawApiError(
          `A year breakdown costs one query per year; ${to - from + 1} years exceeds the ${MAX_YEARS}-year cap`,
          ErrorCodes.INVALID_PARAM,
          [`Narrow the range, e.g. yearFrom:${to - MAX_YEARS + 1}, yearTo:${to}.`],
        )
      }
      const scope = input.collection ?? "Act"
      lines.push(`By year (collection: ${scope}), ${from}–${to}:`)
      const years = Array.from({ length: to - from + 1 }, (_, index) => from + index)
      const rows = await Promise.all(
        years.map(async (year) => ({ year, count: await countFilter(apiClient, `collection eq '${scope}' and year eq ${year}`) })),
      )
      for (const row of rows) {
        lines.push(`  ${String(row.year).padEnd(34)} ${row.count.toLocaleString().padStart(9)}`)
      }
      lines.push(
        "  Note: `year` is the year of the series (the Act's own year), not the year of the latest compilation.",
      )
      lines.push("")
    }

    lines.push(`Counted live from ${new Date().toISOString().slice(0, 10)}. Every figure is an upstream @odata.count.`)
    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "get_law_statistics")
  }
}

interface CountEnvelope {
  "@odata.count"?: number
  value?: unknown[]
}

/** `$top=1&$count=true` — `/Titles/$count` is broken upstream and is never used. */
async function countCriteria(apiClient: AuApiClient, parts: Parameters<typeof and>): Promise<number> {
  const criteria = and(...parts)
  return cachedCount(apiClient, `count:criteria:${criteria}`, titlesSearchPath(criteria), {})
}

async function countFilter(apiClient: AuApiClient, filter: string): Promise<number> {
  return cachedCount(apiClient, `count:filter:${filter}`, "Titles", { $filter: filter })
}

async function cachedCount(
  apiClient: AuApiClient,
  key: string,
  path: string,
  extraQuery: Record<string, string | number>,
): Promise<number> {
  const cached = lawCache.get<number>(key)
  if (cached !== null) return cached
  const json = (await apiClient.fetchJson("frlApi", path, {
    query: { ...extraQuery, $top: 1, $select: "id", $count: "true" },
  })) as CountEnvelope
  const count = json["@odata.count"] ?? json.value?.length ?? 0
  lawCache.set(key, count, SEARCH_CACHE_TTL)
  return count
}
