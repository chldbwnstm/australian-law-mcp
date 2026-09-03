/**
 * Explanatory material for Commonwealth law — two different sources for two
 * different kinds of instrument (grok-followup.md Part 1).
 *
 *  - **Legislative instruments** carry their explanatory statement on the
 *    Federal Register itself, as a `type='ES'` document. Verified end to end:
 *    `Documents?$filter=titleId eq 'F2011L00287' and type eq 'ES'` lists Pdf,
 *    Word and Epub renditions, and
 *    `/{id}/asmade/{yyyy-mm-dd}/es/original/pdf` returns the bytes. The date
 *    segment is the **making date**, not today.
 *  - **Acts** carry nothing of the sort. Their explanatory memorandum belongs
 *    to the *bill*, and lives on ParlInfo. The Register stores the bridge:
 *    `Title.originatingBillUri`, whose id is `legislation/billhome/{r|s}{nnnn}`.
 *    The APH bill page for that id lists `legislation/ems/{billId}_ems_{uuid}`
 *    download links, and the uuid cannot be guessed.
 *
 * One deliberate limitation: ParlInfo is a different host
 * (`parlinfo.aph.gov.au`) from the one in this server's host table
 * (`www.aph.gov.au`), so the EM's own HTML is not fetched here. The links are
 * built and returned instead — which is a coverage gap, not a claim that the
 * memorandum does not exist.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { links } from "./html.js"

const APH_BASE = getHostConfig("aph").base
const PARLINFO = "https://parlinfo.aph.gov.au"

export interface FrlDocument {
  titleId: string
  type: string
  format: string
  start?: string
  sizeInBytes?: number
  isAuthorised?: boolean
  extension?: string
}

/** `Documents?$filter=titleId eq '…' and type eq 'ES'` → the rendition list. */
export function parseDocuments(json: unknown): FrlDocument[] {
  const value = (json as { value?: unknown[] } | null)?.value
  if (!Array.isArray(value)) return []
  const out: FrlDocument[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    if (typeof row.titleId !== "string" || typeof row.type !== "string" || typeof row.format !== "string") {
      continue
    }
    const document: FrlDocument = { titleId: row.titleId, type: row.type, format: row.format }
    if (typeof row.start === "string") document.start = row.start.slice(0, 10)
    if (typeof row.sizeInBytes === "number") document.sizeInBytes = row.sizeInBytes
    if (typeof row.isAuthorised === "boolean") document.isAuthorised = row.isAuthorised
    if (typeof row.extension === "string") document.extension = row.extension
    out.push(document)
  }
  return out
}

/**
 * `/{titleId}/asmade/{yyyy-mm-dd}/es/original/{format}`.
 *
 * When the making date is unknown the doubled `/asmade/asmade/` alias also
 * resolves, but the dated form is preferred in production: it records which
 * version was fetched.
 */
export function esDownloadUrl(
  titleId: string,
  format: "pdf" | "word" | "epub",
  madeOn?: string,
): string {
  const date = madeOn && /^\d{4}-\d{2}-\d{2}$/.test(madeOn) ? madeOn : "asmade"
  return `https://www.legislation.gov.au/${titleId}/asmade/${date}/es/original/${format}`
}

export async function listExplanatoryStatements(
  client: AuApiClient,
  titleId: string,
): Promise<FrlDocument[]> {
  const json = await client.fetchJson("frlApi", "Documents", {
    query: { $filter: `titleId eq '${titleId}' and type eq 'ES'` },
  })
  return parseDocuments(json)
}

/**
 * `…/legislation/billhome/r6940` → `r6940`.
 *
 * The Register stores this URI **percent-encoded inside its own query string**
 * — the live value is `…query=Id%3A"legislation%2Fbillhome%2Fr6940"` — so a
 * pattern written against the readable form silently matches nothing, and the
 * Act's explanatory memorandum then looks like it does not exist. Decode first,
 * and accept the raw form too in case a future record is stored unencoded.
 */
export function billIdFromUri(uri: string | null | undefined): string | undefined {
  if (!uri) return undefined
  let decoded = uri
  try {
    decoded = decodeURIComponent(uri)
  } catch {
    // A malformed escape is not a reason to give up on the raw string.
  }
  const pattern = /legislation[/%2F]{1,3}billhome[/%2F]{1,3}([rs]\d{1,5})/i
  return pattern.exec(decoded)?.[1] ?? pattern.exec(uri)?.[1]
}

/**
 * Fetch `originatingBillUri` for a title.
 *
 * `AuApiClient.getTitle` projects a fixed `$select` list that does not include
 * this field, and the client's contract is frozen — so the one extra column is
 * requested here rather than by widening a shared projection every other tool
 * pays for. Returns undefined when the Register has no bill link, which is
 * common for older Acts and is not a failure.
 */
export async function getOriginatingBillUri(
  client: AuApiClient,
  titleId: string,
): Promise<string | undefined> {
  const json = await client.fetchJson("frlApi", "Titles", {
    query: { $filter: `id eq '${titleId}'`, $select: "id,originatingBillUri" },
  })
  const rows = (json as { value?: unknown[] } | null)?.value
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  const uri = row?.originatingBillUri
  return typeof uri === "string" && uri.trim() ? uri : undefined
}

export function billPageUrl(billId: string): string {
  return `${APH_BASE}/Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=${billId}`
}

export interface EmLink {
  /** `r6940_ems_715c9651-…` — the ParlInfo document id. */
  emId: string
  /** ParlInfo HTML view of the memorandum's text. */
  htmlUrl: string
  /** Download links keyed by the `upload_*` segment APH uses. */
  downloads: Array<{ label: string; url: string }>
}

/** ParlInfo `display.w3p` view for an EM id — the curl-open form of the text. */
export function emHtmlUrl(emId: string): string {
  return `${PARLINFO}/parlInfo/search/display/display.w3p;query=Id:"legislation/ems/${emId}"`
}

/**
 * Scrape the APH bill page for its explanatory-memorandum links.
 *
 * A bill can have several — an original EM, a supplementary EM, a revised EM —
 * and they are grouped by their uuid so a caller sees each memorandum once with
 * its formats, rather than a flat list of near-identical URLs.
 */
export function parseBillEmLinks(html: string): EmLink[] {
  const grouped = new Map<string, EmLink>()
  for (const link of links(html, 600)) {
    const match = /legislation\/ems\/([A-Za-z0-9_-]+_ems_[0-9a-f-]{8,40})/i.exec(link.href)
    if (!match) continue
    const emId = match[1]
    const entry = grouped.get(emId) ?? { emId, htmlUrl: emHtmlUrl(emId), downloads: [] }
    const format = /upload_(\w+)\//i.exec(link.href)?.[1]
    if (format) {
      const label = format.toLowerCase() === "pdf" ? "PDF" : format.toLowerCase() === "word" ? "Word" : format
      if (!entry.downloads.some((download) => download.url === link.href)) {
        entry.downloads.push({ label, url: link.href })
      }
    }
    grouped.set(emId, entry)
  }
  return [...grouped.values()]
}

export async function getBillEmLinks(client: AuApiClient, billId: string): Promise<EmLink[]> {
  const html = await client.fetchHtml(
    "aph",
    `Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=${encodeURIComponent(billId)}`,
  )
  return parseBillEmLinks(html)
}
