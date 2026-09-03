import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { UpstreamBlockedError } from "../errors.js"
import {
  actDownloadUrls,
  actRegisterId,
  getStateLawText,
  normaliseJurisdiction,
  parseActPage,
  parseNtActPage,
  parseNtIndex,
  parseVicActPage,
  parseWaIndex,
  searchStateLaw,
  vicSlug,
  waIndexLetter,
} from "./state-legislation.js"

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")
const WA = fixture("wa-actsif-c.html")
const NT_INDEX = fixture("nt-acts-by-title.html")
const NT_ACT = fixture("nt-act-criminal-code.html")
const VIC = fixture("vic-version-crimes-331.html")
const ACT = fixture("act-a-2001-14.html")

/** No network: every method throws, so a test that touches one fails loudly. */
const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("normaliseJurisdiction", () => {
  it("accepts abbreviations and full names, case-insensitively", () => {
    expect(normaliseJurisdiction("qld")).toBe("QLD")
    expect(normaliseJurisdiction("Western Australia")).toBe("WA")
    expect(normaliseJurisdiction("  NSW ")).toBe("NSW")
  })

  it("returns undefined for something it does not know", () => {
    expect(normaliseJurisdiction("Auckland")).toBeUndefined()
  })
})

describe("NSW and SA are blocked, never empty", () => {
  it("throws UpstreamBlockedError with deep links from search", async () => {
    await expect(searchStateLaw(noNetworkClient, "NSW", "act-2010-123")).rejects.toBeInstanceOf(
      UpstreamBlockedError,
    )
    const error = await searchStateLaw(noNetworkClient, "NSW", "act 2010-123").catch((e) => e)
    expect(error.links[0]).toContain("legislation.nsw.gov.au/view/html/inforce/current/act-2010-123")
    expect(error.message).toMatch(/not an observation about the record/i)
  })

  it("throws for SA too, with an /lz browse link", async () => {
    const error = await getStateLawText(noNetworkClient, "SA", "CRIMINAL LAW").catch((e) => e)
    expect(error).toBeInstanceOf(UpstreamBlockedError)
    expect(error.links[0]).toContain("legislation.sa.gov.au/lz?path=/C/A/")
  })
})

describe("Western Australia", () => {
  it("picks the A–Z index letter from the first significant word", () => {
    expect(waIndexLetter("Criminal Code Act")).toBe("c")
    expect(waIndexLetter("The Dog Act 1976")).toBe("d")
    expect(waIndexLetter("42 things")).toBe("a")
  })

  it("reads the title, act number, page id and full-text document id from each row", () => {
    const rows = parseWaIndex(WA, "https://www.legislation.wa.gov.au/x")
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const first = rows[0]
    expect(first.title).toBe("Cambridge Endowment Lands Act 1920")
    expect(first.pageId).toBe("law_a101")
    expect(first.actNumber).toContain("031 of 1920")
    // The A–Z row carries the mrdoc id directly, so one page answers both
    // "which act is it" and "where is the text".
    expect(first.mrdocId).toBe("mrdoc_23112")
  })
})

describe("Northern Territory", () => {
  it("reads slug and title from the By-Title list", () => {
    const acts = parseNtIndex(NT_INDEX, "https://legislation.nt.gov.au/x")
    expect(acts.length).toBeGreaterThanOrEqual(3)
    expect(acts.find((act) => act.slug === "ABORIGINAL-LAND-ACT-1978")?.title).toBe(
      "ABORIGINAL LAND ACT 1978",
    )
  })

  it("de-duplicates repeated links", () => {
    const acts = parseNtIndex(NT_INDEX, "u")
    expect(new Set(acts.map((act) => act.slug)).size).toBe(acts.length)
  })

  it("returns the PDF/Word API links and says the text is a download", () => {
    const document = parseNtActPage(NT_ACT, "CRIMINAL-CODE-ACT-1983")
    expect(document.documents).toContainEqual({
      label: "PDF",
      url: "https://legislation.nt.gov.au/api/sitecore/Act/PDF?id=11734",
    })
    expect(document.documents).toContainEqual({
      label: "Word",
      url: "https://legislation.nt.gov.au/api/sitecore/Act/Word?id=11734",
    })
    expect(document.note).toMatch(/format limitation, not an absence/i)
  })
})

describe("Victoria", () => {
  it("builds the register's slug from a title", () => {
    expect(vicSlug("Crimes Act 1958")).toBe("crimes-act-1958")
    expect(vicSlug("Children's Services Act 1996")).toBe("childrens-services-act-1996")
  })

  it("reads the title, act number, version and version history", () => {
    const document = parseVicActPage(VIC, "crimes-act-1958")
    expect(document.title).toBe("Crimes Act 1958")
    expect(document.metadata.map(([, value]) => value).join(" ")).toContain("6231/1958")
    expect((document.documents ?? []).length).toBeGreaterThan(0)
    expect(document.documents?.[0].url).toContain("/in-force/acts/crimes-act-1958/")
  })

  it("states that the authorised downloads are client-side only", () => {
    const document = parseVicActPage(VIC, "crimes-act-1958")
    expect(document.note).toMatch(/injected by JavaScript/i)
    expect(document.note).toMatch(/says nothing about whether it exists/i)
  })
})

describe("Australian Capital Territory", () => {
  it("extracts the register number from several spellings", () => {
    expect(actRegisterId("a/2001-14")).toBe("2001-14")
    expect(actRegisterId("2001-14")).toBe("2001-14")
    expect(actRegisterId("Legislation Act 2001")).toBeUndefined()
  })

  it("builds the current-version download URLs", () => {
    expect(actDownloadUrls("2001-14")).toEqual([
      { label: "PDF", url: "https://www.legislation.act.gov.au/DownloadFile/a/2001-14/current/PDF/2001-14.PDF" },
      { label: "DOCX", url: "https://www.legislation.act.gov.au/DownloadFile/a/2001-14/current/DOCX/2001-14.DOCX" },
    ])
  })

  it("prefers the page's own current-version links and explains the missing index", () => {
    const document = parseActPage(ACT, "2001-14")
    expect(document.title).toBe("Legislation Act 2001")
    expect((document.documents ?? []).some((entry) => entry.url.includes("/current/"))).toBe(true)
    expect(document.note).toMatch(/no reachable title index/i)
  })

  it("refuses to guess a register number from a title", async () => {
    await expect(getStateLawText(noNetworkClient, "ACT", "Legislation Act")).rejects.toThrowError(
      /register numbers like 2001-14/i,
    )
  })
})

describe("shape failures", () => {
  it("labels a missing landmark as UPSTREAM_NO_DATA on every register", () => {
    const cases: Array<() => unknown> = [
      () => parseWaIndex("<html><body>x</body></html>", "u"),
      () => parseNtIndex("<html><body>x</body></html>", "u"),
      () => parseNtActPage("   ", "SLUG"),
    ]
    for (const run of cases) {
      try {
        run()
        throw new Error("should have thrown")
      } catch (error) {
        expect((error as { code?: string }).code).toBe("UPSTREAM_NO_DATA")
      }
    }
  })
})
