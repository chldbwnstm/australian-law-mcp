import { describe, expect, it } from "vitest"
import { blockedCourtLinks, getCaseText, searchCases, sourcesFor } from "./precedents.js"

/** No network: every client method throws, so a routing test cannot leak a request. */
const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("sourcesFor", () => {
  it("routes a court token to the one source that carries it", () => {
    expect(sourcesFor({ court: "NSWCA" })).toEqual(["nsw"])
    expect(sourcesFor({ court: "HCA" })).toEqual(["hca"])
    expect(sourcesFor({ court: "QSC" })).toEqual(["qld"])
  })

  it("routes a jurisdiction to its reachable source", () => {
    expect(sourcesFor({ jurisdiction: "NSW" })).toEqual(["nsw"])
    expect(sourcesFor({ jurisdiction: "Queensland" })).toEqual(["qld"])
    expect(sourcesFor({ jurisdiction: "Cth" })).toEqual(["hca"])
  })

  it("returns no sources for a jurisdiction this server cannot reach", () => {
    // Empty means "nothing to ask", which the caller turns into
    // [UPSTREAM_BLOCKED] — never into an empty result set.
    expect(sourcesFor({ jurisdiction: "Vic" })).toEqual([])
    expect(sourcesFor({ jurisdiction: "SA" })).toEqual([])
  })

  it("fans out to all three when nothing is specified", () => {
    expect(sourcesFor({})).toEqual(["nsw", "hca", "qld"])
  })
})

describe("blockedCourtLinks", () => {
  it("offers the Federal Court's own URL plus AustLII and LawCite", () => {
    const links = blockedCourtLinks("[2019] FCA 12")
    expect(links[0]).toBe("https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/2019/2019fca0012")
    expect(links.some((link) => link.includes("austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCA/2019/12.html"))).toBe(true)
    expect(links.some((link) => link.includes("lawcite.austlii.edu.au"))).toBe(true)
  })

  it("uses the Full Court path for FCAFC", () => {
    expect(blockedCourtLinks("[2019] FCAFC 12")[0]).toContain("/fcafc/single/2019/2019fcafc0012")
  })

  it("still returns links for a citation it cannot parse", () => {
    expect(blockedCourtLinks("nonsense").length).toBeGreaterThan(0)
  })
})

describe("get_case_text — blocked courts are never 'not found'", () => {
  it("returns [UPSTREAM_BLOCKED] with deep links for a Federal Court citation", async () => {
    const result = await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/Do not report this as 'no such case/i)
    expect(text).toContain("judgments.fedcourt.gov.au")
    expect(text).not.toMatch(/NOT_FOUND/)
  })

  it("does the same for a Victorian citation", async () => {
    const text = (await getCaseText(noNetworkClient, { citation: "[2021] VSCA 100" })).content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("austlii.edu.au")
  })

  it("rejects a reported citation as unaddressable, with the citator link", async () => {
    const text = (await getCaseText(noNetworkClient, { citation: "(1992) 175 CLR 1" })).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toContain("lawcite.austlii.edu.au")
  })

  it("asks for a citation or id rather than guessing", async () => {
    const text = (await getCaseText(noNetworkClient, {})).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toMatch(/needs either `citation` or `id`/)
  })

  it("rejects an unknown source-id prefix instead of picking a source", async () => {
    const text = (await getCaseText(noNetworkClient, { id: "vic:1234" })).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toMatch(/Unrecognised source id prefix/)
  })
})

describe("search_cases — unreachable jurisdiction", () => {
  it("reports a blocked jurisdiction rather than an empty result", async () => {
    const result = await searchCases(noNetworkClient, { query: "negligence", jurisdiction: "Vic" })
    const text = result.content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/Do not report this as 'no such case/i)
    expect(text).toContain("austlii.edu.au")
  })
})
