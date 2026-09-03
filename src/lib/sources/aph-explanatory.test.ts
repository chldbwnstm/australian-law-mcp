import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  billIdFromUri,
  billPageUrl,
  emHtmlUrl,
  esDownloadUrl,
  parseBillEmLinks,
  parseDocuments,
} from "./aph-explanatory.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const ES_JSON = JSON.parse(fixture("frl-documents-es.json")) as unknown
const BILL = fixture("aph-bill-r6940.html")

describe("parseDocuments — recorded Documents?$filter=… type eq 'ES'", () => {
  const documents = parseDocuments(ES_JSON)

  it("returns every rendition of the explanatory statement", () => {
    expect(documents.length).toBeGreaterThanOrEqual(2)
    expect(documents.map((document) => document.format)).toContain("Pdf")
    expect(documents.every((document) => document.type === "ES")).toBe(true)
  })

  it("keeps the as-made date, which is the URL's date segment", () => {
    expect(documents[0].start).toBe("2011-02-21")
    expect(documents[0].titleId).toBe("F2011L00287")
  })

  it("records which rendition is authorised", () => {
    expect(documents.some((document) => document.isAuthorised === true)).toBe(true)
  })

  it("returns nothing rather than throwing on an unexpected envelope", () => {
    expect(parseDocuments({})).toEqual([])
    expect(parseDocuments(null)).toEqual([])
  })
})

describe("esDownloadUrl", () => {
  it("uses the making date, not today", () => {
    expect(esDownloadUrl("F2011L00287", "pdf", "2011-02-21")).toBe(
      "https://www.legislation.gov.au/F2011L00287/asmade/2011-02-21/es/original/pdf",
    )
  })

  it("falls back to the doubled /asmade/asmade/ alias when the date is unknown", () => {
    expect(esDownloadUrl("F2011L00287", "word")).toBe(
      "https://www.legislation.gov.au/F2011L00287/asmade/asmade/es/original/word",
    )
  })
})

describe("billIdFromUri", () => {
  it("pulls the bill id out of an originatingBillUri", () => {
    expect(
      billIdFromUri('https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/billhome/r6940"'),
    ).toBe("r6940")
    expect(billIdFromUri("…/legislation/billhome/s1493")).toBe("s1493")
  })

  it("returns undefined when the Register has no bill link", () => {
    expect(billIdFromUri(null)).toBeUndefined()
    expect(billIdFromUri("https://example.com/other")).toBeUndefined()
  })
})

describe("parseBillEmLinks — recorded APH bill page", () => {
  const links = parseBillEmLinks(BILL)

  it("groups the formats of one memorandum together", () => {
    // The page lists the same EM twice (PDF and DOCX); the uuid is the identity.
    expect(links.length).toBe(2)
    expect(links[0].downloads.map((download) => download.label).sort()).toEqual(["PDF", "Word"])
  })

  it("separates the supplementary memorandum from the original", () => {
    const ids = links.map((link) => link.emId)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id.startsWith("r6940_ems_"))).toBe(true)
  })

  it("builds the ParlInfo HTML view URL, which is the curl-open form of the text", () => {
    expect(links[0].htmlUrl).toBe(
      `https://parlinfo.aph.gov.au/parlInfo/search/display/display.w3p;query=Id:"legislation/ems/${links[0].emId}"`,
    )
  })

  it("returns nothing for a page with no memorandum links", () => {
    expect(parseBillEmLinks("<html><body>no ems here</body></html>")).toEqual([])
  })
})

describe("URL builders", () => {
  it("builds the APH bill page URL from a bill id", () => {
    expect(billPageUrl("r6940")).toBe(
      "https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=r6940",
    )
  })

  it("quotes the ParlInfo Id: query the way ParlInfo requires", () => {
    expect(emHtmlUrl("r6940_ems_abc")).toContain('query=Id:"legislation/ems/r6940_ems_abc"')
  })
})
