/**
 * `AuApiClient` — the multi-host upstream facade, implementing the frozen
 * contract block in docs/ARCHITECTURE.md.
 *
 * The generic transport (`fetchJson` / `fetchHtml` / `fetchBinary`) is what
 * every tool uses; the FRL conveniences package the verified recipes from
 * docs/research/frl-api-reference.md so their gotchas are encoded exactly once:
 *
 *  - the criteria DSL (double encoding, `and()` form) stays in frl-criteria.ts;
 *  - `$top` is clamped to 100 and `@odata.nextLink` is never followed
 *    (it drops the `$filter`);
 *  - `$expand` is never sent on Versions (the server rejects it);
 *  - `Versions/Find(asAt=…)` datetimes carry no trailing `Z`, and that form's
 *    PascalCase/numeric-enum response shape is normalised before it escapes;
 *  - provisions are sliced from epub volumes via the NCX, because no
 *    per-section endpoint exists.
 *
 * Blocked hosts are refused *before* any network call — `UpstreamBlockedError`
 * is a statement that this server did not look, never that the record is
 * absent.
 */

import { ARTICLE_CACHE_TTL, lawCache } from "./cache.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError } from "./errors.js"
import { fetchWithRetry, maskSensitiveUrl, sleep } from "./fetch-with-retry.js"
import {
  affectedby,
  and,
  collection as criteriaCollection,
  pointintime,
  status as criteriaStatus,
  text as criteriaText,
  titlesSearchPath,
  type AffectKind,
  type Criteria,
  type FrlCollection,
  type FrlStatus,
  type MatchType,
  type SearchType,
} from "./frl-criteria.js"
import { ancestorsOf, parseNcx } from "./ncx-parser.js"
import { findNavPoint, sliceProvision } from "./provision-slicer.js"
import { readResponseBytes, readResponseText } from "./response-body.js"
import { requestCancelledError } from "./session-state.js"
import { formatRef, parseSectionRef } from "./section-ref.js"
import { getHostConfig, defaultHeadersFor, type HostKey } from "./upstream-hosts.js"
import type { FrlTitle, FrlVersion, NcxEntry, ProvisionText } from "./types.js"

export type { AffectKind } from "./frl-criteria.js"
export type { FrlTitle, FrlVersion, NcxEntry, ProvisionText } from "./types.js"

export interface FetchOpts {
  /** Query parameters; keys go on the wire as written, values are URI-encoded. */
  query?: Record<string, string | number | boolean | undefined>
  method?: string
  body?: string | URLSearchParams
  headers?: Record<string, string>
  /** Override of the host's own timeout (rarely needed — the table is per-host already). */
  timeoutMs?: number
  /**
   * Every current Australian source is keyless. Kept on the shared path so a
   * future keyed source cannot bypass the masking in error messages: the value
   * travels as an `apiKey` query parameter, which `maskSensitiveUrl` strips.
   */
  apiKey?: string
}

/** FRL `$top` hard cap; larger values are a 400 upstream (reference §8). */
const FRL_TOP_MAX = 100
const DEFAULT_SEARCH_TOP = 20

/**
 * `originatingBillUri` is carried here rather than fetched separately: it is
 * the only pointer from a title to its parliamentary paper trail (the APH bill
 * page, and through it the explanatory memorandum), and re-requesting the same
 * row to add one field costs a whole round trip against the request budget.
 */
const TITLE_SELECT =
  "id,name,collection,status,isPrincipal,isInForce,year,number,seriesType," +
  "originatingBillUri,nameHistory,statusHistory,hasCommencedUnincorporatedAmendments"

/**
 * Numeric → string enum tables for the `Versions/Find(asAt=…)` quirk. Order is
 * the $metadata declaration order, cross-checked against the recorded pair of
 * fixtures (`frl-versions-find-asat.json` numeric vs `…-find-spec.json` string:
 * status 0 ↔ "InForce", affect 1 ↔ "Amend", seriesType 0 ↔ "Act").
 */
const STATUS_ENUM = ["InForce", "Ceased", "Repealed", "NeverEffective"] as const
const REASON_AFFECT_ENUM = ["AsMade", "Amend", "Repeal", "Cease", "ChangeDate", "Disallow"] as const
const SERIES_TYPE_ENUM = ["Act", "SR", "SLI"] as const

interface ODataList<T> {
  "@odata.count"?: number
  value?: T[]
}

function assertTitleId(titleId: string): string {
  const value = titleId.trim()
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    throw new LawApiError(
      `Invalid FRL title/register id: ${JSON.stringify(titleId)}`,
      ErrorCodes.INVALID_PARAM,
      ["FRL ids look like C2004A00109 or F2011L00287. Take them from search results, never invent one."],
    )
  }
  return value
}

/** `latest` | `asmade` | `yyyy-mm-dd` — the only values the document URL grammar takes. */
function assertDateSegment(date: string | undefined): string {
  if (date === undefined) return "latest"
  const value = date.trim()
  if (value === "latest" || value === "asmade" || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  throw new LawApiError(
    `Invalid point-in-time date: ${JSON.stringify(date)}`,
    ErrorCodes.INVALID_PARAM,
    ['Use "YYYY-MM-DD", "latest" or "asmade".'],
  )
}

/** OData datetime literal — **no trailing Z** (a `Z` is a 400 upstream). */
function toODataDateTime(asAt: string): string {
  const value = asAt.trim().replace(/Z$/i, "")
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return value
  throw new LawApiError(
    `Invalid asAt datetime: ${JSON.stringify(asAt)}`,
    ErrorCodes.INVALID_PARAM,
    ['Use "YYYY-MM-DD" (midnight is assumed) or a full ISO datetime without a timezone.'],
  )
}

/** Lower-case the first letter of every key, recursively — the PascalCase quirk. */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key.charAt(0).toLowerCase() + key.slice(1)] = camelizeKeys(entry)
  }
  return out
}

function enumName(value: unknown, table: readonly string[]): unknown {
  return typeof value === "number" ? table[value] ?? value : value
}

/**
 * Normalise a Version entity: camelCase keys and string enums, whichever form
 * the server answered in. Applied to every `Versions` result so the two Find
 * response dialects can never leak two shapes to callers. Enum mapping is
 * per-path, not per-key-name — `documents[].type` shares a key name with an
 * unrelated enum and is deliberately left as delivered.
 */
export function normalizeFrlVersion(raw: unknown): FrlVersion {
  const version = camelizeKeys(raw) as Record<string, unknown>
  version.status = enumName(version.status, STATUS_ENUM)
  if (Array.isArray(version.reasons)) {
    for (const entry of version.reasons) {
      const reason = entry as Record<string, unknown>
      reason.affect = enumName(reason.affect, REASON_AFFECT_ENUM)
      for (const side of ["affectedByTitle", "amendedByTitle"]) {
        const title = reason[side] as Record<string, unknown> | null | undefined
        if (title) title.seriesType = enumName(title.seriesType, SERIES_TYPE_ENUM)
      }
    }
  }
  return version as unknown as FrlVersion
}

export class AuApiClient {
  private readonly userAgent?: string
  /**
   * Per-host politeness clock (`minIntervalMs` from the hosts table): the
   * earliest moment the *next* request to that host may leave. A slot cursor
   * rather than a "last request at" timestamp because slots are claimed
   * synchronously — see `politeWait`. Kept per client instance; production runs
   * one client per process, so this is the per-host floor the scraped sites'
   * robots files ask for.
   */
  private readonly nextSlotAt = new Map<HostKey, number>()

  constructor(config: { userAgent?: string } = {}) {
    this.userAgent = config.userAgent
  }

  // ── generic transport ────────────────────────────────────────────────────

  async fetchJson(host: HostKey, path: string, opts: FetchOpts = {}): Promise<unknown> {
    const response = await this.request(host, path, opts, false)
    const text = await readResponseText(response)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new LawApiError(
        `Upstream ${host} returned a non-JSON body`,
        ErrorCodes.PARSE_ERROR,
        ["A JSON endpoint answering with something else usually means maintenance or a wrong path — retry shortly and re-check the request."],
      )
    }
    // All FRL collection consumers share this boundary, including tools that
    // call fetchJson directly. An error object or a missing `value` is not an
    // empty collection and must never become a cached zero or NOT_FOUND.
    if (host === "frlApi" && /^\/?(?:Titles|Versions|Documents)(?:\/?(?:\?|$)|\/Search\()/.test(path)) {
      const envelope = json as ODataList<unknown> | null
      const count = envelope?.["@odata.count"]
      if (
        !envelope || !Array.isArray(envelope.value) ||
        envelope.value.some(row => row === null || typeof row !== "object" || Array.isArray(row)) ||
        (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
      ) {
        throw new LawApiError(
          "FRL returned a malformed collection response",
          ErrorCodes.PARSE_ERROR,
          ["The response does not establish whether any records exist. Retry and check the Register directly."],
        )
      }
    }
    return json
  }

  async fetchHtml(host: HostKey, path: string, opts: FetchOpts = {}): Promise<string> {
    const response = await this.request(host, path, opts, true)
    return readResponseText(response)
  }

  async fetchBinary(host: HostKey, path: string, opts: FetchOpts = {}): Promise<Uint8Array> {
    const response = await this.request(host, path, opts, true)
    return readResponseBytes(response)
  }

  // ── FRL conveniences ─────────────────────────────────────────────────────

  /**
   * Run a pre-built criteria fragment.
   *
   * `searchTitles` covers the four facets its parameters name; anything else —
   * `authorises(...)`, an `or(...)` of collections, a facet combination the
   * convenience does not model — used to mean the caller re-derived
   * `titlesSearchPath` and the `$count`/`$top` clamping for itself, which is
   * how a second copy of the pagination rules gets written. Hand the fragment
   * here instead: the DSL still comes from `frl-criteria.ts`, and the wire
   * details stay in one place.
   */
  async criteriaSearch<T = FrlTitle>(
    criteria: Criteria,
    opts: { top?: number; skip?: number; select?: string; expand?: string; orderBy?: string } = {},
  ): Promise<{ count: number; titles: T[] }> {
    const query: NonNullable<FetchOpts["query"]> = {
      $count: "true",
      $top: clampTop(opts.top ?? DEFAULT_SEARCH_TOP),
    }
    if (opts.skip !== undefined) query.$skip = opts.skip
    if (opts.select) query.$select = opts.select
    if (opts.expand) query.$expand = opts.expand
    if (opts.orderBy) query.$orderby = opts.orderBy

    const json = (await this.fetchJson("frlApi", titlesSearchPath(criteria), { query })) as ODataList<T>
    const titles = json.value ?? []
    return { count: json["@odata.count"] ?? titles.length, titles }
  }

  async searchTitles(p: {
    text?: string
    searchType?: "name" | "nameAndText"
    /**
     * How `text()` matches. The DSL default, `contains`, is a **phrase** match:
     * "CSIRO determination" finds 0 notifiable instruments while `all` finds 2.
     * Keyword callers should pass `all`; the default stays `contains` so the
     * frozen behaviour of existing callers does not move underneath them.
     */
    matchType?: MatchType
    collection?: string
    status?: string
    pointInTime?: string
    filter?: string
    top?: number
    skip?: number
    select?: string
    expand?: string
  }): Promise<{ count: number; titles: FrlTitle[] }> {
    const query: NonNullable<FetchOpts["query"]> = {
      $count: "true",
      $top: clampTop(p.top ?? DEFAULT_SEARCH_TOP),
    }
    if (p.skip !== undefined) query.$skip = p.skip
    if (p.select) query.$select = p.select
    if (p.expand) query.$expand = p.expand

    let path: string
    if (p.text) {
      const parts: Criteria[] = [
        criteriaText(p.text, (p.searchType ?? "nameAndText") as SearchType, p.matchType),
      ]
      if (p.collection) parts.push(criteriaCollection(p.collection as FrlCollection))
      if (p.status) parts.push(criteriaStatus(p.status as FrlStatus))
      if (p.pointInTime) parts.push(pointintime(p.pointInTime))
      path = titlesSearchPath(and(...parts))
    } else if (p.filter) {
      path = "Titles"
      query.$filter = p.filter
    } else {
      throw new LawApiError(
        "searchTitles needs either `text` (criteria DSL) or `filter` (raw OData $filter)",
        ErrorCodes.INVALID_PARAM,
      )
    }

    const json = (await this.fetchJson("frlApi", path, { query })) as ODataList<FrlTitle>
    const titles = json.value ?? []
    return { count: json["@odata.count"] ?? titles.length, titles }
  }

  async getTitle(titleId: string): Promise<FrlTitle> {
    const id = assertTitleId(titleId)
    const json = (await this.fetchJson("frlApi", "Titles", {
      query: { $filter: `id eq '${id}'`, $select: TITLE_SELECT },
    })) as ODataList<FrlTitle>
    const title = json.value?.[0]
    if (!title) {
      throw new LawApiError(
        `FRL reports no title with id ${id}`,
        ErrorCodes.NOT_FOUND,
        ["Confirm the register id via searchTitles; historical names resolve there too."],
      )
    }
    // nameHistory carries verbatim duplicate rows upstream (reference §7).
    if (title.nameHistory) {
      const seen = new Set<string>()
      title.nameHistory = title.nameHistory.filter((entry) => {
        const key = `${entry.name} ${entry.start}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    return title
  }

  async listVersions(titleId: string, p: { top?: number; skip?: number } = {}): Promise<FrlVersion[]> {
    const id = assertTitleId(titleId)
    // NO $expand here — the server rejects it on Versions (reference §8).
    const query: NonNullable<FetchOpts["query"]> = {
      $filter: `titleId eq '${id}'`,
      $orderby: "start desc",
      $count: "true",
      $top: clampTop(p.top ?? FRL_TOP_MAX),
    }
    if (p.skip !== undefined) query.$skip = p.skip
    const json = (await this.fetchJson("frlApi", "Versions", { query })) as ODataList<unknown>
    return (json.value ?? []).map(normalizeFrlVersion)
  }

  async findVersion(p: {
    titleId?: string
    asAt?: string
    spec?: "latest" | "current" | "asmade"
    registerId?: string
  }): Promise<FrlVersion> {
    let path: string
    if (p.registerId) {
      path = `Versions/Find(registerId='${assertTitleId(p.registerId)}')`
    } else if (p.titleId && p.asAt) {
      path = `Versions/Find(titleId='${assertTitleId(p.titleId)}',asAt=${toODataDateTime(p.asAt)})`
    } else if (p.titleId && p.spec) {
      if (!["latest", "current", "asmade"].includes(p.spec)) {
        throw new LawApiError(
          `Invalid version spec: ${JSON.stringify(p.spec)}`,
          ErrorCodes.INVALID_PARAM,
          ['Use "latest", "current" or "asmade".'],
        )
      }
      path = `Versions/Find(titleId='${assertTitleId(p.titleId)}',asAtSpecification='${p.spec}')`
    } else {
      throw new LawApiError(
        "findVersion needs registerId, or titleId with asAt or spec",
        ErrorCodes.INVALID_PARAM,
      )
    }
    const json = await this.fetchJson("frlApi", path)
    return normalizeFrlVersion(json)
  }

  async listAmenders(
    titleId: string,
    kinds: AffectKind[] = ["amending"],
  ): Promise<{ count: number; titles: FrlTitle[] }> {
    const id = assertTitleId(titleId)
    const path = titlesSearchPath(affectedby(id, kinds))
    const json = (await this.fetchJson("frlApi", path, {
      query: { $count: "true", $top: FRL_TOP_MAX, $orderby: "name asc" },
    })) as ODataList<FrlTitle>
    const titles = json.value ?? []
    return { count: json["@odata.count"] ?? titles.length, titles }
  }

  // ── document text (epub member extraction) ──────────────────────────────

  /**
   * The parsed NCX for one `(title, date)`, cached for the document TTL.
   *
   * There is no per-section endpoint, so every provision fetch needs the whole
   * table of contents first — and the CCA's is ~830 KB. Without the cache a
   * multi-provision flow (`get_law_text`, `get_instrument_provisions`,
   * `get_historical_law`, a batch) re-downloads the same document once per
   * provision, spending both the request budget and a politeness interval on
   * bytes it already has. The key is exactly the one
   * `tools/statute-helpers/toc.ts` uses, so the two paths share one warm entry
   * instead of keeping two copies.
   *
   * Only a parsed, non-empty TOC is stored: an upstream failure or an empty
   * document is an observation about this attempt, never an answer to remember.
   */
  async getToc(titleId: string, date?: string): Promise<NcxEntry[]> {
    const cacheKey = `toc:${assertTitleId(titleId)}:${assertDateSegment(date)}`
    const cached = lawCache.get<NcxEntry[]>(cacheKey)
    if (cached) return cached

    const xml = await this.fetchHtml("frlDocs", this.epubMemberPath(titleId, date, "document.ncx"))
    const entries = parseNcx(xml)
    if (entries.length === 0) {
      throw new LawApiError(
        `The epub table of contents for ${titleId} contained no navPoints`,
        ErrorCodes.PARSE_ERROR,
        ["This is an upstream document problem, not evidence the title is absent — retry, then verify the id and date."],
      )
    }
    lawCache.set(cacheKey, entries, ARTICLE_CACHE_TTL)
    return entries
  }

  async getVolumeHtml(titleId: string, volume: number, date?: string): Promise<string> {
    if (!Number.isInteger(volume) || volume < 1) {
      throw new LawApiError(
        `Invalid volume number: ${String(volume)}`,
        ErrorCodes.INVALID_PARAM,
        ["Volumes are numbered from 1 (document_1/document_1.html)."],
      )
    }
    return this.fetchHtml(
      "frlDocs",
      this.epubMemberPath(titleId, date, `document_${volume}/document_${volume}.html`),
    )
  }

  async getProvision(titleId: string, provision: string, date?: string): Promise<ProvisionText> {
    const ref = parseSectionRef(provision)
    if (!ref) {
      throw new LawApiError(
        `Not a recognisable provision reference: ${JSON.stringify(provision)}`,
        ErrorCodes.INVALID_PARAM,
        ['Use forms like "s 18", "sch 2 s 18", "pt IV", "reg 2.01".'],
      )
    }

    const entries = await this.getToc(titleId, date)
    const entry = findNavPoint(ref, entries)
    if (!entry) {
      throw new LawApiError(
        `${formatRef(ref)} is not in the ${date ?? "latest"} table of contents of ${titleId}`,
        ErrorCodes.NOT_FOUND,
        [
          "The provision may exist in a different compilation — try another date before concluding anything.",
          ref.schedule
            ? "Schedule sections only match inside their schedule; check the schedule number."
            : 'If you meant a schedule provision (e.g. the ACL), prefix it: "sch 2 s 18".',
        ],
      )
    }

    const html = await this.fetchHtml("frlDocs", this.epubMemberPath(titleId, date, entry.volumeDoc))
    const text = sliceProvision(html, entry, entries)
    if (text === null) {
      throw new LawApiError(
        `The NCX anchor for ${formatRef(ref)} (${entry.anchor ?? "?"}) is missing from ${entry.volumeDoc}`,
        ErrorCodes.PARSE_ERROR,
        ["TOC and volume disagree upstream — retry, and report the register id if it persists."],
      )
    }

    return {
      ref: formatRef(ref),
      heading: entry.label,
      text,
      volumeDoc: entry.volumeDoc,
      ...(entry.anchor ? { anchor: entry.anchor } : {}),
      breadcrumb: ancestorsOf(entry).map((ancestor) => ancestor.label),
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** `{id}/{date|latest}/{date|latest}/text/latest/epub/OEBPS/{member}` (reference §3). */
  private epubMemberPath(titleId: string, date: string | undefined, member: string): string {
    const id = assertTitleId(titleId)
    const d = assertDateSegment(date)
    return `${id}/${d}/${d}/text/latest/epub/OEBPS/${member}`
  }

  private buildUrl(base: string, path: string, opts: FetchOpts): string {
    const cleanPath = path.startsWith("/") ? path.slice(1) : path
    let url = `${base}/${cleanPath}`
    const pairs: string[] = []
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue
      pairs.push(`${key}=${encodeURIComponent(String(value))}`)
    }
    if (opts.apiKey) pairs.push(`apiKey=${encodeURIComponent(opts.apiKey)}`)
    if (pairs.length > 0) url += (url.includes("?") ? "&" : "?") + pairs.join("&")
    return url
  }

  /**
   * Honour the host's `minIntervalMs` between two requests to the same host.
   *
   * The slot is claimed **before** the sleep, and the cursor is advanced in the
   * same synchronous step. Reading a "last request" timestamp and writing it
   * back after awaiting is the shape that quietly does nothing under
   * concurrency: every member of a `Promise.all` fan-out reads the same value,
   * waits the same amount, and then hits the host in one burst — which is
   * precisely the burst the floor exists to prevent on sites whose robots ask
   * for a crawl delay.
   */
  private async politeWait(host: HostKey, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw requestCancelledError(signal.reason)
    const now = Date.now()
    const slot = Math.max(now, this.nextSlotAt.get(host) ?? 0)
    this.nextSlotAt.set(host, slot + minIntervalMs)
    const wait = slot - now
    if (wait > 0) await sleep(wait, signal)
  }

  private async request(
    host: HostKey,
    path: string,
    opts: FetchOpts,
    allowHtmlBody: boolean,
  ): Promise<Response> {
    const config = getHostConfig(host)
    if (config.blocked) {
      // Thrown before any network call: a refusal to look, not an observation.
      throw new UpstreamBlockedError(host, config.blockedReason ?? "blocked by policy", [config.base])
    }

    const url = this.buildUrl(config.base, path, opts)

    const headers: Record<string, string> = { ...defaultHeadersFor(host) }
    if (this.userAgent) headers["user-agent"] = this.userAgent
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      headers[key.toLowerCase()] = value
    }

    const response = await fetchWithRetry(url, {
      beforeAttempt: (signal) => this.politeWait(host, config.minIntervalMs, signal),
      timeout: opts.timeoutMs ?? config.timeoutMs,
      method: opts.method ?? "GET",
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      headers,
      allowHtmlBody,
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      this.throwForStatus(host, response.status, url)
    }
    return response
  }

  private throwForStatus(host: HostKey, status: number, url: string): never {
    const masked = maskSensitiveUrl(url)
    if (status === 429) {
      throw new LawApiError(
        `${host} rate-limited the request (429) - ${masked}`,
        ErrorCodes.RATE_LIMITED,
        ["Wait briefly and retry; this is throttling, not absence."],
      )
    }
    if (status === 404) {
      throw new LawApiError(
        `${host} returned 404 for ${masked}`,
        ErrorCodes.NOT_FOUND,
        ["Re-check the id/path against a search result before concluding the record does not exist."],
      )
    }
    if (status >= 500) {
      throw new LawApiError(
        `${host} upstream server error (${status}) - ${masked}`,
        ErrorCodes.API_ERROR,
        ["Upstream failure — retry shortly. This says nothing about whether the record exists."],
      )
    }
    throw new LawApiError(`${host} request failed (${status}) - ${masked}`, ErrorCodes.API_ERROR)
  }
}

function clampTop(top: number): number {
  if (!Number.isInteger(top) || top < 1) return 1
  return Math.min(top, FRL_TOP_MAX)
}
