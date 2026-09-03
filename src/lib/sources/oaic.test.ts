import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildIndexPath, filterHits, parseDeterminations } from "./oaic.js"

const INDEX = readFileSync(new URL("./__fixtures__/oaic-determinations.html", import.meta.url), "utf-8")
const result = parseDeterminations(INDEX, "https://www.oaic.gov.au/x")

describe("buildIndexPath", () => {
  it("omits the page parameter for page 1 and adds Squiz's for the rest", () => {
    expect(buildIndexPath(1)).not.toContain("?")
    expect(buildIndexPath(3)).toContain("?result_26111_result_page=3")
  })
})

describe("parseDeterminations — recorded privacy determinations index", () => {
  it("reads every article.custom-listing__item", () => {
    expect(result.hits.length).toBeGreaterThanOrEqual(3)
  })

  it("extracts the AICmr citation and uses it as the id", () => {
    const first = result.hits[0]
    expect(first.source).toBe("OAIC")
    expect(first.citation).toBe("[2026] AICmr 40")
    expect(first.id).toBe("[2026] AICmr 40")
  })

  it("strips the trailing decision date from the title", () => {
    expect(result.hits[0].title).toBe(
      "Commissioner Initiated Investigation into Monash IVF Pty Ltd (Privacy) [2026] AICmr 40",
    )
  })

  it("keeps the structured cells the OAIC publishes", () => {
    const first = result.hits[0]
    expect(first.date).toBe("11 June 2026")
    expect(first.catchwords).toContain("Australian Privacy Principles")
    const labels = (first.extra ?? []).map(([label]) => label)
    expect(labels).toContain("Status")
    expect(labels).toContain("Legislative provision")
    expect(labels).toContain("Determination")
  })

  it("points the url at the AustLII copy of the full determination", () => {
    expect(result.hits[0].url).toMatch(/austlii\.edu\.au\/au\/cases\/cth\/AICmr\//)
  })

  it("reads the index's own result count", () => {
    expect(result.total).toBe(101)
  })
})

describe("filterHits", () => {
  it("matches across title, citation, catchwords and cells", () => {
    expect(filterHits(result.hits, "Monash").length).toBe(1)
    expect(filterHits(result.hits, "AICmr").length).toBe(result.hits.length)
  })

  it("ANDs the words, so more words narrow the result", () => {
    expect(filterHits(result.hits, "monash zzzznotpresent")).toHaveLength(0)
  })

  it("returns everything when no query is given", () => {
    expect(filterHits(result.hits, undefined)).toBe(result.hits)
  })
})

describe("shape failures", () => {
  it("labels an index without listing items as UPSTREAM_NO_DATA", () => {
    try {
      parseDeterminations("<html><body>nothing here</body></html>", "u")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
    }
  })
})
