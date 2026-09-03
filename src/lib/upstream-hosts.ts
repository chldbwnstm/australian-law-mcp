/**
 * Every upstream this server knows about — the single source of base URLs,
 * timeouts and politeness intervals (docs/ARCHITECTURE.md "Upstream hosts").
 *
 * Two things live here that could plausibly live elsewhere, deliberately:
 *
 *  - **Blocked hosts are rows in the same table, not a separate list.** They
 *    are real sources with real URL grammars; the only difference is that this
 *    server refuses to fetch them. Keeping them here means `external-links-map`
 *    and the client read one table, and a host can never be blocked in one file
 *    while still being fetched from another.
 *  - **Per-host timeouts and intervals.** Queensland content search takes ~90s
 *    and the ATO form ~60s; a single global timeout either cuts those off or
 *    makes a dead host hang every other tool for a minute and a half.
 */

/** Wire shape a host speaks. Governs `allowHtmlBody` and the default `Accept`. */
export type HostKind =
  /** OData 4.0 JSON (only the Federal Register API). */
  | "odata"
  /** Plain JSON, including endpoints reached by POST. */
  | "json"
  /** HTML pages, scraped. A 200 carrying HTML is *normal* here. */
  | "html"
  /** Document bytes: epub members, PDFs, Word files. */
  | "documents"

export type HostKey =
  // ── fetched ────────────────────────────────────────────────────────────
  | "frlApi"
  | "frlDocs"
  | "nswCaselaw"
  | "hcourt"
  | "qldJudgments"
  | "qldLegislation"
  | "tasLegislation"
  | "waLegislation"
  | "vicLegislation"
  | "ntLegislation"
  | "actLegislation"
  | "ato"
  | "fwc"
  | "oaic"
  | "dfat"
  | "glossary"
  | "mpc"
  | "nacc"
  | "adrp"
  | "aph"
  | "parlinfo"
  // ── blocked (never fetched server-side) ────────────────────────────────
  | "austlii"
  | "lawcite"
  | "fedcourt"
  | "nswLegislation"
  | "saLegislation"
  | "accc"
  | "competitionTribunal"
  | "ombudsman"

export interface HostConfig {
  key: HostKey
  /** Base URL with no trailing slash. Paths are joined with a single `/`. */
  base: string
  kind: HostKind
  timeoutMs: number
  /**
   * Minimum wall-clock gap between two requests to this host, enforced by the
   * client. Scraped sites get >=1s (their robots files ask for a crawl delay);
   * the keyless FRL API observed no rate limit but is still spaced out.
   */
  minIntervalMs: number
  /** True when this server must refuse to fetch the host. */
  blocked?: true
  /** Why it is refused — quoted verbatim in the `[UPSTREAM_BLOCKED]` message. */
  blockedReason?: string
  /** Extra headers merged over the shared defaults. */
  headers?: Record<string, string>
  /** One-line operational note; the source is `docs/research/*`. */
  notes: string
}

/**
 * Several of these sites classify Node's default undici UA as a bot. Read at
 * call time rather than module load so a test (or an operator restarting the
 * process manager with a new value) sees the change.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

export function resolveUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAW_USER_AGENT || DEFAULT_USER_AGENT
}

/** Politeness floor for anything scraped rather than served from an API. */
const SCRAPE_INTERVAL_MS = 1_000

export const UPSTREAM_HOSTS: Readonly<Record<HostKey, HostConfig>> = {
  frlApi: {
    key: "frlApi",
    base: "https://api.prod.legislation.gov.au/v1",
    kind: "odata",
    timeoutMs: 30_000,
    minIntervalMs: 250,
    notes: "Keyless OData 4.0. $top<=100; @odata.nextLink drops $filter, so paginate manually.",
  },
  frlDocs: {
    key: "frlDocs",
    base: "https://www.legislation.gov.au",
    kind: "documents",
    timeoutMs: 60_000,
    minIntervalMs: 500,
    notes: "{id}/{asat}/{viewedat}/{type}/{rect}/{format}[/vol]; epub members served individually (NCX + per-volume HTML).",
  },
  nswCaselaw: {
    key: "nswCaselaw",
    base: "https://www.caselaw.nsw.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Advanced search param is `query`, not `q`; page is 0-indexed; robots excludes decisions — fetch on demand only and cache hard.",
  },
  hcourt: {
    key: "hcourt",
    base: "https://www.hcourt.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Drupal. The facet `f[0]=d:YYYY` must reach the server unencoded.",
  },
  qldJudgments: {
    key: "qldJudgments",
    base: "https://www.queenslandjudgments.com.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Citation-addressable /caselaw/{code}/{yr}/{n}; responses run ~2s.",
  },
  qldLegislation: {
    key: "qldLegislation",
    base: "https://www.legislation.qld.gov.au",
    kind: "json",
    timeoutMs: 90_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "projectdata JSON. Content searches take up to 90s — the long timeout is the endpoint's, not a guess.",
  },
  tasLegislation: {
    key: "tasLegislation",
    base: "https://www.legislation.tas.gov.au",
    kind: "json",
    timeoutMs: 90_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "projectdata JSON with the `EnAct-` datasource prefix.",
  },
  waLegislation: {
    key: "waLegislation",
    base: "https://www.legislation.wa.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Lotus Domino. A–Z index pages plus mrdoc full text.",
  },
  vicLegislation: {
    key: "vicLegislation",
    base: "https://www.legislation.vic.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "HTML + sitemap; full text is only reachable as authorised PDF/DOCX links.",
  },
  ntLegislation: {
    key: "ntLegislation",
    base: "https://legislation.nt.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "By-Title list is the search surface; text arrives as PDF/Word.",
  },
  actLegislation: {
    key: "actLegislation",
    base: "https://www.legislation.act.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Deep URLs only (/a/YYYY-N/, DownloadFile PDFs) — the homepage sits behind an F5 challenge.",
  },
  ato: {
    key: "ato",
    base: "https://www.ato.gov.au",
    kind: "html",
    timeoutMs: 60_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "POST /API/v1/law/lawservices/result with a form body; slow (~60s worst case).",
  },
  fwc: {
    key: "fwc",
    base: "https://www.fwc.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "document-search HTML. The facet-total element disagrees with the result list — count the rows.",
  },
  oaic: {
    key: "oaic",
    base: "https://www.oaic.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Privacy determinations index only; individual determinations are PDFs.",
  },
  dfat: {
    key: "dfat",
    base: "https://docs.dfat.gov.au",
    kind: "json",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "POST /api/search returns JSON; the SPA shell answers 404 for unknown routes even when the API is healthy.",
  },
  glossary: {
    key: "glossary",
    base: "https://legalanswers.sl.nsw.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "State Library of NSW legal glossary.",
  },
  mpc: {
    key: "mpc",
    base: "https://www.mpc.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Case-studies index /resources/case-studies-merits-review-outcomes with f[0]= facets; no JSON search.",
  },
  nacc: {
    key: "nacc",
    base: "https://www.nacc.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Single-page /investigation-reports-and-case-studies index; per-operation anchors + report PDFs.",
  },
  adrp: {
    key: "adrp",
    base: "https://www.industry.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Anti-Dumping Review Panel indexes under /trade/anti-dumping-review-panel; guessed short paths 404.",
  },
  aph: {
    key: "aph",
    base: "https://www.aph.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    notes: "Act EM index via bId= bill pages; ParlInfo EM HTML is open, ParlInfo PDFs need an APH Referer.",
  },
  parlinfo: {
    key: "parlinfo",
    base: "https://parlinfo.aph.gov.au",
    kind: "html",
    timeoutMs: 45_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    // Separate row from `aph` on purpose: it is a different origin with its own
    // politeness clock, and the PDF path needs an APH Referer that the www host
    // does not. One row for both would silently share the interval budget of a
    // site that is scraped far more often (docs/research/grok-followup.md §1.2).
    headers: { referer: "https://www.aph.gov.au/" },
    notes: "ParlInfo document store — explanatory-memorandum HTML is open; the PDF variants need the APH Referer sent here.",
  },

  // ── Blocked ─────────────────────────────────────────────────────────────
  // These stay in the table so link builders and the refusal path read the
  // same row. `blocked` is what stops the client; nothing else has to know.
  austlii: {
    key: "austlii",
    base: "https://www.austlii.edu.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "Cloudflare-gated and AustLII asks automated clients to contact them first",
    notes: "Deep links only: /cgi-bin/viewdoc/au/cases/{jur}/{COURT}/{year}/{n}.html; section pages need the generated slug.",
  },
  lawcite: {
    key: "lawcite",
    base: "https://lawcite.austlii.edu.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "part of AustLII; the markup tool's terms require contacting AustLII before automating",
    notes: "Deep link only: /cgi-bin/LawCite?cit=<citation>.",
  },
  fedcourt: {
    key: "fedcourt",
    base: "https://www.judgments.fedcourt.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "Cloudflare challenge on every request",
    notes: "Deep link only: /judgments/Judgments/fca/single/{year}/{year}fca{n}.",
  },
  nswLegislation: {
    key: "nswLegislation",
    base: "https://legislation.nsw.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "no public query surface and the register discourages automated access",
    notes: "Deep link only: /view/html/inforce/current/act-YYYY-NNN.",
  },
  saLegislation: {
    key: "saLegislation",
    base: "https://www.legislation.sa.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "no public query surface and the register discourages automated access",
    notes: "Deep link only: /lz?path=/C/A/{SLUG}.",
  },
  accc: {
    key: "accc",
    base: "https://www.accc.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "WAF returns 403 to non-browser clients",
    notes: "Deep link only; the `competition` decision domain degrades to links plus a case fan-out.",
  },
  competitionTribunal: {
    key: "competitionTribunal",
    base: "https://www.competitiontribunal.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "WAF returns 403 to non-browser clients",
    notes: "Deep link only; ACompT decisions are also on AustLII (itself blocked).",
  },
  ombudsman: {
    key: "ombudsman",
    base: "https://www.ombudsman.gov.au",
    kind: "html",
    timeoutMs: 30_000,
    minIntervalMs: SCRAPE_INTERVAL_MS,
    blocked: true,
    blockedReason: "Cloudflare challenge on every request",
    notes: "Deep link only; the integrity domain reports [UPSTREAM_BLOCKED] with this link, never absence.",
  },
} as const

export const HOST_KEYS = Object.keys(UPSTREAM_HOSTS) as HostKey[]

/** Hosts this server refuses to fetch. Derived, never hand-maintained. */
export const BLOCKED_HOSTS: ReadonlySet<HostKey> = new Set(
  HOST_KEYS.filter((key) => UPSTREAM_HOSTS[key].blocked === true),
)

export function getHostConfig(key: HostKey): HostConfig {
  const config = UPSTREAM_HOSTS[key]
  if (!config) throw new Error(`Unknown upstream host key: ${String(key)}`)
  return config
}

export function isBlockedHost(key: HostKey): boolean {
  return BLOCKED_HOSTS.has(key)
}

/** Accept header a host expects when the caller does not set one. */
export function defaultAcceptFor(kind: HostKind): string {
  switch (kind) {
    case "odata":
      return "application/json;odata.metadata=minimal"
    case "json":
      return "application/json"
    case "documents":
      return "*/*"
    case "html":
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  }
}

/** Headers every request to `key` starts from. Caller headers win over these. */
export function defaultHeadersFor(
  key: HostKey,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const config = getHostConfig(key)
  return {
    "user-agent": resolveUserAgent(env),
    accept: defaultAcceptFor(config.kind),
    "accept-language": "en-AU,en;q=0.9",
    ...config.headers,
  }
}
