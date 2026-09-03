import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ATO_PIT_CURRENT,
  buildSearchBody,
  docIdFromHref,
  parseCategories,
  parseDocument,
  parseSearchResults,
  pitForDate,
} from "./ato.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const SEARCH = fixture("ato-search-cgt.html")
const DOCUMENT = fixture("ato-document-tr20241.html")

describe("buildSearchBody", () => {
  it("uses the endpoint's own field names", () => {
    const body = buildSearchBody({ allWords: "capital gains", phrase: "main residence", anyWords: "cgt" })
    expect(body.get("tm_and")).toBe("capital gains")
    expect(body.get("tm_phrase")).toBe("main residence")
    expect(body.get("tm_or")).toBe("cgt")
  })

  it("defaults the point-in-time to the 'current' sentinel", () => {
    expect(buildSearchBody({}).get("pit")).toBe(ATO_PIT_CURRENT)
    expect(ATO_PIT_CURRENT).toBe("99991231235958")
  })

  it("omits an unsupplied operator instead of sending an empty one", () => {
    expect(buildSearchBody({ allWords: "x" }).has("tm_phrase")).toBe(false)
  })
})

describe("docIdFromHref", () => {
  it("percent-decodes the docid out of a result href", () => {
    expect(docIdFromHref("/law/view/document?src=ws&docid=TXD%2FTD199970%2FNAT%2FATO%2F00001&dc=false")).toBe(
      "TXD/TD199970/NAT/ATO/00001",
    )
  })

  it("returns undefined when there is no docid", () => {
    expect(docIdFromHref("/law/view/browse")).toBeUndefined()
  })
})

describe("parseSearchResults — recorded POST /API/v1/law/lawservices/result", () => {
  const result = parseSearchResults(SEARCH, "https://www.ato.gov.au/API/v1/law/lawservices/result")

  it("reads the total and page from the <ol> attributes, not a hidden input", () => {
    // The research note described hidden `total` inputs; the endpoint actually
    // puts the count on the list element.
    expect(result.total).toBe(2584)
    expect(result.page).toBe(1)
  })

  it("extracts title, DocID and summary from each row", () => {
    const first = result.hits[0]
    expect(first.source).toBe("ATO Legal Database")
    expect(first.title).toBe("ATO ID 2006/34")
    expect(first.id).toBe("AID/AID200634/00001")
    expect(first.snippet).toContain("testamentary trust")
  })

  it("labels the product from the DocID prefix", () => {
    expect(result.hits[0].extra).toEqual([["Product", "ATO Interpretative Decision (ATO ID)"]])
  })

  it("builds the canonical document URL", () => {
    expect(result.hits[0].url).toBe(
      "https://www.ato.gov.au/law/view/document?docid=AID%2FAID200634%2F00001",
    )
  })

  it("does not invent a five-segment DocID for a three-segment one", () => {
    // ATO IDs really are AID/AID200634/00001 — padding them to
    // .../NAT/ATO/00001 produces a 404 that reads like "no such decision".
    expect(result.hits.some((hit) => hit.id.split("/").length === 3)).toBe(true)
  })
})

describe("parseCategories", () => {
  it("reads the facet category names and counts", () => {
    const categories = parseCategories(SEARCH)
    expect(categories.length).toBeGreaterThan(0)
    expect(categories.every((category) => category.name.length > 0)).toBe(true)
  })
})

describe("parseDocument — recorded TR 2024/1", () => {
  const document = parseDocument(DOCUMENT, "TXR/TR20241/NAT/ATO/00001")

  it("builds the title from the #LawFront headings", () => {
    expect(document.title).toContain("TR 2024/1")
    expect(document.title).toContain("composite items")
  })

  it("records the DocID and product type", () => {
    expect(document.metadata).toContainEqual(["DocID", "TXR/TR20241/NAT/ATO/00001"])
    expect(document.metadata).toContainEqual(["Product", "Taxation Ruling"])
  })

  it("returns the ruling body as paragraphs", () => {
    expect(document.text).toContain("Division 40")
    expect(document.text.split("\n").length).toBeGreaterThan(5)
  })

  it("offers the print and PDF renditions", () => {
    const labels = (document.documents ?? []).map((entry) => entry.label)
    expect(labels).toEqual(["Print view", "PDF"])
    expect(document.documents?.[0].url).toContain("/law/view/print?DocID=TXR%2FTR20241")
  })
})

describe("pitForDate", () => {
  it("builds the historical point-in-time stamp", () => {
    expect(pitForDate("2002-06-30")).toBe("20020630000001")
  })

  it("rejects a non-ISO date rather than sending a wrong point in time", () => {
    expect(() => pitForDate("30/06/2002")).toThrowError(/YYYY-MM-DD/)
  })
})

describe("shape failures", () => {
  it("labels a page without the results list as UPSTREAM_NO_DATA", () => {
    try {
      parseSearchResults("<html><body>Service unavailable</body></html>", "u")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
    }
  })
})
