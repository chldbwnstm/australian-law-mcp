import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildListingPath, parseDetail, parseListing } from "./hcourt.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const LISTING = fixture("hca-search-native-title.html")
const DETAIL = fixture("hca-detail-potter.html")

describe("buildListingPath", () => {
  it("sends the year facet with LITERAL square brackets", () => {
    // Percent-encoding f%5B0%5D is a WAF 403 — this is the whole reason the
    // query string is assembled here instead of via FetchOpts.query.
    expect(buildListingPath({ year: 2020 })).toContain("f[0]=d:2020")
    expect(buildListingPath({ year: 2020 })).not.toContain("%5B")
  })

  it("percent-encodes keyword and case-number values", () => {
    expect(buildListingPath({ keywords: "native title" })).toContain("keywords=native%20title")
    expect(buildListingPath({ caseNumber: "M47/2025" })).toContain("case_number=M47%2F2025")
  })

  it("omits page=0 (the site's first page has no parameter)", () => {
    expect(buildListingPath({ keywords: "x", page: 0 })).not.toContain("page=")
    expect(buildListingPath({ keywords: "x", page: 2 })).toContain("page=2")
  })
})

describe("parseListing — recorded keywords=native+title", () => {
  const result = parseListing(LISTING, "https://www.hcourt.gov.au/x")

  it("reads the view-summary total", () => {
    expect(result.total).toBe(52)
  })

  it("extracts title, citation, slug and metadata from each views-row", () => {
    const first = result.hits[0]
    expect(first.source).toBe("High Court of Australia")
    expect(first.title).toBe("Potter (A Pseudonym) v The King")
    expect(first.citation).toBe("[2026] HCA 25")
    expect(first.id).toBe("potter-pseudonym-v-king")
    expect(first.date).toBe("05 Aug 2026")
    expect(first.extra).toEqual([
      ["Before", "Gageler CJ, Gordon, Steward, Jagot, Beech-Jones JJ"],
      ["Case number", "A24/2025"],
    ])
  })

  it("strips the bold field label out of each value", () => {
    for (const hit of result.hits) {
      expect(hit.citation ?? "").not.toMatch(/Citation:/)
      expect(hit.date ?? "").not.toMatch(/Date:/)
    }
  })

  it("builds an absolute judgment URL", () => {
    expect(result.hits[0].url).toBe(
      "https://www.hcourt.gov.au/cases-and-judgments/judgments/judgments-1998-current/potter-pseudonym-v-king",
    )
  })
})

describe("parseDetail — recorded judgment page", () => {
  const document = parseDetail(DETAIL, "potter-pseudonym-v-king")

  it("reads the page title and the citation span", () => {
    expect(document.title).toBe("Potter (A Pseudonym) v The King")
    expect(document.citation).toBe("[2026] HCA 25")
  })

  it("collects date, case number, bench and catchwords", () => {
    const labels = document.metadata.map(([label]) => label)
    expect(labels).toContain("Judgment date")
    expect(labels).toContain("Case number")
    expect(labels).toContain("Catchwords")
  })

  it("scrapes the PDF and DOCX links rather than constructing them", () => {
    // The upload-date segment is not derivable from the citation.
    const urls = (document.documents ?? []).map((entry) => entry.url)
    expect(urls.some((url) => url.endsWith(".pdf"))).toBe(true)
    expect(urls.some((url) => url.endsWith(".docx"))).toBe(true)
    expect(urls[0]).toContain("/sites/default/files/eresources/2026-08-05/HCA/")
  })

  it("says plainly that the reasons are only in the PDF", () => {
    expect(document.note).toMatch(/only.*available as the PDF/i)
    expect(document.note).toMatch(/Nothing here says the reasons do not exist/i)
  })
})

describe("shape failures", () => {
  it("rejects a page with no views-row landmark", () => {
    try {
      parseListing("<html><body>maintenance</body></html>", "u")
      throw new Error("should have thrown")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
    }
  })
})
