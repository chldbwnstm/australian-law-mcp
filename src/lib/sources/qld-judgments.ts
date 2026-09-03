/**
 * queenslandjudgments.com.au — the only Australian case-law site with a
 * **deterministic citation → URL** mapping (docs/research/case-law-access.md §5).
 *
 * `[2020] QSC 100` is `/caselaw/qsc/2020/100`, full server-rendered HTML, PDF at
 * the same path with `/pdf`. That is worth a lot: for Queensland this server can
 * answer "get me that judgment" with one request and no search step, and a 404
 * there is a real observation about that citation rather than a search miss.
 *
 * The search endpoint is a different animal: its result rows link to internal
 * `/case/id/{n}` ids, not to citations, and the count it prints ("returned
 * 10000 results (comprised of 11279 Judgments …)") is capped. Both facts are
 * carried through to the caller rather than smoothed over.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { splitTrailingCitation, isMediumNeutral } from "./citation-tail.js"
import { blockTextOf, elementById, elementsByClass, extractElements, firstText, links, textOf } from "./html.js"
import {
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

const BASE = getHostConfig("qldJudgments").base

/** Court tokens the search form's `multiSelectCourt[]` accepts (§5). */
export const QLD_COURTS = [
  "QCA", "QSC", "QDC", "QMC", "QCAT", "QPEC", "QLC", "ICQ",
  "QChCM", "QMHC", "LPT", "QHPT", "RSLT", "LG",
] as const

export interface QldSearchParams {
  text?: string
  citation?: string
  caseName?: string
  catchwords?: string
  courts?: readonly string[]
  yearStart?: number
  yearEnd?: number
  /** 1-indexed on this site. */
  page?: number
  perPage?: number
}

/**
 * The query string is assembled here because `multiSelectCourt[]` carries
 * literal brackets in the site's own links and the shared client only encodes
 * values, never keys — so a repeated bracketed key cannot travel through
 * `FetchOpts.query`.
 */
export function buildSearchPath(p: QldSearchParams): string {
  const parts: string[] = []
  const add = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return
    parts.push(`${key}=${encodeURIComponent(String(value))}`)
  }
  add("queryStringSearchText", p.text)
  add("queryStringCitation", p.citation)
  add("queryStringCaseName", p.caseName)
  add("queryStringCatchwords", p.catchwords)
  for (const court of p.courts ?? []) parts.push(`multiSelectCourt[]=${encodeURIComponent(court)}`)
  add("yearStart", p.yearStart)
  add("yearEnd", p.yearEnd)
  add("per-page", p.perPage ?? 20)
  add("page", p.page ?? 1)
  return `caselaw-search/query?${parts.join("&")}`
}

/** `[2020] QSC 100` → `caselaw/qsc/2020/100`. Returns undefined for a non-MNC. */
export function citationPath(citation: string, pdf = false): string | undefined {
  const match = /\[((?:1[89]|20)\d{2})\]\s*([A-Za-z][A-Za-z0-9]{1,14})\s*(\d{1,5})/.exec(citation)
  if (!match) return undefined
  const path = `caselaw/${match[2].toLowerCase()}/${match[1]}/${Number(match[3])}`
  return pdf ? `${path}/pdf` : path
}

const TAGLINE = /returned\s*<strong>\s*([\d,]+)\s*<\/strong>\s*results(?:[\s\S]{0,200}?<strong>\s*([\d,]+)\s*<\/strong>\s*Judgments)?/i

export function parseSearchResults(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ["result-list", "tagline-result"], {
    host: "queenslandjudgments.com.au",
    url: sourceUrl,
    what: "the result list",
  })

  const list = elementsByClass(html, "ul", "result-list", 1)[0]
  const hits: SourceHit[] = []
  for (const item of extractElements(list?.inner ?? html, "li", () => true, 60)) {
    const nameElement = elementsByClass(item.inner, "span", "caseName", 1)[0]
    if (!nameElement) continue
    const raw = textOf(nameElement.inner)
    if (!raw) continue
    const anchor = links(item.inner, 6).find((link) => /^\/case\/id\/\d+$/.test(link.href))
    const id = anchor ? anchor.href.replace("/case/id/", "") : raw
    const { title, citation } = splitTrailingCitation(raw)

    const hit: SourceHit = {
      source: "Queensland Judgments",
      title,
      id,
      url: anchor ? `${BASE}${anchor.href}` : sourceUrl,
    }
    if (citation) {
      hit.citation = citation
      // Prefer the citation-addressable URL when the citation is medium-neutral:
      // it is stable, human-openable and needs no id. A report citation
      // (`[2010] 2 Qd R 591`) is NOT addressable that way — its volume number
      // sits where an MNC's court token does, and treating it as one would build
      // a URL like /caselaw/2/2010/591.
      if (isMediumNeutral(citation)) {
        const direct = citationPath(citation)
        if (direct) hit.url = `${BASE}/${direct}`
      }
    }
    hits.push(hit)
  }

  const tagline = TAGLINE.exec(html)
  const result: SourceSearchResult = { hits, sourceUrl }
  if (tagline) {
    const reported = Number(tagline[1].replace(/,/g, ""))
    const judgments = tagline[2] ? Number(tagline[2].replace(/,/g, "")) : undefined
    if (Number.isFinite(reported)) {
      result.total = reported
      if (reported >= 10000 || (judgments !== undefined && judgments !== reported)) {
        result.totalIsUnreliable = true
        result.totalNote =
          `Queensland Judgments reports ${reported.toLocaleString()} results` +
          (judgments !== undefined ? ` while counting ${judgments.toLocaleString()} judgments` : "") +
          " — the figure is capped at 10,000 and should not be quoted as an exact count."
      }
    }
  }
  return result
}

export function parseJudgment(html: string, url: string): SourceDocument {
  requireLandmark(html, ['id="report-view"', "casename_print", "citation_print"], {
    host: "queenslandjudgments.com.au",
    url,
    what: "the judgment",
  })

  const caseName = firstText(html, /<div[^>]{0,120}class="casename_print"[^>]*>([\s\S]{0,400}?)<\/div>/i)
  const citation = firstText(html, /<div[^>]{0,120}class="citation_print"[^>]*>([\s\S]{0,200}?)<\/div>/i)
  const report = elementById(html, "div", "report-view")
  const body = report ? blockTextOf(report.inner) : ""

  const metadata: Array<[string, string]> = []
  if (report) {
    for (const row of extractElements(report.inner, "tr", () => true, 40)) {
      const cells = extractElements(row.inner, "td", () => true, 6)
        .map((cell) => textOf(cell.inner))
        .filter((cell) => cell.length > 0)
      if (cells.length >= 2 && cells[0].endsWith(":")) {
        metadata.push([cells[0].replace(/:$/, ""), cells.slice(1).join(" ")])
      }
    }
  }

  const document: SourceDocument = {
    title: caseName ?? citation ?? url,
    url,
    metadata,
    text: body,
    documents: [{ label: "PDF", url: `${url.replace(/\/$/, "")}/pdf` }],
  }
  if (citation) document.citation = citation
  return document
}

// ── fetchers ──────────────────────────────────────────────────────────────

export async function search(
  client: AuApiClient,
  params: QldSearchParams,
): Promise<SourceSearchResult> {
  const path = buildSearchPath(params)
  const html = await client.fetchHtml("qldJudgments", path)
  const result = parseSearchResults(html, `${BASE}/${path}`)
  result.page = params.page ?? 1
  return result
}

/** Fetch a judgment by citation. Throws NOT_FOUND (a real 404) for an absent one. */
export async function getByCitation(client: AuApiClient, citation: string): Promise<SourceDocument> {
  const path = citationPath(citation)
  if (!path) {
    throw new Error(`Not a medium-neutral citation Queensland Judgments can address: ${citation}`)
  }
  const html = await client.fetchHtml("qldJudgments", path)
  return parseJudgment(html, `${BASE}/${path}`)
}

/** Fetch by the internal id search results carry (`/case/id/{n}`). */
export async function getById(client: AuApiClient, caseId: string): Promise<SourceDocument> {
  const id = caseId.trim().replace(/^\/?case\/id\//, "")
  const html = await client.fetchHtml("qldJudgments", `case/id/${encodeURIComponent(id)}`)
  return parseJudgment(html, `${BASE}/case/id/${id}`)
}
