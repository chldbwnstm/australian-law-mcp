/**
 * `search_treaties` / `get_treaty_text` — the `treaties` decision domain, over
 * DFAT's Australian Treaties Database
 * (docs/research/tribunals-states-treaties.md §8).
 *
 * This is the one Australian legal source in the whole set that offers a
 * keyless JSON API, and it is rich: status in Australia, agreement type,
 * parties, subject, where and when it was done, entry into force, JSCOT tabling
 * and report, and the treaty-action history.
 *
 * The **text**, though, is on AustLII — every `AtsLink` points there — and this
 * server does not fetch AustLII. So `get_treaty_text` returns the full metadata
 * record and the working link, and says so in as many words. Reporting a treaty
 * whose text was not retrieved as "not found" would be the exact failure this
 * server exists to avoid: the Australia–United States Free Trade Agreement does
 * not stop existing because a scraper was told not to look.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import { treatiesDatabaseUrl } from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as dfat from "../lib/sources/dfat-treaties.js"
import { renderDocument, renderSearch } from "../lib/sources/render.js"

export const SearchTreatiesSchema = z.object({
  query: z.string().optional().describe(
    "Keywords matched across the treaty database, e.g. 'extradition', 'free trade', 'double taxation Japan'.",
  ),
  page: z.number().min(1).default(1).optional().describe("1-based page; 20 treaties per page."),
  facets: z.record(z.string(), z.unknown()).optional().describe(
    "Facet filters passed through verbatim to the API. The available facet names are returned in " +
    "the `facets` block of a search response.",
  ),
  dateFilters: z.record(z.string(), z.unknown()).optional().describe(
    "Date filters passed through verbatim to the API (same shape as the site's own filter panel).",
  ),
})

export type SearchTreatiesInput = z.infer<typeof SearchTreatiesSchema>

export async function searchTreaties(
  client: AuApiClient,
  input: SearchTreatiesInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `treaties:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const params: dfat.TreatySearchParams = {}
    if (input.query) params.keyword = input.query
    if (input.page) params.page = input.page
    if (input.facets) params.facets = input.facets
    if (input.dateFilters) params.dateFilters = input.dateFilters

    const result = await dfat.search(client, params)

    const notes: string[] = [
      "Treaty text is hosted on AustLII, which this server does not fetch. Each hit's `url` is the " +
      "AustLII link for the Australian Treaty Series text and opens in a browser.",
    ]
    if (result.totalPages !== undefined) {
      notes.push(`Page ${result.page ?? 1} of ${result.totalPages}.`)
    }
    if (result.facets) {
      notes.push(`Available facets: ${Object.keys(result.facets).join(", ")}`)
    }

    // The follow-up hint carries the caller's own keyword and page back, because
    // without them the lookup is a scan of page 1: the database has no
    // single-record endpoint, so an id from page 3 is simply not found and the
    // caller reads a [UPSTREAM_NO_DATA] as "no such treaty". A hard-coded
    // example id here taught exactly the call that fails.
    const page = result.page ?? input.page ?? 1
    const followUp =
      `get_treaty_text(id="<the id printed on the hit>"` +
      (input.query ? `, keyword="${input.query}"` : "") +
      (page > 1 ? `, page=${page}` : "") +
      ") — pass the keyword and page back, or the id is looked for on page 1 only. " +
      "Through the unified tool: get_decision_text({domain:\"treaties\", id:\"…\", options:{keyword:\"…\"}})."

    const text = renderSearch(result, {
      heading: "Australian Treaties Database (DFAT)",
      ...(input.query ? { query: input.query } : {}),
      notes,
      followUp,
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_treaties")
  }
}

export const GetTreatyTextSchema = z.object({
  id: z.string().min(1).describe("Treaty database id from search_treaties, e.g. '3030'."),
  keyword: z.string().optional().describe(
    "The keyword used in the search that produced this id. The database has no single-record " +
    "endpoint (`/api/treaty/{id}` is 401), so the record is located inside a search response — " +
    "passing the original keyword makes that lookup exact instead of a scan of page 1.",
  ),
  page: z.number().min(1).optional().describe("Page the id appeared on, if it was not page 1."),
})

export type GetTreatyTextInput = z.infer<typeof GetTreatyTextSchema>

export async function getTreatyText(
  client: AuApiClient,
  input: GetTreatyTextInput,
): Promise<LooseToolResponse> {
  try {
    const hint: { keyword?: string; page?: number } = {}
    if (input.keyword) hint.keyword = input.keyword
    if (input.page) hint.page = input.page
    const record = await dfat.getById(client, input.id, hint)

    if (!record) {
      throw new LawApiError(
        `Treaty id ${input.id} was not in the search response this server read.`,
        ErrorCodes.UPSTREAM_NO_DATA,
        [
          "⚠️ The database exposes no single-record endpoint, so the id is looked up inside a search " +
          "page. Not finding it there does not mean the treaty is absent.",
          "Pass the `keyword` you originally searched for (and the `page` the id appeared on) to make the lookup exact.",
          `Browse the database directly: ${treatiesDatabaseUrl()}`,
        ],
      )
    }

    const metadata: Array<[string, string]> = []
    const push = (label: string, value: string | undefined) => {
      if (value) metadata.push([label, value])
    }
    push("Short title", record.shortTitle)
    push("ATS number", record.atsNumber)
    push("ATNIF number", record.atnifNumber)
    push("Status (Australia)", record.status)
    push("Agreement type", record.agreementType)
    push("Subject", record.subject)
    if (record.countries.length > 0) metadata.push(["Parties", record.countries.join(", ")])
    push("Done at", [record.doneAtPlace, record.doneAtDate].filter(Boolean).join(", ") || undefined)
    push("Entry into force (Australia)", record.entryIntoForceForAustralia)
    push("Entry into force (generally)", record.entryIntoForceGenerally)
    push("Tabled — House of Representatives", record.tablingDateRepresentatives)
    push("Tabled — Senate", record.tablingDateSenate)
    push("Depositary", record.depositary)
    push("JSCOT report", record.jscotReportNumber)
    if (record.actions.length > 0) {
      metadata.push([
        "Treaty actions",
        record.actions.map((action) => `${action.date ?? "?"} ${action.action ?? ""}`.trim()).join(" · "),
      ])
    }
    if (record.implementationMeasures.length > 0) {
      metadata.push(["Australian implementation measures", record.implementationMeasures.join("; ")])
    }

    const documents: Array<{ label: string; url: string }> = []
    if (record.atsLink) documents.push({ label: "Treaty text (ATS, AustLII)", url: record.atsLink })
    if (record.atnifLink) documents.push({ label: "Not-yet-in-force text (ATNIF)", url: record.atnifLink })
    if (record.atniaLink) documents.push({ label: "National Interest Analysis (ATNIA)", url: record.atniaLink })
    if (record.jscotReportUrl) documents.push({ label: "JSCOT report", url: record.jscotReportUrl })

    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: record.title,
              ...(record.atsNumber ? { citation: record.atsNumber } : {}),
              url: record.atsLink ?? treatiesDatabaseUrl(),
              metadata,
              text: "",
              documents,
              note:
                "[UPSTREAM_BLOCKED] The treaty's operative text is hosted on AustLII, which this server " +
                "does not fetch. Everything above is DFAT's own record; the text itself opens from the " +
                "links under Documents. Nothing here says the treaty or its text is unavailable.",
            },
            { bodyHeading: "Text" },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_treaty_text")
  }
}
