import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { SourceDocument, SourceHit, SourceSearchResult } from "../lib/sources/types.js"

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

const committeeDecisions = await import("./committee-decisions.js")
const {
  canonicalAicmr,
  competitionLinks,
  exactDeterminationHit,
  getCompetitionDecisionText,
  getIntegrityDecisionText,
  getPrivacyDecisionText,
  getPublicServiceDecisionText,
  getWorkplaceDecisionText,
  searchCompetitionDecisions,
  searchIntegrityDecisions,
  searchWorkplaceDecisions,
} = committeeDecisions

/**
 * The OAIC determinations index exactly as recorded — `src/lib/sources/oaic.ts`
 * is left real here, because the defect this pins lives in the seam between its
 * keyword filter and the tool that reads the filter's output.
 * Fixture: https://www.oaic.gov.au/privacy/privacy-assessments-and-decisions/
 * privacy-decisions/privacy-determinations (captured for `oaic.test.ts`).
 */
const OAIC_INDEX = readFileSync(new URL("../lib/sources/__fixtures__/oaic-determinations.html", import.meta.url), "utf8")

const oaicClient = { fetchHtml: async () => OAIC_INDEX } as unknown as AuApiClient

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

// ── the determination the caller asked for, or none ────────────────────────

describe("get_decision_text[privacy] matches the citation exactly", () => {
  // Reproduced before the fix, against this same recorded index: the OAIC page
  // has no keyword parameter, so `oaic.searchDeterminations` filters locally
  // and `oaic.filterHits` drops one-character tokens — asked for
  // "[2026] AICmr 4" the needles degenerate to ["[2026]", "aicmr"] and every
  // 2026 determination survives. The tool then took `hits[0]` and rendered
  // "[2026] AICmr 40" (Monash IVF) under the citation the caller typed, with
  // nothing in the output to say it was a different record.
  const wrongForShortNumber: Array<[string, string]> = [
    ["[2026] AICmr 4", "[2026] AICmr 40"],
    ["[2025] AICmr 1", "[2025] AICmr 175"],
    ["[2026] AICmr 2", "[2026] AICmr 22"],
  ]

  it.each(wrongForShortNumber)("does not answer %s with %s", async (asked, nearest) => {
    const result = await getPrivacyDecisionText(oaicClient, { id: asked })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    // The near miss may be *listed* as something that was on the page, but it
    // must never be rendered as the determination that was asked for.
    expect(text).not.toContain("=== ")
    expect(text).not.toMatch(new RegExp(`Citation.{0,4}${nearest.replace(/[[\]]/g, "\\$&")}`))
    expect(text).toContain(asked)
    expect(text).toContain("[UPSTREAM_NO_DATA]")
  })

  it("names what was on the page instead, and warns against taking one of them", async () => {
    const text = (await getPrivacyDecisionText(oaicClient, { id: "[2026] AICmr 4" })).content[0].text
    expect(text).toContain("[2026] AICmr 40")
    expect(text).toContain("none of which is [2026] AICmr 4")
    expect(text).toContain("Do not treat any of these as the one you asked for")
    expect(text).toMatch(/only rules out one page/i)
  })

  it("still returns the determination when the citation does match", async () => {
    const result = await getPrivacyDecisionText(oaicClient, { id: "[2026] AICmr 40" })
    const text = result.content[0].text
    expect(result.isError).toBeFalsy()
    expect(text).toContain("Monash IVF")
    expect(text).toContain("[2026] AICmr 40")
  })

  it("reads a citation the caller typed without brackets as the same citation", async () => {
    const result = await getPrivacyDecisionText(oaicClient, { id: "2026 AICmr 40" })
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("Monash IVF")
  })
})

describe("canonicalAicmr / exactDeterminationHit", () => {
  const hits: SourceHit[] = [
    { source: "OAIC", title: "Vinomofo (Privacy) [2025] AICmr 175", citation: "[2025] AICmr 175", id: "[2025] AICmr 175", url: "u1" },
    { source: "OAIC", title: "Someone (Privacy) [2025] AICmr 2", citation: "[2025] AICmr 2", id: "[2025] AICmr 2", url: "u2" },
  ]

  it("makes two spellings of one citation equal and two citations never equal", () => {
    expect(canonicalAicmr("[2025]  AICmr  02")).toBe(canonicalAicmr("2025 aicmr 2"))
    expect(canonicalAicmr("[2025] AICmr 2")).not.toBe(canonicalAicmr("[2025] AICmr 175"))
    expect(canonicalAicmr("Operation Wilson")).toBeUndefined()
  })

  it("picks the exact citation, never the nearest", () => {
    expect(exactDeterminationHit(hits, "[2025] AICmr 2")?.citation).toBe("[2025] AICmr 2")
    expect(exactDeterminationHit(hits, "[2025] AICmr 17")).toBeUndefined()
    expect(exactDeterminationHit(hits, "[2025] AICmr 1")).toBeUndefined()
  })

  it("falls back to an exact identifier match when the id carries no citation", () => {
    const unnumbered: SourceHit[] = [{ source: "OAIC", title: "Some Determination", id: "some-determination", url: "u" }]
    expect(exactDeterminationHit(unnumbered, "some-determination")?.id).toBe("some-determination")
    expect(exactDeterminationHit(unnumbered, "some")).toBeUndefined()
  })
})

describe("every domain getter answers with the record the caller named", () => {
  // The class, enumerated: a getter resolves an id either by *addressing* the
  // record (the id goes to the source verbatim) or by searching and then
  // verifying the identifier. Nothing in between — "search, take the first
  // hit" is what served a different determination as the one requested.
  const GETTERS = [
    "getWorkplaceDecisionText",
    "getPrivacyDecisionText",
    "getCompetitionDecisionText",
    "getIntegrityDecisionText",
    "getPublicServiceDecisionText",
  ]

  it("covers every get*DecisionText this module exports", () => {
    const exported = Object.keys(committeeDecisions)
      .filter((name) => /^get[A-Z].*DecisionText$/.test(name))
      .sort()
    // A sixth domain getter cannot be added without being classified here.
    expect(exported).toEqual([...GETTERS].sort())
  })

  it("workplace addresses the FWC slug it was given", async () => {
    fwcGetDecision.mockResolvedValue({ title: "Werner v Amcor", url: "u", metadata: [], text: "reasons" })
    await getWorkplaceDecisionText(client, { id: "werner-v-amcor-2014-fwc-3013" })
    expect(fwcGetDecision).toHaveBeenCalledWith(client, "werner-v-amcor-2014-fwc-3013")
  })

  it("integrity addresses the NACC anchor it was given", async () => {
    getNaccOperation.mockResolvedValue({ name: "Operation Wilson", anchor: "operation-wilson", summary: "s", documents: [] })
    await getIntegrityDecisionText(client, { id: "operation-wilson" })
    expect(getNaccOperation).toHaveBeenCalledWith(client, "operation-wilson")
  })

  it("public_service addresses the MPC slug it was given", async () => {
    getMpcCaseStudy.mockResolvedValue({ title: "Financial penalty too harsh", url: "u", text: "t" })
    await getPublicServiceDecisionText(client, { id: "financial-penalty-too-harsh" })
    expect(getMpcCaseStudy).toHaveBeenCalledWith(client, "financial-penalty-too-harsh")
  })

  it("competition renders no document at all — the source is blocked", async () => {
    const result = await getCompetitionDecisionText(noNetworkClient, { id: "[2020] ACompT 1" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[UPSTREAM_BLOCKED]")
  })

  it("privacy searches, and so must verify the identifier of the hit it renders", async () => {
    const wrong = await getPrivacyDecisionText(oaicClient, { id: "[2026] AICmr 4" })
    expect(wrong.isError).toBe(true)
    const right = await getPrivacyDecisionText(oaicClient, { id: "[2026] AICmr 40" })
    expect(right.isError).toBeFalsy()
  })
})
