/**
 * The EnAct `projectdata` JSON platform, shared by Queensland and Tasmania
 * (docs/research/tribunals-states-treaties.md §2).
 *
 * Two registers, one product, one difference: the datasource prefix is `OQPC-`
 * in Queensland and `EnAct-` in Tasmania. Everything else — the CCL expression
 * grammar, the `{"__type__","__value__"}` value wrapper, the
 * `/view/whole/html/...` full-text path — is identical, so it lives here once.
 *
 * Content searches run 30–90 seconds server-side. That is the endpoint's own
 * behaviour, not a guess, and it is why `qldLegislation`/`tasLegislation` carry
 * a 90-second timeout in the hosts table.
 */

import type { AuApiClient } from "../api-client.js"
import type { HostKey } from "../upstream-hosts.js"
import { getHostConfig } from "../upstream-hosts.js"
import type { SourceHit, SourceLabel, SourceSearchResult } from "./types.js"

export type EnactJurisdiction = "QLD" | "TAS"

interface EnactConfig {
  host: HostKey
  prefix: string
  label: SourceLabel
  /**
   * Queensland's index mixes reprint types, so the browse/search expression
   * pins `PrintType`. Tasmania's does not carry the same field values, and
   * adding it there returns nothing.
   */
  printTypeClause?: string
}

const CONFIG: Record<EnactJurisdiction, EnactConfig> = {
  QLD: {
    host: "qldLegislation",
    prefix: "OQPC",
    label: "QLD Legislation",
    printTypeClause: 'PrintType="act.reprint"',
  },
  TAS: {
    host: "tasLegislation",
    prefix: "EnAct",
    label: "TAS Legislation",
  },
}

/** CCL fields the register indexes (§2). `Content` is the full-text one. */
export type CclField = "Content" | "Title" | "Heading" | "Schedule" | "DefinedTerm" | "Titles"

/** Unwrap `{"__type__":"UniString","__value__":"…"}`; pass anything else through. */
export function unwrap(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if ("__value__" in record) return record.__value__
  return value
}

function str(value: unknown): string | undefined {
  const unwrapped = unwrap(value)
  if (typeof unwrapped === "string") return unwrapped.trim() || undefined
  if (typeof unwrapped === "number") return String(unwrapped)
  return undefined
}

function num(value: unknown): number | undefined {
  const unwrapped = unwrap(value)
  if (typeof unwrapped === "number") return unwrapped
  if (typeof unwrapped === "string" && /^\d+$/.test(unwrapped)) return Number(unwrapped)
  return undefined
}

/**
 * Escape a user phrase for the CCL `Field=(…)` operand.
 *
 * The grammar has no escape sequence, so characters that would change the
 * expression's structure are dropped rather than quoted — a query that silently
 * becomes a different boolean is worse than one that loses a bracket.
 */
export function sanitiseTerm(term: string): string {
  return term
    .replace(/[()"'=]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function buildExpression(
  jurisdiction: EnactJurisdiction,
  p: { query: string; field?: CclField; includeRepealed?: boolean },
): string {
  const config = CONFIG[jurisdiction]
  const clauses: string[] = []
  if (!p.includeRepealed) clauses.push("Repealed=N")
  if (config.printTypeClause) clauses.push(config.printTypeClause)
  const term = sanitiseTerm(p.query)
  if (term) clauses.push(`${p.field ?? "Content"}=(${term})`)
  return clauses.join(" AND ")
}

export interface EnactRecord {
  /** Register id, e.g. `Act-2000-005` (QLD) / `act-1884-019` (TAS). */
  id: string
  title: string
  year?: number
  number?: string
  printType?: string
  publicationDate?: string
  repealed?: boolean
  versionSeriesId?: string
  versionDescId?: string
}

interface EnactEnvelope {
  data?: unknown[]
  totalCount?: unknown
  filteredCount?: unknown
}

export function parseRecords(json: unknown): { total?: number; records: EnactRecord[] } {
  const envelope = (json ?? {}) as EnactEnvelope
  const rows = Array.isArray(envelope.data) ? envelope.data : []
  const records: EnactRecord[] = []
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue
    const record = row as Record<string, unknown>
    const id = str(record.id)
    const title = str(record.title) ?? str(record.title_v)
    if (!id || !title) continue
    const entry: EnactRecord = { id, title }
    const year = num(record.year)
    if (year !== undefined) entry.year = year
    const number = str(record.no)
    if (number) entry.number = number
    const printType = str(record["print.type"])
    if (printType) entry.printType = printType
    const published = str(record["publication.date"])
    if (published) entry.publicationDate = published.slice(0, 10)
    const repealed = str(record.repealed)
    if (repealed) entry.repealed = repealed.toUpperCase() === "Y"
    const seriesId = str(record["version.series.id"])
    if (seriesId) entry.versionSeriesId = seriesId
    const descId = str(record["version.desc.id"])
    if (descId) entry.versionDescId = descId
    records.push(entry)
  }
  const total = num(envelope.totalCount)
  return total === undefined ? { records } : { total, records }
}

/** Human URL for a register id — the `/view/whole/` form, which is real HTML. */
export function wholeTextPath(id: string): string {
  return `view/whole/html/inforce/current/${id.toLowerCase()}`
}

export function humanUrl(jurisdiction: EnactJurisdiction, id: string): string {
  return `${getHostConfig(CONFIG[jurisdiction].host).base}/${wholeTextPath(id)}`
}

export async function search(
  client: AuApiClient,
  jurisdiction: EnactJurisdiction,
  p: { query: string; field?: CclField; includeRepealed?: boolean; start?: number; count?: number },
): Promise<SourceSearchResult> {
  const config = CONFIG[jurisdiction]
  const base = getHostConfig(config.host).base
  const query = {
    ds: `${config.prefix}-FragTocRelationIdxDatasource`,
    config: "Y",
    start: p.start ?? 1,
    count: p.count ?? 10,
    expression: buildExpression(jurisdiction, p),
    subset: "F",
    collection: "",
  }
  const json = await client.fetchJson(config.host, "projectdata", { query })
  const { total, records } = parseRecords(json)

  const hits: SourceHit[] = records.map((record) => {
    const hit: SourceHit = {
      source: config.label,
      title: record.title,
      id: record.id,
      url: `${base}/${wholeTextPath(record.id)}`,
    }
    const extra: Array<[string, string]> = []
    if (record.year !== undefined) extra.push(["Year", String(record.year)])
    if (record.number) extra.push(["No", record.number])
    if (record.publicationDate) extra.push(["Reprint", record.publicationDate])
    if (extra.length > 0) hit.extra = extra
    return hit
  })

  const result: SourceSearchResult = {
    hits,
    sourceUrl: `${base}/projectdata?ds=${query.ds}&expression=${encodeURIComponent(query.expression)}`,
  }
  if (total !== undefined) result.total = total
  return result
}

/** Whole-act HTML. `/view/html/...` is a JavaScript shell — only `/view/whole/` is text. */
export async function getWholeText(
  client: AuApiClient,
  jurisdiction: EnactJurisdiction,
  id: string,
): Promise<string> {
  return client.fetchHtml(CONFIG[jurisdiction].host, wholeTextPath(id))
}
