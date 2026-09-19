import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { readAsideSearchHits } from "../lib/sources/aside-case-pages.js"
import { parseSearchResults } from "../lib/sources/nsw-caselaw.js"
import { extractHitIds } from "./search-hits.js"
import { searchCases, setAsideBridge } from "./precedents.js"
import { searchDecisions } from "./unified-decisions.js"

// Publisher captures: NSW 2026-09-04 (sources/__fixtures__/provenance.txt),
// AustLII 2026-09-13 (sources/__fixtures__/aside/provenance.json).
const fixture = (name: string) => readFileSync(new URL(`../lib/sources/__fixtures__/${name}`, import.meta.url), "utf8")
const nswHtml = fixture("nsw-search-negligence.html")
const asideHtml = fixture("aside/austlii-search-ready.html")
const asideUrl = "https://www.austlii.edu.au/cgi-bin/sinosrch.cgi?method=auto&query=prepayment&mask_path=au%2Fcases%2Fcth%2FFCAFC"
const client = new AuApiClient()

beforeEach(() => {
  lawCache.clear()
  vi.stubEnv("AU_LAW_JEV", "true")
  vi.stubEnv("TYPESAFE_API_KEY", "integration-test-key")
  setAsideBridge({ asideStatus: () => ({ enabled: false }), fetchViaAside: async () => { throw new Error("Unexpected browser access") } })
  vi.spyOn(client, "fetchHtml").mockResolvedValue(nswHtml)
})
afterEach(() => { lawCache.clear(); setAsideBridge(null); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Fake evaluator, not a legal-source fixture: force the reverse order. */
function reverseScores() {
  return vi.spyOn(client, "fetchJson").mockImplementation(async (host, _path, opts) => {
    expect(host).toBe("typesafe")
    const { questions } = JSON.parse(String(opts?.body))
    const keys = Object.keys(questions)
    return { model: "test-evaluator", answers: Object.fromEntries(keys.map((key, i) => [key, { type: "noul", noul: (i + 1) / keys.length }])) }
  })
}

describe("Jev through case search tools", () => {
  it("reorders the advertised cases search while preserving IDs, URLs and coverage notes", async () => {
    const evaluate = reverseScores()
    const response = await searchDecisions(client, { domain: "cases", query: "negligence", limit: 3, options: { jurisdiction: "NSW" } })
    const text = response.content[0].text
    const hits = parseSearchResults(nswHtml, "https://www.caselaw.nsw.gov.au/search?query=negligence&page=0").hits.slice(0, 3)
    expect(hits).toHaveLength(3)
    expect(extractHitIds(text)).toEqual(hits.map(hit => `nsw:${hit.id}`).reverse())
    for (const hit of hits) expect(text).toContain(hit.url)
    expect(text).toContain("Ordered by Jev")
    expect(text).not.toContain("integration-test-key")
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it("honours toggling with a saved key and does not reuse or cache evaluated ordering", async () => {
    const evaluate = reverseScores()
    const input = { query: "negligence", jurisdiction: "NSW", limit: 3 }
    vi.stubEnv("AU_LAW_JEV", "false")
    const original = await searchCases(client, input)
    expect(evaluate).not.toHaveBeenCalled()
    vi.stubEnv("AU_LAW_JEV", "true")
    const enabled = await searchCases(client, input)
    expect(extractHitIds(enabled.content[0].text)).toEqual(extractHitIds(original.content[0].text).reverse())
    expect(evaluate).toHaveBeenCalledTimes(1)
    vi.stubEnv("AU_LAW_JEV", "false")
    expect(await searchCases(client, input)).toEqual(original)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it("retains source results after evaluation failure and does not report a legal-source failure", async () => {
    vi.spyOn(client, "fetchJson").mockRejectedValue(new Error("401 integration-test-key"))
    const response = await searchCases(client, { query: "negligence", jurisdiction: "NSW", limit: 3 })
    expect(response.isError).not.toBe(true)
    expect(extractHitIds(response.content[0].text)).toHaveLength(3)
    expect(response.content[0].text).toContain("Original result order retained")
    expect(response.content[0].text).not.toMatch(/integration-test-key|\[NOT_FOUND\]/)
  })

  it("leaves exact-citation lookups out of probabilistic ranking", async () => {
    const evaluate = reverseScores()
    vi.mocked(client.fetchHtml).mockResolvedValue(fixture("nsw-mnc-lookup.html"))
    const response = await searchCases(client, { query: "[2010] NSWCCA 333" })
    expect(response.isError).not.toBe(true)
    expect(response.content[0].text).toContain("exact citation lookup")
    expect(evaluate).not.toHaveBeenCalled()
  })

  it("also ranks Aside's result links without changing the court or unresolved coverage", async () => {
    reverseScores()
    setAsideBridge({ asideStatus: () => ({ enabled: true }), fetchViaAside: async url => ({ url, html: asideHtml }) })
    const response = await searchCases(client, { court: "FCAFC", query: "prepayment", limit: 3 })
    const hits = readAsideSearchHits(asideHtml, asideUrl, { court: "FCAFC" }).slice(0, 3)
    expect(hits).toHaveLength(3)
    const text = response.content[0].text
    expect(text.indexOf(hits[2].title)).toBeLessThan(text.indexOf(hits[1].title))
    expect(text.indexOf(hits[1].title)).toBeLessThan(text.indexOf(hits[0].title))
    for (const hit of hits) expect(text).toContain(hit.url)
    expect(text).toContain("Ordered by Jev")
    expect(text).toContain("retrieved through the user's browser")
    expect(response.structuredContent?.followup.pending).toBe(true)
  })
})
