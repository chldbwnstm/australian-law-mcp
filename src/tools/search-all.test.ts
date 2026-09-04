import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] })
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true })

const searchLaw = vi.fn()
const searchStateLaw = vi.fn()
const searchCases = vi.fn()
const searchLawFallbacks = vi.fn()

vi.mock("./search.js", () => ({ searchLaw: (...a: unknown[]) => searchLaw(...a) }))
vi.mock("./search-fallbacks.js", () => ({ searchLawFallbacks: (...a: unknown[]) => searchLawFallbacks(...a) }))
vi.mock("./state-law.js", () => ({ searchStateLaw: (...a: unknown[]) => searchStateLaw(...a) }))
vi.mock("./precedents.js", () => ({ searchCases: (...a: unknown[]) => searchCases(...a) }))

const { searchAll } = await import("./search-all.js")

const client = {} as AuApiClient
const run = (input: Record<string, unknown> = {}) =>
  searchAll(client, { query: "unfair contract terms", limit: 5, ...input } as never)

beforeEach(() => {
  vi.clearAllMocks()
  searchLaw.mockResolvedValue(ok("1. Competition and Consumer Act 2010\n   id: C2004A00109 | Act | InForce"))
  searchStateLaw.mockResolvedValue(ok("1. Fair Trading Act 1989\n   id: act-1989-020"))
  searchCases.mockResolvedValue(ok("1. Smith v Jones [2020] NSWSC 41\n   id: nsw:aaa"))
  searchLawFallbacks.mockResolvedValue(ok("[FALLBACK] ladder output"))
})

describe("the three families", () => {
  it("asks all three in one call", async () => {
    const text = (await run()).content[0].text
    expect(searchLaw).toHaveBeenCalled()
    expect(searchStateLaw).toHaveBeenCalled()
    expect(searchCases).toHaveBeenCalled()
    expect(text).toContain("Commonwealth legislation")
    expect(text).toContain("State/territory legislation")
    expect(text).toContain("Case law")
  })

  it("searches one state register and names which", async () => {
    // Eight registers are eight sites, two blocked and one documented at up to
    // 90 seconds; a fan-out would spend the whole budget on the least certain
    // branch. The default is stated rather than left to be inferred.
    const text = (await run()).content[0].text
    expect(searchStateLaw).toHaveBeenCalledTimes(1)
    expect(searchStateLaw).toHaveBeenCalledWith(client, {
      jurisdiction: "QLD",
      query: "unfair contract terms",
      limit: 5,
    })
    expect(text).toContain("state register: QLD")
  })

  it("honours a nominated jurisdiction", async () => {
    await run({ jurisdiction: "VIC" })
    expect(searchStateLaw).toHaveBeenCalledWith(client, expect.objectContaining({ jurisdiction: "VIC" }))
  })

  it("runs only the families that were asked for", async () => {
    await run({ families: ["legislation", "cases"] })
    expect(searchStateLaw).not.toHaveBeenCalled()
    expect(searchLaw).toHaveBeenCalled()
    expect(searchCases).toHaveBeenCalled()
  })
})

describe("per-family degradation", () => {
  it("turns a dead family into a marked section, not a failed tool", async () => {
    searchStateLaw.mockRejectedValue(new Error("Queensland content search timed out"))
    const result = await run()
    const text = result.content[0].text

    expect(result.isError).toBeFalsy()
    expect(text).toContain("[NOT RETRIEVED]")
    expect(text).toContain("Queensland content search timed out")
    // The other two still answered.
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("Smith v Jones")
  })

  it("names the tool that retrieves the missing family on its own", async () => {
    searchStateLaw.mockResolvedValue(fail("[UPSTREAM_BLOCKED] register not fetched"))
    const text = (await run({ jurisdiction: "NSW" })).content[0].text
    expect(text).toContain('search_state_law(jurisdiction="NSW")')
  })

  it("says how many families did not answer", async () => {
    searchStateLaw.mockRejectedValue(new Error("x"))
    searchCases.mockRejectedValue(new Error("y"))
    const text = (await run()).content[0].text
    expect(text).toContain("2 of 3 families did not return results")
    expect(text).toContain("treat them as unsearched, not as empty")
  })

  it("forbids filling the gap in", async () => {
    searchCases.mockRejectedValue(new Error("x"))
    const text = (await run()).content[0].text
    expect(text).toContain("do not treat it as empty, and do not fill the gap in")
  })
})

describe("the empty-Commonwealth-result ladder", () => {
  it("does not run when the Commonwealth search found something", async () => {
    await run()
    expect(searchLawFallbacks).not.toHaveBeenCalled()
  })

  it("runs the ladder instead of printing a bare miss", async () => {
    // "No Commonwealth Act matched" is the single most misread result this
    // server produces: the answer is usually that the subject is state law, or
    // that the title is an instrument, or that it was renamed.
    searchLaw.mockResolvedValue(fail("[NOT_FOUND] search_law: No search results"))
    const text = (await run({ query: "residential tenancy bond" })).content[0].text
    expect(searchLawFallbacks).toHaveBeenCalledWith(client, { query: "residential tenancy bond", limit: 5 })
    expect(text).toContain("[FALLBACK] ladder output")
    // The ladder answered, so the family is not reported as unretrieved.
    expect(text).not.toContain("Commonwealth legislation (Federal Register) [NOT RETRIEVED]")
  })

  it("does not run the ladder over an upstream failure", async () => {
    // The ladder's rungs read as "the Commonwealth register was searched and
    // holds nothing". Running them after an outage renders a transport failure
    // as a completed empty search — the absence claim this server exists to
    // avoid. Only [NOT_FOUND] means the register answered.
    searchLaw.mockResolvedValue(fail("[EXTERNAL_API_ERROR] api.prod.legislation.gov.au: 503"))
    const text = (await run({ query: "residential tenancy bond" })).content[0].text
    expect(searchLawFallbacks).not.toHaveBeenCalled()
    expect(text).toContain("Commonwealth legislation (Federal Register) [NOT RETRIEVED]")
    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain("do not treat it as empty")
    expect(text).not.toContain("[FALLBACK] ladder output")
  })

  it("does not run the ladder over an ambiguous alias", async () => {
    // "which jurisdiction did you mean" is a question for the caller, not a
    // miss to climb a ladder over.
    searchLaw.mockResolvedValue(fail('[AMBIGUOUS] "Evidence Act" names Acts in more than one jurisdiction'))
    const text = (await run({ query: "Evidence Act" })).content[0].text
    expect(searchLawFallbacks).not.toHaveBeenCalled()
    expect(text).toContain("[AMBIGUOUS]")
  })
})

describe("budget", () => {
  it("clips a verbose family so it cannot bury a terse one", async () => {
    searchCases.mockResolvedValue(ok("case row\n".repeat(20_000)))
    const result = await run()
    const text = result.content[0].text
    // The statute family is short and must survive intact.
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("more characters in this section")
    expect(text.length).toBeLessThanOrEqual(50_000)
  })
})
