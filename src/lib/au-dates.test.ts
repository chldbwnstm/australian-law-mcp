import { describe, expect, it } from "vitest"
import {
  extractQueryDates,
  parseAuDate,
  parseAuDateRange,
  parseDateFragment,
  stripMatchedDate,
  toIso,
  toIsoDate,
} from "./au-dates.js"
import {
  FINANCIAL_SPAN_SEPARATORS,
  FINANCIAL_YEAR_MARKERS,
  RANGE_PATTERNS,
} from "./au-date-patterns.js"

// Fixed "now" so every relative phrase is deterministic. Wednesday.
const NOW = new Date(2026, 8, 3) // 3 September 2026, local time

describe("explicit dates", () => {
  const cases: Array<[input: string, iso: string]> = [
    ["1 July 2020", "2020-07-01"],
    ["1st July 2020", "2020-07-01"],
    ["30 June 2015", "2015-06-30"],
    ["30 Jun 2015", "2015-06-30"],
    ["15 March 2019", "2019-03-15"],
    ["2020-07-01", "2020-07-01"],
    ["July 1, 2020", "2020-07-01"],
    ["Sept 9 2021", "2021-09-09"],
    ["as at 30 June 2015", "2015-06-30"],
    ["as of 30 June 2015", "2015-06-30"],
    ["on 15 March 2019", "2019-03-15"],
    ["in force at 1 July 2020", "2020-07-01"],
    ["the law as at 1 July 2020", "2020-07-01"],
  ]

  for (const [input, iso] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      expect(toIsoDate(input, NOW)).toBe(iso)
    })
  }

  // Australian convention. Reading this the American way returns a real but
  // wrong compilation for eleven months of every year.
  it("reads numeric dates day-first", () => {
    expect(toIsoDate("01/07/2020", NOW)).toBe("2020-07-01")
    expect(toIsoDate("15/03/2019", NOW)).toBe("2019-03-15")
    expect(toIsoDate("31.12.2019", NOW)).toBe("2019-12-31")
  })

  it("rejects an impossible calendar date instead of rolling it over", () => {
    expect(toIso(2019, 2, 31)).toBeUndefined()
    expect(toIsoDate("31 February 2019", NOW)).toBeNull()
    expect(toIsoDate("32/01/2020", NOW)).toBeNull()
  })

  it("reports which pattern fired and what it consumed", () => {
    const result = parseAuDate("compilation as at 30 June 2015 please", NOW)!
    expect(result.pattern).toBe("day-month-year")
    expect(result.matched).toBe("as at 30 June 2015")
  })

  it("returns null rather than defaulting to today", () => {
    expect(parseAuDate("Fair Work Act misleading conduct", NOW)).toBeNull()
    expect(parseAuDate("", NOW)).toBeNull()
  })
})

describe("relative dates", () => {
  const cases: Array<[input: string, iso: string]> = [
    ["today", "2026-09-03"],
    ["as at today", "2026-09-03"],
    ["yesterday", "2026-09-02"],
    ["two years ago", "2024-09-03"],
    ["2 years ago", "2024-09-03"],
    ["three months ago", "2026-06-03"],
    ["10 days ago", "2026-08-24"],
    ["last month", "2026-08-03"],
    ["last week", "2026-08-27"],
    ["this year", "2026-09-03"],
  ]

  for (const [input, iso] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      expect(toIsoDate(input, NOW)).toBe(iso)
    })
  }

  // A point-in-time lookup wants the compilation in force at the end of the
  // named period, not the one in force on its first day.
  it("resolves 'last year' to the end of that year", () => {
    expect(toIsoDate("last year", NOW)).toBe("2025-12-31")
  })

  it("resolves a bare day and month to the most recent occurrence", () => {
    expect(toIsoDate("1 July", NOW)).toBe("2026-07-01")
    expect(toIsoDate("1 December", NOW)).toBe("2025-12-01")
  })
})

describe("a month and a year", () => {
  // Without a month-year entry the phrase fell through to the bare-year rule
  // and resolved to 31 December — six months late, and on the far side of the
  // 1 July commencement date most Commonwealth amendments take, so the
  // compilation handed back contained amendments that were not yet in force.
  it("resolves to the end of the month, not the end of the year", () => {
    expect(toIsoDate("as at June 2015", NOW)).toBe("2015-06-30")
    expect(toIsoDate("in force at March 2019", NOW)).toBe("2019-03-31")
    expect(parseAuDate("as at June 2015", NOW)!.pattern).toBe("month-year")
  })

  it("counts the days of the month it was given", () => {
    expect(toIsoDate("February 2016", NOW)).toBe("2016-02-29")
    expect(toIsoDate("February 2015", NOW)).toBe("2015-02-28")
    expect(toIsoDate("Sept 2021", NOW)).toBe("2021-09-30")
  })

  it("does not steal a date that names its day", () => {
    expect(parseAuDate("30 June 2015", NOW)!.pattern).toBe("day-month-year")
    expect(parseAuDate("June 30, 2015", NOW)!.pattern).toBe("month-day-year")
    // And it must not rescue an impossible one: "31 February 2019" stays null
    // rather than quietly becoming the 28th.
    expect(toIsoDate("31 February 2019", NOW)).toBeNull()
  })

  it("consumes the lead-in, so the search text is not left holding it", () => {
    const result = extractQueryDates("Competition and Consumer Act as at June 2015", NOW)
    expect(result.date?.iso).toBe("2015-06-30")
    expect(result.range).toBeUndefined()
    expect(result.rest).toBe("Competition and Consumer Act")
  })

  // A question about a month is a question about the whole month. Reading it
  // as the month's last day dropped the other twenty-nine: `amendment_track`
  // sent 30 June 2019 as `fromDate` with no `toDate` and answered with every
  // amendment from that day to today, and `get_law_history` swept one day of
  // the month it was asked about.
  it("reads a month with no lead-in as the whole month", () => {
    const result = parseAuDateRange("amendments to the Privacy Act in June 2019", NOW)!
    expect(result.range).toEqual({ from: "2019-06-01", to: "2019-06-30" })
    expect(result.pattern).toBe("month-year-range")
    expect(parseAuDateRange("register changes in February 2016", NOW)!.range).toEqual({
      from: "2016-02-01",
      to: "2016-02-29",
    })
  })

  it("still answers a point-in-time question with one day", () => {
    // The lead-in is what makes it a point in time, and the single-date match
    // that carries it is wider than the window match inside it.
    const result = extractQueryDates("Privacy Act as at June 2015", NOW)
    expect(result.range).toBeUndefined()
    expect(result.date?.iso).toBe("2015-06-30")
    expect(extractQueryDates("in force at March 2019", NOW).date?.iso).toBe("2019-03-31")
  })

  it("leaves a day-bearing date and an open-ended period alone", () => {
    // "1 July 2020" names a day, not a July-long window…
    expect(parseAuDateRange("the law on 1 July 2020", NOW)).toBeNull()
    // …and "since June 2019" names an open-ended period, not that month.
    expect(parseAuDateRange("decisions since June 2019", NOW)).toBeNull()
  })

  it("reads a month at each end of a range", () => {
    // The standard spelling of the 2020-21 financial year. Until a month-year
    // fragment resolved, both boundaries came back undefined, the from-to
    // match was abandoned, and the query collapsed to calendar 2020.
    expect(parseAuDateRange("amendments from July 2020 to June 2021", NOW)!.range).toEqual({
      from: "2020-07-01",
      to: "2021-06-30",
    })
    expect(parseAuDateRange("between June 2015 and June 2019", NOW)!.range).toEqual({
      from: "2015-06-01",
      to: "2019-06-30",
    })
  })
})

describe("the Australian financial year", () => {
  // 1 July to 30 June, named by the year it ends in.
  const cases: Array<[input: string, from: string, to: string]> = [
    ["FY21", "2020-07-01", "2021-06-30"],
    ["FY 2021", "2020-07-01", "2021-06-30"],
    ["FY2020-21", "2020-07-01", "2021-06-30"],
    ["what changed in the 2020-21 financial year", "2020-07-01", "2021-06-30"],
    ["the 2020/21 financial year", "2020-07-01", "2021-06-30"],
    ["the 2020-2021 financial year", "2020-07-01", "2021-06-30"],
    ["financial year 2021", "2020-07-01", "2021-06-30"],
    ["the 2021 financial year", "2020-07-01", "2021-06-30"],
    ["FY99", "1998-07-01", "1999-06-30"],
    ["financial year 1999-00", "1999-07-01", "2000-06-30"],
  ]

  for (const [input, from, to] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      expect(parseAuDateRange(input, NOW)!.range).toEqual({ from, to })
    })
  }

  it("leaves a calendar range alone", () => {
    // No marker, so this is not a financial year and must not be read as one.
    // "to" is a financial-span separator as much as "-" is, so this is also
    // what proves the marker, not the separator, is what makes a span financial.
    expect(parseAuDateRange("amendments 2015-2019", NOW)!.range).toEqual({
      from: "2015-01-01",
      to: "2019-12-31",
    })
    expect(parseAuDateRange("amendments in 2019", NOW)!.range).toEqual({
      from: "2019-01-01",
      to: "2019-12-31",
    })
    expect(parseAuDateRange("2015 to 2019", NOW)!.pattern).toBe("year-to-year")
    expect(parseAuDateRange("amendments 2015-2019", NOW)!.pattern).toBe("year-to-year")
  })
})

describe("a multi-year financial span", () => {
  // A financial year is twelve months; a wider span carrying the same marker is
  // a run of them, and the run is the answer.
  //
  // The regression this pins: `financial-year-span` matched the phrase, declined
  // to resolve anything wider than one year, and whichever narrower pattern bit
  // next answered a six-year question with twelve months of it — differently for
  // each spelling, which is why no single example exposed it. "FY 2019-2024"
  // reached `financial-year` and came back as the year ending 30 June *2019*;
  // "financial years 2019-2024" missed that pattern's singular arms and came
  // back as six calendar years; "the 2019-2024 financial year" came back as the
  // year ending 30 June 2024. One question, three answers, one of them holding
  // none of the period asked about.
  const SPAN = { from: "2019-07-01", to: "2024-06-30" }

  // Written out rather than generated, so the regression stays legible.
  const spellings = [
    "FY 2019-2024",
    "FY2019-2024",
    "FY2019-24",
    "financial year 2019-2024",
    "financial years 2019-2024",
    "amendments in FY 2019-2024",
    "ATO rulings financial years 2019-2024",
    "the 2019-2024 financial year",
    "the 2019-2024 financial years",
    "the 2019-2024 FY",
    "the 2019-24 FY",
    "FY 2019/2024",
    "FY 2019 to 2024",
    "FY2019-FY2024",
  ]

  for (const spelling of spellings) {
    it(`keeps the whole span in ${JSON.stringify(spelling)}`, () => {
      const parsed = parseAuDateRange(spelling, NOW)!
      expect({ pattern: parsed.pattern, ...parsed.range }).toEqual({
        pattern: "financial-year-span",
        ...SPAN,
      })
    })
  }

  /**
   * Every phrase the pattern's own marker and separator lists admit, built from
   * the exported constants rather than from a hand-written list: a spelling
   * added to the parser cannot opt out of these two tests by not being written
   * down here.
   */
  function admittedSpellings(): string[] {
    const phrases: string[] = []
    for (const marker of FINANCIAL_YEAR_MARKERS) {
      // "FY2019" is written closed up; "financial year2019" is not.
      const gaps = marker === "FY" ? ["", " "] : [" "]
      for (const separator of FINANCIAL_SPAN_SEPARATORS) {
        const written = /^[a-z]+$/i.test(separator) ? [` ${separator} `] : [separator, ` ${separator} `]
        for (const sep of written) {
          for (const end of ["2024", "24"]) {
            for (const gap of gaps) {
              phrases.push(`${marker}${gap}2019${sep}${end}`)
              phrases.push(`${marker}${gap}2019${sep}${marker}${gap}${end}`)
              phrases.push(`amendments in the 2019${sep}${end} ${marker}`)
            }
          }
        }
      }
    }
    return phrases
  }

  it("answers every spelling its marker and separator lists admit", () => {
    const phrases = admittedSpellings()
    // The generator has to actually reach every entry of both lists, or the two
    // tests below would be vacuous for whatever it skipped.
    for (const marker of FINANCIAL_YEAR_MARKERS) {
      expect(phrases.some((phrase) => phrase.includes(marker))).toBe(true)
    }
    for (const separator of FINANCIAL_SPAN_SEPARATORS) {
      expect(phrases.some((phrase) => phrase.includes(separator))).toBe(true)
    }
    for (const phrase of phrases) {
      const parsed = parseAuDateRange(phrase, NOW)
      expect({ phrase, pattern: parsed?.pattern, ...parsed?.range }).toEqual({
        phrase,
        pattern: "financial-year-span",
        ...SPAN,
      })
    }
  })

  it("never declines a phrase its own regex matched", () => {
    // The choke point. Returning `undefined` here is what handed the span to a
    // pattern that reads one year, so the entry has to be total: matched means
    // answered, for every spelling and for the malformed spans too.
    const entry = RANGE_PATTERNS.find((pattern) => pattern.name === "financial-year-span")!
    const phrases = [...admittedSpellings(), "FY 2024-2019", "FY 2019-2019", "FY2019-19"]
    for (const phrase of phrases) {
      const match = entry.regex.exec(phrase)
      expect({ phrase, matched: match !== null }).toEqual({ phrase, matched: true })
      const range = entry.resolve(match!, { now: NOW })
      expect({ phrase, answered: range !== undefined }).toEqual({ phrase, answered: true })
      expect({ phrase, ordered: range!.from < range!.to }).toEqual({ phrase, ordered: true })
    }
  })

  it("reads the everyday two-year span as the same arithmetic", () => {
    // "2020-21" is the two-year case of "first year opens it, last year closes
    // it", not a separate rule. Reading a wider span as FY2019 *through* FY2024
    // instead would make the opening date depend on the closing one: the window
    // for "FY2019-2020" would open on 1 July 2019 and the one for "FY2019-2021"
    // on 1 July 2018, walking the start backwards as the caller extends the end.
    expect(parseAuDateRange("FY2020-21", NOW)!.range).toEqual({ from: "2020-07-01", to: "2021-06-30" })
    expect(parseAuDateRange("FY2019-2020", NOW)!.range).toEqual({ from: "2019-07-01", to: "2020-06-30" })
    expect(parseAuDateRange("FY2019-2021", NOW)!.range).toEqual({ from: "2019-07-01", to: "2021-06-30" })
    // A single financial year still belongs to `financial-year`: no span, no
    // steal, and FY21 is still the twelve months ending 30 June 2021.
    expect(parseAuDateRange("FY21", NOW)!.pattern).toBe("financial-year")
    expect(parseAuDateRange("the 2021 financial year", NOW)!.pattern).toBe("financial-year")
  })
})

describe("ranges", () => {
  it("reads a bare-year range to the end of the closing year", () => {
    expect(parseAuDateRange("between 2015 and 2019", NOW)!.range).toEqual({
      from: "2015-01-01",
      to: "2019-12-31",
    })
  })

  it("reads a hyphenated year range", () => {
    expect(parseAuDateRange("amendments 2015-2019", NOW)!.range).toEqual({
      from: "2015-01-01",
      to: "2019-12-31",
    })
    expect(parseAuDateRange("2015 to 2019", NOW)!.range).toEqual({
      from: "2015-01-01",
      to: "2019-12-31",
    })
  })

  it("reads a from/to range of full dates", () => {
    expect(parseAuDateRange("from 1 July 2020 to 30 June 2021", NOW)!.range).toEqual({
      from: "2020-07-01",
      to: "2021-06-30",
    })
  })

  it("reads a between range of full dates", () => {
    expect(parseAuDateRange("between 1 July 2020 and 30 June 2021", NOW)!.range).toEqual({
      from: "2020-07-01",
      to: "2021-06-30",
    })
  })

  it("reads open-ended ranges", () => {
    expect(parseAuDateRange("since 2015", NOW)!.range).toEqual({ from: "2015-01-01", to: "2026-09-03" })
    expect(parseAuDateRange("before 2015", NOW)!.range.to).toBe("2014-12-31")
  })

  it("reads rolling windows", () => {
    expect(parseAuDateRange("in the last 3 years", NOW)!.range).toEqual({
      from: "2023-09-03",
      to: "2026-09-03",
    })
    expect(parseAuDateRange("past six months", NOW)!.range.from).toBe("2026-03-03")
  })

  it("treats a lone year as that whole year", () => {
    expect(parseAuDateRange("amendments in 2019", NOW)!.range).toEqual({
      from: "2019-01-01",
      to: "2019-12-31",
    })
  })

  it("does not read an ISO date as a bare year", () => {
    expect(parseAuDateRange("2020-07-01", NOW)).toBeNull()
  })

  it("returns null when there is no time condition", () => {
    expect(parseAuDateRange("Fair Work Act s 90", NOW)).toBeNull()
  })
})

describe("stripMatchedDate", () => {
  it("removes the phrase it was given, not a re-parsed one", () => {
    expect(stripMatchedDate("Fair Work Act as at 1 July 2020", "as at 1 July 2020")).toBe("Fair Work Act")
  })

  it("removes the connective left dangling behind the date", () => {
    expect(stripMatchedDate("CCA as at 2015-06-30 version", "as at 2015-06-30")).toBe("CCA")
  })

  it("does not nibble the start of a real search term", () => {
    // "version" only goes if it stands alone; "versioning rules" survives.
    expect(stripMatchedDate("CCA 2015-06-30 versioning rules", "2015-06-30")).toBe("CCA versioning rules")
  })

  it("leaves the query alone when the phrase is not present", () => {
    expect(stripMatchedDate("Fair Work Act", "1 July 2020")).toBe("Fair Work Act")
  })
})

describe("extractQueryDates", () => {
  it("splits a point-in-time query into date and search terms", () => {
    const result = extractQueryDates("Competition and Consumer Act as at 30 June 2015", NOW)
    expect(result.date?.iso).toBe("2015-06-30")
    expect(result.rest).toBe("Competition and Consumer Act")
    expect(result.range).toBeUndefined()
  })

  // Reducing a window to one of its endpoints answers a different question.
  it("prefers a range over a single date when both could match", () => {
    const result = extractQueryDates("amendments between 2015 and 2019", NOW)
    expect(result.range?.range).toEqual({ from: "2015-01-01", to: "2019-12-31" })
    expect(result.date).toBeUndefined()
    expect(result.rest).toBe("amendments")
  })

  it("passes a query with no time condition through untouched", () => {
    expect(extractQueryDates("misleading or deceptive conduct", NOW)).toEqual({
      rest: "misleading or deceptive conduct",
    })
  })
})

describe("parseDateFragment", () => {
  it("resolves a tool parameter that may be written any of several ways", () => {
    expect(parseDateFragment("2015-06-30", NOW)).toBe("2015-06-30")
    expect(parseDateFragment("30 June 2015", NOW)).toBe("2015-06-30")
    expect(parseDateFragment("30/06/2015", NOW)).toBe("2015-06-30")
    expect(parseDateFragment("2015", NOW)).toBe("2015-01-01")
    expect(parseDateFragment("not a date", NOW)).toBeUndefined()
  })
})

