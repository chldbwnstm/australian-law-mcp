import { readFileSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import {
  blockedCourtLinks,
  getCaseText,
  resolveCourt,
  searchCases,
  setAsideBridge,
  sourcesFor,
  type AsideBridge,
} from "./precedents.js"

/**
 * Recorded upstream response (src/lib/sources/__fixtures__/provenance.txt,
 * captured 2026-09-04): GET caselaw.nsw.gov.au/search/advanced?…mnc=[2010] NSWCCA 333…
 */
const NSW_MNC = readFileSync(
  new URL("../lib/sources/__fixtures__/nsw-mnc-lookup.html", import.meta.url),
  "utf8",
)

/** No network: every client method throws, so a routing test cannot leak a request. */
const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

/**
 * The Aside seam is stubbed for **every** test in this file, including the ones
 * that predate the fallback. `fetchViaAside` drives the user's real browser
 * through a child process; a test that reached the real bridge because someone
 * had `AU_LAW_ASIDE=1` exported would open browser tabs during `npm test`.
 */
const asideOff: AsideBridge = {
  asideStatus: () => ({ enabled: false, reason: 'AU_LAW_ASIDE is not set to "1".' }),
  fetchViaAside: async () => {
    throw new Error("the real Aside CLI must never be reached from a test")
  },
}

/** An enabled bridge that serves canned pages and records every URL it was given. */
function asideStub(pages: Record<string, string> | ((url: string) => Promise<string>)): AsideBridge & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    asideStatus: () => ({ enabled: true, command: "/stub/aside" }),
    fetchViaAside: async (url: string) => {
      urls.push(url)
      if (typeof pages === "function") return pages(url)
      const page = pages[url]
      if (page === undefined) throw new Error(`stub has no page for ${url}`)
      return page
    },
  }
}

const FCA_JUDGMENT_HTML = `<html><head><title>Smith v Commonwealth [2019] FCA 12</title></head><body>
  <h1>Smith v Commonwealth of Australia [2019] FCA 12</h1>
  <p>REASONS FOR JUDGMENT</p>
  ${"<p>1. The applicant seeks judicial review of the delegate's decision under s 5 of the ADJR Act.</p>".repeat(12)}
  <p>The application is dismissed with costs.</p>
</body></html>`

const AUSTLII_RESULTS_HTML = `<html><body>
  <ul>
    <li><a href="/cgi-bin/viewdoc/au/cases/cth/FCA/2026/771.html">Ng v Minister [2026] FCA 771</a></li>
    <li><a href="https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCA/2026/770.html">Patel v ASIC [2026] FCA 770</a></li>
    <li><a href="/help/about.html">About AustLII</a></li>
  </ul>
</body></html>`

beforeEach(() => setAsideBridge(asideOff))
afterAll(() => setAsideBridge(null))

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

  it("returns no sources for a court this server cannot serve", () => {
    // The defect this pins: FCA/FCAFC matched no branch, so the function fell
    // through to the full fan-out and a Federal Court request was answered
    // with NSW/HCA/QLD rows — no error, no marker, no deep link.
    expect(sourcesFor({ court: "FCA" })).toEqual([])
    expect(sourcesFor({ court: "FCAFC" })).toEqual([])
    expect(sourcesFor({ court: "VSCA" })).toEqual([])
    expect(sourcesFor({ court: "Federal Court" })).toEqual([])
  })

  it("does not let a blocked court be rescued by the jurisdiction", () => {
    expect(sourcesFor({ court: "FCA", jurisdiction: "Cth" })).toEqual([])
  })

  it("reads the prose a user actually types", () => {
    expect(resolveCourt("federal court")).toEqual({ kind: "blocked", court: "FCA", courtName: "Federal Court of Australia" })
    expect(resolveCourt("Full Court")).toMatchObject({ kind: "blocked", court: "FCAFC" })
    expect(resolveCourt("F.C.A.")).toMatchObject({ kind: "blocked", court: "FCA" })
    expect(resolveCourt("Supreme Court of Victoria")).toMatchObject({ kind: "blocked", court: "VSC" })
    expect(resolveCourt("high court")).toMatchObject({ kind: "live", court: "HCA", sources: ["hca"] })
    expect(resolveCourt("queensland court of appeal")).toMatchObject({ kind: "live", court: "QCA", sources: ["qld"] })
    expect(resolveCourt("nsw court of appeal")).toMatchObject({ kind: "live", court: "NSWCA", sources: ["nsw"] })
  })

  it("keeps the mixed-case scraper tokens routable", () => {
    expect(resolveCourt("qchcm")).toMatchObject({ kind: "live", court: "QChCM", sources: ["qld"] })
    expect(resolveCourt("nswircomm")).toMatchObject({ kind: "live", court: "NSWIRComm", sources: ["nsw"] })
  })

  it("calls a token that is not a court unknown rather than blocked", () => {
    expect(resolveCourt("banana")).toEqual({ kind: "unknown", token: "banana" })
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

describe("search_cases — the id: line is the id get_case_text takes", () => {
  beforeEach(() => lawCache.clear())

  const nswClient = { fetchHtml: async () => NSW_MNC } as unknown as AuApiClient

  it("prefixes the id on an exact-citation hit, like every other branch", async () => {
    const text = (await searchCases(nswClient, { query: "[2010] NSWCCA 333" })).content[0].text
    expect(text).toContain("id: nsw:549fff1d3004262463c85662")
    expect(text).not.toContain("id: 549fff1d3004262463c85662")
  })

  it("prints an id the get_ call actually accepts", async () => {
    const text = (await searchCases(nswClient, { query: "[2010] NSWCCA 333" })).content[0].text
    const id = /id: (\S+)/.exec(text)?.[1]
    expect(id).toBeDefined()
    // The failure this pins: feeding the printed id straight back used to give
    // "[INVALID_PARAMETER] Unrecognised source id prefix".
    const back = (await getCaseText(nswClient, { id: id as string })).content[0].text
    expect(back).not.toContain("Unrecognised source id prefix")
    // It routed to NSW Caselaw and asked for that decision (the fixture is a
    // search page, so reading it fails after the routing this test is about).
    expect(back).toContain("caselaw.nsw.gov.au/decision/549fff1d3004262463c85662")
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

describe("search_cases — a court this server cannot serve", () => {
  beforeEach(() => lawCache.clear())

  it("blocks a Federal Court request instead of answering it with NSW/HCA/QLD", async () => {
    // The reported defect, end to end: this used to return the three-source
    // fan-out (or its transport failure) with nothing saying the Federal Court
    // was never asked.
    const result = await searchCases(noNetworkClient, { query: "judicial review", court: "FCA" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("Federal Court of Australia")
    expect(text).toMatch(/Do not report this as 'no such case/i)
    expect(text).not.toContain("NSW Caselaw")
    // The deep link is court-restricted, not a bare AustLII search.
    expect(text).toContain("mask_path=au%2Fcases%2Fcth%2FFCA")
    expect(text).toContain("lawcite.austlii.edu.au")
  })

  it("does the same for the prose a user types", async () => {
    for (const court of ["Federal Court", "full court", "Supreme Court of Victoria"]) {
      const text = (await searchCases(noNetworkClient, { query: "negligence", court })).content[0].text
      expect(text).toContain("[UPSTREAM_BLOCKED]")
      expect(text).not.toContain("[EXTERNAL_API_ERROR]")
    }
    const full = (await searchCases(noNetworkClient, { query: "negligence", court: "full court" })).content[0].text
    expect(full).toContain("Full Court")
    expect(full).toContain("mask_path=au%2Fcases%2Fcth%2FFCAFC")
  })

  it("says a non-court token is unclear rather than calling it blocked", async () => {
    const text = (await searchCases(noNetworkClient, { query: "negligence", court: "banana" })).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toContain('"banana"')
    expect(text).not.toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/not that the court or the case does not exist/)
  })

  it("routes a court it can serve on the canonical token, not the caller's spelling", async () => {
    const seen: unknown[][] = []
    const qldClient = {
      fetchHtml: async (...args: unknown[]) => {
        seen.push(args)
        return "<html><body>no rows</body></html>"
      },
    } as unknown as AuApiClient
    await searchCases(qldClient, { query: "negligence", court: "queensland court of appeal" })
    // The prose reached Queensland Judgments as its own court filter token.
    expect(seen.flat().join(" ")).toContain("multiSelectCourt[]=QCA")
  })
})

describe("the Aside browser fallback — off", () => {
  beforeEach(() => lawCache.clear())

  it("keeps today's answer and adds one line saying the fallback exists", async () => {
    const text = (await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })).content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("judgments.fedcourt.gov.au")
    // Discoverability: a Claude Desktop Chat user never sees this repo, so if
    // the answer does not mention the fallback, the fallback does not exist.
    expect(text).toContain("Browser fallback (off)")
    // Names the toggle the extension actually renders, not a config file edit.
    expect(text).toContain("Finish blocked legal sources using the Aside browser")
    expect(text).toMatch(/Settings → Extensions/)
    expect(text).toContain('AU_LAW_ASIDE is not set to "1".')
  })

  it("adds the same line to a blocked search", async () => {
    const text = (await searchCases(noNetworkClient, { query: "penalty", court: "FCA" })).content[0].text
    expect(text).toContain("Browser fallback (off)")
  })

  it("adds it to a blocked jurisdiction too", async () => {
    const text = (await searchCases(noNetworkClient, { query: "negligence", jurisdiction: "Vic" })).content[0].text
    expect(text).toContain("Browser fallback (off)")
  })

  it("never says it when the answer is not a block", async () => {
    const text = (await getCaseText(noNetworkClient, {})).content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).not.toContain("Browser fallback (off)")
  })
})

describe("the Aside browser fallback — on", () => {
  beforeEach(() => lawCache.clear())

  it("returns the judgment through the user's browser, marked as such", async () => {
    const stub = asideStub({
      "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/2019/2019fca0012": FCA_JUDGMENT_HTML,
    })
    setAsideBridge(stub)
    const result = await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })
    const text = result.content[0].text

    expect(result.isError).toBeUndefined()
    expect(text).not.toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("[2019] FCA 12")
    expect(text).toContain("judicial review of the delegate's decision")
    // Browser-retrieved material is never presented as the publisher's answer.
    expect(text).toContain("Retrieved via: Aside")
    expect(text).toContain("not the publisher's API")
    expect(text).toContain("⚠️ Provenance")
    expect(text).not.toContain("Browser fallback (off)")
    // Containment: only URLs this file built from the parsed citation.
    expect(stub.urls).toEqual([
      "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/2019/2019fca0012",
    ])
  })

  it("falls back to AustLII's copy when the court's own page does not come back", async () => {
    const stub = asideStub(async (url: string) => {
      if (url.includes("fedcourt")) throw new Error("Cloudflare interstitial")
      return FCA_JUDGMENT_HTML
    })
    setAsideBridge(stub)
    const text = (await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })).content[0].text
    expect(text).toContain("Retrieved via: Aside")
    expect(stub.urls[1]).toContain("austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCA/2019/12.html")
  })

  it("reports the block, and that the browser was tried, when the page is an interstitial", async () => {
    setAsideBridge(asideStub(() => Promise.resolve("<html><body>Checking your browser…</body></html>")))
    const text = (await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })).content[0].text
    // A 30-character shell is not a judgment. Returning it as the reasons would
    // be worse than returning the block.
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("the Aside browser fallback is on and was tried")
    expect(text).toContain("too little to be the reasons")
    expect(text).not.toContain("Browser fallback (off)")
  })

  it("still refuses to claim absence when the bridge refuses the host", async () => {
    setAsideBridge({
      asideStatus: () => ({ enabled: true, command: "/stub/aside" }),
      fetchViaAside: async () => {
        throw new Error("host not on the browser-fallback allowlist")
      },
    })
    const text = (await getCaseText(noNetworkClient, { citation: "[2019] FCA 12" })).content[0].text
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("host not on the browser-fallback allowlist")
    expect(text).not.toMatch(/NOT_FOUND/)
  })

  it("answers a blocked keyword search with the browser's own result page", async () => {
    const stub = asideStub(() => Promise.resolve(AUSTLII_RESULTS_HTML))
    setAsideBridge(stub)
    const result = await searchCases(noNetworkClient, { query: "judicial review", court: "FCA", limit: 5 })
    const text = result.content[0].text

    expect(result.isError).toBeUndefined()
    expect(text).toContain("Retrieved via: Aside")
    expect(text).toContain("Ng v Minister [2026] FCA 771")
    expect(text).toContain("https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCA/2026/771.html")
    // Non-case chrome is not dressed up as a result.
    expect(text).not.toContain("About AustLII")
    // The rows are links, not ids get_case_text would reject.
    expect(text).not.toMatch(/^\s*id: /m)
    expect(stub.urls[0]).toContain("mask_path=au%2Fcases%2Fcth%2FFCA")
  })

  it("does not invent hits when the page has no case links", async () => {
    setAsideBridge(asideStub(() => Promise.resolve("<html><body><p>Your search returned no documents.</p></body></html>")))
    const text = (await searchCases(noNetworkClient, { query: "zzz", court: "FCA" })).content[0].text
    expect(text).toContain("No case links could be read off this page")
    expect(text).toMatch(/not about whether decisions exist/)
    expect(text).toContain("Your search returned no documents.")
  })

  it("routes an exact citation in a blocked court through the browser too", async () => {
    const stub = asideStub(() => Promise.resolve(FCA_JUDGMENT_HTML))
    setAsideBridge(stub)
    const text = (await searchCases(noNetworkClient, { query: "[2019] FCA 12" })).content[0].text
    expect(text).toContain("Retrieved via: Aside")
    expect(stub.urls[0]).toContain("judgments.fedcourt.gov.au")
  })

  it("leaves a reachable court alone — the fallback is for blocked sources only", async () => {
    const stub = asideStub(() => Promise.resolve(FCA_JUDGMENT_HTML))
    setAsideBridge(stub)
    const nswClient = { fetchHtml: async () => NSW_MNC } as unknown as AuApiClient
    const text = (await searchCases(nswClient, { query: "[2010] NSWCCA 333" })).content[0].text
    expect(text).toContain("id: nsw:549fff1d3004262463c85662")
    expect(stub.urls).toEqual([])
  })
})
