import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildSearchPath, citationPath, parseJudgment, parseSearchResults } from "./qld-judgments.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const SEARCH = fixture("qld-search-negligence.html")
const JUDGMENT = fixture("qld-case-qsc-2020-100.html")

describe("citationPath", () => {
  it("maps a medium-neutral citation straight to a URL path", () => {
    expect(citationPath("[2020] QSC 100")).toBe("caselaw/qsc/2020/100")
    expect(citationPath("[2020] QSC 100", true)).toBe("caselaw/qsc/2020/100/pdf")
  })

  it("drops leading zeros in the judgment number", () => {
    expect(citationPath("[2020] QCA 007")).toBe("caselaw/qca/2020/7")
  })

  it("returns undefined for a reported citation it cannot address", () => {
    expect(citationPath("(1992) 175 CLR 1")).toBeUndefined()
  })
})

describe("buildSearchPath", () => {
  it("repeats multiSelectCourt[] with literal brackets", () => {
    const path = buildSearchPath({ text: "negligence", courts: ["QSC", "QCA"] })
    expect(path).toContain("multiSelectCourt[]=QSC")
    expect(path).toContain("multiSelectCourt[]=QCA")
    expect(path).not.toContain("%5B%5D")
  })

  it("defaults to 20 per page and page 1 (this site is 1-indexed)", () => {
    expect(buildSearchPath({ text: "x" })).toContain("per-page=20&page=1")
  })

  it("omits fields that were not supplied", () => {
    expect(buildSearchPath({ text: "x" })).not.toContain("queryStringCitation")
  })
})

describe("parseSearchResults — recorded /caselaw-search/query", () => {
  const result = parseSearchResults(SEARCH, "https://www.queenslandjudgments.com.au/x")

  it("reads the case name and citation out of span.caseName", () => {
    const first = result.hits[0]
    expect(first.source).toBe("Queensland Judgments")
    expect(first.title).toBe("White v Patterson")
    expect(first.citation).toBe("[2010] 2 Qd R 591")
  })

  it("keeps the internal /case/id/ identifier for the follow-up fetch", () => {
    expect(result.hits[0].id).toBe("505964")
  })

  it("flags the capped total instead of quoting it", () => {
    expect(result.total).toBe(10000)
    expect(result.totalIsUnreliable).toBe(true)
    expect(result.totalNote).toMatch(/capped at 10,000/i)
  })

  it("does NOT build a citation URL from a year-as-volume report citation", () => {
    // `[2010] 2 Qd R 591` puts a volume number where an MNC's court token goes.
    // Treating it as medium-neutral would produce /caselaw/2/2010/591.
    const reported = result.hits.filter((hit) => hit.citation?.includes(" Qd R "))
    expect(reported.length).toBeGreaterThan(0)
    for (const hit of reported) {
      expect(hit.url).toMatch(/\/case\/id\/\d+$/)
      expect(hit.url).not.toContain("/caselaw/2/")
    }
  })
})

describe("parseJudgment — recorded [2020] QSC 100", () => {
  const document = parseJudgment(JUDGMENT, "https://www.queenslandjudgments.com.au/caselaw/qsc/2020/100")

  it("takes the case name and citation from the print block", () => {
    expect(document.title).toBe("Attorney-General v Perkins")
    expect(document.citation).toBe("[2020] QSC 100")
  })

  it("reads the coversheet rows inside #report-view", () => {
    const labels = document.metadata.map(([label]) => label)
    expect(labels).toContain("CITATION")
    expect(labels).toContain("PARTIES")
    expect(labels).toContain("FILE NO")
  })

  it("returns the judgment body as readable paragraphs", () => {
    expect(document.text).toContain("SUPREME COURT OF QUEENSLAND")
    expect(document.text.split("\n").length).toBeGreaterThan(5)
  })

  it("appends the deterministic PDF link", () => {
    expect(document.documents).toEqual([
      { label: "PDF", url: "https://www.queenslandjudgments.com.au/caselaw/qsc/2020/100/pdf" },
    ])
  })

  it("says nothing extra when the reasons did come back", () => {
    expect(document.note).toBeUndefined()
  })
})

describe("a record served without reasons is not a short judgment", () => {
  it("says the reasons were not received, rather than returning a bare PDF link", () => {
    // Live 2026-09-05, `get_decision_text {domain:"cases", id:"qld:507327"}`
    // ([2010] 2 Qd R 312) returned 223 characters: a title, a citation and a PDF
    // link, with nothing saying the reasons were missing. `renderDocument`
    // prints no body section at all when `text` is empty, so a missing document
    // read as a short one. The FWC path already says this.
    // Shape of the live record read 2026-09-05: `casename_print` and
    // `citation_print` are present, `#report-view` is not, so there is no body
    // and no coversheet to read.
    const headnoteOnly =
      "<html><body>" +
      '<div class="casename_print">Lerinda Pty Ltd v Laertes Investments Pty Ltd</div>' +
      '<div class="citation_print">[2010] 2 Qd R 312</div>' +
      "</body></html>"
    const document = parseJudgment(headnoteOnly, "https://www.queenslandjudgments.com.au/case/id/507327")
    expect(document.text.trim()).toBe("")
    expect(document.note).toContain("without reasons in HTML")
    expect(document.note).toContain("The reasons exist")
    expect(document.note).not.toMatch(/does not exist/i)
  })
})

describe("shape failures", () => {
  it("labels a page without #report-view as UPSTREAM_NO_DATA", () => {
    try {
      parseJudgment("<html><body>nope</body></html>", "u")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
      expect((error as Error).message).not.toMatch(/does not exist/i)
    }
  })
})
