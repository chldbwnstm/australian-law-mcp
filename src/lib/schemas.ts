/**
 * Shared Zod schemas
 */

import { z } from "zod"
import { cutAtSafeBoundary, extractSummary, sliceWellFormed, summaryTail } from "./truncate-text.js"

/**
 * Date schema (YYYYMMDD)
 */
export const dateSchema = z
  .string()
  .regex(/^\d{8}$/, "Date format: YYYYMMDD (e.g. 20240101)")
  .refine(
    (val) => {
      const year = parseInt(val.slice(0, 4), 10)
      const month = parseInt(val.slice(4, 6), 10)
      const day = parseInt(val.slice(6, 8), 10)

      if (year < 1900 || year > 2100) return false
      if (month < 1 || month > 12) return false
      if (day < 1 || day > 31) return false

      // Days-per-month check
      const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      if (month === 2 && isLeapYear) {
        return day <= 29
      }
      return day <= daysInMonth[month - 1]
    },
    { message: "Invalid date." }
  )

/**
 * Optional date schema
 */
export const optionalDateSchema = dateSchema.optional()

/**
 * The regex every Australian point-in-time parameter checks against.
 *
 * Exported so no tool has to retype it: `/^\d{4}-\d{2}-\d{2}$/` inlined at a
 * dozen call sites is a dozen chances for one of them to be written
 * `\d{4}-\d{1,2}-\d{1,2}` and start accepting `2020-1-1`, which every upstream
 * on the AU side rejects (the FRL document URL grammar and the OData datetime
 * literal both want zero-padded parts).
 */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * ISO `YYYY-MM-DD` — the wire format of every Australian upstream.
 *
 * Shape *and* calendar are both checked: `2023-02-30` matches the pattern and
 * is still not a day, and an upstream handed a non-day answers with an empty
 * result rather than an error, which reads as "no such compilation".
 *
 * @param description text for the generated JSON Schema (LLM callers read it)
 */
export function isoDateSchema(description: string) {
  return z
    .string()
    .regex(ISO_DATE_PATTERN, "Date format: YYYY-MM-DD (e.g. 2024-07-01)")
    .refine(isRealIsoDay, { message: "Not a real calendar date." })
    .describe(description)
}

/** True when a `YYYY-MM-DD` string names a day that exists. */
export function isRealIsoDay(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split("-").map((part) => parseInt(part, 10))
  if (year < 1800 || year > 2200) return false
  if (month < 1 || month > 12) return false
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const limit = month === 2 && isLeapYear ? 29 : daysInMonth[month - 1]
  return day >= 1 && day <= limit
}

/**
 * Pagination schema
 */
export const paginationSchema = z.object({
  display: z.number().min(1).max(100).default(20).describe("Number of results (default: 20, max: 100)"),
  page: z.number().min(1).default(1).describe("Page number (default: 1)"),
})

/**
 * Response size limit — 50,000 **characters** (UTF-16 length), not bytes.
 * Transferred bytes can be two or three times this value once non-ASCII text is
 * encoded as UTF-8. Character count is the better approximation of a token
 * budget, so the character basis is kept.
 */
export const MAX_RESPONSE_SIZE = 50000

/**
 * Format a date (YYYYMMDD → YYYY.MM.DD)
 */
export function formatDateDot(dateStr: string): string {
  if (!dateStr || dateStr.length < 8) return dateStr || "N/A"
  return `${dateStr.substring(0, 4)}.${dateStr.substring(4, 6)}.${dateStr.substring(6, 8)}`
}

/**
 * truncateResponse options
 */
interface TruncateOptions {
  maxLength?: number
  /** When true, extract only the key content once the limit is exceeded */
  summary?: boolean
}

/**
 * Apply the response size limit.
 *
 * @param text - source text
 * @param maxSizeOrOpts - a number (max length) or an options object
 */
export function truncateResponse(text: string, maxSizeOrOpts?: number): string
export function truncateResponse(text: string, maxSizeOrOpts?: TruncateOptions): string
export function truncateResponse(text: string, maxSizeOrOpts: number | TruncateOptions = MAX_RESPONSE_SIZE): string {
  let maxSize: number
  let summary = false

  if (typeof maxSizeOrOpts === "object" && maxSizeOrOpts !== null) {
    maxSize = maxSizeOrOpts.maxLength ?? MAX_RESPONSE_SIZE
    summary = !!maxSizeOrOpts.summary
  } else {
    maxSize = maxSizeOrOpts
  }

  if (text.length <= maxSize) return text

  // Summary mode: extract the key content (first line + section titles).
  // The overflow is cut at a boundary too — a hard cut would sever the
  // `📋 Summary mode` tail mid-string.
  if (summary) {
    const extracted = extractSummary(text, maxSize)
    if (extracted.length <= maxSize) return extracted
    // The tail marker sits at the very end of the document, so cutting from the
    // end removes the tail first — and the fact that the text was truncated and
    // summarised becomes unmarked. Reserve the tail length in the budget, cut
    // only the body at a boundary, then reattach. The reattached tail is at
    // most as long as the original because the body shrank, so the limit holds.
    const tailBudget = maxSize - summaryTail(text.length, extracted.length).length
    if (tailBudget <= 0) return sliceWellFormed(extracted, maxSize)
    const body = cutAtSafeBoundary(extracted, tailBudget)
    return body + summaryTail(text.length, body.length)
  }

  // The notice is appended *after* the slice, so its length has to come out of
  // the budget first. Without that, the result is maxSize + notice length
  // (50,030 characters for a 50,000-character request).
  const notice = `\n\n⚠️ Response truncated to ${maxSize.toLocaleString()} characters.`
  const budget = maxSize - notice.length
  if (budget <= 0) return sliceWellFormed(text, maxSize)
  return cutAtSafeBoundary(text, budget) + notice
}

/**
 * Per-section truncation for chain tools.
 *
 * For text shaped as "▶ Section title\ncontent", limit each section
 * individually so the whole response stays balanced.
 *
 * @param text - text of the form "▶ title\ncontent\n\n▶ title\ncontent"
 * @param totalMax - overall maximum length
 * @param sectionMax - maximum length per section (default: totalMax / section count)
 */
export function truncateSections(
  text: string,
  totalMax: number = MAX_RESPONSE_SIZE,
  sectionMax?: number
): string {
  if (text.length <= totalMax) return text

  // Split on the "▶ " marker
  const sectionPattern = /(?=▶\s)/g
  const parts = text.split(sectionPattern)

  // Separate a leading chunk that is empty or precedes the first header
  let preamble = ""
  let sections = parts
  if (parts.length > 0 && !parts[0].startsWith("▶")) {
    preamble = parts[0]
    sections = parts.slice(1)
  }

  if (sections.length === 0) {
    // No section markers — fall back to plain truncation
    return truncateResponse(text, totalMax)
  }

  const perSection = sectionMax || Math.floor((totalMax - preamble.length - 100) / sections.length)

  const truncatedSections = sections.map((sec) => {
    if (sec.length <= perSection) return sec
    // The notice is appended *after* the cut, so subtract its length from the
    // budget first — the same class of bug the top-level cut fixed, still
    // present at section granularity. Without it every section overshoots
    // perSection by the notice length.
    const notice = `\n   ⚠️ (this section shortened from ${sec.length.toLocaleString()} to ${perSection.toLocaleString()} characters)`
    const budget = perSection - notice.length
    if (budget <= 0) return cutAtSafeBoundary(sec, perSection)
    return cutAtSafeBoundary(sec, budget) + notice
  })

  let result = preamble + truncatedSections.join("\n\n")

  // Re-check the overall length — cut with the notice length removed from the
  // budget so totalMax is never exceeded.
  if (result.length > totalMax) {
    const notice = `\n\n⚠️ Full response truncated to ${totalMax.toLocaleString()} characters.`
    const budget = totalMax - notice.length
    result = budget > 0 ? cutAtSafeBoundary(result, budget) + notice : sliceWellFormed(result, totalMax)
  }

  return result
}
