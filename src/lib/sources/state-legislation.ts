/**
 * One interface over eight very different state/territory registers
 * (docs/research/tribunals-states-treaties.md §2).
 *
 * The registers do not converge, so this module does not pretend they do. What
 * it guarantees is that the *shape* of the answer is the same everywhere and
 * that a register this server cannot reach is reported as unreached:
 *
 *  - **QLD, TAS** — real search (EnAct `projectdata`) and real full text.
 *  - **WA** — the A–Z in-force index doubles as the search surface *and*
 *    carries the `mrdoc_*` full-text link on the same row, so one page answers
 *    both questions.
 *  - **NT** — the By-Title list is the search surface; the text is a PDF/Word
 *    download behind `/api/sitecore/Act/{PDF,Word}?id=`.
 *  - **VIC** — act pages are addressable by slug and carry version history, but
 *    the authorised PDF/DOCX links are rendered client-side and are *not* in the
 *    served HTML (checked live 2026-09-04; the research note that they sit in
 *    the version page no longer holds). Reported as a limitation, never as
 *    "no text exists".
 *  - **ACT** — deep URLs only. `/a/{year}-{n}/` works; every index path probed
 *    (`/Browse/…`, `/Search/Results`, `/sitemap.xml`) is a 404, so there is no
 *    title search to offer and saying so is the honest answer.
 *  - **NSW, SA** — blocked hosts. `[UPSTREAM_BLOCKED]` plus a deep link, always.
 */

import type { AuApiClient } from "../api-client.js"
import { UpstreamBlockedError } from "../errors.js"
import { nswLegislationUrl, saLegislationUrl } from "../external-links-map.js"
import { getHostConfig } from "../upstream-hosts.js"
import { absoluteUrl, attr, elementsByClass, extractElements, firstText, links, textOf } from "./html.js"
import * as enact from "./enact-projectdata.js"
import {
  requireLandmark,
  type SourceDocument,
  type SourceHit,
  type SourceSearchResult,
} from "./types.js"

export type StateJurisdiction = "QLD" | "TAS" | "WA" | "VIC" | "NT" | "ACT" | "NSW" | "SA"

const ALIASES: Record<string, StateJurisdiction> = {
  qld: "QLD", queensland: "QLD",
  tas: "TAS", tasmania: "TAS",
  wa: "WA", "western australia": "WA",
  vic: "VIC", victoria: "VIC",
  nt: "NT", "northern territory": "NT",
  act: "ACT", "australian capital territory": "ACT",
  nsw: "NSW", "new south wales": "NSW",
  sa: "SA", "south australia": "SA",
}

export function normaliseJurisdiction(input: string): StateJurisdiction | undefined {
  return ALIASES[input.trim().toLowerCase()]
}

export const STATE_JURISDICTIONS: readonly StateJurisdiction[] = [
  "QLD", "TAS", "WA", "VIC", "NT", "ACT", "NSW", "SA",
]

// ── blocked registers ─────────────────────────────────────────────────────

function blockedError(jurisdiction: "NSW" | "SA", hint?: string): UpstreamBlockedError {
  const key = jurisdiction === "NSW" ? "nswLegislation" : "saLegislation"
  const config = getHostConfig(key)
  const linkList = [config.base]
  const numbered = hint ? /(?:act[- ])?((?:1[89]|20)\d{2})[- ](\d{1,3})/i.exec(hint) : null
  if (jurisdiction === "NSW" && numbered) {
    linkList.unshift(nswLegislationUrl(Number(numbered[1]), Number(numbered[2])))
  }
  if (jurisdiction === "SA" && hint) {
    linkList.unshift(saLegislationUrl(hint.trim().toUpperCase().replace(/\s+/g, "%20")))
  }
  return new UpstreamBlockedError(key, config.blockedReason ?? "blocked by policy", linkList)
}

// ── Western Australia ─────────────────────────────────────────────────────

const WA_BASE = getHostConfig("waLegislation").base
const WA_NSF = "legislation/statutes.nsf"

/** `Dog Act 1976` → `d`. The A–Z lists file every act under its first letter. */
export function waIndexLetter(query: string): string {
  const word = query.trim().replace(/^(?:the|a|an)\s+/i, "")
  const letter = word.slice(0, 1).toLowerCase()
  return /^[a-z]$/.test(letter) ? letter : "a"
}

export interface WaActRow {
  title: string
  /** Act page id, e.g. `law_a101`. */
  pageId: string
  actNumber?: string
  /** Full-text document id, e.g. `mrdoc_23112`. */
  mrdocId?: string
}

export function parseWaIndex(html: string, sourceUrl: string): WaActRow[] {
  requireLandmark(html, ["actsbyletter", "citation alive", "law_a"], {
    host: "legislation.wa.gov.au",
    url: sourceUrl,
    what: "the A–Z act index",
  })
  const rows: WaActRow[] = []
  for (const row of extractElements(html, "tr", () => true, 800)) {
    const anchors = links(row.inner, 10)
    const titleLink = anchors.find((link) => /law_[a-z]\d+\.html/i.test(link.href))
    if (!titleLink || !titleLink.text) continue
    const cells = extractElements(row.inner, "td", () => true, 8).map((cell) => textOf(cell.inner))
    const mrdoc = anchors
      .map((link) => /query=(mrdoc_\d+)\.(?:htm|html)/i.exec(link.href)?.[1])
      .find((id): id is string => Boolean(id))
    const entry: WaActRow = {
      title: titleLink.text,
      pageId: (/((?:law_[a-z]\d+))\.html/i.exec(titleLink.href)?.[1] ?? "").toLowerCase(),
    }
    if (cells[1]) entry.actNumber = cells[1]
    if (mrdoc) entry.mrdocId = mrdoc
    rows.push(entry)
  }
  return rows
}

function waHumanUrl(pageId: string): string {
  return `${WA_BASE}/${WA_NSF}/${pageId}.html`
}

async function searchWa(client: AuApiClient, query: string, limit: number): Promise<SourceSearchResult> {
  const letter = waIndexLetter(query)
  const path = `${WA_NSF}/actsif_${letter}.html`
  const html = await client.fetchHtml("waLegislation", path)
  const sourceUrl = `${WA_BASE}/${path}`
  const rows = parseWaIndex(html, sourceUrl)
  const needles = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2)
  const matched = rows.filter((row) => {
    const title = row.title.toLowerCase()
    return needles.length === 0 || needles.every((needle) => title.includes(needle))
  })

  const hits: SourceHit[] = matched.slice(0, limit).map((row) => {
    const hit: SourceHit = {
      source: "WA Legislation",
      title: row.title,
      id: row.mrdocId ?? row.pageId,
      url: waHumanUrl(row.pageId),
    }
    if (row.actNumber) hit.extra = [["Act no", row.actNumber]]
    return hit
  })
  return {
    hits,
    total: matched.length,
    sourceUrl,
    totalNote: `Matched against the '${letter.toUpperCase()}' in-force index only — WA has no server-side search form.`,
  }
}

async function getWaText(client: AuApiClient, id: string): Promise<SourceDocument> {
  let mrdoc = /^(mrdoc_\d+)$/i.exec(id)?.[1]
  let pageId = /^(law_[a-z]\d+)$/i.exec(id)?.[1]
  if (!mrdoc && pageId) {
    const page = await client.fetchHtml("waLegislation", `${WA_NSF}/${pageId}.html`)
    mrdoc = links(page, 200)
      .map((link) => /query=(mrdoc_\d+)\.(?:htm|html)/i.exec(link.href)?.[1])
      .find((found): found is string => Boolean(found))
  }
  if (!mrdoc) {
    throw new Error(
      `WA ids look like law_a101 (act page) or mrdoc_23112 (full text); got ${JSON.stringify(id)}. ` +
      "Take the id from search_state_law results.",
    )
  }
  const path = `${WA_NSF}/RedirectURL?OpenAgent&query=${mrdoc}.htm`
  const html = await client.fetchHtml("waLegislation", path)
  const url = `${WA_BASE}/${path}`
  requireLandmark(html, ["<body", "<BODY", "<p", "<P"], {
    host: "legislation.wa.gov.au",
    url,
    what: "the act text",
  })
  const title = firstText(html, /<title>([^<]{0,300})<\/title>/i) ?? mrdoc
  const document: SourceDocument = {
    title,
    url,
    metadata: pageId ? [["Act page", waHumanUrl(pageId)]] : [],
    text: textOf(html).slice(0, 400_000),
    documents: [
      { label: "PDF", url: `${WA_BASE}/${WA_NSF}/RedirectURL?OpenAgent&query=${mrdoc}.pdf` },
      { label: "Word", url: `${WA_BASE}/${WA_NSF}/RedirectURL?OpenAgent&query=${mrdoc}.docx` },
    ],
  }
  return document
}

// ── Northern Territory ────────────────────────────────────────────────────

const NT_BASE = getHostConfig("ntLegislation").base

export function parseNtIndex(html: string, sourceUrl: string): Array<{ slug: string; title: string }> {
  requireLandmark(html, ["/en/Legislation/", "legislation-category-panel"], {
    host: "legislation.nt.gov.au",
    url: sourceUrl,
    what: "the By-Title act list",
  })
  const out: Array<{ slug: string; title: string }> = []
  const seen = new Set<string>()
  for (const link of links(html, 1200)) {
    const match = /^\/en\/Legislation\/([A-Za-z0-9-]+)$/.exec(link.href)
    if (!match || !link.text || seen.has(match[1])) continue
    seen.add(match[1])
    out.push({ slug: match[1], title: link.text })
  }
  return out
}

async function searchNt(client: AuApiClient, query: string, limit: number): Promise<SourceSearchResult> {
  const path = "en/LegislationPortal/Acts/By-Title"
  const html = await client.fetchHtml("ntLegislation", path)
  const sourceUrl = `${NT_BASE}/${path}`
  const needles = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2)
  const matched = parseNtIndex(html, sourceUrl).filter((entry) => {
    const title = entry.title.toLowerCase()
    return needles.length === 0 || needles.every((needle) => title.includes(needle))
  })
  return {
    hits: matched.slice(0, limit).map((entry) => ({
      source: "NT Legislation" as const,
      title: entry.title,
      id: entry.slug,
      url: `${NT_BASE}/en/Legislation/${entry.slug}`,
    })),
    total: matched.length,
    sourceUrl,
    totalNote: "Matched by title against the NT By-Title list — the register has no full-text search.",
  }
}

export function parseNtActPage(html: string, slug: string): SourceDocument {
  const url = `${NT_BASE}/en/Legislation/${slug}`
  requireLandmark(html, ["/api/sitecore/Act/", "Legislation"], {
    host: "legislation.nt.gov.au",
    url,
    what: "the act page",
  })
  const documents: Array<{ label: string; url: string }> = []
  for (const link of links(html, 300)) {
    const match = /\/api\/sitecore\/Act\/(PDF|Word)\?id=(\d+)/i.exec(link.href)
    if (!match) continue
    const label = match[1].toUpperCase() === "PDF" ? "PDF" : "Word"
    const absolute = absoluteUrl(NT_BASE, link.href)
    if (!documents.some((entry) => entry.url === absolute)) documents.push({ label, url: absolute })
  }
  const document: SourceDocument = {
    title: slug.replace(/-/g, " "),
    url,
    metadata: [],
    text: "",
    note:
      "The Northern Territory register publishes act text as PDF/Word downloads only; the HTML page " +
      "carries metadata and the download links below. This is a format limitation, not an absence.",
  }
  if (documents.length > 0) document.documents = documents
  return document
}

// ── Victoria ──────────────────────────────────────────────────────────────

const VIC_BASE = getHostConfig("vicLegislation").base

/** `Crimes Act 1958` → `crimes-act-1958` (the register's own slug grammar). */
export function vicSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export function parseVicActPage(html: string, slug: string): SourceDocument {
  const url = `${VIC_BASE}/in-force/acts/${slug}`
  requireLandmark(html, ["legislation.vic.gov.au", "<title>"], {
    host: "legislation.vic.gov.au",
    url,
    what: "the act page",
  })
  const title =
    firstText(html, /<title>([^<]{0,300})<\/title>/i)?.replace(/\s*\|.*$/, "") ?? slug.replace(/-/g, " ")

  const metadata: Array<[string, string]> = []
  for (const item of elementsByClass(html, "span", "lgs-hero-header__meta-item", 6)) {
    const value = textOf(item.inner)
    const [label, ...rest] = value.split(/\s+/)
    if (rest.length > 0) metadata.push([label === "Act" ? "Act number" : label, rest.join(" ").replace(/^number\s*/i, "")])
  }

  const versions: Array<{ label: string; url: string }> = []
  for (const link of links(html, 400)) {
    const match = new RegExp(`^/in-force/acts/${slug}/(\\d+)$`).exec(link.href)
    if (!match || versions.some((entry) => entry.url.endsWith(`/${match[1]}`))) continue
    versions.push({ label: `Version ${match[1]}`, url: `${VIC_BASE}${link.href}` })
  }

  const document: SourceDocument = {
    title,
    url,
    metadata,
    text: "",
    note:
      "legislation.vic.gov.au serves act pages and version history as HTML, but the authorised " +
      "PDF/DOCX links are injected by JavaScript and are not present in the server response " +
      "(verified 2026-09-04). Open the page above to download the authorised text — this server " +
      "did not receive it, which says nothing about whether it exists.",
  }
  if (versions.length > 0) document.documents = versions.slice(0, 12)
  return document
}

async function searchVic(client: AuApiClient, query: string): Promise<SourceSearchResult> {
  const slug = vicSlug(query)
  const sourceUrl = `${VIC_BASE}/in-force/acts/${slug}`
  try {
    const html = await client.fetchHtml("vicLegislation", `in-force/acts/${slug}`)
    const document = parseVicActPage(html, slug)
    return {
      hits: [{ source: "VIC Legislation", title: document.title, id: slug, url: sourceUrl }],
      total: 1,
      sourceUrl,
      totalNote:
        "Victoria has no server-side search endpoint; the title was resolved by slug. " +
        "A miss here means the slug did not match, not that the act does not exist.",
    }
  } catch {
    return {
      hits: [],
      total: 0,
      sourceUrl: `${VIC_BASE}/in-force/acts`,
      totalNote:
        `Victoria has no server-side search endpoint. The slug '${slug}' derived from the query did ` +
        "not resolve, which is not evidence the act is absent — browse the in-force list above, or " +
        "retry with the exact act title including its year.",
    }
  }
}

// ── Australian Capital Territory ──────────────────────────────────────────

const ACT_BASE = getHostConfig("actLegislation").base

/** `a/2001-14`, `2001-14`, `Legislation Act 2001 a 2001-14` → `2001-14`. */
export function actRegisterId(input: string): string | undefined {
  const match = /((?:1[89]|20)\d{2})[-–](\d{1,4})/.exec(input)
  return match ? `${match[1]}-${match[2]}` : undefined
}

export function actDownloadUrls(id: string): Array<{ label: string; url: string }> {
  return [
    { label: "PDF", url: `${ACT_BASE}/DownloadFile/a/${id}/current/PDF/${id}.PDF` },
    { label: "DOCX", url: `${ACT_BASE}/DownloadFile/a/${id}/current/DOCX/${id}.DOCX` },
  ]
}

export function parseActPage(html: string, id: string): SourceDocument {
  const url = `${ACT_BASE}/a/${id}/`
  requireLandmark(html, ["DownloadFile", "<title>"], {
    host: "legislation.act.gov.au",
    url,
    what: "the act page",
  })
  const title =
    firstText(html, /<title>([^<]{0,300})<\/title>/i)?.replace(/\s*\|.*$/, "") ?? `ACT act ${id}`
  // The register lists the current version in more than one place on the page,
  // so the same href appears several times; a caller reading "PDF, DOCX, PDF,
  // DOCX" cannot tell whether the duplicates are different documents.
  const seen = new Set<string>()
  const current = links(html, 600)
    .filter((link) => /\/DownloadFile\/a\/[^/]+\/current\//i.test(link.href))
    .map((link) => ({
      label: /DOCX/i.test(link.href) ? "DOCX" : /RTF/i.test(link.href) ? "RTF" : "PDF",
      url: absoluteUrl(ACT_BASE, link.href),
    }))
    .filter((entry) => {
      if (seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
  return {
    title,
    url,
    metadata: [["Register id", `a/${id}`]],
    text: "",
    documents: current.length > 0 ? current : actDownloadUrls(id),
    note:
      "The ACT register publishes act text as PDF/DOCX downloads; the HTML page is an index of " +
      "versions. There is no reachable title index — every browse and search path returns 404 to a " +
      "non-browser client — so ACT lookups need the `YYYY-N` register number.",
  }
}

async function searchAct(client: AuApiClient, query: string): Promise<SourceSearchResult> {
  const id = actRegisterId(query)
  if (!id) {
    return {
      hits: [],
      sourceUrl: ACT_BASE,
      totalNote:
        "The ACT Legislation Register exposes no index or search path to a non-browser client " +
        "(every one probed returns 404), so a title cannot be resolved here. Supply the register " +
        "number instead — e.g. '2001-14' for the Legislation Act 2001. This is a limitation of the " +
        "register's public surface, not a statement that the act does not exist.",
    }
  }
  const html = await client.fetchHtml("actLegislation", `a/${id}/`)
  const document = parseActPage(html, id)
  return {
    hits: [{ source: "ACT Legislation", title: document.title, id, url: document.url }],
    total: 1,
    sourceUrl: document.url,
  }
}

// ── unified entry points ──────────────────────────────────────────────────

export interface StateSearchOptions {
  /** Maximum hits returned from an index-scan register (WA/NT). */
  limit?: number
  /** QLD/TAS CCL field; `Content` is full text, `Title` is the act name. */
  field?: enact.CclField
  includeRepealed?: boolean
}

export async function searchStateLaw(
  client: AuApiClient,
  jurisdiction: StateJurisdiction,
  query: string,
  options: StateSearchOptions = {},
): Promise<SourceSearchResult> {
  const limit = options.limit ?? 20
  switch (jurisdiction) {
    case "QLD":
    case "TAS": {
      const p: Parameters<typeof enact.search>[2] = { query, count: limit }
      if (options.field) p.field = options.field
      if (options.includeRepealed !== undefined) p.includeRepealed = options.includeRepealed
      return enact.search(client, jurisdiction, p)
    }
    case "WA":
      return searchWa(client, query, limit)
    case "NT":
      return searchNt(client, query, limit)
    case "VIC":
      return searchVic(client, query)
    case "ACT":
      return searchAct(client, query)
    case "NSW":
    case "SA":
      throw blockedError(jurisdiction, query)
  }
}

export async function getStateLawText(
  client: AuApiClient,
  jurisdiction: StateJurisdiction,
  id: string,
): Promise<SourceDocument> {
  const clean = id.trim()
  switch (jurisdiction) {
    case "QLD":
    case "TAS": {
      const html = await enact.getWholeText(client, jurisdiction, clean)
      const url = enact.humanUrl(jurisdiction, clean)
      requireLandmark(html, ["<body", "<BODY", "<div", "<p"], {
        host: jurisdiction === "QLD" ? "legislation.qld.gov.au" : "legislation.tas.gov.au",
        url,
        what: "the act text",
      })
      const title = firstText(html, /<title>([^<]{0,300})<\/title>/i) ?? clean
      return {
        title,
        url,
        metadata: [["Register id", clean]],
        text: textOf(html).slice(0, 400_000),
      }
    }
    case "WA":
      return getWaText(client, clean)
    case "NT": {
      const slug = clean.replace(/^\/?en\/Legislation\//i, "").toUpperCase()
      const html = await client.fetchHtml("ntLegislation", `en/Legislation/${slug}`)
      return parseNtActPage(html, slug)
    }
    case "VIC": {
      const slug = /^[a-z0-9-]+$/.test(clean) ? clean : vicSlug(clean)
      const html = await client.fetchHtml("vicLegislation", `in-force/acts/${slug}`)
      return parseVicActPage(html, slug)
    }
    case "ACT": {
      const registerId = actRegisterId(clean)
      if (!registerId) {
        throw new Error(
          `ACT ids are register numbers like 2001-14; got ${JSON.stringify(id)}. ` +
          "The register offers no title index to resolve a name into one.",
        )
      }
      const html = await client.fetchHtml("actLegislation", `a/${registerId}/`)
      return parseActPage(html, registerId)
    }
    case "NSW":
    case "SA":
      throw blockedError(jurisdiction, clean)
  }
}

