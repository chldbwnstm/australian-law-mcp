import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildSearchPath, downloadUrl, parseDecisionPage, parseSearchResults } from "./fwc.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const SEARCH = fixture("fwc-search-redundancy.html")
const DECISION = fixture("fwc-decision-2014-fwc-3013.html")

describe("buildSearchPath", () => {
  it("selects the decisions search UI and a 0-indexed page", () => {
    const path = buildSearchPath({ query: "genuine redundancy" })
    expect(path).toContain("search-ui=decisions")
    expect(path).toContain("search=genuine%20redundancy")
    expect(path).toContain("page=0")
  })

  it("emits facets with literal square brackets", () => {
    const path = buildSearchPath({ query: "x", benchType: "full", facets: ["case-type:99"] })
    expect(path).toContain("f[0]=bench-type%3Afull")
    expect(path).toContain("f[1]=case-type%3A99")
    expect(path).not.toContain("f%5B0%5D")
  })
})

describe("parseSearchResults — recorded document-search", () => {
  const result = parseSearchResults(SEARCH, "https://www.fwc.gov.au/document-search")

  it("counts the returned rows, NOT the page's own results figure", () => {
    // The page prints "of 186201 results" for every query; only the rows are filtered.
    expect(result.total).toBe(result.hits.length)
    expect(result.total).toBeLessThan(1000)
  })

  it("carries the misleading facet total as a labelled warning", () => {
    expect(result.totalIsUnreliable).toBe(true)
    expect(result.totalNote).toMatch(/facet-wide document total/i)
    expect(result.totalNote).toContain("186201")
  })

  it("splits the case name from the trailing citation", () => {
    const first = result.hits[0]
    expect(first.source).toBe("Fair Work Commission")
    expect(first.title).toBe("Werner, David Bradley v BHPM Enterprises Pty Ltd T/A Big Lobster Cafe")
    expect(first.citation).toBe("[2014] FWC 3013")
  })

  it("keeps the decision slug and strips the ?from=search suffix", () => {
    const first = result.hits[0]
    expect(first.id).toBe("werner-david-bradley-v-bhpm-enterprises-pty-ltd-t-a-big-lobster-cafe-2014-fwc-3013")
    expect(first.url).toBe(
      "https://www.fwc.gov.au/document-view/decisions/werner-david-bradley-v-bhpm-enterprises-pty-ltd-t-a-big-lobster-cafe-2014-fwc-3013",
    )
  })

  it("reads the excerpt, the date chip and the download link", () => {
    const first = result.hits[0]
    expect(first.snippet).toContain("Unfair dismissal")
    expect(first.date).toBe("8 May 2014")
    expect(first.extra).toEqual([["Download", "https://www.fwc.gov.au/document-view/media/download/713708"]])
  })
})

describe("parseDecisionPage — recorded decision", () => {
  const document = parseDecisionPage(DECISION, "werner-2014-fwc-3013")

  it("takes the case name and citation from the page title", () => {
    expect(document.title).toBe("Werner, David Bradley v BHPM Enterprises Pty Ltd T/A Big Lobster Cafe")
    expect(document.citation).toBe("[2014] FWC 3013")
  })

  it("reads the metadata chips with their icon text removed", () => {
    expect(document.metadata).toContainEqual(["Bench", "single"])
    expect(document.metadata).toContainEqual(["Case number", "U2014/4188"])
    expect(document.metadata).toContainEqual(["Document type", "Decision"])
  })

  it("returns the PDF link and says the reasons are not in the HTML", () => {
    expect(document.documents).toEqual([
      { label: "PDF", url: "https://www.fwc.gov.au/document-view/media/download/713708" },
    ])
    expect(document.text).toBe("")
    expect(document.note).toMatch(/The reasons exist/i)
  })
})

describe("downloadUrl", () => {
  it("builds the media download path from an id", () => {
    expect(downloadUrl(883192)).toBe("https://www.fwc.gov.au/document-view/media/download/883192")
  })
})

describe("shape failures", () => {
  it("labels a page without result rows as UPSTREAM_NO_DATA", () => {
    try {
      parseSearchResults("<html><body>down for maintenance</body></html>", "u")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
    }
  })
})
