/**
 * `search_cases` and `get_case_text` — the `cases` decision domain.
 *
 * Australia has no single case-law source a server can query, so this fans out
 * across the three that answer HTTP: NSW Caselaw, the High Court, and
 * Queensland Judgments (docs/research/case-law-access.md). Everything else —
 * the Federal Court, Victoria, SA, WA, Tasmania, the ACT and the NT — publishes
 * through AustLII or its own Cloudflare-gated site, both of which this server
 * refuses to fetch.
 *
 * That refusal is the design problem this file exists to solve. `[2019] FCA 12`
 * must never come back as "not found": it exists, this server just did not look.
 * Every unreachable court therefore returns `[UPSTREAM_BLOCKED]` with a deep
 * link the user can open, and the three live sources are labelled per hit so a
 * caller can tell "no NSW hits" from "NSW was never asked".
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError, formatToolError } from "../lib/errors.js"
import { lookupCourt, parseCaseCitation } from "../lib/case-citation.js"
import type { Jurisdiction } from "../lib/court-codes.js"
import {
  austliiCaseUrl,
  austliiSearchUrl,
  fedCourtJudgmentUrl,
  lawCiteUrl,
} from "../lib/external-links-map.js"
import { lawCache, SEARCH_CACHE_TTL } from "../lib/cache.js"
import type { LooseToolResponse } from "../lib/types.js"
import * as nsw from "../lib/sources/nsw-caselaw.js"
import * as hca from "../lib/sources/hcourt.js"
import * as qld from "../lib/sources/qld-judgments.js"
import { interleave, renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceHit, SourceSearchResult } from "../lib/sources/types.js"

/** Which of the three live sources a jurisdiction/court routes to. */
export type LiveSource = "nsw" | "hca" | "qld"

const JURISDICTION_SOURCES: Partial<Record<Jurisdiction, LiveSource[]>> = {
  NSW: ["nsw"],
  Cth: ["hca"],
  Qld: ["qld"],
}

/** Queensland Judgments also republishes HCA and Privy Council decisions. */
const QLD_TOKENS = new Set(["QSC", "QCA", "QDC", "QMC", "QCAT", "QCATA", "QPEC", "QLC", "ICQ", "QChCM", "QMHC"])

export function sourcesFor(p: { jurisdiction?: string; court?: string }): LiveSource[] {
  if (p.court) {
    const token = p.court.toUpperCase()
    if (token.startsWith("NSW")) return ["nsw"]
    if (token.startsWith("HCA")) return ["hca"]
    if (QLD_TOKENS.has(p.court) || QLD_TOKENS.has(token)) return ["qld"]
  }
  if (p.jurisdiction) {
    const key = normaliseJurisdiction(p.jurisdiction)
    if (key && JURISDICTION_SOURCES[key]) return JURISDICTION_SOURCES[key]!
    // A jurisdiction this server cannot reach still routes somewhere honest:
    // the fan-out runs and the blocked note is added by the caller.
    if (key) return []
  }
  return ["nsw", "hca", "qld"]
}

function normaliseJurisdiction(value: string): Jurisdiction | undefined {
  const table: Record<string, Jurisdiction> = {
    cth: "Cth", commonwealth: "Cth", federal: "Cth", australia: "Cth",
    nsw: "NSW", "new south wales": "NSW",
    vic: "Vic", victoria: "Vic",
    qld: "Qld", queensland: "Qld",
    sa: "SA", "south australia": "SA",
    wa: "WA", "western australia": "WA",
    tas: "Tas", tasmania: "Tas",
    act: "ACT", nt: "NT",
  }
  return table[value.trim().toLowerCase()]
}

/** Deep links for a court this server does not fetch. Never an empty list. */
export function blockedCourtLinks(citation: string): string[] {
  const parsed = parseCaseCitation(citation)
  const links: string[] = []
  if (parsed.ok && parsed.citation.kind === "mnc") {
    const { court, year, number } = parsed.citation
    if (court === "FCA" || court === "FCAFC") {
      links.push(fedCourtJudgmentUrl(year, number, court === "FCAFC" ? "fcafc" : "fca"))
    }
    const austlii = austliiCaseUrl({ court, year, num: number })
    if (austlii) links.push(austlii)
  }
  links.push(lawCiteUrl(citation))
  links.push(austliiSearchUrl(citation))
  return links
}

function blockedCourtError(citation: string, courtName: string): UpstreamBlockedError {
  return new UpstreamBlockedError(
    `${courtName} judgments`,
    "its publisher (AustLII / judgments.fedcourt.gov.au) blocks non-browser clients, so this server does not request them",
    blockedCourtLinks(citation),
  )
}

// ── search_cases ──────────────────────────────────────────────────────────

export const SearchCasesSchema = z.object({
  query: z.string().min(1).describe(
    "Keywords, party names, or a medium-neutral citation such as '[2010] NSWCCA 333'. " +
    "A citation is routed to an exact lookup first.",
  ),
  jurisdiction: z.string().optional().describe(
    "Cth | NSW | Qld | Vic | SA | WA | Tas | ACT | NT. Cth reaches the High Court only " +
    "(the Federal Court is blocked); Vic/SA/WA/Tas/ACT/NT return deep links, not text.",
  ),
  court: z.string().optional().describe(
    "Medium-neutral court token, e.g. HCA, NSWSC, NSWCA, QSC, QCA, NSWCATAP.",
  ),
  limit: z.number().min(1).max(50).default(10).optional().describe("Maximum hits to return (default 10)."),
  page: z.number().min(1).default(1).optional().describe("1-based page number (default 1)."),
})

export type SearchCasesInput = z.infer<typeof SearchCasesSchema>

async function searchOneSource(
  client: AuApiClient,
  source: LiveSource,
  input: SearchCasesInput,
): Promise<SourceSearchResult> {
  const page = (input.page ?? 1) - 1
  switch (source) {
    case "nsw": {
      const courts = input.court && nsw.NSW_COURT_IDS[input.court]
        ? [nsw.NSW_COURT_IDS[input.court]]
        : undefined
      if (courts) return nsw.advancedSearch(client, { body: input.query, courts, page })
      return nsw.search(client, { query: input.query, page })
    }
    case "hca":
      return hca.search(client, { keywords: input.query, page })
    case "qld": {
      const params: qld.QldSearchParams = { text: input.query, page: (input.page ?? 1), perPage: 20 }
      if (input.court && QLD_TOKENS.has(input.court.toUpperCase())) params.courts = [input.court.toUpperCase()]
      return qld.search(client, params)
    }
  }
}

/** Exact-citation routing: the three live sources each have their own lookup. */
async function lookupCitation(
  client: AuApiClient,
  citation: string,
): Promise<{ result?: SourceSearchResult; blocked?: UpstreamBlockedError }> {
  const parsed = parseCaseCitation(citation)
  if (!parsed.ok || parsed.citation.kind !== "mnc") return {}
  const { court } = parsed.citation

  if (nsw.NSW_COURT_IDS[court]) {
    return { result: await nsw.lookupByCitation(client, citation) }
  }
  if (court.startsWith("HCA")) {
    const hit = await hca.findByCitation(client, citation)
    return {
      result: {
        hits: hit ? [hit] : [],
        sourceUrl: `https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current?f[0]=d:${parsed.citation.year}`,
        total: hit ? 1 : 0,
      },
    }
  }
  if (QLD_TOKENS.has(court)) {
    return { result: await qld.search(client, { citation, perPage: 10 }) }
  }
  const info = lookupCourt(court)
  return { blocked: blockedCourtError(citation, info?.name ?? court) }
}

export async function searchCases(
  client: AuApiClient,
  input: SearchCasesInput,
): Promise<LooseToolResponse> {
  try {
    const limit = input.limit ?? 10
    const cacheKey = `search_cases:${JSON.stringify(input)}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) return { content: [{ type: "text", text: cached }] }

    const notes: string[] = []
    const citationShaped = /\[(?:1[89]|20)\d{2}\]\s*[A-Za-z]/.test(input.query)

    if (citationShaped) {
      const { result, blocked } = await lookupCitation(client, input.query)
      if (blocked) return formatToolError(blocked, "search_cases")
      if (result && result.hits.length > 0) {
        const text = renderSearch(
          // Prefixed here too: `renderSearch` prints `id:` as the identifier the
          // get_ call takes, and a bare NSW hex / HCA slug / QLD number is
          // rejected by get_case_text and get_decision_text alike.
          { ...result, hits: result.hits.slice(0, limit).map(withPrefixedId) },
          {
            heading: "Case law — exact citation lookup",
            query: input.query,
            showSource: true,
            followUp: `get_case_text(citation="${input.query}") or get_case_text(id="<id from above>")`,
          },
        )
        lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
        return { content: [{ type: "text", text }] }
      }
      notes.push(
        "The exact-citation lookup returned nothing, so the query was run as keywords instead. " +
        "A citation that does not resolve here may still be a real case in a source this server cannot fetch.",
      )
    }

    const sources = sourcesFor({
      ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      ...(input.court ? { court: input.court } : {}),
    })
    if (sources.length === 0) {
      const jurisdiction = input.jurisdiction ?? ""
      throw new UpstreamBlockedError(
        `${jurisdiction} courts`,
        "their judgments are published through AustLII or a Cloudflare-gated court site, neither of which this server requests",
        [austliiSearchUrl(input.query), lawCiteUrl(input.query)],
      )
    }

    const settled = await Promise.allSettled(
      sources.map((source) => searchOneSource(client, source, input)),
    )
    const results: SourceSearchResult[] = []
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value)
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        notes.push(`${sources[index]} did not answer (${reason}) — its records were not searched, not ruled out.`)
      }
    })

    if (results.length === 0) {
      throw new LawApiError(
        "None of the reachable case-law sources answered this request.",
        ErrorCodes.API_ERROR,
        [
          "⚠️ Every source failed at the transport level; this says nothing about whether the case exists.",
          "Retry shortly, then try a single jurisdiction to isolate the failing source.",
        ],
      )
    }

    if (sources.includes("hca") && !input.court) {
      notes.push(
        "Federal Court judgments are not included: judgments.fedcourt.gov.au is Cloudflare-gated. " +
        `Search them in a browser at ${austliiSearchUrl(input.query, ["au/cases/cth/FCA"])}`,
      )
    }

    const merged = interleave(results).slice(0, limit)
    const combined: SourceSearchResult = {
      hits: merged.map(withPrefixedId),
      sourceUrl: results[0].sourceUrl,
      total: results.reduce((sum, result) => sum + (result.total ?? result.hits.length), 0),
      totalIsUnreliable: results.some((result) => result.totalIsUnreliable),
      ...(input.page !== undefined ? { page: input.page } : {}),
    }
    if (combined.totalIsUnreliable) {
      combined.totalNote = results
        .map((result) => result.totalNote)
        .filter(Boolean)
        .join(" ")
    }

    const text = renderSearch(combined, {
      heading: `Case law — ${sources.map(sourceName).join(" + ")}`,
      query: input.query,
      showSource: true,
      notes,
      followUp: 'get_case_text(citation="[2010] NSWCCA 333") or get_case_text(id="nsw:<id from above>")',
    })
    lawCache.set(cacheKey, text, SEARCH_CACHE_TTL)
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return formatToolError(error, "search_cases")
  }
}

function sourceName(source: LiveSource): string {
  return source === "nsw" ? "NSW Caselaw" : source === "hca" ? "High Court" : "Queensland Judgments"
}

/** Prefix a hit's id so `get_case_text` can route it without guessing. */
function withPrefixedId(hit: SourceHit): SourceHit {
  const prefix =
    hit.source === "NSW Caselaw" ? "nsw" : hit.source === "High Court of Australia" ? "hca" : "qld"
  return hit.id.includes(":") ? hit : { ...hit, id: `${prefix}:${hit.id}` }
}

// ── get_case_text ─────────────────────────────────────────────────────────

export const GetCaseTextSchema = z.object({
  citation: z.string().optional().describe(
    "Medium-neutral citation, e.g. '[2020] QSC 100', '[2010] NSWCCA 333', '[2020] HCA 41'.",
  ),
  id: z.string().optional().describe(
    "Source id from search_cases, prefixed: 'nsw:<24-hex>', 'hca:<slug>', 'qld:<numeric>'.",
  ),
  full: z.boolean().optional().describe(
    "true = return the reasons verbatim. Omitted = long bodies are shortened from the middle with the gap marked.",
  ),
})

export type GetCaseTextInput = z.infer<typeof GetCaseTextSchema>

export async function getCaseText(
  client: AuApiClient,
  input: GetCaseTextInput,
): Promise<LooseToolResponse> {
  try {
    const full = input.full === true
    if (input.id) {
      const [prefix, ...rest] = input.id.split(":")
      const id = rest.join(":") || prefix
      switch (prefix) {
        case "nsw":
          return document(await nsw.getDecision(client, id), full)
        case "hca":
          return document(await hca.getDetail(client, id), full)
        case "qld":
          return document(
            /^\d+$/.test(id) ? await qld.getById(client, id) : await qld.getByCitation(client, id),
            full,
          )
        default:
          throw new LawApiError(
            `Unrecognised source id prefix: ${JSON.stringify(prefix)}`,
            ErrorCodes.INVALID_PARAM,
            ["Ids from search_cases look like 'nsw:549fff1d…', 'hca:potter-pseudonym-v-king' or 'qld:505964'."],
          )
      }
    }

    if (!input.citation) {
      throw new LawApiError(
        "get_case_text needs either `citation` or `id`.",
        ErrorCodes.INVALID_PARAM,
        ["Run search_cases first and pass back the `id` it printed, or give a medium-neutral citation."],
      )
    }

    const parsed = parseCaseCitation(input.citation)
    if (!parsed.ok || parsed.citation.kind !== "mnc") {
      throw new LawApiError(
        `${input.citation} is not a medium-neutral citation this server can address (${parsed.ok ? "reported citation" : parsed.reason}).`,
        ErrorCodes.INVALID_PARAM,
        [
          "Medium-neutral form is '[year] COURT number', e.g. '[2020] HCA 41'.",
          `A reported citation can be resolved in a browser: ${lawCiteUrl(input.citation)}`,
        ],
      )
    }

    const court = parsed.citation.court
    if (QLD_TOKENS.has(court)) return document(await qld.getByCitation(client, input.citation), full)

    if (nsw.NSW_COURT_IDS[court]) {
      const found = await nsw.lookupByCitation(client, input.citation)
      const hit = found.hits[0]
      if (!hit) {
        throw new LawApiError(
          `NSW Caselaw's exact-citation search returned no row for ${input.citation}.`,
          ErrorCodes.UPSTREAM_NO_DATA,
          [
            "⚠️ This is one register's answer, not a finding that the case does not exist.",
            `Check it in a browser: ${lawCiteUrl(input.citation)}`,
          ],
        )
      }
      return document(await nsw.getDecision(client, hit.id), full)
    }

    if (court.startsWith("HCA")) {
      const hit = await hca.findByCitation(client, input.citation)
      if (!hit) {
        throw new LawApiError(
          `${input.citation} was not on the High Court year listing pages this server read.`,
          ErrorCodes.UPSTREAM_NO_DATA,
          [
            "⚠️ Only the first few facet pages were walked; absence there is not absence from the Court's record.",
            `Check the year listing in a browser: https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current?f[0]=d:${parsed.citation.year}`,
          ],
        )
      }
      return document(await hca.getDetail(client, hit.id), full)
    }

    const info = lookupCourt(court)
    throw blockedCourtError(input.citation, info?.name ?? court)
  } catch (error) {
    return formatToolError(error, "get_case_text")
  }
}

function document(source: Parameters<typeof renderDocument>[0], full: boolean): LooseToolResponse {
  return { content: [{ type: "text", text: renderDocument(source, { bodyHeading: "Reasons", full }) }] }
}
