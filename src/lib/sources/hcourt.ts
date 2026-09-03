/**
 * www.hcourt.gov.au — High Court judgments, 1998 to current
 * (docs/research/case-law-access.md §2).
 *
 * The site is Drupal and the listing is a plain view, so scraping is easy. One
 * thing is not: **the year facet's square brackets must reach the server
 * literally.** `f[0]=d:2020` works; `f%5B0%5D=d:2020` is a WAF 403. The shared
 * client percent-encodes query *values* (never keys), so the facet cannot go
 * through `FetchOpts.query` at all — the whole query string is assembled here
 * and passed as part of the path, which the client copies verbatim.
 *
 * The detail page carries catchwords and metadata only. Full text is a PDF or
 * DOCX under `/sites/default/files/eresources/{upload-date}/HCA/…`, and the
 * upload date is not derivable from the citation, so the link is scraped from
 * the detail page rather than constructed.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { absoluteUrl, elementsByClass, firstText, links, textOf } from "./html.js"
import {
  parseDisplayingTotal,
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

const BASE = getHostConfig("hcourt").base
const LISTING = "cases-and-judgments/judgments/judgments-1998-current"

export interface HcourtSearchParams {
  keywords?: string
  caseNumber?: string
  /** Year facet. Emitted as a LITERAL `f[0]=d:YYYY` — see the module note. */
  year?: number
  /** 0-indexed, 12 results per page. */
  page?: number
}

/**
 * Build the listing path with its query string already assembled.
 * Keyword and case-number values are encoded; the facet is not, deliberately.
 */
export function buildListingPath(p: HcourtSearchParams): string {
  const parts: string[] = []
  if (p.keywords) parts.push(`keywords=${encodeURIComponent(p.keywords)}`)
  if (p.caseNumber) parts.push(`case_number=${encodeURIComponent(p.caseNumber)}`)
  if (p.year !== undefined) parts.push(`f[0]=d:${p.year}`)
  if (p.page !== undefined && p.page > 0) parts.push(`page=${p.page}`)
  return parts.length > 0 ? `${LISTING}?${parts.join("&")}` : LISTING
}

function fieldText(rowHtml: string, fieldClass: string): string | undefined {
  const element = elementsByClass(rowHtml, "div", ["field", fieldClass], 1)[0]
  if (!element) return undefined
  // Every field renders as "<strong>Label:</strong> value"; the label is noise.
  const value = textOf(element.inner.replace(/<strong\b[^>]*>[\s\S]{0,200}?<\/strong\s*>/i, " "))
  return value.length > 0 ? value : undefined
}

export function parseListing(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ['class="views-row"', "view-judgments", "view-summary"], {
    host: "hcourt.gov.au",
    url: sourceUrl,
    what: "the judgment list",
  })

  const hits: SourceHit[] = []
  for (const row of elementsByClass(html, "div", "views-row", 60)) {
    const anchor = links(row.inner, 4).find((link) => link.href.includes(LISTING))
    if (!anchor) continue
    const title = fieldText(row.inner, "field--title")
    const citation = fieldText(row.inner, "field--citation")
    const slug = anchor.href.replace(/^.*\//, "")

    const hit: SourceHit = {
      source: "High Court of Australia",
      title: title ?? anchor.text,
      id: slug,
      url: absoluteUrl(BASE, anchor.href),
    }
    if (citation) hit.citation = citation
    const date = fieldText(row.inner, "field--hca-date-issued")
    if (date) hit.date = date
    const bench = fieldText(row.inner, "field--legacy-before")
    const matter = fieldText(row.inner, "field--hca-matter-number")
    const extra: Array<[string, string]> = []
    if (bench) extra.push(["Before", bench])
    if (matter) extra.push(["Case number", matter])
    if (extra.length > 0) hit.extra = extra
    hits.push(hit)
  }

  const total = parseDisplayingTotal(html)
  const result: SourceSearchResult = { hits, sourceUrl }
  if (total !== undefined) result.total = total
  return result
}

export function parseDetail(html: string, slug: string): SourceDocument {
  const url = `${BASE}/${LISTING}/${slug}`
  requireLandmark(html, ["page-title", 'class="citation"', "node--type-hca-judgment"], {
    host: "hcourt.gov.au",
    url,
    what: "the judgment detail",
  })

  const title =
    firstText(html, /<h1[^>]{0,200}class="[^"]*page-title[^"]*"[^>]*>([\s\S]{0,600}?)<\/h1>/i) ??
    firstText(html, /<title>([^<]{0,300})<\/title>/i)?.replace(/\s*\|.*$/, "") ??
    slug

  const citation = firstText(html, /<span[^>]{0,120}class="citation"[^>]*>([\s\S]{0,120}?)<\/span>/i)

  const metadata: Array<[string, string]> = []
  for (const [fieldClass, label] of [
    ["field--name-field-hca-date-issued", "Judgment date"],
    ["field--name-field-hca-matter-number", "Case number"],
    ["field--name-field-hca-justices", "Before"],
  ] as const) {
    const element = elementsByClass(html, "div", ["field", fieldClass], 1)[0]
    if (!element) continue
    const value = textOf(element.inner.replace(/<div[^>]{0,300}field__label[^>]*>[\s\S]{0,200}?<\/div>/i, " "))
    if (value) metadata.push([label, value.replace(new RegExp(`^${label}\\s*`, "i"), "")])
  }

  const catchwordsElement = elementsByClass(html, "div", ["field", "field--name-field-hca-catchwords"], 1)[0]
  const catchwords = catchwordsElement
    ? textOf(catchwordsElement.inner.replace(/<div[^>]{0,300}field__label[^>]*>[\s\S]{0,200}?<\/div>/i, " "))
    : undefined

  const documents = links(html, 400)
    .filter((link) => /\/sites\/default\/files\/eresources\//i.test(link.href))
    .map((link) => ({
      label: /\.docx?$/i.test(link.href) ? "DOCX" : /\.pdf$/i.test(link.href) ? "PDF" : link.text || "Download",
      url: absoluteUrl(BASE, link.href),
    }))

  const document: SourceDocument = {
    title,
    url,
    metadata: catchwords ? [...metadata, ["Catchwords", catchwords]] : metadata,
    text: catchwords ?? "",
    note:
      "hcourt.gov.au publishes catchwords and metadata as HTML; the reasons themselves are only " +
      "available as the PDF/DOCX linked below. Nothing here says the reasons do not exist.",
  }
  if (citation) document.citation = citation
  if (documents.length > 0) document.documents = documents
  return document
}

// ── fetchers ──────────────────────────────────────────────────────────────

export async function search(
  client: AuApiClient,
  params: HcourtSearchParams,
): Promise<SourceSearchResult> {
  const path = buildListingPath(params)
  const html = await client.fetchHtml("hcourt", path)
  const result = parseListing(html, `${BASE}/${path}`)
  if (params.page !== undefined) result.page = params.page
  return result
}

export async function getDetail(client: AuApiClient, slug: string): Promise<SourceDocument> {
  const clean = slug.trim().replace(/^.*\//, "")
  const html = await client.fetchHtml("hcourt", `${LISTING}/${encodeURIComponent(clean)}`)
  return parseDetail(html, clean)
}

/** Pages of the year facet walked when resolving a citation. Bounded on purpose. */
export const CITATION_LOOKUP_MAX_PAGES = 6

/**
 * `[2020] HCA 41` → the listing row for that judgment.
 *
 * There is no citation parameter, so the year facet is walked and each row's
 * `.field--citation` compared. Returning `undefined` here means "not found in
 * the pages examined" — the caller must not turn that into "no such case".
 */
export async function findByCitation(
  client: AuApiClient,
  citation: string,
  maxPages = CITATION_LOOKUP_MAX_PAGES,
): Promise<SourceHit | undefined> {
  const parsed = /\[((?:1[89]|20)\d{2})\]\s*(HCA(?:SL|SJ)?)\s*(\d{1,5})/i.exec(citation)
  if (!parsed) return undefined
  const wanted = `[${parsed[1]}] ${parsed[2].toUpperCase()} ${Number(parsed[3])}`

  for (let page = 0; page < maxPages; page++) {
    const result = await search(client, { year: Number(parsed[1]), page })
    const hit = result.hits.find((entry) => normaliseCitation(entry.citation) === wanted)
    if (hit) return hit
    if (result.hits.length === 0) break
    if (result.total !== undefined && (page + 1) * 12 >= result.total) break
  }
  return undefined
}

function normaliseCitation(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /\[((?:1[89]|20)\d{2})\]\s*([A-Za-z]{2,8})\s*(\d{1,5})/.exec(value)
  return match ? `[${match[1]}] ${match[2].toUpperCase()} ${Number(match[3])}` : undefined
}
