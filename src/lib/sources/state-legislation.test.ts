import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../api-client.js"
import { ErrorCodes, LawApiError, UpstreamBlockedError, formatToolError } from "../errors.js"
import { ExecutionLimitError } from "../execution-limits.js"
import { requestCancelledError } from "../session-state.js"
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

/** A client whose every fetch fails the same way — the upstream-failure paths. */
const rejectingClient = (error: unknown): AuApiClient =>
  ({ fetchHtml: () => Promise.reject(error), fetchJson: () => Promise.reject(error) } as unknown as AuApiClient)

/** Records the paths asked for, so "never requested" is assertable. */
function spyClient(html = ""): { client: AuApiClient; paths: string[] } {
  const paths: string[] = []
  const client = {
    fetchHtml: (_host: string, path: string) => {
      paths.push(path)
      return Promise.resolve(html)
    },
  } as unknown as AuApiClient
  return { client, paths }
}

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

  it("percent-encodes the SA slug exactly once — a %2520 link is a dead link", async () => {
    // The only thing a blocked host can offer is the link, so it has to work.
    const error = await getStateLawText(noNetworkClient, "SA", "Fair Work Act 1994").catch((e) => e)
    expect(error.links[0]).toBe(
      "https://www.legislation.sa.gov.au/lz?path=/C/A/FAIR%20WORK%20ACT%201994",
    )
    expect(error.links[0]).not.toContain("%2520")
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

describe("Victoria — a failed lookup is never reported as a miss", () => {
  it("keeps a genuine 404 a miss, with the slug wording", async () => {
    const client = rejectingClient(
      new LawApiError("vicLegislation returned 404 for https://x", ErrorCodes.NOT_FOUND),
    )
    const result = await searchStateLaw(client, "VIC", "Crimes Act 1958")
    expect(result.hits).toEqual([])
    expect(result.total).toBe(0)
    expect(result.totalNote).toMatch(/did not\s+resolve/i)
  })

  it("surfaces an upstream failure as [EXTERNAL_API_ERROR] instead of an unresolved slug", async () => {
    const client = rejectingClient(
      new LawApiError("vicLegislation upstream server error (503)", ErrorCodes.API_ERROR),
    )
    const error = await searchStateLaw(client, "VIC", "Crimes Act 1958").catch((e) => e)
    expect(error).toBeInstanceOf(LawApiError)
    expect(error.code).toBe(ErrorCodes.API_ERROR)
    const rendered = formatToolError(error, "search_state_law").content[0].text
    expect(rendered).toContain("[EXTERNAL_API_ERROR]")
    expect(rendered).not.toMatch(/did not resolve/i)
  })

  it("surfaces a timeout rather than swallowing it", async () => {
    const client = rejectingClient(new Error("Request timeout after 30000ms for https://x"))
    await expect(searchStateLaw(client, "VIC", "Crimes Act 1958")).rejects.toThrowError(
      /Request timeout/i,
    )
  })

  it("lets budget exhaustion and cancellation abort the call", async () => {
    const budget = rejectingClient(new ExecutionLimitError("Upstream request budget exhausted."))
    await expect(searchStateLaw(budget, "VIC", "Crimes Act 1958")).rejects.toBeInstanceOf(
      ExecutionLimitError,
    )
    const cancelled = rejectingClient(requestCancelledError())
    const error = await searchStateLaw(cancelled, "VIC", "Crimes Act 1958").catch((e) => e)
    expect(error.name).toBe("AbortError")
  })

  it("reports a response-shape failure as UPSTREAM_NO_DATA, not as a slug that missed", async () => {
    const { client } = spyClient("   ")
    const error = await searchStateLaw(client, "VIC", "Crimes Act 1958").catch((e) => e)
    expect(error.code).toBe(ErrorCodes.UPSTREAM_NO_DATA)
  })
})

describe("caller-supplied ids cannot rewrite an upstream path", () => {
  it("rejects NT ids that are not one register slug, before any request", async () => {
    const { client, paths } = spyClient(NT_ACT)
    for (const bad of [
      "CRIMINAL-CODE-ACT-1983?view=full#top",
      "../../en/LegislationPortal/Acts",
      "CRIMINAL/CODE",
      "%2e%2e%2fadmin",
    ]) {
      const error = await getStateLawText(client, "NT", bad).catch((e) => e)
      expect(error).toBeInstanceOf(LawApiError)
      expect(error.code).toBe(ErrorCodes.INVALID_PARAM)
    }
    expect(paths).toEqual([])
  })

  it("still accepts the register slug, and the title it is built from", async () => {
    const { client, paths } = spyClient(NT_ACT)
    await getStateLawText(client, "NT", "CRIMINAL-CODE-ACT-1983")
    // The By-Title list spells the slug as the upper-cased title with hyphens
    // (fixture: "CRIMINAL CODE ACT 1983" ↔ CRIMINAL-CODE-ACT-1983).
    await getStateLawText(client, "NT", "Criminal Code Act 1983")
    expect(paths).toEqual([
      "en/Legislation/CRIMINAL-CODE-ACT-1983",
      "en/Legislation/CRIMINAL-CODE-ACT-1983",
    ])
  })

  it("rejects a QLD/TAS register id carrying a query string or fragment, before any request", async () => {
    const { client, paths } = spyClient()
    for (const jurisdiction of ["QLD", "TAS"] as const) {
      const error = await getStateLawText(client, jurisdiction, "act-1899-009?view=full#top").catch(
        (e) => e,
      )
      expect(error).toBeInstanceOf(LawApiError)
      expect(error.code).toBe(ErrorCodes.INVALID_PARAM)
    }
    expect(paths).toEqual([])
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
