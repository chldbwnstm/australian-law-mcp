/**
 * OAIC privacy determinations index
 * (docs/research/tribunals-states-treaties.md §7).
 *
 * The Commissioner publishes a summary listing — decision name with its
 * `[YYYY] AICmr N` citation, outcome, provisions and catchwords — and links the
 * full determination to AustLII. AustLII is on this server's blocked list, so
 * the honest position for this domain is: the index is live and rich, the full
 * text is one click away in the user's browser, and neither of those facts is
 * "no such determination".
 *
 * Pagination is Squiz's `?result_26111_result_page=N` (1-based) and there is no
 * keyword parameter — filtering happens over the fetched page.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { elementsByClass, links, textOf } from "./html.js"
import { requireLandmark, type SourceHit, type SourceSearchResult } from "./types.js"

const BASE = getHostConfig("oaic").base
const INDEX_PATH =
  "privacy/privacy-assessments-and-decisions/privacy-decisions/privacy-determinations"

export function buildIndexPath(page = 1): string {
  return page > 1 ? `${INDEX_PATH}?result_26111_result_page=${page}` : INDEX_PATH
}

const AICMR = /(\[(?:20)\d{2}\]\s*AICmr\s*\d{1,5})/i

/** Label/value cells of one `article.custom-listing__item`. */
function cellPairs(inner: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const cell of elementsByClass(inner, "div", "custom-listing__cell", 20)) {
    const label = elementsByClass(cell.inner, "p", "custom-listing__cell-title", 1)[0]
    if (!label) continue
    const labelText = textOf(label.inner)
    const rest = cell.inner.slice(label.index + label.openTag.length + label.inner.length)
    const value = textOf(rest)
    if (labelText && value) pairs.push([labelText, value])
  }
  return pairs
}

export function parseDeterminations(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ["custom-listing__item", "custom-listing__cell", "AICmr"], {
    host: "oaic.gov.au",
    url: sourceUrl,
    what: "the determinations index",
  })

  const hits: SourceHit[] = []
  for (const item of elementsByClass(html, "article", "custom-listing__item", 60)) {
    const pairs = cellPairs(item.inner)
    const decision = pairs.find(([label]) => /^decision$/i.test(label))?.[1]
    if (!decision) continue
    const citation = AICMR.exec(decision)?.[1]
    const austlii = links(item.inner, 10).find((link) => /austlii\.edu\.au/i.test(link.href))

    const hit: SourceHit = {
      source: "OAIC",
      // The listing prints "Name (Privacy) [2026] AICmr 40 (11 June 2026)".
      title: decision.replace(/\s*\((\d{1,2} [A-Za-z]+ \d{4})\)\s*$/, "").trim(),
      id: citation ?? decision.slice(0, 80),
      url: austlii ? austlii.href : sourceUrl,
    }
    if (citation) hit.citation = citation.replace(/\s+/g, " ")
    const date = pairs.find(([label]) => /decision year|date/i.test(label))?.[1]
    if (date) hit.date = date
    const catchwords = pairs.find(([label]) => /catchword/i.test(label))?.[1]
    if (catchwords) hit.catchwords = catchwords
    const extra = pairs.filter(([label]) => /status|provision|determination/i.test(label))
    if (extra.length > 0) hit.extra = extra
    hits.push(hit)
  }

  const total = /of\s*<span[^>]{0,80}class="count"[^>]*>\s*([\d,]+)\s*<\/span>/i.exec(html)?.[1]
    ?? /of\s+([\d,]+)\s+results/i.exec(textOf(html))?.[1]

  const result: SourceSearchResult = { hits, sourceUrl }
  if (total) {
    const value = Number(total.replace(/,/g, ""))
    if (Number.isFinite(value)) result.total = value
  }
  return result
}

/** Case-insensitive filtering over an already-fetched index page. */
export function filterHits(hits: SourceHit[], query: string | undefined): SourceHit[] {
  if (!query) return hits
  const needles = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1)
  if (needles.length === 0) return hits
  return hits.filter((hit) => {
    const haystack = [hit.title, hit.citation, hit.catchwords, ...(hit.extra ?? []).map(([, v]) => v)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return needles.every((needle) => haystack.includes(needle))
  })
}

export async function searchDeterminations(
  client: AuApiClient,
  p: { query?: string; page?: number } = {},
): Promise<SourceSearchResult> {
  const path = buildIndexPath(p.page ?? 1)
  const html = await client.fetchHtml("oaic", path)
  const parsed = parseDeterminations(html, `${BASE}/${path}`)
  const filtered = filterHits(parsed.hits, p.query)
  const result: SourceSearchResult = {
    ...parsed,
    hits: filtered,
    page: p.page ?? 1,
  }
  if (p.query) {
    result.totalIsUnreliable = true
    result.totalNote =
      `The OAIC index has no keyword parameter, so '${p.query}' was matched against page ` +
      `${p.page ?? 1} only (${parsed.hits.length} determinations on this page` +
      `${parsed.total !== undefined ? ` of ${parsed.total} in total` : ""}). Raise \`page\` to look further.`
  }
  return result
}
