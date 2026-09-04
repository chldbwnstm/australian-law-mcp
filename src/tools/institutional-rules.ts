/**
 * Three "rules made by an institution" domains: `university_rules`,
 * `agency_rules` and `gazettes`.
 *
 * What they have in common is that the instrument, not a decision, is the
 * record — and that two of them have a real register behind them:
 *
 *  - **agency_rules** → the Federal Register's `NotifiableInstrument`
 *    collection. Determinations, directions and staff instruments made by
 *    Commonwealth agencies land here.
 *  - **gazettes** → the Register's `Gazette` collection (~18,600 items,
 *    register ids shaped `C2025G00695`, same document grammar as any other
 *    title).
 *  - **university_rules** → Australian universities are established by *state*
 *    acts, and their by-laws and statutes are made under those acts. There is
 *    no national register, so this searches the state legislation clients for
 *    university legislation and says plainly which registers were reachable.
 *
 * Register searches go through `lib/sources/frl-search.ts` rather than
 * `AuApiClient.searchTitles`, for one measured reason: the client's frozen
 * signature always uses the criteria DSL's default match type, `contains`,
 * which is a **phrase** match. "CSIRO determination" returns 0 results that way
 * and 2 with `all`. The criteria grammar itself still comes from
 * `lib/frl-criteria.ts` — neither file rewrites it.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError, formatToolError } from "../lib/errors.js"
import { frlHumanUrl } from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { FrlTitle, LooseToolResponse } from "../lib/types.js"
import { frlSearchUrl, searchTitlesMatching } from "../lib/sources/frl-search.js"
import { searchStateLaw, STATE_JURISDICTIONS, type StateJurisdiction } from "../lib/sources/state-legislation.js"
import { getHostConfig } from "../lib/upstream-hosts.js"
import { interleave, renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceHit, SourceSearchResult } from "../lib/sources/types.js"

// ── shared FRL rendering ──────────────────────────────────────────────────

function frlHits(titles: FrlTitle[], label: string): SourceHit[] {
  return titles.map((title) => {
    const hit: SourceHit = {
      source: "Federal Register of Legislation",
      title: title.name,
      id: title.id,
      url: frlHumanUrl(title.id),
    }
    const extra: Array<[string, string]> = [["Register", label]]
    if (title.status) extra.push(["Status", title.status])
    if (title.year !== undefined && title.year !== null) extra.push(["Year", String(title.year)])
    if (title.number !== undefined && title.number !== null) extra.push(["Number", String(title.number)])
    hit.extra = extra
    return hit
  })
}

async function searchFrlCollection(
  client: AuApiClient,
  p: { text: string; collection: "NotifiableInstrument" | "Gazette"; limit: number; page: number },
): Promise<SourceSearchResult> {
  // `all`, not the DSL's default phrase match — see lib/sources/frl-search.ts.
  const { count, titles } = await searchTitlesMatching(client, {
    query: p.text,
    collection: p.collection,
    top: p.limit,
    skip: (p.page - 1) * p.limit,
  })
  return {
    hits: frlHits(titles, p.collection),
    total: count,
    page: p.page,
    sourceUrl: frlSearchUrl(p.text),
  }
}

// ── agency_rules ──────────────────────────────────────────────────────────

export const SearchAgencyRulesSchema = z.object({
  query: z.string().min(1).describe(
    "Keywords, e.g. 'CSIRO determination', 'Australian Public Service Commissioner direction'.",
  ),
  limit: z.number().min(1).max(100).default(20).optional(),
  page: z.number().min(1).default(1).optional(),
})

export type SearchAgencyRulesInput = z.infer<typeof SearchAgencyRulesSchema>

export async function searchAgencyRules(
  client: AuApiClient,
  input: SearchAgencyRulesInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `agency_rules:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const result = await searchFrlCollection(client, {
      text: input.query,
      collection: "NotifiableInstrument",
      limit: input.limit ?? 20,
      page: input.page ?? 1,
    })
    const text = renderSearch(result, {
      heading: "Commonwealth notifiable instruments (agency rules)",
      query: input.query,
      notes: [
        "Notifiable instruments are agency-made rules registered on the Federal Register of " +
        "Legislation. Instruments an agency publishes only on its own website are not registered " +
        "here and will not appear.",
      ],
      followUp: 'get_decision_text(domain="agency_rules", id="F2024N00123")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[agency_rules]")
  }
}

// ── gazettes ──────────────────────────────────────────────────────────────

export const SearchGazettesSchema = z.object({
  query: z.string().min(1).describe("Keywords, e.g. 'appointment ACCC chair', 'Commonwealth of Australia Gazette'."),
  limit: z.number().min(1).max(100).default(20).optional(),
  page: z.number().min(1).default(1).optional(),
})

export type SearchGazettesInput = z.infer<typeof SearchGazettesSchema>

export async function searchGazettes(
  client: AuApiClient,
  input: SearchGazettesInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `gazettes:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const result = await searchFrlCollection(client, {
      text: input.query,
      collection: "Gazette",
      limit: input.limit ?? 20,
      page: input.page ?? 1,
    })
    const text = renderSearch(result, {
      heading: "Commonwealth Gazette",
      query: input.query,
      notes: [
        "The Gazette collection on the Federal Register holds the notices published since the series " +
        "moved online; older paper gazettes are held by the National Library and are not in this index.",
      ],
      followUp: 'get_decision_text(domain="gazettes", id="C2025G00695")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[gazettes]")
  }
}

// ── shared FRL getter (agency_rules + gazettes) ───────────────────────────

export const GetRegisteredInstrumentSchema = z.object({
  id: z.string().min(1).describe("Federal Register title id, e.g. 'F2024N00123' or 'C2025G00695'."),
})

export type GetRegisteredInstrumentInput = z.infer<typeof GetRegisteredInstrumentSchema>

export async function getRegisteredInstrumentText(
  client: AuApiClient,
  input: GetRegisteredInstrumentInput,
): Promise<LooseToolResponse> {
  try {
    const title = await client.getTitle(input.id)
    const versions = await client.listVersions(title.id, { top: 5 })
    const metadata: Array<[string, string]> = [["Register id", title.id]]
    if (title.collection) metadata.push(["Collection", title.collection])
    if (title.status) metadata.push(["Status", title.status])
    if (title.year !== undefined && title.year !== null) metadata.push(["Year", String(title.year)])
    if (title.number !== undefined && title.number !== null) metadata.push(["Number", String(title.number)])
    const latest = versions[0]
    if (latest?.start) metadata.push(["Latest version start", latest.start])
    if (latest?.registerId) metadata.push(["Latest register id", latest.registerId])

    return {
      content: [
        {
          type: "text",
          text: renderDocument(
            {
              title: title.name,
              url: frlHumanUrl(title.id),
              metadata,
              text: "",
              documents: [
                { label: "Authorised PDF", url: `https://www.legislation.gov.au/${title.id}/latest/downloads` },
                { label: "Text", url: frlHumanUrl(title.id) },
              ],
              note:
                "Gazettes and notifiable instruments are registered as documents rather than as " +
                "provision-structured text. Use get_law_text for a title that has an epub compilation; " +
                "otherwise the download links above are the authorised form.",
            },
            { bodyHeading: "Text" },
          ),
        },
      ],
    }
  } catch (error) {
    return formatToolError(error, "get_decision_text[registered instrument]")
  }
}

// ── university_rules ──────────────────────────────────────────────────────

/** Universities are creatures of state statute, so the search runs per register. */
const UNIVERSITY_TERMS = ["university"] as const

export const SearchUniversityRulesSchema = z.object({
  query: z.string().min(1).describe(
    "University name or subject, e.g. 'University of Sydney', 'Queensland University of Technology by-laws'.",
  ),
  jurisdiction: z.string().optional().describe(
    "QLD | TAS | WA | VIC | NT | ACT. Omitted = the reachable registers are searched together. " +
    "NSW and SA are blocked and return links.",
  ),
  limit: z.number().min(1).max(50).default(10).optional(),
})

export type SearchUniversityRulesInput = z.infer<typeof SearchUniversityRulesSchema>

/** Registers that answer a query without a browser. NSW/SA are excluded by design. */
export const SEARCHABLE_STATE_REGISTERS: readonly StateJurisdiction[] = STATE_JURISDICTIONS.filter(
  (jurisdiction) => jurisdiction !== "NSW" && jurisdiction !== "SA",
)

/** Derived from the searchable set, so the two lists cannot disagree. */
export const BLOCKED_STATE_REGISTERS: readonly StateJurisdiction[] = STATE_JURISDICTIONS.filter(
  (jurisdiction) => !SEARCHABLE_STATE_REGISTERS.includes(jurisdiction),
)

/** Landing page of a blocked register, from the host table (the single source of bases). */
const BLOCKED_REGISTER_HOSTS = { NSW: "nswLegislation", SA: "saLegislation" } as const

function blockedRegisterUrl(jurisdiction: StateJurisdiction): string | undefined {
  const key = (BLOCKED_REGISTER_HOSTS as Partial<Record<StateJurisdiction, "nswLegislation" | "saLegislation">>)[
    jurisdiction
  ]
  return key ? getHostConfig(key).base : undefined
}

/**
 * Every register asked for is one this server refuses to fetch.
 *
 * `searchStateLaw` throws `UpstreamBlockedError` for NSW and SA *before* it
 * makes any request, and `Promise.allSettled` turns that into a rejection like
 * any other. Flattening it into `[EXTERNAL_API_ERROR] … Transport failures
 * only; retry` said three untrue things at once: that a transport failed, that
 * retrying could help, and — by dropping `error.links` — that there was
 * nowhere to look. `[UPSTREAM_BLOCKED]` is a different fact from
 * `[EXTERNAL_API_ERROR]` and from `[NOT_FOUND]`, and it always travels with
 * the deep links.
 */
function blockedRefusal(blocked: readonly UpstreamBlockedError[]): Error {
  const single = blocked.length === 1 ? blocked[0] : undefined
  // One register: hand back the register client's own error, so the label, the
  // reason and the links are exactly what `errors.ts` renders for a refusal.
  if (single) return single
  return new LawApiError(
    blocked.map((error) => error.message).join(" "),
    ErrorCodes.UPSTREAM_BLOCKED,
    [
      "⚠️ Do not report this as 'no such university legislation'. These registers were never queried, so this " +
        "response carries no evidence either way, and retrying will not change it.",
      ...blocked.flatMap((error) => error.links.map((link) => `Open directly: ${link}`)),
    ],
  )
}

export async function searchUniversityRules(
  client: AuApiClient,
  input: SearchUniversityRulesInput,
): Promise<LooseToolResponse> {
  try {
    const cacheKey = `university_rules:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const requested = input.jurisdiction?.toUpperCase() as StateJurisdiction | undefined
    const registers = requested
      ? [requested]
      : // WA and NT scan an A–Z index, so a "university" query lands on the U page
        // and finds the university acts directly; QLD and TAS full-text search.
        (["QLD", "TAS", "WA", "NT"] as StateJurisdiction[])

    const term = UNIVERSITY_TERMS.some((word) => input.query.toLowerCase().includes(word))
      ? input.query
      : `${input.query} university`

    const settled = await Promise.allSettled(
      registers.map((jurisdiction) =>
        searchStateLaw(client, jurisdiction, term, { limit: input.limit ?? 10, field: "Title" }),
      ),
    )

    const results: SourceSearchResult[] = []
    const notes: string[] = [
      "Australian universities are established by state acts; their by-laws and statutes are made " +
      "under those acts. There is no Commonwealth register of university rules.",
      "Some university rules are published only on the university's own website and appear in no " +
      "legislation register at all — absence here is not absence in law.",
    ]
    const blocked: UpstreamBlockedError[] = []
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value)
        return
      }
      if (outcome.reason instanceof UpstreamBlockedError) blocked.push(outcome.reason)
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      const label = outcome.reason instanceof UpstreamBlockedError ? `[${ErrorCodes.UPSTREAM_BLOCKED}] ` : ""
      notes.push(`${label}${registers[index]} register: ${reason}`)
      if (outcome.reason instanceof UpstreamBlockedError) {
        for (const link of outcome.reason.links) notes.push(`  Open directly: ${link}`)
      }
    })

    // The registers this server never asks — named even when the search
    // succeeded elsewhere, because the schema promises links for them and
    // because "not in these results" is not "not in Australian law".
    const unsearched = BLOCKED_STATE_REGISTERS.filter((jurisdiction) => !registers.includes(jurisdiction))
    if (unsearched.length > 0) {
      notes.push(
        `[${ErrorCodes.UPSTREAM_BLOCKED}] ${unsearched.join(" and ")} were not searched — those registers refuse ` +
          "automated clients. Their university acts exist and open in a browser: " +
          unsearched
            .map((jurisdiction) => `${jurisdiction} ${blockedRegisterUrl(jurisdiction) ?? "(no link recorded)"}`)
            .join(", "),
      )
    }

    if (results.length === 0) {
      // A refusal is not a transport failure. Only when every register that
      // failed failed for transport reasons is "retry" the right advice.
      if (blocked.length > 0 && blocked.length === registers.length) throw blockedRefusal(blocked)
      throw new LawApiError(
        "No state legislation register answered the university-rules search.",
        ErrorCodes.API_ERROR,
        [
          "⚠️ This is a lookup failure, not evidence that no such university legislation exists.",
          "⚠️ Transport failures; retry, or name a single jurisdiction to isolate the problem.",
          ...blocked.flatMap((error) => error.links.map((link) => `Open directly: ${link}`)),
        ],
      )
    }

    const merged: SourceSearchResult = {
      hits: interleave(results).slice(0, input.limit ?? 10),
      total: results.reduce((sum, result) => sum + (result.total ?? result.hits.length), 0),
      sourceUrl: results[0].sourceUrl,
    }
    const text = renderSearch(merged, {
      heading: `University legislation — ${registers.join(", ")}`,
      query: input.query,
      showSource: true,
      notes,
      followUp: 'get_state_law_text(jurisdiction="QLD", id="<id from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_decisions[university_rules]")
  }
}
