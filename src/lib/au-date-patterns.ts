/**
 * English date-phrase patterns — the data half of `au-dates.ts`.
 *
 * Order is the rule: the more specific pattern must come first. `2019` on its
 * own has to be last, or "between 2015 and 2019" loses its start year to the
 * bare-year rule and the range collapses to a single day.
 *
 * The one convention that is not obvious to a non-Australian reader: **numeric
 * dates are day-first**. `01/07/2020` is 1 July 2020, not 7 January. Getting
 * this backwards silently returns a real but wrong compilation for eleven
 * months of every year, which is worse than failing.
 */

/** An ISO calendar date, `YYYY-MM-DD` — the form the FRL API and file URLs take. */
export type IsoDate = string

export interface DateRange {
  from: IsoDate
  to: IsoDate
}

export interface DateContext {
  /** "Now" for relative phrases. Injected so the tables are testable without timers. */
  now: Date
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

export const MONTH_ALTERNATION = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|")

export function monthNumber(name: string): number | undefined {
  return MONTHS[name.toLowerCase().replace(/\./g, "")]
}

/** Spelled-out counts a lawyer actually writes ("two years ago"). */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

export const COUNT_ALTERNATION = `\\d{1,3}|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|")}`

export function countValue(token: string): number {
  const digits = Number(token)
  if (Number.isFinite(digits)) return digits
  return WORD_NUMBERS[token.toLowerCase()] ?? 1
}

/**
 * Build an ISO date, rejecting impossible calendar days (31 February).
 * Returning `undefined` rather than rolling over is deliberate: a rolled-over
 * date is a plausible-looking wrong answer.
 */
export function toIso(year: number, month: number, day: number): IsoDate | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function isoOf(date: Date): IsoDate {
  return toIso(date.getFullYear(), date.getMonth() + 1, date.getDate())!
}

function shift(base: Date, years = 0, months = 0, days = 0): Date {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  date.setFullYear(date.getFullYear() + years)
  date.setMonth(date.getMonth() + months)
  date.setDate(date.getDate() + days)
  return date
}

/**
 * Optional lead-in that belongs to the date phrase rather than the query.
 * Captured so `stripMatchedDate` removes "as at" along with the date and does
 * not leave "as at legislation" as the search term.
 */
const LEAD_IN = "(?:\\b(?:as\\s+at|as\\s+of|as\\s+on|on|at|from|effective(?:\\s+from)?|in\\s+force\\s+(?:at|on))\\s+)?"

export interface DatePattern {
  name: string
  regex: RegExp
  resolve: (match: RegExpMatchArray, context: DateContext) => IsoDate | undefined
}

/** Single-date patterns, most specific first. */
export const DATE_PATTERNS: readonly DatePattern[] = [
  {
    name: "iso",
    regex: new RegExp(`${LEAD_IN}\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, "i"),
    resolve: (m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    // "1 July 2020", "1st July 2020", "30 June 2015"
    name: "day-month-year",
    regex: new RegExp(
      `${LEAD_IN}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})\\.?,?\\s+(\\d{4})\\b`,
      "i",
    ),
    resolve: (m) => toIso(Number(m[3]), monthNumber(m[2])!, Number(m[1])),
  },
  {
    // "July 1 2020", "July 1st, 2020" — American ordering, still understood.
    name: "month-day-year",
    regex: new RegExp(
      `${LEAD_IN}\\b(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
      "i",
    ),
    resolve: (m) => toIso(Number(m[3]), monthNumber(m[1])!, Number(m[2])),
  },
  {
    // Numeric, day-first. `01/07/2020` is 1 July 2020.
    name: "numeric-day-first",
    regex: new RegExp(`${LEAD_IN}\\b(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{4})\\b`, "i"),
    resolve: (m) => toIso(Number(m[3]), Number(m[2]), Number(m[1])),
  },
  {
    name: "today",
    regex: new RegExp(`${LEAD_IN}\\b(?:today|now|currently|at\\s+present)\\b`, "i"),
    resolve: (_m, { now }) => isoOf(now),
  },
  {
    name: "yesterday",
    regex: new RegExp(`${LEAD_IN}\\byesterday\\b`, "i"),
    resolve: (_m, { now }) => isoOf(shift(now, 0, 0, -1)),
  },
  {
    name: "n-years-ago",
    regex: new RegExp(`\\b(${COUNT_ALTERNATION})\\s+years?\\s+ago\\b`, "i"),
    resolve: (m, { now }) => isoOf(shift(now, -countValue(m[1]))),
  },
  {
    name: "n-months-ago",
    regex: new RegExp(`\\b(${COUNT_ALTERNATION})\\s+months?\\s+ago\\b`, "i"),
    resolve: (m, { now }) => isoOf(shift(now, 0, -countValue(m[1]))),
  },
  {
    name: "n-days-ago",
    regex: new RegExp(`\\b(${COUNT_ALTERNATION})\\s+days?\\s+ago\\b`, "i"),
    resolve: (m, { now }) => isoOf(shift(now, 0, 0, -countValue(m[1]))),
  },
  {
    // "last year" resolves to the last day of that year: a point-in-time
    // lookup wants the compilation in force at the end of the period, not the
    // one in force on 1 January.
    name: "last-year",
    regex: /\blast\s+year\b/i,
    resolve: (_m, { now }) => toIso(now.getFullYear() - 1, 12, 31),
  },
  {
    name: "this-year",
    regex: /\bthis\s+year\b/i,
    resolve: (_m, { now }) => isoOf(now),
  },
  {
    name: "last-month",
    regex: /\blast\s+month\b/i,
    resolve: (_m, { now }) => isoOf(shift(now, 0, -1)),
  },
  {
    name: "last-week",
    regex: /\blast\s+week\b/i,
    resolve: (_m, { now }) => isoOf(shift(now, 0, 0, -7)),
  },
  {
    // Bare "1 July" with no year — assume the most recent occurrence.
    name: "day-month",
    regex: new RegExp(`${LEAD_IN}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})\\b(?!\\s+\\d)`, "i"),
    resolve: (m, { now }) => {
      const month = monthNumber(m[2])!
      const day = Number(m[1])
      const thisYear = toIso(now.getFullYear(), month, day)
      if (!thisYear) return undefined
      return thisYear <= isoOf(now) ? thisYear : toIso(now.getFullYear() - 1, month, day)
    },
  },
]

export interface RangePattern {
  name: string
  regex: RegExp
  resolve: (match: RegExpMatchArray, context: DateContext) => DateRange | undefined
}

const YEAR = "((?:1[89]|20)\\d{2})"

/** Range patterns, most specific first. */
export const RANGE_PATTERNS: readonly RangePattern[] = [
  {
    name: "between-full-dates",
    regex: new RegExp(
      `\\bbetween\\s+(.{4,32}?)\\s+and\\s+(.{4,32}?)(?=[,.;]|$)`,
      "i",
    ),
    resolve: (m, context) => {
      const from = resolveBoundary(m[1], context, "start")
      const to = resolveBoundary(m[2], context, "end")
      return from && to ? { from, to } : undefined
    },
  },
  {
    name: "from-to",
    regex: new RegExp(`\\bfrom\\s+(.{4,32}?)\\s+(?:to|until|through)\\s+(.{4,32}?)(?=[,.;]|$)`, "i"),
    resolve: (m, context) => {
      const from = resolveBoundary(m[1], context, "start")
      const to = resolveBoundary(m[2], context, "end")
      return from && to ? { from, to } : undefined
    },
  },
  {
    name: "year-to-year",
    regex: new RegExp(`\\b${YEAR}\\s*(?:-|–|—|to)\\s*${YEAR}\\b`, "i"),
    resolve: (m) => ({ from: `${m[1]}-01-01`, to: `${m[2]}-12-31` }),
  },
  {
    name: "since-year",
    regex: new RegExp(`\\b(?:since|after|from)\\s+${YEAR}\\b`, "i"),
    resolve: (m, { now }) => ({ from: `${m[1]}-01-01`, to: isoOf(now) }),
  },
  {
    name: "before-year",
    regex: new RegExp(`\\b(?:before|prior\\s+to|up\\s+to|until)\\s+${YEAR}\\b`, "i"),
    resolve: (m) => ({ from: "1901-01-01", to: `${Number(m[1]) - 1}-12-31` }),
  },
  {
    name: "last-n-years",
    regex: new RegExp(`\\b(?:last|past)\\s+(${COUNT_ALTERNATION})\\s+years?\\b`, "i"),
    resolve: (m, { now }) => ({ from: isoOf(shift(now, -countValue(m[1]))), to: isoOf(now) }),
  },
  {
    name: "last-n-months",
    regex: new RegExp(`\\b(?:last|past)\\s+(${COUNT_ALTERNATION})\\s+months?\\b`, "i"),
    resolve: (m, { now }) => ({ from: isoOf(shift(now, 0, -countValue(m[1]))), to: isoOf(now) }),
  },
  {
    // Bare year, last so the combining patterns above win. Anchored against a
    // neighbouring year so "2015 and 2019" is never read as one of them.
    name: "bare-year",
    regex: new RegExp(`(?<!\\d)(?<!-)${YEAR}(?!-\\d)(?!\\s*(?:-|–|—|to|and)\\s*\\d{4})(?!\\d)`, "i"),
    resolve: (m) => ({ from: `${m[1]}-01-01`, to: `${m[1]}-12-31` }),
  },
]

/**
 * Resolve one date fragment. Lives here rather than in `au-dates.ts` because
 * the range table needs it; the public entry point re-exports it.
 */
export function resolveSingle(fragment: string, context: DateContext): IsoDate | undefined {
  const text = fragment.trim()
  if (!text) return undefined
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.regex.exec(text)
    if (match) {
      const iso = pattern.resolve(match, context)
      if (iso) return iso
    }
  }
  const year = /^(?:1[89]|20)\d{2}$/.exec(text)
  return year ? `${year[0]}-01-01` : undefined
}

/**
 * Resolve a range endpoint.
 *
 * A bare year means the whole year, so which end of it is meant depends on
 * which end of the range it sits at: "between 2015 and 2019" runs to 31
 * December 2019, not to 1 January. Collapsing that would silently drop
 * eleven months of the requested window.
 */
export function resolveBoundary(
  fragment: string,
  context: DateContext,
  edge: "start" | "end",
): IsoDate | undefined {
  const text = fragment.trim()
  const bareYear = /^(?:1[89]|20)\d{2}$/.exec(text)
  if (bareYear) return edge === "start" ? `${bareYear[0]}-01-01` : `${bareYear[0]}-12-31`
  return resolveSingle(text, context)
}
