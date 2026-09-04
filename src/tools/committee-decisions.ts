/**
 * The five commission/committee decision domains: `workplace`, `privacy`,
 * `competition`, `integrity` and `public_service`.
 *
 * They are grouped because they share one structural problem — each is a single
 * body publishing to a single index, and each index is degraded in a different
 * way. Handling them together makes the degradation explicit rather than
 * letting each tool invent its own euphemism:
 *
 *  | domain         | reachable                              | not reachable                       |
 *  |----------------|----------------------------------------|-------------------------------------|
 *  | workplace      | FWC document search + decision PDFs    | —                                   |
 *  | privacy        | OAIC determinations index (rich)       | full text (AustLII)                 |
 *  | competition    | — (ACCC + Tribunal WAF-blocked)        | everything; falls back to case law  |
 *  | integrity      | NACC investigation reports + PDFs      | Commonwealth Ombudsman (Cloudflare) |
 *  | public_service | MPC case-study index                   | individual promotion-review reasons |
 *
 * `competition` is the sharpest case. Both of its primary sources return 403 to
 * a non-browser client, so the domain would otherwise be an empty tool. Instead
 * it says `[UPSTREAM_BLOCKED]`, hands over the two registers' URLs, and runs the
 * live case-law fan-out — competition litigation ends up in the courts, so that
 * fallback returns real, relevant authority while being explicit that it is not
 * the regulator's own register.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, formatToolError } from "../lib/errors.js"
import {
  acccRegistersUrl,
  austliiSearchUrl,
  competitionTribunalUrl,
  ombudsmanReportsUrl,
} from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as fwc from "../lib/sources/fwc.js"
import * as oaic from "../lib/sources/oaic.js"
import {
  getMpcCaseStudy,
  getNaccOperation,
  searchMpc,
  searchNacc,
} from "../lib/sources/integrity-sources.js"
import { renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceSearchResult } from "../lib/sources/types.js"
import { searchCases } from "./precedents.js"

/**
 * `search_decisions` advertises `limit` for all eighteen domains, and these
 * four sources publish a fixed-size index page the caller cannot resize. So
 * `limit` means "show at most this many of the rows that were fetched": the
 * upstream `total` is left alone, which keeps the rendered count line honest
 * about the corpus, and `page` remains the way to move through it.
 */
function applyLimit(result: SourceSearchResult, limit?: number): SourceSearchResult {
  if (limit === undefined || result.hits.length <= limit) return result
  return { ...result, hits: result.hits.slice(0, limit) }
}

// ── workplace (Fair Work Commission) ──────────────────────────────────────

export const SearchWorkplaceSchema = z.object({
  query: z.string().min(1).describe("Keywords, e.g. 'genuine redundancy', 'small business unfair dismissal'."),
  benchType: z.enum(["full", "single"]).optional().describe("Restrict to Full Bench or single-member decisions."),
  page: z.number().min(1).default(1).optional().describe("1-based page; 25 rows per page."),
  limit: z.number().min(1).max(50).optional().describe(
    "Maximum hits to show from the fetched page (the page size itself is the FWC's, 25 rows — use `page` to move on).",
  ),
})

export type SearchWorkplaceInput = z.infer<typeof SearchWorkplaceSchema>

export async function searchWorkplaceDecisions(
  client: AuApiClient,
  input: SearchWorkplaceInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `workplace:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const params: fwc.FwcSearchParams = { query: input.query, page: (input.page ?? 1) - 1 }
    if (input.benchType) params.benchType = input.benchType
    const fetched = await fwc.search(client, params)
    // The FWC pages from 0; this tool's `page` is 1-based, so report the number
    // the caller passed rather than the one that went on the wire.
    fetched.page = input.page ?? 1
    const result = applyLimit(fetched, input.limit)

    const text = renderSearch(result, {
      heading: "Fair Work Commission decisions",
      query: input.query,
      followUp: 'get_decision_text(domain="workplace", id="<slug from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[workplace]")
  }
}

export const GetWorkplaceSchema = z.object({
  id: z.string().min(1).describe("Decision slug from the search results, e.g. 'werner-…-2014-fwc-3013'."),
  full: z.boolean().optional().describe("true = reasons verbatim; omitted = long bodies shortened with the gap marked."),
})

export type GetWorkplaceInput = z.infer<typeof GetWorkplaceSchema>

export async function getWorkplaceDecisionText(
  client: AuApiClient,
  input: GetWorkplaceInput,
): Promise<LooseToolResponse> {
  try {
    const document = await fwc.getDecision(client, input.id)
    return {
      content: [
        { type: "text", text: renderDocument(document, { bodyHeading: "Reasons", full: input.full === true }) },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[workplace]")
  }
}

// ── privacy (OAIC) ────────────────────────────────────────────────────────

export const SearchPrivacySchema = z.object({
  query: z.string().optional().describe(
    "Keywords matched against the determination titles, catchwords and outcomes on the fetched page.",
  ),
  page: z.number().min(1).default(1).optional().describe("1-based index page; 10 determinations per page."),
  limit: z.number().min(1).max(50).optional().describe(
    "Maximum hits to show from the fetched index page (the page size itself is the OAIC's, 10 rows).",
  ),
})

export type SearchPrivacyInput = z.infer<typeof SearchPrivacySchema>

export async function searchPrivacyDecisions(
  client: AuApiClient,
  input: SearchPrivacyInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `privacy:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const params: Parameters<typeof oaic.searchDeterminations>[1] = {}
    if (input.query) params.query = input.query
    if (input.page) params.page = input.page
    const result = applyLimit(await oaic.searchDeterminations(client, params), input.limit)

    const text = renderSearch(result, {
      heading: "OAIC privacy determinations",
      ...(input.query ? { query: input.query } : {}),
      notes: [
        "The OAIC index carries the finding, remedies and catchwords for each determination. The " +
        "full reasons live on AustLII, which this server does not fetch — the `url` on each hit is " +
        "the AustLII link, and it opens fine in a browser.",
      ],
      followUp: 'get_decision_text(domain="privacy", id="[2026] AICmr 40")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[privacy]")
  }
}

export const GetPrivacySchema = z.object({
  id: z.string().min(1).describe("An AICmr citation from the search results, e.g. '[2026] AICmr 40'."),
  page: z.number().min(1).optional().describe("Index page to look on, if the determination is not on page 1."),
})

export type GetPrivacyInput = z.infer<typeof GetPrivacySchema>

export async function getPrivacyDecisionText(
  client: AuApiClient,
  input: GetPrivacyInput,
): Promise<LooseToolResponse> {
  try {
    const params: Parameters<typeof oaic.searchDeterminations>[1] = { query: input.id }
    if (input.page) params.page = input.page
    const result = await oaic.searchDeterminations(client, params)
    const hit = result.hits[0]
    if (!hit) {
      throw new LawApiError(
        `${input.id} was not on OAIC determinations index page ${input.page ?? 1}.`,
        ErrorCodes.UPSTREAM_NO_DATA,
        [
          "⚠️ The index is paginated and has no search parameter, so this only rules out one page.",
          "Raise `page` and try again, or run search_decisions(domain=\"privacy\") without a query to see what is on each page.",
        ],
      )
    }
    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: hit.title,
              url: hit.url,
              metadata: [
                ...(hit.citation ? ([["Citation", hit.citation]] as Array<[string, string]>) : []),
                ...(hit.date ? ([["Date", hit.date]] as Array<[string, string]>) : []),
                ...(hit.extra ?? []),
                ...(hit.catchwords ? ([["Catchwords", hit.catchwords]] as Array<[string, string]>) : []),
              ],
              text: "",
              note:
                "The OAIC publishes a structured summary — finding, remedies, provisions, catchwords — " +
                "and links the full determination to AustLII, which this server does not fetch. The " +
                "reasons exist and the link above opens them in a browser.",
            },
            { bodyHeading: "Determination" },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[privacy]")
  }
}

// ── competition (blocked, with a case-law fallback) ───────────────────────

export const SearchCompetitionSchema = z.object({
  query: z.string().min(1).describe("Keywords, e.g. 'merger authorisation', 'cartel', 'misuse of market power'."),
  limit: z.number().min(1).max(50).default(10).optional(),
})

export type SearchCompetitionInput = z.infer<typeof SearchCompetitionSchema>

export function competitionLinks(query: string): string[] {
  return [
    acccRegistersUrl(),
    competitionTribunalUrl(),
    austliiSearchUrl(query, ["au/cases/cth/ACompT"]),
  ]
}

export async function searchCompetitionDecisions(
  client: AuApiClient,
  input: SearchCompetitionInput,
): Promise<LooseToolResponse> {
  const header = [
    "[UPSTREAM_BLOCKED] The ACCC public registers and the Australian Competition Tribunal both return " +
    "403 to non-browser clients, so this server does not request them.",
    "",
    "⚠️ Nothing below says a determination or authorisation does not exist — the registers were never queried.",
    ...competitionLinks(input.query).map((link) => `Open directly: ${link}`),
    "",
    "Falling back to live case law, because competition matters are litigated in the courts and those " +
    "judgments ARE reachable. These are court decisions, not the regulator's own register:",
    "",
  ].join("\n")

  const cases = await searchCases(client, {
    query: input.query,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
  const body = cases.content.map((entry) => entry.text).join("\n")
  // The fallback IS this domain's only live result, so its failure is this
  // tool's failure. Dropping `isError` here would hand a caller that keys on it
  // — search_all's runFamily marks a failed family [NOT RETRIEVED] — a
  // successful competition search that happened to find nothing.
  return {
    content: [{ type: "text", text: `${header}${body}` }],
    ...(cases.isError ? { isError: true } : {}),
  }
}

export const GetCompetitionSchema = z.object({
  id: z.string().min(1).describe("A case id or citation — competition matters resolve through the case-law sources."),
})

export type GetCompetitionInput = z.infer<typeof GetCompetitionSchema>

export async function getCompetitionDecisionText(
  _client: AuApiClient,
  input: GetCompetitionInput,
): Promise<LooseToolResponse> {
  return {
    content: [
      {
        type: "text",
        text: [
          "[UPSTREAM_BLOCKED] ACCC and Competition Tribunal documents are not fetched by this server " +
          "(both WAFs return 403 to non-browser clients).",
          "",
          "⚠️ This is a refusal to request, not evidence the document is absent.",
          ...competitionLinks(input.id).map((link) => `Open directly: ${link}`),
          "",
          `For the court judgment in a competition matter, use get_case_text(citation="${input.id}") — ` +
          "the NSW, High Court and Queensland sources are live.",
        ].join("\n"),
      },
    ],
    isError: true,
  }
}

// ── integrity (NACC live, Ombudsman blocked) ──────────────────────────────

export const SearchIntegritySchema = z.object({
  query: z.string().optional().describe("Keywords, e.g. 'border force', 'tobacco', or an operation name."),
  limit: z.number().min(1).max(50).optional().describe(
    "Maximum hits to show. The NACC index is a single page, so this only shortens the list, never the corpus.",
  ),
})

export type SearchIntegrityInput = z.infer<typeof SearchIntegritySchema>

export async function searchIntegrityDecisions(
  client: AuApiClient,
  input: SearchIntegrityInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `integrity:${input.query ?? ""}:${input.limit ?? ""}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const result = applyLimit(await searchNacc(client, input.query), input.limit)
    const text = renderSearch(result, {
      heading: "NACC investigation reports and case studies",
      ...(input.query ? { query: input.query } : {}),
      notes: [
        "[UPSTREAM_BLOCKED] Commonwealth Ombudsman reports are behind a Cloudflare challenge and are " +
        `not requested by this server. They exist and open in a browser: ${ombudsmanReportsUrl()}`,
        "NACC investigation reports are published documents, not tribunal decisions — they carry no citation.",
      ],
      followUp: 'get_decision_text(domain="integrity", id="operation-wilson")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[integrity]")
  }
}

export const GetIntegritySchema = z.object({
  id: z.string().min(1).describe("Operation anchor from the search results, e.g. 'operation-wilson'."),
  full: z.boolean().optional().describe(
    "true = the index entry verbatim; omitted = a long entry is shortened with the gap marked.",
  ),
})

export type GetIntegrityInput = z.infer<typeof GetIntegritySchema>

export async function getIntegrityDecisionText(
  client: AuApiClient,
  input: GetIntegrityInput,
): Promise<LooseToolResponse> {
  try {
    const operation = await getNaccOperation(client, input.id)
    if (!operation) {
      throw new LawApiError(
        `The NACC investigation-reports index has no section matching ${JSON.stringify(input.id)}.`,
        ErrorCodes.UPSTREAM_NO_DATA,
        [
          "⚠️ The index lists only reports the Commission has published; an operation missing from it may " +
          "be ongoing or unpublished, not non-existent.",
          'Run search_decisions(domain="integrity") with no query to list every published operation.',
        ],
      )
    }
    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: operation.name,
              url: `https://www.nacc.gov.au/investigation-reports-and-case-studies#${operation.anchor}`,
              metadata: [],
              text: operation.summary,
              documents: operation.documents,
              note:
                "The investigation report itself is a PDF; the summary above is the NACC's own index entry. " +
                "Download links are listed under Documents.",
            },
            { bodyHeading: "Background", full: input.full === true },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[integrity]")
  }
}

// ── public service (Merit Protection Commissioner) ────────────────────────

export const SearchPublicServiceSchema = z.object({
  query: z.string().optional().describe("Keywords, e.g. 'conflict of interest', 'financial penalty'."),
  facets: z.array(z.string()).optional().describe(
    "Drupal facet values, e.g. 'filter_by_code_of_conduct:18' or 'filter_by_employment_related_actions:…'.",
  ),
  page: z.number().min(1).default(1).optional().describe("1-based page; 20 case studies per page."),
  limit: z.number().min(1).max(50).optional().describe(
    "Maximum hits to show from the fetched page (the page size itself is the MPC's, 20 rows).",
  ),
})

export type SearchPublicServiceInput = z.infer<typeof SearchPublicServiceSchema>

export async function searchPublicServiceDecisions(
  client: AuApiClient,
  input: SearchPublicServiceInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `public_service:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const params: Parameters<typeof searchMpc>[1] = { page: (input.page ?? 1) - 1 }
    if (input.query) params.query = input.query
    if (input.facets) params.facets = input.facets
    const fetched = await searchMpc(client, params)
    fetched.page = input.page ?? 1
    const result = applyLimit(fetched, input.limit)

    const text = renderSearch(result, {
      heading: "Merit Protection Commissioner — case studies of merits review outcomes",
      ...(input.query ? { query: input.query } : {}),
      notes: [
        "[NOT_A_TRIBUNAL_DECISION] Individual reviews of APS promotion decisions are published as " +
        "notices rather than reasons, so they are not searchable here at all.",
      ],
      followUp: 'get_decision_text(domain="public_service", id="<slug from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[public_service]")
  }
}

export const GetPublicServiceSchema = z.object({
  id: z.string().min(1).describe("Case-study slug from the search results, e.g. 'financial-penalty-too-harsh'."),
  full: z.boolean().optional().describe(
    "true = the case study verbatim; omitted = a long one is shortened with the gap marked.",
  ),
})

export type GetPublicServiceInput = z.infer<typeof GetPublicServiceSchema>

export async function getPublicServiceDecisionText(
  client: AuApiClient,
  input: GetPublicServiceInput,
): Promise<LooseToolResponse> {
  try {
    const study = await getMpcCaseStudy(client, input.id)
    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: study.title,
              url: study.url,
              metadata: [],
              text: study.text,
              note:
                "A de-identified case study published by the Merit Protection Commissioner — not a " +
                "tribunal decision, and it carries no citation.",
            },
            { bodyHeading: "Background", full: input.full === true },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[public_service]")
  }
}
