import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { STATE_JURISDICTIONS, type StateJurisdiction } from "../lib/sources/state-legislation.js"
import type { SourceSearchResult } from "../lib/sources/types.js"

/**
 * The register client is wrapped, not replaced: NSW and SA still go through the
 * real `searchStateLaw`, which is where the `UpstreamBlockedError` — with the
 * host, the reason and the deep links — is built. Only the reachable registers
 * are stubbed, and only so one of them can be made to succeed without a
 * network.
 */
const stateSearch = vi.fn()
vi.mock("../lib/sources/state-legislation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/sources/state-legislation.js")>()
  return {
    ...original,
    searchStateLaw: (...args: Parameters<typeof original.searchStateLaw>) => stateSearch(...args),
  }
})

const realState = await vi.importActual<typeof import("../lib/sources/state-legislation.js")>(
  "../lib/sources/state-legislation.js",
)

const { BLOCKED_STATE_REGISTERS, SEARCHABLE_STATE_REGISTERS, searchUniversityRules } = await import(
  "./institutional-rules.js"
)

/** Every call throws, so a reachable register fails the way an outage fails. */
const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

function hits(jurisdiction: StateJurisdiction): SourceSearchResult {
  return {
    hits: [
      {
        source: "QLD Legislation",
        title: `${jurisdiction} University of Somewhere Act 1998`,
        id: "act-1998-021",
        url: "https://www.legislation.qld.gov.au/view/html/inforce/current/act-1998-021",
      },
    ],
    total: 1,
    sourceUrl: "https://www.legislation.qld.gov.au/search",
  }
}

const run = (input: { query: string; jurisdiction?: string }) =>
  searchUniversityRules(noNetworkClient as AuApiClient, input as never)

beforeEach(() => {
  lawCache.clear()
  stateSearch.mockReset()
  stateSearch.mockImplementation((...args: Parameters<typeof realState.searchStateLaw>) =>
    realState.searchStateLaw(...args),
  )
})

describe("university_rules keeps a refusal apart from an outage", () => {
  // Reproduced before the fix: `searchStateLaw` throws `UpstreamBlockedError`
  // for NSW and SA before it makes any request, `Promise.allSettled` turned it
  // into a rejection like any other, and with one register asked for every
  // outcome rejected — so the tool answered
  // "[EXTERNAL_API_ERROR] No state legislation register answered the
  // university-rules search. / Transport failures only; retry", which is
  // untrue three times over and drops the links the schema promises.
  it.each(["NSW", "SA"])("reports the %s register as blocked, with its links", async (jurisdiction) => {
    const result = await run({ query: "University of Sydney", jurisdiction })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).not.toContain("[EXTERNAL_API_ERROR]")
    expect(text).not.toContain("Transport failures only")
    expect(text).toMatch(/Open directly: https?:\/\/\S+/)
    expect(text).toMatch(/not fetched by this server/i)
  })

  it("does not tell the caller to retry something that can never succeed", async () => {
    const text = (await run({ query: "University of Sydney", jurisdiction: "NSW" })).content[0].text
    expect(text).not.toMatch(/retry/i)
    expect(text).toMatch(/nothing here says the material is absent|no such/i)
  })

  it("still reports a reachable register's outage as an outage", async () => {
    const result = await run({ query: "University of Queensland", jurisdiction: "QLD" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(text).not.toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("not evidence that no such university legislation exists")
    expect(text).toMatch(/retry/i)
  })
})

describe("the blocked registers are enumerated, not listed by hand", () => {
  it("every register this server refuses is answered with the blocked label and a link", async () => {
    // The guard: a register moved into the blocked set is covered here the
    // moment it is added, because the list comes from the module itself.
    expect(BLOCKED_STATE_REGISTERS.length).toBeGreaterThan(0)
    for (const jurisdiction of BLOCKED_STATE_REGISTERS) {
      lawCache.clear()
      const text = (await run({ query: "University of Somewhere", jurisdiction })).content[0].text
      expect(text, jurisdiction).toContain("[UPSTREAM_BLOCKED]")
      expect(text, jurisdiction).toMatch(/Open directly: https?:\/\/\S+/)
    }
  })

  it("the searchable and blocked sets partition the register list", () => {
    expect([...SEARCHABLE_STATE_REGISTERS, ...BLOCKED_STATE_REGISTERS].sort()).toEqual([...STATE_JURISDICTIONS].sort())
    for (const jurisdiction of BLOCKED_STATE_REGISTERS) {
      expect(SEARCHABLE_STATE_REGISTERS).not.toContain(jurisdiction)
    }
  })

  it("names the blocked registers, with links, even when another register answered", async () => {
    stateSearch.mockImplementation((...args: Parameters<typeof realState.searchStateLaw>) =>
      args[1] === "QLD" ? Promise.resolve(hits(args[1])) : realState.searchStateLaw(...args),
    )
    const result = await run({ query: "University of Somewhere" })
    const text = result.content[0].text
    expect(result.isError).toBeFalsy()
    expect(text).toContain("University of Somewhere Act 1998")
    for (const jurisdiction of BLOCKED_STATE_REGISTERS) {
      expect(text, jurisdiction).toContain(jurisdiction)
    }
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/were not searched/)
    expect(text).toMatch(/https?:\/\/\S*legislation\.nsw\.gov\.au/)
    expect(text).toMatch(/https?:\/\/\S*legislation\.sa\.gov\.au/)
  })
})
