/**
 * Integrity, public-service and anti-dumping indexes — three small HTML
 * scrapers that share one property: none of them has a search API, all of them
 * are reachable, and the domain they serve is easy to mis-report as empty
 * (grok-followup.md §3.1–3.4).
 *
 *  - **NACC** — one page, `#operation-{name}` anchors, investigation-report
 *    PDFs. Not a pager, not a tribunal register: these are published reports.
 *  - **MPC** — a Drupal view with a real `keys=` exposed filter and code-of-
 *    conduct / employment-action facets. The items are de-identified case
 *    studies, not merits-review decisions, and every hit says so.
 *  - **ADRP** — current and past review indexes rendered as a three-column
 *    table (reference number, title, date).
 *
 * The Commonwealth Ombudsman belongs to the same integrity domain and is
 * Cloudflare-blocked; it is not scraped here at all — `committee-decisions.ts`
 * emits `[UPSTREAM_BLOCKED]` with the human link, which is the only honest
 * answer available.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { absoluteUrl, attr, blockTextOf, elementsByClass, extractElements, links, textOf } from "./html.js"
import { requireLandmark, type SourceHit, type SourceSearchResult } from "./types.js"

// ── NACC ──────────────────────────────────────────────────────────────────

const NACC_BASE = getHostConfig("nacc").base
const NACC_PATH = "investigation-reports-and-case-studies"

export interface NaccOperation {
  anchor: string
  name: string
  summary: string
  documents: Array<{ label: string; url: string }>
}

export function parseNaccIndex(html: string, sourceUrl: string): NaccOperation[] {
  requireLandmark(html, ['id="operation-', "Investigation reports"], {
    host: "nacc.gov.au",
    url: sourceUrl,
    what: "the investigation-reports index",
  })

  const headings = [
    ...html.matchAll(/<h2\b[^>]{0,300}id="(operation-[a-z0-9-]+)"[^>]*>([\s\S]{0,200}?)<\/h2>/gi),
  ]
  const operations: NaccOperation[] = []
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    const start = (heading.index ?? 0) + heading[0].length
    const end = index + 1 < headings.length ? headings[index + 1].index ?? html.length : html.length
    const section = html.slice(start, end)
    const documents = links(section, 30)
      .filter((link) => /nacc\.gov\.au|^\//.test(link.href))
      .map((link) => ({ label: link.text || "Document", url: absoluteUrl(NACC_BASE, link.href) }))
    operations.push({
      anchor: heading[1],
      name: textOf(heading[2]),
      summary: textOf(section.replace(/<ul\b[\s\S]*?<\/ul\s*>/gi, " ")),
      documents,
    })
  }
  return operations
}

export async function searchNacc(
  client: AuApiClient,
  query?: string,
): Promise<SourceSearchResult> {
  const html = await client.fetchHtml("nacc", NACC_PATH)
  const sourceUrl = `${NACC_BASE}/${NACC_PATH}`
  const operations = parseNaccIndex(html, sourceUrl)
  const needles = (query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 2)
  const matched = operations.filter((operation) => {
    if (needles.length === 0) return true
    const haystack = `${operation.name} ${operation.summary}`.toLowerCase()
    return needles.every((needle) => haystack.includes(needle))
  })

  return {
    hits: matched.map((operation) => {
      const hit: SourceHit = {
        source: "NACC",
        title: operation.name,
        id: operation.anchor,
        url: `${sourceUrl}#${operation.anchor}`,
        snippet: operation.summary.slice(0, 400),
      }
      if (operation.documents.length > 0) {
        hit.extra = operation.documents.map(
          (document) => [document.label, document.url] as [string, string],
        )
      }
      return hit
    }),
    total: matched.length,
    sourceUrl,
    totalNote:
      `The NACC publishes ${operations.length} investigation reports and case studies on one page; ` +
      "there is no search API, so the query was matched over that page.",
  }
}

export async function getNaccOperation(
  client: AuApiClient,
  anchor: string,
): Promise<NaccOperation | undefined> {
  const html = await client.fetchHtml("nacc", NACC_PATH)
  const wanted = anchor.trim().toLowerCase().replace(/^#/, "")
  const operations = parseNaccIndex(html, `${NACC_BASE}/${NACC_PATH}`)
  return (
    operations.find((operation) => operation.anchor === wanted) ??
    operations.find((operation) => operation.name.toLowerCase() === wanted) ??
    operations.find((operation) => operation.anchor.includes(wanted))
  )
}

// ── Merit Protection Commissioner ─────────────────────────────────────────

const MPC_BASE = getHostConfig("mpc").base
const MPC_PATH = "resources/case-studies-merits-review-outcomes"

export interface MpcSearchParams {
  query?: string
  /** Facet values, e.g. `filter_by_code_of_conduct:18`. Emitted as literal `f[n]=`. */
  facets?: readonly string[]
  /** 0-indexed Drupal pager. */
  page?: number
}

export function buildMpcPath(p: MpcSearchParams = {}): string {
  const parts: string[] = []
  if (p.query) parts.push(`keys=${encodeURIComponent(p.query)}`)
  if (p.page) parts.push(`page=${p.page}`)
  ;(p.facets ?? []).forEach((facet, index) => {
    parts.push(`f[${index}]=${encodeURIComponent(facet)}`)
  })
  return parts.length > 0 ? `${MPC_PATH}?${parts.join("&")}` : MPC_PATH
}

export function parseMpcCaseStudies(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ["node--type-case_summary", "views-row", "view-header"], {
    host: "mpc.gov.au",
    url: sourceUrl,
    what: "the case-studies index",
  })

  const hits: SourceHit[] = []
  for (const row of elementsByClass(html, "div", "views-row", 60)) {
    const anchor = links(row.inner, 10).find((link) => link.href.startsWith("/case-summaries/"))
    if (!anchor || !anchor.text) continue
    const fields = elementsByClass(row.inner, "div", "field__item", 12).map((item) => textOf(item.inner))
    const summary = elementsByClass(row.inner, "div", "search__summary", 1)[0]
    const hit: SourceHit = {
      source: "Merit Protection Commissioner",
      title: anchor.text,
      id: anchor.href.replace("/case-summaries/", ""),
      url: absoluteUrl(MPC_BASE, anchor.href),
    }
    if (summary) {
      const text = textOf(summary.inner)
      if (text) hit.snippet = text
    }
    const tags = fields.filter((field) => field && field.length < 60)
    if (tags.length > 0) hit.extra = [["Tags", [...new Set(tags)].join(", ")]]
    hits.push(hit)
  }

  const header = elementsByClass(html, "div", "view-header", 1)[0]
  const total = header ? /([\d,]+)\s*result\(s\)\s*found/i.exec(textOf(header.inner))?.[1] : undefined

  const result: SourceSearchResult = { hits, sourceUrl }
  if (total) {
    const value = Number(total.replace(/,/g, ""))
    if (Number.isFinite(value)) result.total = value
  }
  result.totalNote =
    "These are de-identified case studies of merits-review outcomes published by the Merit " +
    "Protection Commissioner — they are not tribunal decisions and carry no citation."
  return result
}

export async function searchMpc(
  client: AuApiClient,
  params: MpcSearchParams = {},
): Promise<SourceSearchResult> {
  const path = buildMpcPath(params)
  const html = await client.fetchHtml("mpc", path)
  const result = parseMpcCaseStudies(html, `${MPC_BASE}/${path}`)
  result.page = params.page ?? 0
  return result
}

export interface MpcCaseStudy {
  title: string
  url: string
  text: string
}

export function parseMpcCaseStudy(html: string, slug: string): MpcCaseStudy {
  const url = `${MPC_BASE}/case-summaries/${slug}`
  requireLandmark(html, ["node--type-case_summary", "field--name-body"], {
    host: "mpc.gov.au",
    url,
    what: "the case study",
  })
  const title = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(html)?.[1]
  // Scope to the case-summary article first. The page template renders the
  // sitewide search form inside a `field--name-body` too, and it comes FIRST in
  // document order — taking the first match returns the words "Search Search"
  // as the case study's text.
  const article = elementsByClass(html, "article", "node--type-case_summary", 1)[0]
  const scope = article?.inner ?? html
  const body = elementsByClass(scope, "div", "field--name-body", 1)[0]
  return {
    title: title ? textOf(title) : slug.replace(/-/g, " "),
    url,
    text: blockTextOf(body?.inner ?? scope),
  }
}

export async function getMpcCaseStudy(client: AuApiClient, slug: string): Promise<MpcCaseStudy> {
  const clean = slug.trim().replace(/^\/?case-summaries\//, "")
  const html = await client.fetchHtml("mpc", `case-summaries/${encodeURIComponent(clean)}`)
  return parseMpcCaseStudy(html, clean)
}

// ── Anti-Dumping Review Panel ─────────────────────────────────────────────

const ADRP_BASE = getHostConfig("adrp").base
export const ADRP_PATHS = {
  current: "trade/anti-dumping-review-panel/current-anti-dumping-review-panel-reviews",
  past: "trade/anti-dumping-review-panel/past-anti-dumping-review-panel-reviews",
  judicial: "trade/anti-dumping-review-panel/judicial-past-anti-dumping-review-panel-reviews",
  applications:
    "trade/anti-dumping-review-panel/anti-dumping-review-panel-applications-and-duty-assessment-reviews",
} as const

export type AdrpIndex = keyof typeof ADRP_PATHS

export function parseAdrpIndex(html: string, sourceUrl: string): SourceHit[] {
  requireLandmark(html, ["views-field-title", "anti-dumping-review-panel", "views-table"], {
    host: "industry.gov.au",
    url: sourceUrl,
    what: "the review index",
  })

  const hits: SourceHit[] = []
  for (const row of extractElements(html, "tr", () => true, 400)) {
    const anchor = links(row.inner, 6).find((link) =>
      /anti-dumping-review-panel(?:-reviews)?\//.test(link.href),
    )
    if (!anchor || !anchor.text) continue
    const cells = extractElements(row.inner, "td", () => true, 8)
    const reference = cells
      .map((cell) => ({ headers: attr(cell.openTag, "headers") ?? "", text: textOf(cell.inner) }))
      .find((cell) => cell.headers.includes("reference-number"))?.text
    const when = cells
      .map((cell) => ({ headers: attr(cell.openTag, "headers") ?? "", text: textOf(cell.inner) }))
      .find((cell) => cell.headers.includes("field-date"))?.text

    const hit: SourceHit = {
      source: "Anti-Dumping Review Panel",
      title: anchor.text,
      id: anchor.href.replace(/^.*\//, ""),
      url: absoluteUrl(ADRP_BASE, anchor.href),
    }
    if (reference) hit.citation = reference
    if (when) hit.date = when
    hits.push(hit)
  }
  return hits
}

export async function searchAdrp(
  client: AuApiClient,
  p: { query?: string; index?: AdrpIndex; limit?: number } = {},
): Promise<SourceSearchResult> {
  const index = p.index ?? "past"
  const path = ADRP_PATHS[index]
  const html = await client.fetchHtml("adrp", path)
  const sourceUrl = `${ADRP_BASE}/${path}`
  const all = parseAdrpIndex(html, sourceUrl)
  const needles = (p.query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 2)
  const matched = all.filter((hit) => {
    if (needles.length === 0) return true
    const haystack = `${hit.title} ${hit.citation ?? ""}`.toLowerCase()
    return needles.every((needle) => haystack.includes(needle))
  })
  return {
    hits: matched.slice(0, p.limit ?? 20),
    total: matched.length,
    sourceUrl,
    totalNote:
      `Matched over the ADRP '${index}' review index (${all.length} rows) — the panel publishes ` +
      "no search API, so a miss here means the term is absent from this index, not that no review exists.",
  }
}
