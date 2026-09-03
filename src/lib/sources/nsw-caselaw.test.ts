import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ALL_NSW_COURT_IDS,
  NCAT_COURT_IDS,
  NSW_COURT_IDS,
  buildAdvancedPath,
  buildSearchPath,
  decisionDownloads,
  normaliseMnc,
  parseDecision,
  parseSearchResults,
  splitTitleCitation,
} from "./nsw-caselaw.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const SEARCH = fixture("nsw-search-negligence.html")
const MNC = fixture("nsw-mnc-lookup.html")
const DECISION = fixture("nsw-decision-dela-cruz.html")

describe("URL building", () => {
  it("uses `query`, not `q`, and a 0-indexed page", () => {
    expect(buildSearchPath({ query: "negligence", page: 0 })).toBe("search?query=negligence&page=0")
  })

  it("sends every advanced field plus the checkbox-group markers", () => {
    const path = buildAdvancedPath({ mnc: "[2010] NSWCCA 333", courts: [NSW_COURT_IDS.NSWCCA] })
    expect(path).toContain("mnc=%5B2010%5D%20NSWCCA%20333")
    // Without both markers the GET returns the blank advanced form.
    expect(path).toContain("_courts=on")
    expect(path).toContain("_tribunals=on")
    expect(path).toContain(`courts=${NSW_COURT_IDS.NSWCCA}`)
    for (const field of ["body", "title", "before", "catchwords", "party", "startDate", "endDate", "fileNumber", "legislationCited", "casesCited"]) {
      expect(path).toContain(`${field}=`)
    }
  })

  it("repeats `courts` once per selected id", () => {
    const path = buildAdvancedPath({ mnc: "x", courts: ["a", "b", "c"] })
    expect(path.match(/courts=/g)).toHaveLength(4) // three values plus `_courts=on`
  })
})

describe("court id table", () => {
  it("keeps the five NCAT divisions distinct", () => {
    expect(new Set(NCAT_COURT_IDS).size).toBe(5)
  })

  it("de-duplicates the shared industrial id", () => {
    expect(NSW_COURT_IDS.NSWIRComm).toBe(NSW_COURT_IDS.NSWIC)
    expect(ALL_NSW_COURT_IDS).toHaveLength(Object.keys(NSW_COURT_IDS).length - 1)
  })
})

describe("normaliseMnc", () => {
  it("adds the square brackets the form requires", () => {
    // `2010 NSWCCA 333` returns 0 of 0 upstream, which reads like absence.
    expect(normaliseMnc("2010 NSWCCA 333")).toBe("[2010] NSWCCA 333")
  })

  it("leaves an already-bracketed citation alone", () => {
    expect(normaliseMnc("  [2010]  NSWCCA  333 ")).toBe("[2010] NSWCCA 333")
  })
})

describe("splitTitleCitation", () => {
  it("splits the case name from a trailing medium-neutral citation", () => {
    expect(splitTitleCitation("Menzies v Wheatley [2014] NSWDC 147")).toEqual({
      title: "Menzies v Wheatley",
      citation: "[2014] NSWDC 147",
    })
  })

  it("returns the whole string when there is no citation", () => {
    expect(splitTitleCitation("Menzies v Wheatley")).toEqual({ title: "Menzies v Wheatley" })
  })
})

describe("parseSearchResults — recorded /search?query=negligence", () => {
  const result = parseSearchResults(SEARCH, "https://www.caselaw.nsw.gov.au/search?query=negligence")

  it("reads every div.row.result in the fixture", () => {
    expect(result.hits.length).toBeGreaterThanOrEqual(3)
  })

  it("extracts the decision id, citation and catchwords", () => {
    const first = result.hits[0]
    expect(first.id).toBe("549f74c33004262463a7e3c7")
    expect(first.title).toBe("(Re Zunic) BHP Billiton v Commonwealth of Australia")
    expect(first.citation).toBe("[2007] NSWDDT 34")
    expect(first.catchwords).toContain("Dust Diseases Tribunal")
    expect(first.url).toBe("https://www.caselaw.nsw.gov.au/decision/549f74c33004262463a7e3c7")
  })

  it("reads the sidebar judge and decision date", () => {
    const first = result.hits[0]
    expect(first.date).toBe("10 December 2007")
    expect(first.extra?.[0]).toEqual(["Judgment of", "O&apos;Meally P"])
  })

  it("flags the 10,000 cap rather than quoting it as a count", () => {
    expect(result.total).toBe(10000)
    expect(result.totalIsUnreliable).toBe(true)
    expect(result.totalNote).toMatch(/caps its reported total/i)
  })
})

describe("parseSearchResults — recorded exact-MNC advanced lookup", () => {
  const result = parseSearchResults(MNC, "https://www.caselaw.nsw.gov.au/search/advanced")

  it("returns the single matching decision", () => {
    expect(result.total).toBe(1)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].id).toBe("549fff1d3004262463c85662")
    expect(result.hits[0].citation).toBe("[2010] NSWCCA 333")
  })

  it("does not treat the form's example citation as a result", () => {
    // The advanced form's hint text contains "[2010] NSWCCA 333" too; only rows
    // inside div.row.result count.
    expect(result.hits.every((hit) => hit.id.length === 24)).toBe(true)
  })
})

describe("parseDecision — recorded /decision/{id}", () => {
  const document = parseDecision(DECISION, "549fff1d3004262463c85662")

  it("reads the coversheet label/value pairs", () => {
    const labels = document.metadata.map(([label]) => label)
    expect(labels).toContain("CITATION")
    expect(labels).toContain("JUDGMENT OF")
    expect(labels).toContain("DECISION")
  })

  it("takes the case name and citation from the CITATION row", () => {
    expect(document.title).toBe("Dela Cruz v R")
    expect(document.citation).toBe("[2010] NSWCCA 333")
  })

  it("keeps the reasons as readable text", () => {
    expect(document.text.length).toBeGreaterThan(1000)
    expect(document.text).toContain("Court of Criminal Appeal")
  })

  it("offers the deterministic export links", () => {
    expect(document.documents).toEqual([
      { label: "PDF", url: "https://www.caselaw.nsw.gov.au/decision/549fff1d3004262463c85662/export.pdf" },
      { label: "DOCX", url: "https://www.caselaw.nsw.gov.au/decision/549fff1d3004262463c85662/export.docx" },
    ])
  })
})

describe("shape failures", () => {
  it("reports an unrecognised page as UPSTREAM_NO_DATA, never as absence", () => {
    expect(() => parseSearchResults("<html><body>Maintenance</body></html>", "u")).toThrowError(
      /expected .* landmark/i,
    )
    try {
      parseSearchResults("<html><body>Maintenance</body></html>", "u")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
    }
  })

  it("treats an empty body as a shape failure too", () => {
    expect(() => parseDecision("   ", "abc")).toThrowError(/empty/i)
  })
})

describe("decisionDownloads", () => {
  it("builds both export URLs without scraping", () => {
    expect(decisionDownloads("abc").docx).toBe("https://www.caselaw.nsw.gov.au/decision/abc/export.docx")
  })
})
