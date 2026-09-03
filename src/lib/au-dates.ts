/**
 * English date phrases in legal queries -> ISO dates.
 *
 * The engine half; the pattern tables live in `au-date-patterns.ts`. Split
 * the same way as the reference implementation's date-parser/date-patterns
 * pair, for the same reason: pattern order is the semantics, and ordering
 * decisions are easier to see and to review when they are the only thing in
 * the file.
 *
 * Output is always `YYYY-MM-DD`, which is what `Versions/Find(asAt=…)` and
 * the document URL grammar both take. Nothing here appends a time or a `Z` —
 * the FRL API rejects a trailing `Z` on datetime literals.
 */

import {
  DATE_PATTERNS,
  RANGE_PATTERNS,
  isoOf,
  resolveBoundary,
  resolveSingle,
  type DateContext,
  type DateRange,
  type IsoDate,
} from "./au-date-patterns.js"

export type { DateRange, IsoDate }
export { isoOf, resolveBoundary, toIso } from "./au-date-patterns.js"

export interface DateParseResult {
  /** The resolved calendar date. */
  iso: IsoDate
  /**
   * The exact source substring recognised as a date.
   *
   * `stripMatchedDate` removes this text rather than re-parsing the query:
   * re-parsing a cleaned string picks up a *different* pattern than the one
   * that matched the original, and then removes the wrong span.
   */
  matched: string
  /** Which table entry fired — useful when a caller wants to explain itself. */
  pattern: string
}

export interface RangeParseResult {
  range: DateRange
  matched: string
  pattern: string
}

function contextFrom(now?: Date): DateContext {
  return { now: now ?? new Date() }
}

/**
 * Find the first date phrase in a query.
 *
 * Returns `null` when there is none — never today's date as a fallback. A
 * silent "assume now" turns a query about historical law into a query about
 * current law, and the answer looks perfectly reasonable either way.
 */
export function parseAuDate(query: string, now?: Date): DateParseResult | null {
  if (!query) return null
  const context = contextFrom(now)
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.regex.exec(query)
    if (!match) continue
    const iso = pattern.resolve(match, context)
    // A pattern can match shape but not resolve (31 February). Keep looking:
    // a later, looser pattern may still read the phrase correctly.
    if (iso) return { iso, matched: match[0], pattern: pattern.name }
  }
  return null
}

/** Just the ISO date, for callers that do not need the provenance. */
export function toIsoDate(query: string, now?: Date): IsoDate | null {
  return parseAuDate(query, now)?.iso ?? null
}

/**
 * Find the first date *range* in a query.
 *
 * Tried before `parseAuDate` by callers that accept either: "between 2015 and
 * 2019" contains two things a single-date parser would happily latch onto.
 */
export function parseAuDateRange(query: string, now?: Date): RangeParseResult | null {
  if (!query) return null
  const context = contextFrom(now)
  // A single date read from the same text. Used only to veto range matches
  // that are really a fragment of it — see below.
  const single = parseAuDate(query, now)

  for (const pattern of RANGE_PATTERNS) {
    const match = pattern.regex.exec(query)
    if (!match) continue
    // "as at 30 June 2015" contains a year, but it names one day. Any range
    // match that sits *inside* a fuller single-date match is that fragment
    // being re-read, and honouring it would silently widen a point-in-time
    // question into a twelve-month window.
    if (single && containsSpan(query, single.matched, match)) continue
    const range = pattern.resolve(match, context)
    if (range && range.from <= range.to) {
      return { range, matched: match[0], pattern: pattern.name }
    }
  }
  return null
}

/** Does `outer` (as found in `query`) fully contain the span of `match`? */
function containsSpan(query: string, outer: string, match: RegExpMatchArray): boolean {
  const start = query.indexOf(outer)
  if (start < 0 || match.index === undefined) return false
  return match.index >= start && match.index + match[0].length <= start + outer.length
}

/**
 * Remove a recognised date phrase and the connective left behind.
 *
 * Takes the matched text rather than re-deriving it, for the reason set out
 * on `DateParseResult.matched`. The trailing-word list is deliberately short
 * and each entry must be followed by whitespace or end-of-string, so it
 * cannot eat the start of a real search term.
 */
const TRAILING_CONNECTIVES = /^(?:\s*(?:version|compilation|onwards?|inclusive)(?=\s|$))+/i

export function stripMatchedDate(query: string, matched: string): string {
  const index = query.indexOf(matched)
  if (index < 0) return query.trim()
  const before = query.slice(0, index)
  const rest = query.slice(index + matched.length)
  const connective = TRAILING_CONNECTIVES.exec(rest)
  const after = connective ? rest.slice(connective[0].length) : rest
  return `${before} ${after}`.replace(/\s+/g, " ").trim()
}

export interface QueryDates {
  /** A single point in time, when the query names one. */
  date?: DateParseResult
  /** A window, when the query names one. */
  range?: RangeParseResult
  /** The query with the date phrase removed — what to send to a search API. */
  rest: string
}

/**
 * Split a query into its time condition and its search terms.
 *
 * A range wins over a single date when both are present: "amendments between
 * 2015 and 2019" is a window, and reducing it to one endpoint would answer a
 * different question.
 */
export function extractQueryDates(query: string, now?: Date): QueryDates {
  const text = (query ?? "").trim()
  if (!text) return { rest: "" }

  const range = parseAuDateRange(text, now)
  if (range) return { range, rest: stripMatchedDate(text, range.matched) }

  const date = parseAuDate(text, now)
  if (date) return { date, rest: stripMatchedDate(text, date.matched) }

  return { rest: text }
}

/** Resolve one fragment already known to be a date, e.g. a tool parameter. */
export function parseDateFragment(fragment: string, now?: Date): IsoDate | undefined {
  return resolveSingle(fragment, contextFrom(now))
}
