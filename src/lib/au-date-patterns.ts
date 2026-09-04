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

/** Last calendar day of a month, leap years included: day 0 of the next one. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
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
    // "June 2015" — a month names a period, and a point-in-time question about
    // one wants the compilation in force at the **end** of it, the same
    // convention `last-year` and the bare-year range use. Without this entry
    // the phrase fell through to the bare year and "as at June 2015" resolved
    // to 31 December 2015 — six months late, and past the 1 July commencement
    // date most Commonwealth amendments take, so the compilation returned
    // contains amendments that were not in force when the caller asked about.
    // Placed after the day-bearing forms, and the lookbehind is what keeps it
    // from *rescuing* one: "31 February 2019" must stay null, not quietly
    // become 28 February. A day already written is a day the caller meant.
    name: "month-year",
    regex: new RegExp(
      `${LEAD_IN}(?<!\\d(?:st|nd|rd|th)?\\s{0,3})\\b(${MONTH_ALTERNATION})\\.?,?\\s+((?:1[89]|20)\\d{2})\\b`,
      "i",
    ),
    resolve: (m) => {
      const month = monthNumber(m[1])!
      const year = Number(m[2])
      return toIso(year, month, lastDayOfMonth(year, month))
    },
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
/** The closing year of a span, written in full or as a two-digit tail. */
const SPAN_END = "((?:1[89]|20)\\d{2}|\\d{2})"

/**
 * The Australian financial year: 1 July to 30 June, named by the year it
 * **ends** in. FY21 is 1 July 2020 to 30 June 2021.
 *
 * Reading it as a calendar year moves the window six months in the direction
 * that matters most — 1 July is when the bulk of Commonwealth amendments
 * commence, so a calendar reading of "FY21" both loses half the year asked
 * about and adds half a year that was not.
 */
function financialYear(endYear: number): DateRange {
  return { from: `${endYear - 1}-07-01`, to: `${endYear}-06-30` }
}

/** "2020-21" -> 2021, "1999-00" -> 2000: a two-digit tail carries the century. */
function spanEndYear(startYear: number, tail: string): number {
  const value = Number(tail)
  if (tail.length === 4) return value
  const carried = Math.floor(startYear / 100) * 100 + value
  return carried > startYear ? carried : carried + 100
}

/** A financial year written on its own: "FY21" -> 2021, "FY99" -> 1999. */
function namedYear(token: string): number {
  const value = Number(token)
  if (token.length === 4) return value
  return value >= 70 ? 1900 + value : 2000 + value
}

/**
 * The spellings that mark a hyphenated year span as *financial* years, and the
 * separators such a span may be written with.
 *
 * Exported because the tests enumerate them: every phrase these two lists admit
 * has to be answered by `financial-year-span` itself. A spelling added here and
 * not answered there fails that test instead of silently leaking to a later
 * pattern that reads one end of the span — which is precisely how "FY 2019-2024"
 * came back as the twelve months ending 30 June 2019.
 *
 * Deliberately *not* shared with `year-to-year`, whose separator set is its own
 * business: a bare "2015/2019" is not a calendar range, and widening that entry
 * is not this entry's job.
 */
export const FINANCIAL_YEAR_MARKERS = ["FY", "financial year", "financial years"] as const
export const FINANCIAL_SPAN_SEPARATORS = ["-", "–", "—", "/", "to"] as const

/** Longest first, so "financial years" is never read as "financial year" + stray "s". */
const FY_MARKER = `(?:${[...FINANCIAL_YEAR_MARKERS]
  .sort((a, b) => b.length - a.length)
  .map((marker) => marker.replace(/ /g, "\\s+"))
  .join("|")})`

const FY_SPAN_SEPARATOR = `\\s*(?:${FINANCIAL_SPAN_SEPARATORS.map((separator) =>
  separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|")})\\s*`

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
    // "FY2020-21", "the 2020-21 financial year", "2020/21 FY" — and the wider
    // "financial years 2019-2024", "FY2019 to FY2024". The marker has to appear
    // on one side or the other: a bare "2015-2019" is a calendar range and
    // belongs to `year-to-year` below, which is why this cannot simply be
    // folded into it.
    //
    // **This entry answers every phrase it matches.** It never returns
    // `undefined` and it never hands a span down the table, because the
    // patterns below read a single year and would answer a six-year question
    // with twelve months of it. It used to do exactly that for anything wider
    // than one financial year, and the damage was per-spelling, which is why
    // ordering alone could not repair it: "FY 2019-2024" fell to
    // `financial-year`'s `FY\s?(\d{2,4})` arm and came back as the year ending
    // 30 June **2019**; the same span written "financial years 2019-2024"
    // missed that arm (it wants the singular) and landed on `year-to-year`;
    // "the 2019-2024 financial year" hit a third arm and came back as the year
    // ending 30 June 2024. Three spellings of one question, three answers.
    //
    // Both years written are calendar years, and the period they name runs from
    // 1 July of the first to 30 June of the last — one arithmetic at every
    // width, of which the everyday "2020-21" is just the two-year case. The
    // other reading of a wide span — FY2019 *through* FY2024, each named by the
    // year it ends in — is rejected because it makes the opening date depend on
    // the closing one: "FY2019-2020" would open on 1 July 2019 and
    // "FY2019-2021" on 1 July 2018, walking the start of the window backwards
    // as the caller extends its end.
    name: "financial-year-span",
    regex: new RegExp(
      `\\b${FY_MARKER}\\s*${YEAR}${FY_SPAN_SEPARATOR}(?:${FY_MARKER}\\s*)?${SPAN_END}\\b` +
      `|\\b${YEAR}${FY_SPAN_SEPARATOR}${SPAN_END}\\s+${FY_MARKER}\\b`,
      "i",
    ),
    resolve: (m) => {
      const first = Number(m[1] ?? m[3])
      const written = spanEndYear(first, m[2] ?? m[4])
      // A span written backwards ("FY 2024-2019") names the same years, and
      // "FY 2019-2019" still names a period; ordering the pair and giving it a
      // floor of twelve months keeps this entry total, so there is no input
      // that matches here and gets answered somewhere narrower.
      const opens = Math.min(first, written)
      const closes = Math.max(opens + 1, first, written)
      return { from: financialYear(opens + 1).from, to: financialYear(closes).to }
    },
  },
  {
    // "FY21", "the 2021 financial year". Both name the year the period ends
    // in, so the span is still July-to-June.
    name: "financial-year",
    regex: new RegExp(
      `\\bFY\\s?((?:1[89]|20)\\d{2}|\\d{2})\\b` +
      `|\\b${YEAR}\\s+financial\\s+year\\b` +
      `|\\bfinancial\\s+year\\s+${YEAR}\\b`,
      "i",
    ),
    resolve: (m) => financialYear(namedYear(m[1] ?? m[2] ?? m[3])),
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
    // "June 2019" as a **window**. A month names a period, and a question
    // about what happened during one asks about all of it: before this entry
    // existed the phrase fell through to `bare-year` and produced the whole
    // calendar year; with only the single-date reading of it, the same
    // question collapsed to the month's last day and the other twenty-nine
    // were never swept.
    //
    // Which reading a caller meant is settled in `parseAuDateRange`: a
    // point-in-time phrase carries a lead-in ("as at June 2015"), so its
    // single-date match is strictly wider than this one and this match is
    // discarded as a fragment of it. A bare "in June 2019" matches both
    // exactly, and there the window is the answer to the question asked.
    //
    // The lookbehinds are guards, not decoration: a directional word in front
    // names an open-ended period rather than that month ("since June 2019"),
    // and a day already written is a day the caller meant ("1 July 2020" is
    // not a July-long window).
    name: "month-year-range",
    regex: new RegExp(
      `(?<!(?:since|after|before|until|through|to)\\s{1,3})` +
      `(?<!\\d(?:st|nd|rd|th)?\\s{0,3})\\b(${MONTH_ALTERNATION})\\.?,?\\s+${YEAR}\\b`,
      "i",
    ),
    resolve: (m) => {
      const month = monthNumber(m[1])!
      const year = Number(m[2])
      const from = toIso(year, month, 1)
      const to = toIso(year, month, lastDayOfMonth(year, month))
      return from && to ? { from, to } : undefined
    },
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

/** `June 2015` standing alone as one end of a range. */
const MONTH_YEAR_ONLY = new RegExp(`^(${MONTH_ALTERNATION})\\.?,?\\s+((?:1[89]|20)\\d{2})$`, "i")

/**
 * Resolve a range endpoint.
 *
 * A bare year — or a bare month — means the whole period, so which end of it
 * is meant depends on which end of the range it sits at: "between 2015 and
 * 2019" runs to 31 December 2019, not to 1 January. Collapsing that would
 * silently drop eleven months of the requested window.
 *
 * The month case is how an Australian financial year is usually spelled out:
 * "from July 2020 to June 2021" has to open on 1 July and close on 30 June,
 * and until a month-year fragment resolved at all the whole from-to match was
 * abandoned and the query fell back to a single calendar year.
 */
export function resolveBoundary(
  fragment: string,
  context: DateContext,
  edge: "start" | "end",
): IsoDate | undefined {
  const text = fragment.trim()
  const bareYear = /^(?:1[89]|20)\d{2}$/.exec(text)
  if (bareYear) return edge === "start" ? `${bareYear[0]}-01-01` : `${bareYear[0]}-12-31`
  const monthYear = MONTH_YEAR_ONLY.exec(text)
  if (monthYear) {
    const month = monthNumber(monthYear[1])!
    const year = Number(monthYear[2])
    return edge === "start" ? toIso(year, month, 1) : toIso(year, month, lastDayOfMonth(year, month))
  }
  return resolveSingle(text, context)
}
