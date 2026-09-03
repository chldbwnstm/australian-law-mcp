import { describe, expect, it } from "vitest"
import {
  extractCaseCitations,
  formatCitation,
  lookupCourt,
  normaliseCourtToken,
  parseCaseCitation,
  parseParallelCitation,
  preferredCitation,
  type CaseCitation,
} from "./case-citation.js"
import { COURT_CODES } from "./court-codes.js"
import { REPORT_SERIES, lookupSeries } from "./report-series.js"

function parsed(input: string): CaseCitation {
  const result = parseCaseCitation(input)
  if (!result.ok) throw new Error(`${input} did not parse: ${result.reason}`)
  return result.citation
}

describe("medium-neutral citations", () => {
  it("parses the canonical form", () => {
    const citation = parsed("[2020] HCA 41")
    expect(citation).toMatchObject({ kind: "mnc", year: 2020, court: "HCA", number: 41 })
    expect(citation.warnings).toEqual([])
    expect(formatCitation(citation)).toBe("[2020] HCA 41")
  })

  it("parses a citation carrying party names", () => {
    expect(parsed("Quarmby v Keating [2009] TASSC 80")).toMatchObject({ court: "TASSC", number: 80 })
    expect(parsed("*Mabo v Queensland (No 2)* [1992] HCA 23")).toMatchObject({ court: "HCA", number: 23 })
  })

  it("absorbs the dotted form", () => {
    expect(parsed("[2024] F.C.A.F.C. 170")).toMatchObject({ court: "FCAFC", number: 170 })
    expect(parsed("[2015] N.S.W.C.A. 228")).toMatchObject({ court: "NSWCA" })
    expect(normaliseCourtToken("F.C.A.F.C.")).toBe("FCAFC")
  })

  it("normalises case", () => {
    expect(parsed("[2020] hca 41").court).toBe("HCA")
    expect(parsed("[2025] NswCatAd 12").court).toBe("NSWCATAD")
  })

  it("parses a paragraph pinpoint", () => {
    const citation = parsed("Quarmby v Keating [2009] TASSC 80, [11]")
    expect(citation.pinpoint).toEqual({ paragraphs: ["11"] })
    expect(formatCitation(citation)).toBe("[2009] TASSC 80, [11]")
  })

  it("parses a paragraph range pinpoint", () => {
    expect(parsed("[2009] TASSC 80, [11]–[14]").pinpoint).toEqual({ paragraphs: ["11", "14"] })
    expect(parsed("[2009] TASSC 80, [11]-[14]").pinpoint).toEqual({ paragraphs: ["11", "14"] })
  })

  it("warns, rather than refusing, when the year predates MNC adoption", () => {
    const citation = parsed("[1990] HCA 12")
    expect(citation.warnings.join(" ")).toMatch(/1998/)
    expect(citation.warnings.join(" ")).toMatch(/not a rejection/)
  })

  it("warns when a closed body is cited after it closed, and names the successor", () => {
    const citation = parsed("[2026] AATA 12")
    expect(citation.warnings.join(" ")).toMatch(/ARTA/)
  })
})

// The one lesson the reference implementation paid for: an unrecognised
// token is a gap in this table, not evidence about the world.
describe("unknown court codes are unclear, never absent", () => {
  it("reports the reason and the token", () => {
    const result = parseCaseCitation("[2020] ZZZZ 41")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("court code unclear")
    expect(result.token).toBe("ZZZZ")
  })

  it("never uses not-found wording", () => {
    const result = parseCaseCitation("[2020] NOTACOURT 1")
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).not.toMatch(/not found|does not exist|no such/i)
  })

  it("keeps the unknown citation in an extraction instead of dropping it", () => {
    const found = extractCaseCitations("See [2020] HCA 41 and [2020] ZZZZ 7.")
    expect(found).toHaveLength(2)
    expect(found[1].ok).toBe(false)
  })
})

describe("report series", () => {
  it("parses a volume-numbered series in round brackets", () => {
    const citation = parsed("Mabo v Queensland (No 2) (1992) 175 CLR 1")
    expect(citation).toMatchObject({ kind: "report", year: 1992, volume: 175, series: "CLR", page: 1, bracket: "round" })
    expect(citation.warnings).toEqual([])
    expect(formatCitation(citation)).toBe("(1992) 175 CLR 1")
  })

  it("parses a year-as-volume series in square brackets", () => {
    const citation = parsed("Nydam v The Queen [1977] VR 430")
    expect(citation).toMatchObject({ kind: "report", year: 1977, series: "VR", page: 430, bracket: "square" })
    expect(citation).not.toHaveProperty("volume")
    expect(citation.warnings).toEqual([])
    expect(formatCitation(citation)).toBe("[1977] VR 430")
  })

  it("parses a spaced series abbreviation", () => {
    expect(parsed("(2010) 200 A Crim R 1")).toMatchObject({ series: "A Crim R", volume: 200, page: 1 })
    expect(parsed("[2005] 2 Qd R 90")).toMatchObject({ series: "Qd R", page: 90 })
  })

  it("absorbs a dotted series abbreviation", () => {
    expect(lookupSeries("A.Crim.R.")?.abbrev).toBe("A Crim R")
    expect(lookupSeries("C.L.R.")?.abbrev).toBe("CLR")
  })

  it("parses a page pinpoint and a page-plus-paragraph pinpoint", () => {
    expect(parsed("(1992) 175 CLR 1, 42").pinpoint).toEqual({ page: 42 })
    const both = parsed("(1992) 175 CLR 1, 42 [15]")
    expect(both.pinpoint).toEqual({ page: 42, paragraphs: ["15"] })
    expect(formatCitation(both)).toBe("(1992) 175 CLR 1, 42 [15]")
  })

  // A bracket slip is a formatting fault, not a hallucination. Reporting it
  // as anything stronger would turn a nit into a false accusation.
  it("warns about the wrong bracket instead of refusing", () => {
    const citation = parsed("[1992] 175 CLR 1")
    expect(citation.kind).toBe("report")
    expect(citation.warnings.join(" ")).toMatch(/round brackets/)
  })

  it("does not warn for series whose bracket style varies over time", () => {
    expect(parsed("[1998] 20 WAR 1").warnings).toEqual([])
  })

  it("keeps an unknown series usable and says only what it could not check", () => {
    const citation = parsed("(2010) 5 ZZZ 100")
    expect(citation).toMatchObject({ kind: "report", series: "ZZZ", volume: 5, page: 100 })
    expect(citation.warnings.join(" ")).toMatch(/not in the AGLC series table/)
  })
})

describe("parallel citations", () => {
  it("splits the canonical AGLC pairing", () => {
    const parallel = parseParallelCitation("Love v Commonwealth (2020) 270 CLR 152; [2020] HCA 3")
    expect(parallel.report).toMatchObject({ series: "CLR", volume: 270, page: 152 })
    expect(parallel.mnc).toMatchObject({ court: "HCA", number: 3 })
    expect(parallel.problems).toEqual([])
  })

  it("surfaces an unclear court token from one half without losing the other", () => {
    const parallel = parseParallelCitation("(1992) 175 CLR 1; [1992] ZZZZ 23")
    expect(parallel.report).toBeDefined()
    expect(parallel.mnc).toBeUndefined()
    expect(parallel.problems[0].reason).toBe("court code unclear")
  })

  it("prefers the authorised report over the MNC", () => {
    const parallel = parseParallelCitation("(2020) 270 CLR 152; [2020] HCA 3")
    const best = preferredCitation([parallel.report!, parallel.mnc!])!
    expect(formatCitation(best)).toBe("(2020) 270 CLR 152")
  })

  it("prefers an authorised series over an unauthorised one", () => {
    const best = preferredCitation([parsed("(1992) 107 ALR 1"), parsed("(1992) 175 CLR 1")])!
    expect(formatCitation(best)).toBe("(1992) 175 CLR 1")
  })
})

describe("extraction", () => {
  it("finds every citation in a paragraph, in order, de-duplicated", () => {
    const found = extractCaseCitations(
      "Following Mabo v Queensland (No 2) (1992) 175 CLR 1, the Court in [2020] HCA 41 " +
      "and again in [2020] HCA 41 applied Nydam v The Queen [1977] VR 430.",
    )
    expect(found.every((r) => r.ok)).toBe(true)
    expect(found.map((r) => (r.ok ? formatCitation(r.citation) : ""))).toEqual([
      "(1992) 175 CLR 1",
      "[2020] HCA 41",
      "[1977] VR 430",
    ])
  })

  it("finds nothing in text without a citation", () => {
    expect(extractCaseCitations("The Competition and Consumer Act 2010 (Cth) s 18 applies.")).toEqual([])
  })

  // These patterns run over caller-supplied documents, so a pathological
  // input must not be able to stall the process.
  it("does not backtrack catastrophically", () => {
    const evil = `[2020] ${"A".repeat(5000)} ${"1".repeat(5000)}` + " (1992) ".repeat(500)
    const started = Date.now()
    extractCaseCitations(evil)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("tables", () => {
  it("carries every court code the research report lists", () => {
    for (const code of [
      "HCA", "HCASL", "HCASJ", "FCA", "FCAFC", "FamCA", "FamCAFC", "FCCA", "FMCA",
      "FedCFamC1F", "FedCFamC1A", "FedCFamC2F", "FedCFamC2G",
      "AATA", "ARTA", "FWC", "FWCFB", "FWA", "FWAFB", "AIRC", "ACompT", "ACopyT",
      "AICmr", "ATP", "NNTTA", "ADFDAT",
      "NSWSC", "NSWCA", "NSWCCA", "NSWLEC", "NSWDC", "NSWLC", "NSWIRComm",
      "NSWCAT", "NSWCATAD", "NSWCATAP", "NSWCATCD", "NSWCATGD", "NSWCATOD",
      "NSWADT", "NSWADTAP",
      "VSC", "VSCA", "VCC", "VMC", "VCAT",
      "QSC", "QCA", "QDC", "QMC", "QCAT", "QCATA",
      "SASC", "SASCFC", "SASCA", "SADC", "SAERDC", "SACAT",
      "WASC", "WASCA", "WADC", "WASAT",
      "TASSC", "TASCCA", "TASCAT",
      "ACTSC", "ACTCA", "ACAT",
      "NTSC", "NTCA", "NTCCA", "NTCAT",
    ]) {
      expect(lookupCourt(code)?.code, code).toBe(code)
    }
  })

  it("has no duplicate court codes", () => {
    const codes = COURT_CODES.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("has no duplicate report series", () => {
    const series = REPORT_SERIES.map((entry) => entry.abbrev)
    expect(new Set(series).size).toBe(series.length)
  })

  it("ranks the authorised series first", () => {
    for (const abbrev of ["CLR", "FCR", "NSWLR", "VR", "Qd R", "SASR", "WAR", "Tas R", "NTR"]) {
      expect(lookupSeries(abbrev)?.rank, abbrev).toBe(1)
    }
    for (const abbrev of ["ALR", "ALJR", "FLR", "ACTLR"]) {
      expect(lookupSeries(abbrev)?.rank, abbrev).toBe(2)
    }
    for (const abbrev of ["A Crim R", "ACSR", "IR", "IPR", "ATD", "ATR"]) {
      expect(lookupSeries(abbrev)?.rank, abbrev).toBe(3)
    }
  })

  it("keeps CLR round and VR/Qd R square", () => {
    expect(lookupSeries("CLR")?.bracket).toBe("round")
    expect(lookupSeries("VR")?.bracket).toBe("square")
    expect(lookupSeries("Qd R")?.bracket).toBe("square")
  })
})
