import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { SourceDocument, SourceSearchResult } from "../lib/sources/types.js"

// The two source modules behind workplace / integrity / public_service are
// stubbed so the `limit` and `full` behaviour can be asserted without a network
// fixture. `precedents.js` is left real — the competition fallback below runs it
// against a client that refuses every call, which is the outage it must report.
const fwcSearch = vi.fn()
const fwcGetDecision = vi.fn()
const searchNacc = vi.fn()
const getNaccOperation = vi.fn()
const getMpcCaseStudy = vi.fn()
const searchMpc = vi.fn()

vi.mock("../lib/sources/fwc.js", () => ({
  search: (...a: unknown[]) => fwcSearch(...a),
  getDecision: (...a: unknown[]) => fwcGetDecision(...a),
}))
vi.mock("../lib/sources/integrity-sources.js", () => ({
  searchNacc: (...a: unknown[]) => searchNacc(...a),
  getNaccOperation: (...a: unknown[]) => getNaccOperation(...a),
  searchMpc: (...a: unknown[]) => searchMpc(...a),
  getMpcCaseStudy: (...a: unknown[]) => getMpcCaseStudy(...a),
}))

const {
  competitionLinks,
  getCompetitionDecisionText,
  getIntegrityDecisionText,
  getPublicServiceDecisionText,
  getWorkplaceDecisionText,
  searchCompetitionDecisions,
  searchIntegrityDecisions,
  searchWorkplaceDecisions,
} = await import("./committee-decisions.js")

const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

const client = {} as AuApiClient

/** A page of rows the upstream chose the size of — 25 for the FWC. */
function page(rows: number, total = rows): SourceSearchResult {
  return {
    hits: Array.from({ length: rows }, (_, index) => ({
      source: "Fair Work Commission" as const,
      title: `Decision ${index + 1}`,
      id: `decision-${index + 1}`,
      url: `https://www.fwc.gov.au/d${index + 1}`,
    })),
    total,
    sourceUrl: "https://www.fwc.gov.au/document-search",
  }
}

/** Long enough that `compactBody` shortens it (head 1600 + tail 800 + 500). */
const LONG_BODY = Array.from({ length: 200 }, (_, index) => `[${index + 1}] Paragraph ${index + 1} of the reasons.`).join("\n")

beforeEach(() => {
  vi.clearAllMocks()
  lawCache.clear()
})

describe("competitionLinks", () => {
  it("offers both blocked registers plus the Tribunal's AustLII series", () => {
    const links = competitionLinks("cartel")
    expect(links[0]).toContain("accc.gov.au/public-registers")
    expect(links[1]).toContain("competitiontribunal.gov.au/decisions")
    expect(links[2]).toContain("mask_path=au%2Fcases%2Fcth%2FACompT")
  })
})

describe("get_decision_text[competition]", () => {
  it("refuses honestly and points at the case-law tool", async () => {
    const result = await getCompetitionDecisionText(noNetworkClient, { id: "[2020] ACompT 1" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/refusal to request, not evidence the document is absent/i)
    expect(text).toContain('get_case_text(citation="[2020] ACompT 1")')
  })
})

describe("search_decisions[competition]", () => {
  it("leads with the blocked notice before falling back to case law", async () => {
    const result = await searchCompetitionDecisions(noNetworkClient, { query: "merger authorisation" })
    const text = result.content.map((entry) => entry.text).join("\n")
    const blockedAt = text.indexOf("[UPSTREAM_BLOCKED]")
    const fallbackAt = text.indexOf("Falling back to live case law")
    expect(blockedAt).toBeGreaterThanOrEqual(0)
    expect(fallbackAt).toBeGreaterThan(blockedAt)
    expect(text).toMatch(/These are court decisions, not the regulator's own register/)
  })

  it("reports the fallback's failure as a failure, not as a search that found nothing", async () => {
    // The case-law fan-out is this domain's only live result. With every source
    // down its [EXTERNAL_API_ERROR] used to be embedded under the blocked header
    // and returned as a success, so a caller keying on isError — search_all's
    // runFamily marks a failed family [NOT RETRIEVED] — read a transport failure
    // as a completed competition search.
    const result = await searchCompetitionDecisions(noNetworkClient, { query: "cartel" })
    const text = result.content.map((entry) => entry.text).join("\n")
    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(result.isError).toBe(true)
  })
})

describe("`limit` is honoured, not just advertised", () => {
  it("shows at most `limit` of the FWC's fixed 25-row page", async () => {
    fwcSearch.mockResolvedValue(page(25, 186_201))
    const result = await searchWorkplaceDecisions(client, { query: "redundancy", limit: 3 })
    const text = result.content[0].text
    expect(text).toContain("Decision 3")
    expect(text).not.toContain("Decision 4")
  })

  it("leaves the upstream total alone, so the count line stays true", async () => {
    fwcSearch.mockResolvedValue(page(25, 400))
    const text = (await searchWorkplaceDecisions(client, { query: "redundancy", limit: 3 })).content[0].text
    expect(text).toContain("400")
  })

  it("returns the whole page when no limit is given", async () => {
    fwcSearch.mockResolvedValue(page(25))
    const text = (await searchWorkplaceDecisions(client, { query: "redundancy" })).content[0].text
    expect(text).toContain("Decision 25")
  })

  it("applies to the NACC index too", async () => {
    searchNacc.mockResolvedValue(page(12))
    const text = (await searchIntegrityDecisions(client, { query: "border force", limit: 2 })).content[0].text
    expect(text).toContain("Decision 2")
    expect(text).not.toContain("Decision 3")
  })
})

describe("`full` returns the body verbatim for the domains that have one", () => {
  const document: SourceDocument = {
    title: "Werner v Amcor",
    url: "https://www.fwc.gov.au/d1",
    metadata: [],
    text: LONG_BODY,
  }

  it("shortens an FWC decision by default and returns it whole on full=true", async () => {
    fwcGetDecision.mockResolvedValue(document)
    const shortened = (await getWorkplaceDecisionText(client, { id: "werner" })).content[0].text
    expect(shortened).toContain("⋯ omitted")

    const whole = (await getWorkplaceDecisionText(client, { id: "werner", full: true })).content[0].text
    expect(whole).not.toContain("⋯ omitted")
    expect(whole).toContain("[100] Paragraph 100 of the reasons.")
  })

  it("returns an MPC case study whole on full=true", async () => {
    // Reproduced before the fix: full=true came back at 2.7k characters with
    // "call again with full=true", so the middle of the case study was
    // unreachable through the advertised tool and the caller looped.
    getMpcCaseStudy.mockResolvedValue({
      title: "Financial penalty too harsh",
      url: "https://www.mpc.gov.au/case-summaries/financial-penalty-too-harsh",
      text: LONG_BODY,
    })
    const shortened = (await getPublicServiceDecisionText(client, { id: "financial-penalty-too-harsh" })).content[0].text
    expect(shortened).toContain("⋯ omitted")

    const whole = (await getPublicServiceDecisionText(client, { id: "financial-penalty-too-harsh", full: true }))
      .content[0].text
    expect(whole).not.toContain("⋯ omitted")
    expect(whole).toContain("[100] Paragraph 100 of the reasons.")
  })

  it("returns a NACC index entry whole on full=true", async () => {
    getNaccOperation.mockResolvedValue({
      name: "Operation Wilson",
      anchor: "operation-wilson",
      summary: LONG_BODY,
      documents: [],
    })
    const whole = (await getIntegrityDecisionText(client, { id: "operation-wilson", full: true })).content[0].text
    expect(whole).not.toContain("⋯ omitted")
    expect(whole).toContain("[100] Paragraph 100 of the reasons.")
  })
})
