/**
 * The 45-second deadline, exercised end to end.
 *
 * Parallelism lowers the average and does nothing about the tail: the same
 * question has been measured at 12 seconds and at 71. Past the client's
 * 60-second limit the caller gets no partial result at all — just a timeout —
 * so the three wide chains assemble what arrived and mark the rest.
 *
 * Every upstream is mocked. A slow branch is a promise that never settles, and
 * the deadline is shortened through the environment so nothing here actually
 * waits 45 seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"

const ok = (text: string) => ({ content: [{ type: "text", text }] })
/** A branch that never answers. */
const hang = () => new Promise<never>(() => {})

const resolveChainBaseLaw = vi.fn()
const getThreeTier = vi.fn()
const getSchedules = vi.fn()
const searchCases = vi.fn()
const searchRulings = vi.fn()
const searchAdminAppeals = vi.fn()
const searchAiLaw = vi.fn()
const getLawText = vi.fn()
const fetchSearchDetailChain = vi.fn()

vi.mock("./chain-law-lookup.js", () => ({ resolveChainBaseLaw: (...a: unknown[]) => resolveChainBaseLaw(...a) }))
vi.mock("./three-tier.js", () => ({ getThreeTier: (...a: unknown[]) => getThreeTier(...a) }))
vi.mock("./schedules.js", () => ({ getSchedules: (...a: unknown[]) => getSchedules(...a) }))
vi.mock("./precedents.js", () => ({ searchCases: (...a: unknown[]) => searchCases(...a) }))
vi.mock("./rulings.js", () => ({ searchRulings: (...a: unknown[]) => searchRulings(...a) }))
vi.mock("./admin-appeals.js", () => ({ searchAdminAppeals: (...a: unknown[]) => searchAdminAppeals(...a) }))
vi.mock("./ai-search.js", () => ({ searchAiLaw: (...a: unknown[]) => searchAiLaw(...a) }))
vi.mock("./law-text.js", () => ({ getLawText: (...a: unknown[]) => getLawText(...a) }))
vi.mock("./search-detail-chain.js", () => ({
  fetchSearchDetailChain: (...a: unknown[]) => fetchSearchDetailChain(...a),
}))
vi.mock("./batch-provisions.js", () => ({ getBatchProvisions: vi.fn() }))
vi.mock("./committee-decisions.js", () => ({
  searchWorkplaceDecisions: vi.fn(async () => ok("fwc")),
  searchPrivacyDecisions: vi.fn(),
  searchCompetitionDecisions: vi.fn(),
  searchIntegrityDecisions: vi.fn(),
  searchPublicServiceDecisions: vi.fn(),
}))
vi.mock("./tax-tribunal-decisions.js", () => ({ searchTaxTribunalDecisions: vi.fn() }))
vi.mock("./comparison.js", () => ({ compareOldNew: vi.fn() }))
vi.mock("./provision-history.js", () => ({ getProvisionHistory: vi.fn() }))
vi.mock("./law-linkage.js", () => ({ getStateEquivalents: vi.fn(), getEnabledInstruments: vi.fn() }))
vi.mock("./state-law.js", () => ({ searchStateLaw: vi.fn() }))
vi.mock("./document-analysis.js", () => ({ analyzeDocument: vi.fn() }))

const { chainActionBasis, chainDisputePrep, chainFullResearch } = await import("./chains.js")

const client = {} as AuApiClient
const CCA = { registerId: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce" }

const ORIGINAL = process.env.MCP_CHAIN_DEADLINE_MS

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MCP_CHAIN_DEADLINE_MS = "5000"
  resolveChainBaseLaw.mockResolvedValue({ laws: [CCA], searchedWith: "CCA", attempts: ["CCA"] })
  fetchSearchDetailChain.mockResolvedValue(null)
  for (const stub of [getThreeTier, getSchedules, searchCases, searchRulings, searchAdminAppeals, searchAiLaw, getLawText]) {
    stub.mockResolvedValue(ok("stub result"))
  }
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MCP_CHAIN_DEADLINE_MS
  else process.env.MCP_CHAIN_DEADLINE_MS = ORIGINAL
})

describe("a branch that never answers", () => {
  it("becomes a marker naming the tool that fetches it alone, and marks nothing else", async () => {
    // Two assertions in one run because each run costs a real deadline: the
    // branch that hung gets a marker, and the branch nobody asked for — a
    // `Promise.resolve(null)`, which also races to `{ok:false}` after expiry —
    // does not.
    getThreeTier.mockImplementation(hang)
    const result = await chainActionBasis(client, { query: "what authorises this direction" })
    const text = result.content[0].text

    expect(text).toContain("Legal basis")
    expect(text).toContain("not collected before the time limit")
    expect(text).toContain("get_three_tier")
    expect(text).not.toMatch(/▶ Schedules \(penalties, fees\)\n⏱/)
    // A partial answer is a valid answer.
    expect(result.isError).toBeFalsy()
  }, 20_000)

  it("keeps a search that arrived when only its detail lookup hangs", async () => {
    // Racing the pair as one unit throws away a result that did arrive.
    searchCases.mockResolvedValue(ok("1. Smith v Jones\n   id: nsw:aaa"))
    fetchSearchDetailChain.mockImplementation(hang)
    const text = (await chainActionBasis(client, { query: "misleading conduct" })).content[0].text

    expect(text).toContain("Smith v Jones")
    expect(text).toMatch(/▶ Case in full\n⏱/)
  }, 20_000)
})

describe("the deadline covers the chain's groundwork too", () => {
  it("returns partially rather than hanging when the base-law search stalls", async () => {
    resolveChainBaseLaw.mockImplementation(hang)
    const started = Date.now()
    const result = await chainActionBasis(client, { query: "renewal of a licence" })
    const text = result.content[0].text

    expect(Date.now() - started).toBeLessThan(15_000)
    expect(text).toContain("Legal basis")
    expect(text).toContain("time limit")
    // Expiry is never dressed up as absence.
    expect(text).not.toContain("[NOT_FOUND]")
    expect(result.isError).toBeFalsy()
  }, 20_000)

  it("does not report an expiry-emptied search as 'no such law'", async () => {
    resolveChainBaseLaw.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_500))
      return { laws: [], attempts: ["x"] }
    })
    const text = (await chainActionBasis(client, { query: "renewal of a licence" })).content[0].text
    expect(text).not.toContain("[NOT_FOUND]")
    expect(text).toContain("time limit")
  }, 20_000)

  it("full_research keeps the sections it collected before the stall", async () => {
    searchAiLaw.mockResolvedValue(ok("Fair Work Act 2009 [C2009A00028]"))
    getLawText.mockImplementation(hang)
    const result = await chainFullResearch(client, { query: "stood down without pay" })
    const text = result.content[0].text

    expect(text).toContain("Fair Work Act 2009")
    expect(text).toContain("time limit")
    expect(result.isError).toBeFalsy()
  }, 20_000)

  it("dispute_prep shows the branch that answered next to the one that did not", async () => {
    searchCases.mockImplementation(hang)
    searchAdminAppeals.mockResolvedValue(ok("1. Tribunal matter\n   id: ncat:aaa"))
    const result = await chainDisputePrep(client, { query: "unfair dismissal" })
    const text = result.content[0].text

    expect(text).toMatch(/▶ Court judgments\n⏱/)
    expect(text).toContain("Tribunal matter")
    expect(result.isError).toBeFalsy()
  }, 20_000)
})

describe("a misconfigured deadline", () => {
  it("is reported, not silently ignored", async () => {
    process.env.MCP_CHAIN_DEADLINE_MS = "abc"
    const result = await chainActionBasis(client, { query: "anything" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("MCP_CHAIN_DEADLINE_MS")
  }, 20_000)

  it("is reported by full_research too, rather than thrown raw", async () => {
    process.env.MCP_CHAIN_DEADLINE_MS = "abc"
    const result = await chainFullResearch(client, { query: "anything" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("MCP_CHAIN_DEADLINE_MS")
  }, 20_000)
})
