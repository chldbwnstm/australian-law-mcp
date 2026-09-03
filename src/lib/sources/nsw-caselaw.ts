/**
 * caselaw.nsw.gov.au — the best live Australian case-law source this server can
 * reach (docs/research/case-law-access.md §4, grok-followup.md Part 2).
 *
 * Three things about this site are counter-intuitive and all three are encoded
 * here rather than at the call sites:
 *
 *  1. **The simple-search parameter is `query`, not `q`.** `q` is accepted and
 *     silently ignored, so a wrong parameter returns 10,000 unrelated rows and
 *     looks like a working search.
 *  2. **`page` is 0-indexed** and the pager is JS-only, so the result count has
 *     to come from the "Displaying X - Y of Z" line. Z caps at 10,000.
 *  3. **Exact citation lookup needs a court selected.** `mnc=` on its own
 *     returns the blank advanced form — which reads exactly like "the citation
 *     does not exist". The working request is `mnc=` **plus** `_courts=on`
 *     plus at least one `courts=<hex id>` (grok-followup.md Part 2, matrix row
 *     4). Selecting every id does not inflate the result (row 5), so the exact
 *     lookup here sends the whole table and stays correct for any NSW court.
 */

import type { AuApiClient } from "../api-client.js"
import { splitTrailingCitation } from "./citation-tail.js"
import { getHostConfig } from "../upstream-hosts.js"
import {
  absoluteUrl,
  attr,
  elementsByClass,
  extractElements,
  links,
  textOf,
} from "./html.js"
import {
  parseDisplayingTotal,
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

const BASE = getHostConfig("nswCaselaw").base

/**
 * MNC court token → NSW Caselaw ObjectId.
 *
 * The court/tribunal ids come from case-law-access.md §4. The five NCAT
 * division ids were published there only as an unlabelled set
 * (`…8289/-8d/-8b/-8c/-8a`); the token each one belongs to was resolved
 * live on 2026-09-04 by running one filtered search per id and reading the
 * citations that came back — 8289 → NSWCATAD, 828a → NSWCATOD,
 * 828b → NSWCATCD, 828c → NSWCATGD, 828d → NSWCATAP. The same probe fixed
 * 8286 → NSWLEC, 828e → NSWIRComm and 8283 → NSWDDT.
 */
export const NSW_COURT_IDS: Readonly<Record<string, string>> = {
  NSWSC: "54a634063004de94513d8281",
  NSWCA: "54a634063004de94513d8278",
  NSWCCA: "54a634063004de94513d8279",
  NSWDC: "54a634063004de94513d827c",
  NSWLC: "54a634063004de94513d8280",
  NSWLEC: "54a634063004de94513d8286",
  NSWCHC: "54a634063004de94513d827a",
  NSWIRComm: "54a634063004de94513d828e",
  NSWIC: "54a634063004de94513d828e",
  NSWDDT: "54a634063004de94513d8283",
  NSWCATAD: "54a634063004de94513d8289",
  NSWCATOD: "54a634063004de94513d828a",
  NSWCATCD: "54a634063004de94513d828b",
  NSWCATGD: "54a634063004de94513d828c",
  NSWCATAP: "54a634063004de94513d828d",
}

/** The five NCAT divisions — the `admin_appeals` domain's NSW half. */
export const NCAT_COURT_IDS: readonly string[] = [
  NSW_COURT_IDS.NSWCATAD,
  NSW_COURT_IDS.NSWCATOD,
  NSW_COURT_IDS.NSWCATCD,
  NSW_COURT_IDS.NSWCATGD,
  NSW_COURT_IDS.NSWCATAP,
]

/** Every id, de-duplicated (NSWIRComm and NSWIC share one). */
export const ALL_NSW_COURT_IDS: readonly string[] = [...new Set(Object.values(NSW_COURT_IDS))]

export interface NswSearchParams {
  query: string
  /** 0-indexed, as the site expects. */
  page?: number
  /** `""` = relevance | `decisionDate,desc` | `titleForSort,asc` … */
  sort?: string
}

export interface NswAdvancedParams {
  body?: string
  title?: string
  before?: string
  catchwords?: string
  party?: string
  mnc?: string
  /** dd/mm/yyyy, as the form posts it. */
  startDate?: string
  endDate?: string
  fileNumber?: string
  legislationCited?: string
  casesCited?: string
  /** Repeatable court ObjectIds; at least one is required for the form to run. */
  courts?: readonly string[]
  page?: number
}

function encodePairs(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")
}

export function buildSearchPath(p: NswSearchParams): string {
  const pairs: Array<[string, string]> = [
    ["query", p.query],
    ["page", String(p.page ?? 0)],
  ]
  if (p.sort !== undefined) pairs.push(["sort", p.sort])
  return `search?${encodePairs(pairs)}`
}

/**
 * Advanced-form GET. Every field the form posts is sent, empty ones included:
 * the site's own form does that, and the verified request in grok-followup.md
 * carries them all. `_courts=on`/`_tribunals=on` are the checkbox-group
 * markers without which the GET returns the blank form.
 */
export function buildAdvancedPath(p: NswAdvancedParams): string {
  const pairs: Array<[string, string]> = [
    ["page", p.page === undefined ? "" : String(p.page)],
    ["body", p.body ?? ""],
    ["title", p.title ?? ""],
    ["before", p.before ?? ""],
    ["catchwords", p.catchwords ?? ""],
    ["party", p.party ?? ""],
    ["mnc", p.mnc ?? ""],
    ["startDate", p.startDate ?? ""],
    ["endDate", p.endDate ?? ""],
    ["fileNumber", p.fileNumber ?? ""],
    ["legislationCited", p.legislationCited ?? ""],
    ["casesCited", p.casesCited ?? ""],
    ["_courts", "on"],
  ]
  for (const court of p.courts ?? []) pairs.push(["courts", court])
  pairs.push(["_tribunals", "on"])
  return `search/advanced?${encodePairs(pairs)}`
}

/**
 * Split "Dela Cruz v R [2010] NSWCCA 333" into name and citation, using the
 * shared citation grammar rather than a local pattern.
 */
export const splitTitleCitation = splitTrailingCitation

/** Label/value pairs out of a result row's `ul.list-group` sidebar. */
function sidebarPairs(inner: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  let label: string | undefined
  for (const item of extractElements(inner, "li", () => true, 40)) {
    const classes = attr(item.openTag, "class") ?? ""
    const value = textOf(item.inner)
    if (!value) continue
    if (classes.split(/\s+/).includes("head")) {
      label = value
    } else if (label) {
      pairs.push([label, value])
      label = undefined
    }
  }
  return pairs
}

export function parseSearchResults(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ['class="row result"', "searchresults", "Displaying"], {
    host: "caselaw.nsw.gov.au",
    url: sourceUrl,
    what: "the result list",
  })

  const hits: SourceHit[] = []
  for (const row of elementsByClass(html, "div", ["row", "result"], 100)) {
    const anchor = links(row.inner, 5).find((link) => /^\/decision\/[0-9a-f]{16,32}$/.test(link.href))
    if (!anchor) continue
    const { title, citation } = splitTitleCitation(anchor.text)
    const id = anchor.href.slice("/decision/".length)
    const pairs = sidebarPairs(row.inner)
    const catchwords = /Catchwords:\s*<\/strong>\s*<\/p>\s*<p>([\s\S]{0,4000}?)<\/p>/i.exec(row.inner)

    const hit: SourceHit = {
      source: "NSW Caselaw",
      title,
      id,
      url: `${BASE}${anchor.href}`,
    }
    if (citation) hit.citation = citation
    const date = pairs.find(([label]) => /decision date/i.test(label))?.[1]
    if (date) hit.date = date
    const judge = pairs.find(([label]) => /judgment of/i.test(label))?.[1]
    if (judge) hit.extra = [["Judgment of", judge]]
    if (catchwords) {
      const text = textOf(catchwords[1])
      if (text) hit.catchwords = text
    }
    hits.push(hit)
  }

  const total = parseDisplayingTotal(html)
  const result: SourceSearchResult = { hits, sourceUrl }
  if (total !== undefined) {
    result.total = total
    // The site stops counting at 10,000 rather than reporting the true size.
    if (total >= 10000) {
      result.totalIsUnreliable = true
      result.totalNote = "NSW Caselaw caps its reported total at 10,000; the real number may be larger."
    }
  }
  return result
}

/** Coversheet label/value rows out of the decision page's leading table. */
function coversheetMetadata(bodyHtml: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const row of extractElements(bodyHtml, "tr", () => true, 60)) {
    const cells = extractElements(row.inner, "td", () => true, 8)
      .map((cell) => textOf(cell.inner))
      .filter((cell) => cell.length > 0)
    if (cells.length < 2) continue
    const labelIndex = cells.findIndex((cell) => cell.endsWith(":"))
    if (labelIndex < 0) continue
    const label = cells[labelIndex].replace(/:$/, "").trim()
    const value = cells.slice(labelIndex + 1).join(" ").trim()
    if (label && value) pairs.push([label, value])
  }
  return pairs
}

export function parseDecision(html: string, decisionId: string): SourceDocument {
  const url = `${BASE}/decision/${decisionId}`
  requireLandmark(html, ['class="judgment"', 'class="body"'], {
    host: "caselaw.nsw.gov.au",
    url,
    what: "the judgment",
  })

  const judgment = elementsByClass(html, "div", "judgment", 1)[0]
  const body = judgment ? elementsByClass(judgment.inner, "div", "body", 1)[0] : undefined
  const source = body?.inner ?? judgment?.inner ?? html
  const metadata = coversheetMetadata(source)
  const citation = metadata.find(([label]) => /^citation$/i.test(label))?.[1]
  const parsedCitation = citation ? splitTitleCitation(citation) : undefined

  const document: SourceDocument = {
    title: parsedCitation?.title || citation || `NSW decision ${decisionId}`,
    url,
    metadata,
    text: textOfJudgment(source),
    documents: [
      { label: "PDF", url: `${url}/export.pdf` },
      { label: "DOCX", url: `${url}/export.docx` },
    ],
  }
  if (parsedCitation?.citation) document.citation = parsedCitation.citation
  return document
}

/** Body text with the coversheet tables kept — they carry the orders and catchwords. */
function textOfJudgment(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .split(/<\/?(?:p|div|tr|br|h[1-6])\b[^>]*>/i)
    .map((chunk) => textOf(chunk))
    .filter((chunk) => chunk.length > 0)
    .join("\n")
}

// ── fetchers ──────────────────────────────────────────────────────────────

export async function search(
  client: AuApiClient,
  params: NswSearchParams,
): Promise<SourceSearchResult> {
  const path = buildSearchPath(params)
  const html = await client.fetchHtml("nswCaselaw", path)
  const result = parseSearchResults(html, `${BASE}/${path}`)
  result.page = params.page ?? 0
  return result
}

export async function advancedSearch(
  client: AuApiClient,
  params: NswAdvancedParams,
): Promise<SourceSearchResult> {
  const courts = params.courts?.length ? params.courts : ALL_NSW_COURT_IDS
  const path = buildAdvancedPath({ ...params, courts })
  const html = await client.fetchHtml("nswCaselaw", path)
  return parseSearchResults(html, `${BASE}/${path}`)
}

/**
 * Exact medium-neutral-citation lookup.
 *
 * The brackets are mandatory — `2010 NSWCCA 333` returns 0 of 0 (matrix row 6),
 * which is a false negative waiting to happen, so the citation is normalised
 * into bracket form before it goes on the wire.
 */
export async function lookupByCitation(
  client: AuApiClient,
  citation: string,
): Promise<SourceSearchResult> {
  const normalised = normaliseMnc(citation)
  const court = /\]\s*([A-Za-z][A-Za-z0-9]{1,14})\s/.exec(normalised)?.[1]
  const known = court ? NSW_COURT_IDS[court] : undefined
  return advancedSearch(client, {
    mnc: normalised,
    // A known court narrows the request; an unknown one falls back to every id
    // because extra selections do not inflate an MNC match.
    courts: known ? [known] : ALL_NSW_COURT_IDS,
  })
}

/** `2010 NSWCCA 333` / `[2010] NSWCCA 333` → `[2010] NSWCCA 333`. */
export function normaliseMnc(citation: string): string {
  const cleaned = citation.trim().replace(/\s+/g, " ")
  const match = /\[?((?:1[89]|20)\d{2})\]?\s+([A-Za-z][A-Za-z0-9]{1,14})\s+(\d{1,5})/.exec(cleaned)
  return match ? `[${match[1]}] ${match[2]} ${match[3]}` : cleaned
}

export async function getDecision(client: AuApiClient, decisionId: string): Promise<SourceDocument> {
  const id = decisionId.trim().replace(/^\/?decision\//, "")
  const html = await client.fetchHtml("nswCaselaw", `decision/${encodeURIComponent(id)}`)
  return parseDecision(html, id)
}

/** Canonical download URLs — deterministic, no scraping needed. */
export function decisionDownloads(decisionId: string): { pdf: string; docx: string } {
  return {
    pdf: `${BASE}/decision/${decisionId}/export.pdf`,
    docx: `${BASE}/decision/${decisionId}/export.docx`,
  }
}

