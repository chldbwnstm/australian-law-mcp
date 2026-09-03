/**
 * DFAT Australian Treaties Database
 * (docs/research/tribunals-states-treaties.md §8).
 *
 * `POST https://docs.dfat.gov.au/api/search` is a real JSON API and the only
 * keyless one in this whole domain set. It returns ~40 fields per treaty; this
 * module keeps the ones that identify and situate a treaty and drops the rest,
 * because a tool answer built from 40 mostly-null fields is unreadable.
 *
 * The catch is where the *text* lives: every `AtsLink`/`AtnifLink`/`AtniaLink`
 * points at AustLII, which this server refuses to fetch. So `search` and `get`
 * are honest metadata tools that hand the user a working browser link, and they
 * say so — a treaty whose text was not retrieved is not a treaty that does not
 * exist.
 *
 * The site is a single-page app whose shell answers 404 for unknown routes even
 * while the API is healthy; that quirk does not affect `/api/search`, which is
 * the only path used here.
 */

import type { AuApiClient } from "../api-client.js"
import { getHostConfig } from "../upstream-hosts.js"
import { treatiesDatabaseUrl } from "../external-links-map.js"
import type { SourceHit, SourceSearchResult } from "./types.js"

const BASE = getHostConfig("dfat").base
const SEARCH_PATH = "api/search"

export interface TreatySearchParams {
  keyword?: string
  page?: number
  /** Passed through verbatim — the facet names come back in the response. */
  facets?: Record<string, unknown>
  dateFilters?: Record<string, unknown>
}

export interface TreatyRecord {
  id: string
  title: string
  shortTitle?: string
  atsNumber?: string
  atsLink?: string
  atnifNumber?: string
  atnifLink?: string
  atniaNumber?: string
  atniaLink?: string
  agreementType?: string
  status?: string
  subject?: string
  countries: string[]
  doneAtPlace?: string
  doneAtDate?: string
  entryIntoForceForAustralia?: string
  entryIntoForceGenerally?: string
  tablingDateRepresentatives?: string
  tablingDateSenate?: string
  depositary?: string
  jscotReportNumber?: string
  jscotReportUrl?: string
  actions: Array<{ date?: string; action?: string }>
  implementationMeasures: string[]
}

interface RawSearchResponse {
  totalCount?: number
  currentPage?: number
  pageSize?: number
  totalPages?: number
  results?: unknown[]
  facets?: Record<string, unknown>
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed && trimmed.toLowerCase() !== "none" ? trimmed : undefined
  }
  if (typeof value === "number") return String(value)
  return undefined
}

/** `2011-09-07T00:00:00Z` → `2011-09-07`; leave anything else as delivered. */
function date(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  return match ? match[1] : raw
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => text(entry)).filter((entry): entry is string => Boolean(entry))
}

export function mapTreaty(raw: unknown): TreatyRecord | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const row = raw as Record<string, unknown>
  const title = text(row.Title)
  const id = text(row.Id)
  if (!title || !id) return undefined

  const record: TreatyRecord = {
    id,
    title,
    countries: stringList(row.Countries),
    actions: Array.isArray(row.TreatyActions)
      ? (row.TreatyActions as unknown[]).flatMap((entry) => {
          if (entry === null || typeof entry !== "object") return []
          const action = entry as Record<string, unknown>
          const mapped: { date?: string; action?: string } = {}
          const when = date(action.Date)
          if (when) mapped.date = when
          const what = text(action.Action)
          if (what) mapped.action = what
          return mapped.date || mapped.action ? [mapped] : []
        })
      : [],
    implementationMeasures: stringList(row.AustralianImplementationMeasures),
  }

  const assign = <K extends keyof TreatyRecord>(key: K, value: TreatyRecord[K] | undefined) => {
    if (value !== undefined) record[key] = value
  }
  assign("shortTitle", text(row.ShortTitle))
  assign("atsNumber", text(row.AtsNumber))
  assign("atsLink", text(row.AtsLink) ?? text(row.TreatyLink))
  assign("atnifNumber", text(row.AtnifNumber))
  assign("atnifLink", text(row.AtnifLink))
  assign("atniaNumber", text(row.AtniaNumber))
  assign("atniaLink", text(row.AtniaLink))
  assign("agreementType", text(row.AgreementType))
  assign("status", text(row.TreatyStatusAustralia) ?? text(row.TreatyStatusGenerally))
  assign("subject", text(row.Subject))
  assign("doneAtPlace", text(row.DoneAtPlace))
  assign("doneAtDate", date(row.DoneAtDate))
  assign("entryIntoForceForAustralia", date(row.EntryIntoForceForAustraliaDate))
  assign("entryIntoForceGenerally", date(row.EntryIntoForceGenerallyDate))
  assign("tablingDateRepresentatives", date(row.TablingDateRepresentatives))
  assign("tablingDateSenate", date(row.TablingDateSenate))
  assign("depositary", text(row.Depositary))
  assign("jscotReportNumber", text(row.JscotReportNumber))
  assign("jscotReportUrl", text(row.JscotReportUrl))
  return record
}

export interface TreatySearchResult extends SourceSearchResult {
  records: TreatyRecord[]
  totalPages?: number
  facets?: Record<string, unknown>
}

export function parseSearchResponse(json: unknown, sourceUrl: string): TreatySearchResult {
  const response = (json ?? {}) as RawSearchResponse
  const records = (response.results ?? [])
    .map(mapTreaty)
    .filter((record): record is TreatyRecord => record !== undefined)

  const hits: SourceHit[] = records.map((record) => {
    const hit: SourceHit = {
      source: "DFAT Treaties Database",
      title: record.title,
      id: record.id,
      // The database's own UI is an SPA route; the ATS link is what a human can
      // actually open, so it is the canonical URL when one exists.
      url: record.atsLink ?? record.atnifLink ?? treatiesDatabaseUrl(),
    }
    if (record.atsNumber ?? record.atnifNumber) hit.citation = record.atsNumber ?? record.atnifNumber
    if (record.entryIntoForceForAustralia ?? record.doneAtDate) {
      hit.date = record.entryIntoForceForAustralia ?? record.doneAtDate
    }
    const extra: Array<[string, string]> = []
    if (record.status) extra.push(["Status (Australia)", record.status])
    if (record.agreementType) extra.push(["Type", record.agreementType])
    if (record.countries.length > 0) extra.push(["Parties", record.countries.join(", ")])
    if (record.subject) extra.push(["Subject", record.subject])
    if (extra.length > 0) hit.extra = extra
    return hit
  })

  const result: TreatySearchResult = { hits, records, sourceUrl }
  if (typeof response.totalCount === "number") result.total = response.totalCount
  if (typeof response.currentPage === "number") result.page = response.currentPage
  if (typeof response.totalPages === "number") result.totalPages = response.totalPages
  if (response.facets && Object.keys(response.facets).length > 0) result.facets = response.facets
  return result
}

export async function search(
  client: AuApiClient,
  params: TreatySearchParams = {},
): Promise<TreatySearchResult> {
  const body = JSON.stringify({
    keyword: params.keyword ?? "",
    page: params.page ?? 1,
    facets: params.facets ?? {},
    dateFilters: params.dateFilters ?? {},
  })
  const json = await client.fetchJson("dfat", SEARCH_PATH, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  })
  return parseSearchResponse(json, `${BASE}/${SEARCH_PATH}`)
}

/**
 * One treaty by database id.
 *
 * `GET /api/treaty/{id}` answers 401, so there is no single-record endpoint;
 * the record is taken from a search response instead. When a keyword is known
 * it narrows the scan, otherwise the caller's page is scanned as delivered.
 */
export async function getById(
  client: AuApiClient,
  id: string,
  hint?: { keyword?: string; page?: number },
): Promise<TreatyRecord | undefined> {
  const result = await search(client, {
    ...(hint?.keyword ? { keyword: hint.keyword } : {}),
    ...(hint?.page ? { page: hint.page } : {}),
  })
  return result.records.find((record) => record.id === id.trim())
}
