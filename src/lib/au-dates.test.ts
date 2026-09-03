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
