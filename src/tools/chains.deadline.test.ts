/**
 * The 45-second deadline, exercised end to end.
 *
 * Parallelism lowers the average and does nothing about the tail: the same
 * question has been measured at 12 seconds and at 71. Past the client's
 * 60-second limit the caller gets no partial result at all — just a timeout —
 * so the three wide chains assemble what arrived and mark the rest.
 *
 * **Nothing here waits on a clock.** Every upstream is mocked, and the deadline
 * is driven by hand through `createManualChainClock()`. That is not a speed
 * optimisation, it is the only way these assertions mean anything: the earlier
 * version shortened the limit to the 5-second floor and then *raced the real
 * timer against the mocked branches*, so under full-suite load — where a worker
 * routinely loses its core for longer than the window — the chain's own work
 * stopped landing inside the window the test assumed and a different case
 * failed on every run. The shape of every test here is therefore:
 *
 *   1. start the chain without awaiting it;
 *   2. `settle()` — let every branch that *can* answer answer;
 *   3. assert the chain is still parked on the deadline (`clock.armed === 1`);
 *   4. `clock.expire()` — the limit passes;
 *   5. assert on the partial document.
 *
 * Steps 2 and 3 replace "wait 5 seconds and hope": what arrived is decided by
 * the chain's structure, never by how fast the machine is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { createManualChainClock, type ManualChainClock } from "./chain-deadline.js"

const ok = (text: string) => ({ content: [{ type: "text", text }] })
/** A branch that never answers. */
const hang = () => new Promise<never>(() => {})

/**
 * Let every branch that can answer without the clock answer.
 *
 * `setImmediate` runs after the microtask queue has drained, so each round
 * carries one more macrotask-separated step of the chain forward. The number of
 * rounds needed is a property of the chain's shape — a fixed count — never of
 * the machine's speed, which is the whole point.
 */
async function settle(rounds = 25): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Run a chain without awaiting it, and expose whether it has answered yet. */
function track<T>(work: Promise<T>): { promise: Promise<T>; readonly settled: boolean } {
  let done = false
  const promise = work.then((value) => {
    done = true
    return value
  })
  return {
    promise,
    get settled() {
      return done
    },
  }
}

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
  searchWorkplaceDecisions: vi.fn(async () => ok("1. Stood-down worker v Employer [2020] FWC 1")),
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
let clock: ManualChainClock

beforeEach(() => {
  vi.clearAllMocks()
  // Left at the production default on purpose. With the clock in the test's
  // hands the configured limit no longer decides anything here, so nothing
  // below is tuned against `MIN_DEADLINE_MS`.
  delete process.env.MCP_CHAIN_DEADLINE_MS
  clock = createManualChainClock()
  resolveChainBaseLaw.mockResolvedValue({ laws: [CCA], searchedWith: "CCA", attempts: ["CCA"] })
  fetchSearchDetailChain.mockResolvedValue(null)
  for (const stub of [getThreeTier, getSchedules, searchCases, searchRulings, searchAdminAppeals, searchAiLaw, getLawText]) {
    stub.mockResolvedValue(ok("stub result"))
  }
})

afterEach(() => {
  clock.restore()
  if (ORIGINAL === undefined) delete process.env.MCP_CHAIN_DEADLINE_MS
  else process.env.MCP_CHAIN_DEADLINE_MS = ORIGINAL
})

describe("a branch that never answers", () => {
  it("becomes a marker naming the tool that fetches it alone", async () => {
    getThreeTier.mockImplementation(hang)
    const run = track(chainActionBasis(client, { query: "what authorises this direction" }))

    await settle()
    // The chain is waiting on the limit and on nothing else: every branch that
    // could answer already has, and none of them ended the chain.
    expect(run.settled).toBe(false)
    expect(clock.armed).toBe(1)
    clock.expire()

    const result = await run.promise
    const text = result.content[0].text

    expect(text).toContain("Legal basis")
    expect(text).toMatch(/▶ Act → regulations → rules\n⏱/)
    expect(text).toContain("not collected before the time limit")
    expect(text).toContain("get_three_tier")
    // A partial answer is a valid answer.
    expect(result.isError).toBeFalsy()
  })

  it("leaves the branches that did answer untouched", async () => {
    getThreeTier.mockImplementation(hang)
    searchRulings.mockResolvedValue(ok("TR 2020/1 Stand-down directions"))
    searchCases.mockResolvedValue(ok("1. Smith v Jones\n   id: nsw:aaa"))
    searchAdminAppeals.mockResolvedValue(ok("1. Tribunal matter\n   id: ncat:aaa"))
    const run = track(chainActionBasis(client, { query: "what authorises this direction" }))

    await settle()
    clock.expire()
    const text = (await run.promise).content[0].text

    // Only the branch that hung is marked; the three that answered keep their
    // sections verbatim. This is the assertion the wall-clock version could not
    // make honestly — under load these three were the ones that vanished.
    expect(text).toContain("TR 2020/1 Stand-down directions")
    expect(text).toContain("Smith v Jones")
    expect(text).toContain("Tribunal matter")
    expect(text.match(/⏱ This section was not collected/g)).toHaveLength(1)
  })

  it("does not mark a branch nobody asked for, even when the limit passes before it starts", async () => {
    // `Schedules` is only fetched when the query asks about fees or forms;
    // otherwise the leg races a bare `Promise.resolve(null)`. Once the signal is
    // aborted *that* race resolves `{ok:false}` too, so without the
    // `needSchedules` guard the chain would report a timeout for work it never
    // requested. The limit therefore has to pass before the leg is even built —
    // reachable only with the clock in hand, which is why the wall-clock version
    // claimed this coverage in a comment but never had it.
    getThreeTier.mockImplementation(() => {
      clock.expire()
      return hang()
    })
    const run = track(chainActionBasis(client, { query: "what authorises this direction" }))

    await settle()
    const result = await run.promise
    const text = result.content[0].text

    expect(clock.armed).toBe(0)
    expect(text).toMatch(/▶ Act → regulations → rules\n⏱/)
    expect(text).not.toMatch(/▶ Schedules \(penalties, fees\)/)
    expect(result.isError).toBeFalsy()
  })

  it("keeps a search that arrived when only its detail lookup hangs", async () => {
    // Racing the pair as one unit throws away a result that did arrive.
    searchCases.mockResolvedValue(ok("1. Smith v Jones\n   id: nsw:aaa"))
    fetchSearchDetailChain.mockImplementation(hang)
    const run = track(chainActionBasis(client, { query: "misleading conduct" }))

    await settle()
    expect(run.settled).toBe(false)
    clock.expire()
    const text = (await run.promise).content[0].text

    expect(text).toContain("Smith v Jones")
    expect(text).toMatch(/▶ Case in full\n⏱/)
  })
})

describe("the deadline covers the chain's groundwork too", () => {
  it("returns partially rather than hanging when the base-law search stalls", async () => {
    resolveChainBaseLaw.mockImplementation(hang)
    const run = track(chainActionBasis(client, { query: "renewal of a licence" }))

    await settle()
    // The old test asserted `Date.now() - started < 15_000`, which is a claim
    // about the machine. The claim that matters is this one: the chain does not
    // answer until the limit passes, and then it answers rather than hanging.
    expect(run.settled).toBe(false)
    clock.expire()

    const result = await run.promise
    const text = result.content[0].text

    expect(text).toContain("Legal basis")
    expect(text).toContain("time limit")
    // Expiry is never dressed up as absence.
    expect(text).not.toContain("[NOT_FOUND]")
    expect(result.isError).toBeFalsy()
  })

  it("does not report an expiry-emptied search as 'no such law'", async () => {
    // The Register answers "no titles" — but only after the limit has passed,
    // so the emptiness is the deadline's doing and proves nothing about the law.
    let answer: (value: unknown) => void = () => {}
    resolveChainBaseLaw.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const run = track(chainActionBasis(client, { query: "renewal of a licence" }))

    await settle()
    clock.expire()
    answer({ laws: [], attempts: ["x"] })

    const text = (await run.promise).content[0].text
    expect(text).not.toContain("[NOT_FOUND]")
    expect(text).toContain("time limit")
  })

  it("full_research keeps the sections it collected before the stall", async () => {
    searchAiLaw.mockResolvedValue(ok("Fair Work Act 2009 [C2009A00028]"))
    getLawText.mockImplementation(hang)
    const run = track(chainFullResearch(client, { query: "stood down without pay" }))

    await settle()
    expect(run.settled).toBe(false)
    expect(clock.armed).toBe(1)
    clock.expire()

    const result = await run.promise
    const text = result.content[0].text

    expect(text).toContain("Fair Work Act 2009")
    // The base-law header landed before the stall too, and stays.
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("time limit")
    expect(text).toContain("everything above is all that arrived in time")
    expect(result.isError).toBeFalsy()
  })

  it("dispute_prep shows the branch that answered next to the one that did not", async () => {
    searchCases.mockImplementation(hang)
    searchAdminAppeals.mockResolvedValue(ok("1. Tribunal matter\n   id: ncat:aaa"))
    const run = track(chainDisputePrep(client, { query: "unfair dismissal" }))

    await settle()
    expect(run.settled).toBe(false)
    expect(clock.armed).toBe(1)
    clock.expire()

    const result = await run.promise
    const text = result.content[0].text

    expect(text).toMatch(/▶ Court judgments\n⏱/)
    expect(text).toContain("Tribunal matter")
    // The specialist branch answered too, and is not collateral damage.
    expect(text).toContain("Stood-down worker v Employer")
    // One cause gets one marker: the detail leg behind the search that expired
    // is not reported a second time.
    expect(text).not.toMatch(/▶ Leading judgments in full\n⏱/)
    expect(result.isError).toBeFalsy()
  })
})

describe("a misconfigured deadline", () => {
  it("is reported, not silently ignored", async () => {
    process.env.MCP_CHAIN_DEADLINE_MS = "abc"
    const result = await chainActionBasis(client, { query: "anything" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("MCP_CHAIN_DEADLINE_MS")
  })

  it("is reported by full_research too, rather than thrown raw", async () => {
    process.env.MCP_CHAIN_DEADLINE_MS = "abc"
    const result = await chainFullResearch(client, { query: "anything" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("MCP_CHAIN_DEADLINE_MS")
  })
})
