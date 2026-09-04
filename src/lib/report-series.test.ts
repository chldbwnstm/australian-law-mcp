/**
 * The report-series table, tested as data.
 *
 * A bracket recorded the wrong way round is invisible until a correctly
 * formatted citation is reported to the user as an AGLC error — the table is
 * the single source, so the fact is pinned here rather than in the parser.
 */

import { describe, expect, it } from "vitest"
import { parseCaseCitation } from "./case-citation.js"
import { REPORT_SERIES, lookupSeries, normaliseSeriesToken } from "./report-series.js"

describe("New South Wales Reports (NSWR)", () => {
  // NSWR ran 1960-1970 and the year is the volume: "Barton v Armstrong [1969]
  // 2 NSWR 451", "Ex parte Corbishley; Re Locke [1967] 2 NSWR 54". Its
  // successor NSWLR (1971- ) is the round-bracket one, and conflating them
  // turns every historical NSW citation into a formatting complaint.
  it("is a square-bracket, year-organised series", () => {
    expect(lookupSeries("NSWR")?.bracket).toBe("square")
    expect(lookupSeries("NSWLR")?.bracket).toBe("round")
  })

  it("does not warn about a correctly bracketed historical citation", () => {
    const result = parseCaseCitation("Smith v Jones [1968] 2 NSWR 500")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.citation.kind).toBe("report")
    expect(result.citation.warnings).toEqual([])
  })

  it("still flags the round-bracket form as the AGLC slip it is", () => {
    const result = parseCaseCitation("Smith v Jones (1968) 2 NSWR 500")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.citation.warnings.join(" ")).toContain("square brackets")
  })
})

describe("the table as a whole", () => {
  it("has one entry per normalised abbreviation", () => {
    const keys = REPORT_SERIES.map((entry) => normaliseSeriesToken(entry.abbrev))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
