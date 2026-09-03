/**
 * ATO Legal Database — rulings, determinations, practice statements,
 * interpretative decisions and decision impact statements
 * (docs/research/tribunals-states-treaties.md §4, grok-followup.md §3.5).
 *
 * The public site is a JavaScript single-page app, but two server-side
 * endpoints under it answer plain HTTP and are what this module uses:
 *
 *  - `POST /API/v1/law/lawservices/result` with a form body — returns an HTML
 *    result fragment. Re-verified live 2026-09-04.
 *  - `GET /law/view/document?docid=…` — the full document as server-rendered
 *    HTML, with `/law/view/print` and `/law/view/pdf` renditions beside it.
 *
 * The result fragment's real markup differs from the note in the research doc
 * (which described `li.document` / `a.resultTitle` and hidden `total` inputs).
 * What the endpoint actually returns, checked on the wire:
 *
 *     <ol class="resultsList list-unstyled" total="2584" totalPages="259" currentPage="1">
 *       <li><div class="resultTitle"><a class="document" href="/law/view/document?…docid=…">ATO ID 2006/34</a></div>
 *           <div class="summary"><strong>Income Tax</strong>…</div></li>
 *
 * so the count lives on the `<ol>` attributes and the classes are one level in
 * from where the note put them. This module encodes the observed reality.
 */

import type { AuApiClient } from "../api-client.js"
import { ATO_PIT_CURRENT, atoDocUrl, atoPdfUrl } from "../external-links-map.js"
import { getHostConfig } from "../upstream-hosts.js"
import { attr, blockTextOf, elementById, elementsByClass, extractElements, firstText, links, textOf } from "./html.js"
import {
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

const BASE = getHostConfig("ato").base
const SEARCH_PATH = "API/v1/law/lawservices/result"

export { ATO_PIT_CURRENT }

/** Document-id prefixes seen in the wild (grok-followup.md §3.5 + live results). */
export const ATO_PREFIXES: Readonly<Record<string, string>> = {
  TXR: "Taxation Ruling (TR)",
  TXD: "Taxation Determination (TD)",
  GST: "GST Ruling/Determination",
  PSR: "Law Administration Practice Statement (PS LA)",
  AID: "ATO Interpretative Decision (ATO ID)",
  PAC: "Principal legislation",
  NEM: "Extrinsic material / explanatory memorandum",
  JUD: "Court and tribunal decision",
  ESO: "Legislative instrument explanatory statement",
  CTR: "Compendium",
}

export interface AtoSearchParams {
  /** All of these words must appear (`tm_and`). */
  allWords?: string
  /** Exact phrase (`tm_phrase`). */
  phrase?: string
  /** Any of these words (`tm_or`). */
  anyWords?: string
  /** 1-based row offset the endpoint calls `start`. */
  start?: number
  pageSize?: number
  /** Point-in-time sentinel; the default is "current". */
  pit?: string
}

export function buildSearchBody(p: AtoSearchParams): URLSearchParams {
  const body = new URLSearchParams()
  if (p.allWords) body.set("tm_and", p.allWords)
  if (p.phrase) body.set("tm_phrase", p.phrase)
  if (p.anyWords) body.set("tm_or", p.anyWords)
  body.set("start", String(p.start ?? 1))
  body.set("pageSize", String(p.pageSize ?? 10))
  body.set("pit", p.pit ?? ATO_PIT_CURRENT)
  return body
}

/** Pull the `docid` out of a result href, percent-decoded. */
export function docIdFromHref(href: string): string | undefined {
  const match = /[?&]docid=([^&]+)/i.exec(href)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export function parseSearchResults(html: string, sourceUrl: string): SourceSearchResult {
  requireLandmark(html, ["resultsList", "searchResult", "resultTitle"], {
    host: "ato.gov.au",
    url: sourceUrl,
    what: "the search results",
  })

  const list = elementsByClass(html, "ol", "resultsList", 1)[0]
  const hits: SourceHit[] = []
  for (const item of extractElements(list?.inner ?? html, "li", () => true, 60)) {
    const titleBlock = elementsByClass(item.inner, "div", "resultTitle", 1)[0]
    if (!titleBlock) continue
    const anchor = links(titleBlock.inner, 3)[0]
    if (!anchor) continue
    const docId = docIdFromHref(anchor.href)
    if (!docId) continue
    const summaryBlock = elementsByClass(item.inner, "div", "summary", 1)[0]
    const hit: SourceHit = {
      source: "ATO Legal Database",
      title: anchor.text,
      id: docId,
      url: atoDocUrl(docId),
    }
    const summary = summaryBlock ? textOf(summaryBlock.inner) : ""
    if (summary) hit.snippet = summary
    const prefix = docId.split("/")[0]?.toUpperCase()
    if (prefix && ATO_PREFIXES[prefix]) hit.extra = [["Product", ATO_PREFIXES[prefix]]]
    hits.push(hit)
  }

  const result: SourceSearchResult = { hits, sourceUrl }
  if (list) {
    const total = Number(attr(list.openTag, "total") ?? "")
    if (Number.isFinite(total)) result.total = total
    const page = Number(attr(list.openTag, "currentPage") ?? "")
    if (Number.isFinite(page)) result.page = page
  }
  return result
}

/** Facet categories the fragment lists (`<li svalue stext category="category">`). */
export function parseCategories(html: string): Array<{ name: string; count: number }> {
  const out: Array<{ name: string; count: number }> = []
  for (const item of extractElements(html, "li", (openTag) => attr(openTag, "category") === "category", 120)) {
    const name = attr(item.openTag, "stext")
    if (!name) continue
    const count = Number(/\((\d[\d,]*)\)\s*$/.exec(textOf(item.inner))?.[1]?.replace(/,/g, "") ?? "")
    out.push({ name, count: Number.isFinite(count) ? count : 0 })
  }
  return out
}

export function parseDocument(html: string, docId: string, pit: string = ATO_PIT_CURRENT): SourceDocument {
  const url = atoDocUrl(docId)
  requireLandmark(html, ['id="LawContents"', 'id="LawFront"', "Legal database"], {
    host: "ato.gov.au",
    url,
    what: "the document",
  })

  const front = elementById(html, "div", "LawFront")
  const productType = front ? firstText(front.inner, /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) : undefined
  const code = front ? firstText(front.inner, /<h2[^>]*>([\s\S]{0,200}?)<\/h2>/i) : undefined
  const subject = front ? firstText(front.inner, /<h3[^>]*>([\s\S]{0,600}?)<\/h3>/i) : undefined
  const pageTitle = firstText(html, /<title>([^<]{0,300})<\/title>/i)?.replace(/\s*\|.*$/, "")

  const contents = elementById(html, "div", "LawContents")
  const reference = elementById(html, "div", "LawReference")
  const body = contents ? blockTextOf(contents.inner) : blockTextOf(html)

  const metadata: Array<[string, string]> = [["DocID", docId]]
  if (productType) metadata.push(["Product", productType])
  if (subject) metadata.push(["Subject", subject])
  if (pit !== ATO_PIT_CURRENT) metadata.push(["Point in time", pit])
  if (reference) {
    const referenceText = blockTextOf(reference.inner)
    if (referenceText) metadata.push(["Related", referenceText.split("\n").slice(0, 12).join(" · ")])
  }

  const scrapedPdf = links(html, 400).find((link) => /\/law\/view\/pdf\?/i.test(link.href))?.href

  return {
    title: code ? `${code}${subject ? ` — ${subject}` : ""}` : pageTitle ?? docId,
    url,
    metadata,
    text: body,
    documents: [
      { label: "Print view", url: `${BASE}/law/view/print?DocID=${encodeURIComponent(docId)}&PiT=${pit}` },
      {
        label: "PDF",
        url: scrapedPdf
          ? (scrapedPdf.startsWith("http") ? scrapedPdf : `${BASE}${scrapedPdf}`)
          : atoPdfUrl(docId, pit),
      },
    ],
  }
}

// ── fetchers ──────────────────────────────────────────────────────────────

export async function search(
  client: AuApiClient,
  params: AtoSearchParams,
): Promise<SourceSearchResult> {
  const body = buildSearchBody(params)
  const html = await client.fetchHtml("ato", SEARCH_PATH, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })
  return parseSearchResults(html, `${BASE}/${SEARCH_PATH}`)
}

/**
 * A known document by id.
 *
 * `docid` is lower-case on `/law/view/document`; the capitalised `DocID` form
 * is the print/pdf spelling and 404s here. Both are kept straight in one place
 * so a caller cannot mix them.
 */
export async function getDocument(
  client: AuApiClient,
  docId: string,
  pit: string = ATO_PIT_CURRENT,
): Promise<SourceDocument> {
  const id = docId.trim()
  const query: Record<string, string> = { docid: id }
  if (pit !== ATO_PIT_CURRENT) query.PiT = pit
  const html = await client.fetchHtml("ato", "law/view/document", { query })
  return parseDocument(html, id, pit)
}

/** `yyyy-mm-dd` → the ATO's historical point-in-time stamp `yyyyMMdd000001`. */
export function pitForDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!match) throw new Error(`ATO point-in-time dates are YYYY-MM-DD; got ${JSON.stringify(date)}`)
  return `${match[1]}${match[2]}${match[3]}000001`
}
