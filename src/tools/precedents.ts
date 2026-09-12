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
 *
 * Since v1.1 there is one more rung below that link: when the user has turned
 * the Aside browser fallback on, a blocked court is fetched through their own
 * local browser session (`../lib/sources/aside-browser.ts`) and returned marked
 * as browser-retrieved. The marking is not decoration — material that came out
 * of a page render in someone's logged-in browser is not the same evidence as
 * material a publisher's API handed over, and a caller has to be able to tell
 * the two apart. When the fallback is off, the answer is exactly what it was
 * before plus one line saying the fallback exists and how to switch it on.
 */

import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError, formatToolError } from "../lib/errors.js"
import { lookupCourt, parseCaseCitation } from "../lib/case-citation.js"
import { COURT_CODES, normaliseCourtToken, type Jurisdiction } from "../lib/court-codes.js"
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
import { absoluteUrl, blockTextOf, firstText, links as htmlLinks } from "../lib/sources/html.js"
import { interleave, renderDocument, renderSearch } from "../lib/sources/render.js"
import type { SourceDocument, SourceHit, SourceSearchResult } from "../lib/sources/types.js"
import { truncateResponse } from "../lib/schemas.js"
import { asideStatus, fetchViaAside } from "../lib/sources/aside-browser.js"
import { sourceDocumentResponse } from "./source-document.js"
import { followupEnvelope, makeGap } from "../lib/research-followup.js"

function enrichCaseGap(response: LooseToolResponse, input: { query?: string; citation?: string; id?: string; jurisdiction?: string }): LooseToolResponse {
  const existing = response.structuredContent?.followup
  if (!existing) return response
  const citation = input.citation ?? (input.query && /\[(?:1[89]|20)\d{2}\]\s*[A-Za-z]/.test(input.query) ? input.query : undefined)
  const links = citation ? blockedCourtLinks(citation) : input.query ? [austliiSearchUrl(input.query), lawCiteUrl(input.query)] : []
  response.structuredContent = { followup: followupEnvelope(existing.gaps.map((gap) => makeGap({
    ...gap,
    target: { ...(citation ? { citation } : {}), ...(input.id ? { documentId: input.id } : {}), ...(!citation && input.query ? { query: input.query } : {}) },
    ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
    sourceUrls: gap.sourceUrls.length ? gap.sourceUrls : links,
  })), { pending: true, ...(existing.notices ? { notices: existing.notices } : {}) }) }
  return response
}

/** Which of the three live sources a jurisdiction/court routes to. */
export type LiveSource = "nsw" | "hca" | "qld"

const JURISDICTION_SOURCES: Partial<Record<Jurisdiction, LiveSource[]>> = {
  NSW: ["nsw"],
  Cth: ["hca"],
  Qld: ["qld"],
}

/** Queensland Judgments also republishes HCA and Privy Council decisions. */
const QLD_TOKENS = new Set(["QSC", "QCA", "QDC", "QMC", "QCAT", "QCATA", "QPEC", "QLC", "ICQ", "QChCM", "QMHC"])

/**
 * The short forms people actually type, mapped onto the canonical MNC token.
 *
 * Callers do not write `FCAFC`; they write "Federal Court" or "the Full Court",
 * and a model relaying a user's question writes whatever the user wrote. Before
 * this table those strings matched no branch of `sourcesFor`, which then fanned
 * out to NSW+HCA+QLD — a Federal Court question answered with NSW rows and no
 * marker. Full court *names* are matched separately against `COURT_CODES`, so
 * only the colloquial forms need an entry here.
 */
const COURT_PROSE: Record<string, string> = {
  "federal court": "FCA", "federal court of australia": "FCA", "fed court": "FCA", "fedcourt": "FCA",
  "full court": "FCAFC", "full federal court": "FCAFC", "full court of the federal court": "FCAFC",
  "federal court full court": "FCAFC", "full court of the federal court of australia": "FCAFC",
  "high court": "HCA", "the high court": "HCA", "hc": "HCA",
  "family court": "FedCFamC1F", "federal circuit and family court": "FedCFamC1F",
  "federal circuit court": "FedCFamC2G",
  "nsw supreme court": "NSWSC", "supreme court of nsw": "NSWSC", "new south wales supreme court": "NSWSC",
  "nsw court of appeal": "NSWCA", "nsw court of criminal appeal": "NSWCCA",
  "queensland supreme court": "QSC", "supreme court of qld": "QSC",
  "queensland court of appeal": "QCA", "qld court of appeal": "QCA",
  "victorian supreme court": "VSC", "vic supreme court": "VSC", "supreme court of vic": "VSC",
  "victorian court of appeal": "VSCA", "vic court of appeal": "VSCA", "court of appeal of victoria": "VSCA",
  "county court": "VCC",
  "sa supreme court": "SASC", "south australian supreme court": "SASC", "supreme court of sa": "SASC",
  "sa court of appeal": "SASCA", "south australian court of appeal": "SASCA",
  "wa supreme court": "WASC", "western australian supreme court": "WASC", "supreme court of wa": "WASC",
  "wa court of appeal": "WASCA", "western australian court of appeal": "WASCA",
  "tasmanian supreme court": "TASSC", "tas supreme court": "TASSC", "supreme court of tas": "TASSC",
  "act supreme court": "ACTSC", "supreme court of the act": "ACTSC",
  "nt supreme court": "NTSC", "supreme court of the nt": "NTSC", "northern territory supreme court": "NTSC",
  "aat": "AATA", "art": "ARTA",
}

/** Full court names from the code table, lowercased — "Supreme Court of Victoria" → VSC. */
const COURT_BY_NAME = new Map<string, string>(
  COURT_CODES.map((entry) => [entry.name.toLowerCase(), entry.code]),
)

/**
 * Upper-cased index → the spelling each downstream lookup expects. Both source
 * tables carry mixed-case tokens (`QChCM`, `NSWIRComm`), so matching on an
 * upper-cased key and *returning the table's own spelling* is what keeps a
 * user's "qchcm" routed to Queensland with its court filter intact.
 */
const QLD_BY_UPPER = new Map<string, string>([...QLD_TOKENS].map((token) => [token.toUpperCase(), token]))
const NSW_BY_UPPER = new Map<string, string>(
  Object.keys(nsw.NSW_COURT_IDS).map((token) => [token.toUpperCase(), token]),
)

/**
 * What this server can do with a requested court. Three outcomes, never two:
 * a court it can serve, a court it refuses to fetch, and a token that is not a
 * court at all. Collapsing the last two would report a typo as a Cloudflare
 * block; collapsing either into "no court specified" is the defect this type
 * exists to make unrepresentable.
 */
export type CourtRoute =
  /** Reachable: which live sources carry it, plus the canonical token to filter on. */
  | { kind: "live"; court: string; sources: LiveSource[] }
  /** A real court this server does not fetch — `[UPSTREAM_BLOCKED]` + deep links. */
  | { kind: "blocked"; court: string; courtName: string }
  /** Not a court identifier this server knows. Unclear, never "does not exist". */
  | { kind: "unknown"; token: string }

/** `"Federal Court"`, `"fca"`, `"F.C.A."` → `FCA`; unknown strings stay unknown. */
function canonicalCourtToken(court: string): string | undefined {
  const raw = court.trim()
  if (!raw) return undefined
  const upper = normaliseCourtToken(raw)
  // The scraper tables first: they carry live tokens the AGLC code table does
  // not (NSWCHC, NSWDDT, QChCM), and a token this server can actually serve
  // must never be demoted to "unknown".
  const nswToken = NSW_BY_UPPER.get(upper)
  if (nswToken) return nswToken
  const qldToken = QLD_BY_UPPER.get(upper)
  if (qldToken) return qldToken
  const known = lookupCourt(raw)
  if (known) return known.code
  const prose = raw.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim()
  return COURT_PROSE[prose] ?? COURT_BY_NAME.get(prose)
}

export function resolveCourt(court: string): CourtRoute {
  const token = canonicalCourtToken(court)
  if (!token) return { kind: "unknown", token: court.trim() }
  const upper = token.toUpperCase()
  if (upper.startsWith("NSW")) return { kind: "live", court: token, sources: ["nsw"] }
  if (upper.startsWith("HCA")) return { kind: "live", court: token, sources: ["hca"] }
  if (QLD_BY_UPPER.has(upper)) return { kind: "live", court: token, sources: ["qld"] }
  return { kind: "blocked", court: token, courtName: lookupCourt(token)?.name ?? token }
}

export function sourcesFor(p: { jurisdiction?: string; court?: string }): LiveSource[] {
  if (p.court) {
    const route = resolveCourt(p.court)
    if (route.kind === "live") return route.sources
    // A court this server cannot serve has nothing to ask, so it returns no
    // sources — never the three-source fan-out, which used to answer a Federal
    // Court request with NSW/HCA/QLD rows and no marker at all. The caller
    // turns this into [UPSTREAM_BLOCKED] (blocked) or [INVALID_PARAMETER]
    // (unknown token); it must not turn it into an empty result set.
    return []
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

/**
 * `au/cases/cth/FCA` — the SINO `mask_path` that pins an AustLII search to one
 * court. Read back out of `austliiCaseUrl` rather than kept in a second
 * jurisdiction table here, so the search link and the judgment link cannot
 * drift apart.
 */
function austliiCourtMask(court: string): string | undefined {
  const url = austliiCaseUrl({ court, year: 2000, num: 1 })
  const match = url ? /\/(au\/cases\/[^/]+\/[^/]+)\//.exec(url) : null
  return match ? match[1] : undefined
}

/**
 * Deep links for a *keyword* search of a court this server does not fetch.
 * No citation means no single-judgment URL exists yet, so the links are the
 * court-restricted AustLII search and the citator — never an empty list.
 */
export function blockedCourtSearchLinks(court: string, query: string): string[] {
  const mask = austliiCourtMask(court)
  return [austliiSearchUrl(query, mask ? [mask] : []), lawCiteUrl(query)]
}

function blockedCourtError(
  citation: string,
  courtName: string,
  options: { links?: string[]; asideFailures?: string[] } = {},
): UpstreamBlockedError {
  const attempted = options.asideFailures?.length
    // Said in the reason, not in a suggestion: "the fallback was on and still
    // did not get the page" is part of what happened, and a caller that only
    // reads the first line has to see it.
    ? `; the Aside browser fallback is on and was tried, but the page did not come back (${options.asideFailures.join("; ")})`
    : ""
  return new UpstreamBlockedError(
    `${courtName} judgments`,
    "its publisher (AustLII / judgments.fedcourt.gov.au) blocks non-browser clients, so this server does not request them" + attempted,
    options.links ?? blockedCourtLinks(citation),
  )
}

// ── Aside browser fallback ────────────────────────────────────────────────

/**
 * The seam onto `../lib/sources/aside-browser.ts`.
 *
 * Declared here as a two-method interface, and injectable, for two reasons.
 * Tests must never spawn the real Aside CLI — it drives the user's actual
 * browser — and this file must be able to state exactly how much of Aside it
 * uses: one status read and one URL fetch. Nothing in this module hands
 * `fetchViaAside` a URL that came from a caller; every URL below is built by
 * `external-links-map.ts` out of a parsed citation or a canonical court token,
 * and the bridge enforces its own host allowlist underneath that.
 */
export interface AsideBridge {
  asideStatus(): { enabled: boolean; command?: string; reason?: string }
  fetchViaAside(url: string): Promise<string>
}

const realAsideBridge: AsideBridge = { asideStatus, fetchViaAside }
let asideBridge: AsideBridge | null = null

/** Inject a stub (tests) or `null` to restore the real bridge. */
export function setAsideBridge(bridge: AsideBridge | null): void {
  asideBridge = bridge
}

function bridge(): AsideBridge {
  return asideBridge ?? realAsideBridge
}

/** Never let a broken bridge break the case-law path: no status means off. */
function asideState(): { enabled: boolean; command?: string; reason?: string } {
  try {
    return bridge().asideStatus()
  } catch (error) {
    return { enabled: false, reason: `the browser fallback could not report its status (${message(error)})` }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one line that makes the fallback discoverable. A Claude Desktop Chat user
 * never sees this repo, the project `.mcp.json` or the follow-up skill — the
 * bundled extension is the whole surface — so if the answer does not say the
 * fallback exists, for that user it does not exist.
 */
const ASIDE_OFF_HINT =
  "Browser fallback (off): this server can retrieve a blocked court through the user's own logged-in browser via " +
  "Aside, which reaches pages this server is refused. Turn on \"Finish blocked legal sources using the Aside " +
  "browser\" in Claude Desktop → Settings → Extensions → Australian Law, then re-run this call."

function asideOffLine(status: { reason?: string }): string {
  return status.reason ? `${ASIDE_OFF_HINT} (Currently off: ${status.reason})` : ASIDE_OFF_HINT
}

/** Append the discoverability line to a blocked answer when the fallback is off. */
function withAsideHint(response: LooseToolResponse, error: unknown): LooseToolResponse {
  if (!(error instanceof UpstreamBlockedError)) return response
  const status = asideState()
  if (status.enabled) return response
  const first = response.content[0]
  if (!first) return response
  return {
    ...response,
    content: [{ ...first, text: `${first.text}\n${asideOffLine(status)}` }, ...response.content.slice(1)],
  }
}

/** How this file labels anything that came out of the user's browser. */
const VIA_ASIDE_LABEL = "Aside — the user's own local browser session, not the publisher's API"

const ASIDE_PROVENANCE_NOTE =
  "⚠️ Provenance: this text was read out of a page rendered in the user's local browser through Aside. It did not " +
  "come from the publisher's API and this server did not verify it against the publisher's record — page furniture " +
  "may be mixed into the body. Cite the paragraph numbers shown on the page, and say in the answer that the " +
  "material was retrieved through the user's browser."

/** Below this, the body is an interstitial or a shell, not a judgment. */
const MIN_ASIDE_BODY_CHARS = 400

/** At most two pages per blocked answer: this drives a real browser window. */
const MAX_ASIDE_ATTEMPTS = 2

type AsideFetch = { url: string; html: string } | { failures: string[] }

async function fetchFirstViaAside(urls: string[]): Promise<AsideFetch> {
  const failures: string[] = []
  for (const url of urls.slice(0, MAX_ASIDE_ATTEMPTS)) {
    try {
      const html = await bridge().fetchViaAside(url)
      if (!html || html.trim().length === 0) {
        failures.push(`${url} → the browser returned an empty page`)
        continue
      }
      return { url, html }
    } catch (error) {
      failures.push(`${url} → ${message(error)}`)
    }
  }
  return { failures }
}

/** The judgment pages for a citation, citator and search links dropped. */
function judgmentUrls(citation: string): string[] {
  return blockedCourtLinks(citation).filter((url) => !url.includes("sinosrch.cgi") && !url.includes("LawCite"))
}

function pageTitle(html: string): string | undefined {
  return (
    firstText(html, /<h1\b[^>]{0,300}>([\s\S]{0,600}?)<\/h1\s*>/i) ??
    firstText(html, /<title\b[^>]{0,300}>([\s\S]{0,600}?)<\/title\s*>/i)
  )
}

/**
 * A blocked judgment, fetched through the user's browser.
 * `undefined` means the fallback is off — the caller keeps today's behaviour.
 */
async function judgmentViaAside(p: {
  citation: string
  courtName: string
  full: boolean
}): Promise<{ response: LooseToolResponse } | { failures: string[] } | undefined> {
  if (!asideState().enabled) return undefined
  const urls = judgmentUrls(p.citation)
  if (urls.length === 0) return { failures: ["no judgment URL could be built for this citation"] }
  const fetched = await fetchFirstViaAside(urls)
  if ("failures" in fetched) return fetched
  const text = blockTextOf(fetched.html)
  if (text.length < MIN_ASIDE_BODY_CHARS) {
    // A short body here is the anti-bot interstitial, not a short judgment.
    // Reporting it as the decision would be worse than reporting the block.
    return { failures: [`${fetched.url} → the page carried ${text.length} characters of text, too little to be the reasons`] }
  }
  const doc: SourceDocument = {
    title: pageTitle(fetched.html) ?? p.citation,
    citation: p.citation,
    url: fetched.url,
    metadata: [
      ["Court", p.courtName],
      ["Retrieved via", VIA_ASIDE_LABEL],
    ],
    text,
    note: ASIDE_PROVENANCE_NOTE,
    bodyStatus: "full_text",
  }
  return {
    response: sourceDocumentResponse(doc, {
      bodyHeading: "Reasons",
      full: p.full,
      originTool: "get_case_text",
      documentId: p.citation,
    }),
  }
}

/**
 * A blocked court's *search* page, fetched through the user's browser.
 *
 * This returns the publisher's own result list as the browser rendered it, not
 * parsed records: the rows are links, and they are labelled as links rather
 * than dressed up as `id:` values that `get_case_text` would then reject.
 */
async function searchViaAside(p: {
  url: string
  label: string
  query: string
  limit: number
}): Promise<{ response: LooseToolResponse } | { failures: string[] } | undefined> {
  if (!asideState().enabled) return undefined
  const fetched = await fetchFirstViaAside([p.url])
  if ("failures" in fetched) return fetched
  const origin = originOf(fetched.url)
  const seen = new Set<string>()
  const hits: string[] = []
  for (const link of htmlLinks(fetched.html)) {
    if (!/\/au\/cases\//.test(link.href)) continue
    const url = absoluteUrl(origin, link.href)
    if (seen.has(url)) continue
    seen.add(url)
    hits.push(`${hits.length + 1}. ${link.text || url}\n   ${url}`)
    if (hits.length >= p.limit) break
  }
  const lines = [
    `=== ${p.label} — retrieved through the user's browser ===`,
    `Query: ${p.query}`,
    `Retrieved via: ${VIA_ASIDE_LABEL}`,
    `Search page: ${fetched.url}`,
    "",
    ASIDE_PROVENANCE_NOTE,
    "",
  ]
  if (hits.length > 0) {
    lines.push(...hits)
    lines.push("")
    lines.push(
      "These are page links, not `id:` values — `get_case_text(citation=\"…\")` fetches one of them through the " +
      "same browser fallback.",
    )
  } else {
    // No parseable rows is not "no cases": say so, and hand over what the page
    // did say so the caller can judge it.
    lines.push(
      "No case links could be read off this page. That is a statement about the page this server could parse, " +
      "not about whether decisions exist. The page text follows so it can be judged directly:",
      "",
      blockTextOf(fetched.html).slice(0, 2000),
    )
  }
  return { response: { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] } }
}

function originOf(url: string): string {
  const match = /^(https?:\/\/[^/]+)/i.exec(url)
  return match ? match[1] : url
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
    "Medium-neutral court token (HCA, NSWSC, NSWCA, QSC, QCA, NSWCATAP) or the court's name " +
    "('Federal Court', 'Supreme Court of Victoria'). A court this server cannot fetch — the Federal Court " +
    "and the Vic/SA/WA/Tas/ACT/NT courts — returns [UPSTREAM_BLOCKED] with deep links, never another court's " +
    "results. A string that is not a court at all is rejected as [INVALID_PARAMETER] rather than ignored.",
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
      const token = input.court ? QLD_BY_UPPER.get(normaliseCourtToken(input.court)) : undefined
      if (token) params.courts = [token]
      return qld.search(client, params)
    }
  }
}

/** Exact-citation routing: the three live sources each have their own lookup. */
async function lookupCitation(
  client: AuApiClient,
  citation: string,
): Promise<{ result?: SourceSearchResult; blocked?: { court: string; courtName: string } }> {
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
  return { blocked: { court, courtName: info?.name ?? court } }
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
      if (blocked) {
        // An exact citation in a blocked court is the one case where the
        // fallback can return the decision itself rather than a link.
        const viaAside = await judgmentViaAside({ citation: input.query, courtName: blocked.courtName, full: false })
        if (viaAside && "response" in viaAside) return viaAside.response
        throw blockedCourtError(input.query, blocked.courtName, {
          ...(viaAside ? { asideFailures: viaAside.failures } : {}),
        })
      }
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

    const route = input.court ? resolveCourt(input.court) : undefined
    if (route?.kind === "unknown") {
      // Not a court, so not a block either. Saying "blocked" here would invent
      // a Cloudflare gate in front of a typo.
      throw new LawApiError(
        `${JSON.stringify(route.token)} is not a court identifier this server recognises, so it was not used to route the search.`,
        ErrorCodes.INVALID_PARAM,
        [
          "⚠️ This says the token is unclear to this server, not that the court or the case does not exist.",
          "Use a medium-neutral court token (HCA, NSWCA, QSC, FCA, VSCA) or the court's full name ('Federal Court of Australia').",
          "Or re-run without `court` to search the three reachable sources on keywords alone.",
        ],
      )
    }
    if (route?.kind === "blocked") {
      const links = blockedCourtSearchLinks(route.court, input.query)
      const viaAside = await searchViaAside({
        url: links[0],
        label: `Case law — ${route.courtName}`,
        query: input.query,
        limit,
      })
      if (viaAside && "response" in viaAside) return viaAside.response
      throw blockedCourtError(input.query, route.courtName, {
        links,
        ...(viaAside ? { asideFailures: viaAside.failures } : {}),
      })
    }

    const sources = route
      ? route.sources
      : sourcesFor(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {})
    if (sources.length === 0) {
      const jurisdiction = input.jurisdiction ?? ""
      const links = [austliiSearchUrl(input.query), lawCiteUrl(input.query)]
      const viaAside = await searchViaAside({
        url: links[0],
        label: `Case law — ${jurisdiction} courts`,
        query: input.query,
        limit,
      })
      if (viaAside && "response" in viaAside) return viaAside.response
      throw new UpstreamBlockedError(
        `${jurisdiction} courts`,
        "their judgments are published through AustLII or a Cloudflare-gated court site, neither of which this server requests" +
        (viaAside?.failures.length
          ? `; the Aside browser fallback is on and was tried, but the page did not come back (${viaAside.failures.join("; ")})`
          : ""),
        links,
      )
    }

    // The canonical token, not the caller's spelling: "queensland court of
    // appeal" has to reach the QLD court filter as `QCA`.
    const routed: SearchCasesInput = route ? { ...input, court: route.court } : input
    const settled = await Promise.allSettled(
      sources.map((source) => searchOneSource(client, source, routed)),
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
    return withAsideHint(enrichCaseGap(formatToolError(error, "search_cases"), input), error)
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
    const courtName = info?.name ?? court
    const viaAside = await judgmentViaAside({ citation: input.citation, courtName, full })
    if (viaAside && "response" in viaAside) return viaAside.response
    throw blockedCourtError(input.citation, courtName, {
      ...(viaAside ? { asideFailures: viaAside.failures } : {}),
    })
  } catch (error) {
    return withAsideHint(enrichCaseGap(formatToolError(error, "get_case_text"), input), error)
  }
}

function document(source: Parameters<typeof renderDocument>[0], full: boolean): LooseToolResponse {
  return sourceDocumentResponse(source, { bodyHeading: "Reasons", full, originTool: "get_case_text", documentId: source.citation ?? source.url })
}
