/**
 * Fair Work Commission document search
 * (docs/research/tribunals-states-treaties.md §5).
 *
 * One trap dominates this source: **the result-count element is a lie.** The
 * page prints "Showing 1 - 25 of 186201 results" for every query, narrow or
 * broad, because it reports the facet-wide document total rather than the hit
 * count. The rows themselves *are* filtered. So the count here is taken from
 * the rows, and the site's own figure is carried only as a labelled note — a
 * tool that repeats 186,201 as the answer to "how many unfair dismissal
 * decisions mention X" is confidently wrong.
 *
 * Facet parameters (`f[0]=bench-type:full`) use literal square brackets, so the
 * query string is assembled here instead of going through `FetchOpts.query`,
 * which percent-encodes values.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { absoluteUrl, elementsByClass, firstText, links, textOf } from "./html.js"
import {
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

const BASE = getHostConfig("fwc").base
const SEARCH_PATH = "document-search"

/** The `search-ui` values the endpoint accepts (§5). */
export type FwcSearchUi = "decisions" | "awards" | "agreements" | "rlhao"

export interface FwcSearchParams {
  query: string
  searchUi?: FwcSearchUi
  /** `full` | `single` — the bench-type facet. */
  benchType?: "full" | "single"
  /** Raw extra facets, e.g. `case-type:1234`. Emitted as `f[n]=…`. */
  facets?: readonly string[]
  /** 0-indexed; 25 rows per page. */
  page?: number
  sort?: string
}

export function buildSearchPath(p: FwcSearchParams): string {
  const parts = [
    `search-ui=${encodeURIComponent(p.searchUi ?? "decisions")}`,
    `search=${encodeURIComponent(p.query)}`,
    `sort=${encodeURIComponent(p.sort ?? "search_api_relevance:DESC")}`,
    `page=${p.page ?? 0}`,
  ]
  const facets = [...(p.benchType ? [`bench-type:${p.benchType}`] : []), ...(p.facets ?? [])]
  facets.forEach((facet, index) => {
    // Literal brackets on purpose — see the module note.
    parts.push(`f[${index}]=${encodeURIComponent(facet)}`)
  })
  return `${SEARCH_PATH}?${parts.join("&")}`
}

const TITLE_CITATION = /\s*[-–]\s*(\[(?:1[89]|20)\d{2}\]\s+FWC[A-Z]{0,3}\s+\d{1,6})\s*$/

export function parseSearchResults(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ["faceted-search-item", "fwc-results-item", "result-title-link"], {
    host: "fwc.gov.au",
    url: sourceUrl,
    what: "the decision list",
  })

  const hits: SourceHit[] = []
  for (const row of elementsByClass(html, "div", ["views-row", "faceted-search-item"], 60)) {
    const titleElement = elementsByClass(row.inner, "h3", "result-title", 1)[0]
    const anchor = links(titleElement?.inner ?? row.inner, 4).find((link) =>
      link.href.includes("/document-view/"),
    )
    if (!anchor || !anchor.text) continue
    const citation = TITLE_CITATION.exec(anchor.text)
    const slug = anchor.href.replace(/^.*\/document-view\/[^/]+\//, "").replace(/\?.*$/, "")

    const hit: SourceHit = {
      source: "Fair Work Commission",
      title: citation ? anchor.text.slice(0, citation.index).trim() : anchor.text,
      id: slug,
      url: absoluteUrl(BASE, anchor.href.replace(/\?from=search$/, "")),
    }
    if (citation) hit.citation = citation[1].replace(/\s+/g, " ")

    const excerpt = elementsByClass(row.inner, "div", "search-excerpt", 1)[0]
    if (excerpt) {
      const text = textOf(excerpt.inner)
      if (text) hit.snippet = text
    }
    const chips = elementsByClass(row.inner, "div", "fwc-chip", 6).map((chip) => textOf(chip.inner))
    const date = chips.find((chip) => /\d{1,2} [A-Z][a-z]+ \d{4}/.test(chip))
    if (date) hit.date = date
    const download = links(row.inner, 10).find((link) =>
      /\/document-view\/media\/download\/\d+/.test(link.href),
    )
    if (download) {
      hit.extra = [["Download", absoluteUrl(BASE, download.href)]]
    }
    hits.push(hit)
  }

  const summary = elementsByClass(html, "div", "search-results-summary", 1)[0]
  const facetTotal = summary ? /of\s+([\d,]+)\s+results/i.exec(textOf(summary.inner))?.[1] : undefined

  const result: SourceSearchResult = {
    hits,
    // The row count is the only honest number this page yields.
    total: hits.length,
    sourceUrl,
  }
  if (facetTotal) {
    result.totalIsUnreliable = true
    result.totalNote =
      `The FWC page prints "${facetTotal} results" for every query — that element reports the ` +
      "facet-wide document total, not the hits for this search. Only the returned rows are filtered."
  }
  return result
}

export function parseDecisionPage(html: string, slug: string): SourceDocument {
  const url = `${BASE}/document-view/decisions/${slug}`
  requireLandmark(html, ["document-node__title", "node--type-document", "fwc-chip"], {
    host: "fwc.gov.au",
    url,
    what: "the decision page",
  })

  const heading =
    firstText(html, /<h1[^>]{0,200}document-node__title[^>]*>([\s\S]{0,600}?)<\/h1>/i) ??
    firstText(html, /<title>([^<]{0,300})<\/title>/i)?.replace(/\s*\|.*$/, "") ??
    slug
  const citation = TITLE_CITATION.exec(heading)

  const metadata: Array<[string, string]> = []
  for (const [chipClass, label] of [
    ["chip-bench-type", "Bench"],
    ["chip-case-number", "Case number"],
    ["chip-document-type", "Document type"],
    ["chip-date", "Date"],
    ["chip-member", "Member"],
  ] as const) {
    const chip = elementsByClass(html, "div", ["fwc-chip", chipClass], 1)[0]
    if (!chip) continue
    const value = textOf(chip.inner.replace(/<span[^>]{0,200}chip-icon[^>]*>[\s\S]{0,80}?<\/span>/i, " "))
    if (value) metadata.push([label, value])
  }

  const download = links(html, 300).find((link) =>
    /\/document-view\/media\/download\/\d+/.test(link.href),
  )

  const document: SourceDocument = {
    title: citation ? heading.slice(0, citation.index).trim() : heading,
    url,
    metadata,
    text: "",
    bodyStatus: "binary_link_only",
    note:
      "The FWC serves decision reasons as a PDF inside a viewer; the HTML page carries only the " +
      "metadata above and the download link. The reasons exist — this server just did not receive " +
      "them as text.",
  }
  if (citation) document.citation = citation[1].replace(/\s+/g, " ")
  if (download) document.documents = [{ label: "PDF", url: absoluteUrl(BASE, download.href) }]
  return document
}

// ── fetchers ──────────────────────────────────────────────────────────────

export async function search(
  client: AuApiClient,
  params: FwcSearchParams,
): Promise<SourceSearchResult> {
  const path = buildSearchPath(params)
  const html = await client.fetchHtml("fwc", path)
  const result = parseSearchResults(html, `${BASE}/${path}`)
  result.page = params.page ?? 0
  return result
}

export async function getDecision(client: AuApiClient, slug: string): Promise<SourceDocument> {
  const clean = slug.trim().replace(/^.*\/document-view\/[^/]+\//, "").replace(/\?.*$/, "")
  const html = await client.fetchHtml("fwc", `document-view/decisions/${encodeURIComponent(clean)}`)
  return parseDecisionPage(html, clean)
}

/** Deterministic PDF URL once a media id is known. */
export function downloadUrl(mediaId: string | number): string {
  return `${BASE}/document-view/media/download/${mediaId}`
}
