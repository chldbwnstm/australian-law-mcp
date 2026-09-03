/**
 * Case citations — the single source of MNC and report-series grammar
 * (AGLC4 r 2, docs/research §4.2–4.5).
 *
 * The rule that shapes the whole module: **an unrecognised court token is
 * "unclear", never "not found".** MNC identifiers are allocated by dozens of
 * bodies and this table cannot be complete; a verifier that answers "no such
 * case" for a code it simply has not been taught advises a real authority out
 * of existence. Every failure path here returns a reason, and none of them
 * says the case does not exist.
 *
 * Every quantifier below is bounded. These patterns run over whole documents
 * supplied by a caller, so an unbounded group nested in another would turn a
 * long line of digits into a hang.
 */

import { lookupCourt, normaliseCourtToken, type CourtCode } from "./court-codes.js"
import { lookupSeries, normaliseSeriesToken, type BracketStyle, type ReportSeries } from "./report-series.js"

export type { CourtCode, ReportSeries, BracketStyle }
export { COURT_CODES, lookupCourt, normaliseCourtToken } from "./court-codes.js"
export { REPORT_SERIES, compareSeriesRank, lookupSeries } from "./report-series.js"

export interface Pinpoint {
  /** Page number, for a reported citation: `(1992) 175 CLR 1, 42`. */
  page?: number
  /** Paragraph numbers in order: `, [11]` or `, [11]–[14]` -> `["11", "14"]`. */
  paragraphs?: string[]
}

export interface MncCitation {
  kind: "mnc"
  year: number
  /** Canonical court token — dots absorbed, case normalised. */
  court: string
  number: number
  court_info: CourtCode
  pinpoint?: Pinpoint
  /** Non-fatal observations, e.g. a year before the body allocated MNCs. */
  warnings: string[]
  raw: string
}

export interface ReportCitation {
  kind: "report"
  year: number
  /** Absent for a year-as-volume series. */
  volume?: number
  /** Canonical series abbreviation. */
  series: string
  page: number
  bracket: BracketStyle
  series_info?: ReportSeries
  pinpoint?: Pinpoint
  warnings: string[]
  raw: string
}

export type CaseCitation = MncCitation | ReportCitation

export type CaseCitationResult =
  | { ok: true; citation: CaseCitation }
  | { ok: false; reason: string; raw: string; token?: string }

// ── Patterns ──────────────────────────────────────────────────────────────
// Bounded everywhere: years are two fixed alternatives, court tokens at most
// 12 characters, judgment/page numbers at most 5 digits, whitespace runs at
// most 3 characters. Nothing here can nest an unbounded repeat.

/** `[2020] HCA 41`, `[2009] TASSC 80`, `[2026] FedCFamC1A 12`. */
const MNC_CORE = "\\[((?:1[89]|20)\\d{2})\\]\\s{0,3}([A-Za-z][A-Za-z0-9.]{1,15})\\s{1,3}(\\d{1,5})"

/** `(1992) 175 CLR 1` — the year is round-bracketed and a volume number follows. */
const REPORT_VOLUME_CORE =
  "\\(((?:1[89]|20)\\d{2})\\)\\s{1,3}(\\d{1,4})\\s{1,3}([A-Za-z][A-Za-z. ]{0,14}[A-Za-z.])\\s{1,3}(\\d{1,5})"

/** `[1977] VR 430`, `[2008] 3 All ER 1069` — the year is the volume. */
const REPORT_YEAR_CORE =
  "\\[((?:1[89]|20)\\d{2})\\]\\s{0,3}(?:(\\d{1,3})\\s{1,3})?([A-Za-z][A-Za-z. ]{0,14}[A-Za-z.])\\s{1,3}(\\d{1,5})"

/** `, 42 [15]`, `, [11]`, `, [11]-[14]`. Trails a citation; always optional. */
const PINPOINT_TAIL = "(?:\\s?,\\s{0,2}(\\d{1,5})?\\s{0,2}(?:\\[(\\d{1,5})\\](?:\\s{0,2}[-–—]\\s{0,2}\\[(\\d{1,5})\\])?)?)?"

const MNC_ANCHORED = new RegExp(`^${MNC_CORE}${PINPOINT_TAIL}$`)
const REPORT_VOLUME_ANCHORED = new RegExp(`^${REPORT_VOLUME_CORE}${PINPOINT_TAIL}$`)
const REPORT_YEAR_ANCHORED = new RegExp(`^${REPORT_YEAR_CORE}${PINPOINT_TAIL}$`)

export const MNC_PATTERN = MNC_CORE
export const REPORT_VOLUME_PATTERN = REPORT_VOLUME_CORE
export const REPORT_YEAR_PATTERN = REPORT_YEAR_CORE

function buildPinpoint(page?: string, from?: string, to?: string): Pinpoint | undefined {
  const paragraphs = from ? (to ? [from, to] : [from]) : undefined
  if (page === undefined && !paragraphs) return undefined
  return {
    ...(page !== undefined ? { page: Number(page) } : {}),
    ...(paragraphs ? { paragraphs } : {}),
  }
}

function mncFrom(match: RegExpExecArray, raw: string): CaseCitationResult {
  const [, yearText, courtToken, numberText, page, paraFrom, paraTo] = match
  const info = lookupCourt(courtToken)
  if (!info) {
    // The one place this module is allowed to fail, and it still does not
    // claim the case is absent — only that this token is not one it knows.
    return {
      ok: false,
      reason: "court code unclear",
      raw,
      token: normaliseCourtToken(courtToken),
    }
  }

  const year = Number(yearText)
  const warnings: string[] = []
  if (info.from && year < info.from) {
    warnings.push(
      `${info.code} began allocating medium-neutral citations in ${info.from}; ` +
      `[${year}] predates that. Databases do back-fill, so this is a flag, not a rejection.`,
    )
  }
  if (info.until && year > info.until) {
    warnings.push(
      `${info.code} stopped allocating medium-neutral citations in ${info.until}` +
      `${info.successor ? ` (succeeded by ${info.successor})` : ""}; [${year}] is after that.`,
    )
  }

  return {
    ok: true,
    citation: {
      kind: "mnc",
      year,
      court: info.code,
      number: Number(numberText),
      court_info: info,
      ...(buildPinpoint(page, paraFrom, paraTo) ? { pinpoint: buildPinpoint(page, paraFrom, paraTo)! } : {}),
      warnings,
      raw,
    },
  }
}

function reportFrom(
  match: RegExpExecArray,
  raw: string,
  bracket: BracketStyle,
  hasVolume: boolean,
): CaseCitationResult {
  const [, yearText, volumeText, seriesToken, pageText, page, paraFrom, paraTo] = match
  const trimmedSeries = seriesToken.trim()
  const info = lookupSeries(trimmedSeries)

  const warnings: string[] = []
  if (!info) {
    // Unknown series is still a usable citation — it names a year, a volume
    // and a page. Only the ranking and bracket check go missing.
    warnings.push(
      `Report series "${trimmedSeries}" is not in the AGLC series table; ` +
      `bracket style and authorised rank could not be checked.`,
    )
  } else if (info.bracket !== bracket && !info.bracketVaries) {
    warnings.push(
      `${info.name} is organised by ${info.bracket === "round" ? "volume number" : "year"}, ` +
      `so AGLC r 2.2 writes the year in ${info.bracket} brackets — this citation uses ${bracket}.`,
    )
  }

  return {
    ok: true,
    citation: {
      kind: "report",
      year: Number(yearText),
      ...(hasVolume && volumeText ? { volume: Number(volumeText) } : {}),
      series: info ? info.abbrev : trimmedSeries,
      page: Number(pageText),
      bracket,
      ...(info ? { series_info: info } : {}),
      ...(buildPinpoint(page, paraFrom, paraTo) ? { pinpoint: buildPinpoint(page, paraFrom, paraTo)! } : {}),
      warnings,
      raw,
    },
  }
}

/**
 * Parse one citation. The input may carry party names — they are stripped
 * before matching, because AGLC italicises them and nothing about the
 * citation's identity depends on them.
 */
export function parseCaseCitation(input: string): CaseCitationResult {
  const raw = (input ?? "").trim()
  if (!raw) return { ok: false, reason: "empty citation", raw }

  // Strip markdown/underscore italics and any leading party names.
  const cleaned = raw
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const body = trimPartyNames(cleaned)

  // `[1977] VR 430` matches the MNC shape as well as the year-as-volume
  // report shape — the two grammars are genuinely ambiguous, and only the
  // tables can separate them. So a known court wins, then a known series,
  // and "court code unclear" is reported only when *neither* table
  // recognises the token.
  const mnc = MNC_ANCHORED.exec(body)
  if (mnc && lookupCourt(mnc[2])) return mncFrom(mnc, raw)

  const volumeReport = REPORT_VOLUME_ANCHORED.exec(body)
  if (volumeReport) return reportFrom(volumeReport, raw, "round", true)

  const yearReport = REPORT_YEAR_ANCHORED.exec(body)
  if (yearReport && lookupSeries(yearReport[3])) {
    return reportFrom(yearReport, raw, "square", Boolean(yearReport[2]))
  }

  // Nothing matched a table. An MNC-shaped citation is the more specific
  // reading, so its "unclear" reason is the more useful one to return.
  if (mnc) return mncFrom(mnc, raw)
  if (yearReport) return reportFrom(yearReport, raw, "square", Boolean(yearReport[2]))

  return { ok: false, reason: "not a recognised citation format", raw }
}

/**
 * Drop everything before the first `[` or `(` that starts a year.
 *
 * Party names are free text and can contain anything, so no attempt is made
 * to validate them — the citation is identified by what follows.
 */
function trimPartyNames(text: string): string {
  const match = /[[(](?:1[89]|20)\d{2}[\])]/.exec(text)
  return match ? text.slice(match.index) : text
}

export interface ParallelCitation {
  /** The reported citation, when one was given. */
  report?: ReportCitation
  /** The medium-neutral citation, when one was given. */
  mnc?: MncCitation
  /** Parse failures that are not "there was nothing there". */
  problems: Array<{ reason: string; raw: string; token?: string }>
}

/**
 * Parse `Love v Commonwealth (2020) 270 CLR 152; [2020] HCA 3`.
 *
 * Splitting on `;` is enough: AGLC r 2.3.1 joins parallel citations with a
 * semicolon, and a semicolon never appears inside one citation.
 */
export function parseParallelCitation(input: string): ParallelCitation {
  const out: ParallelCitation = { problems: [] }
  for (const part of (input ?? "").split(";")) {
    const piece = part.trim()
    if (!piece) continue
    const result = parseCaseCitation(piece)
    if (!result.ok) {
      if (result.reason !== "not a recognised citation format") {
        out.problems.push({ reason: result.reason, raw: result.raw, ...(result.token ? { token: result.token } : {}) })
      }
      continue
    }
    if (result.citation.kind === "mnc") out.mnc ??= result.citation
    else out.report ??= result.citation
  }
  return out
}

/** Re-emit a citation in canonical AGLC form. */
export function formatCitation(citation: CaseCitation): string {
  const pinpoint = formatPinpoint(citation.pinpoint)
  if (citation.kind === "mnc") {
    return `[${citation.year}] ${citation.court} ${citation.number}${pinpoint}`
  }
  const open = citation.bracket === "round" ? "(" : "["
  const close = citation.bracket === "round" ? ")" : "]"
  const volume = citation.volume !== undefined ? `${citation.volume} ` : ""
  return `${open}${citation.year}${close} ${volume}${citation.series} ${citation.page}${pinpoint}`
}

function formatPinpoint(pinpoint?: Pinpoint): string {
  if (!pinpoint) return ""
  const parts: string[] = []
  if (pinpoint.page !== undefined) parts.push(String(pinpoint.page))
  if (pinpoint.paragraphs?.length) {
    parts.push(
      pinpoint.paragraphs.length > 1
        ? `[${pinpoint.paragraphs[0]}]–[${pinpoint.paragraphs[1]}]`
        : `[${pinpoint.paragraphs[0]}]`,
    )
  }
  return parts.length ? `, ${parts.join(" ")}` : ""
}

/**
 * Every citation in a block of prose, in order of appearance.
 *
 * Unknown court tokens come back as `{ok:false, reason:"court code unclear"}`
 * entries rather than being dropped — silently discarding them is how an
 * unverified citation slips past a hallucination check under a banner saying
 * everything was checked.
 */
export function extractCaseCitations(text: string): CaseCitationResult[] {
  if (!text) return []
  const scanner = new RegExp(
    `(?:${MNC_CORE}${PINPOINT_TAIL})|(?:${REPORT_VOLUME_CORE}${PINPOINT_TAIL})|(?:${REPORT_YEAR_CORE}${PINPOINT_TAIL})`,
    "g",
  )
  const out: CaseCitationResult[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(scanner)) {
    const found = match[0].trim()
    if (seen.has(found)) continue
    seen.add(found)
    out.push(parseCaseCitation(found))
  }
  return out
}

/**
 * Rank parallel citations the way AGLC r 2.2.2 does: authorised report first,
 * then general, then subject-specific, then the MNC. Returns the preferred
 * citation, or `undefined` when nothing parsed.
 */
export function preferredCitation(citations: CaseCitation[]): CaseCitation | undefined {
  const scored = citations.map((citation) => ({
    citation,
    rank: citation.kind === "report" ? (citation.series_info?.rank ?? 3) : 4,
  }))
  scored.sort((a, b) => a.rank - b.rank)
  return scored[0]?.citation
}
