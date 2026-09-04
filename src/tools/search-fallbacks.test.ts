import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { looksLikeInstrumentQuery, looksLikeStateLawQuery, searchLawFallbacks } from "./search-fallbacks.js"

const REGS: FrlTitle = {
  id: "F2009L02356",
  name: "Fair Work Regulations 2009",
  collection: "LegislativeInstrument",
  status: "InForce",
}
const TPA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  nameHistory: [
    { name: "Trade Practices Act 1974", start: "1974-08-01", affecterTitleId: null, affecterName: null },
  ],
}

/** Answers only the collection it is told to; everything else is empty. */
function client(byCollection: Record<string, FrlTitle[]>): AuApiClient {
  return {
    searchTitles: async (p: { collection?: string }) => {
      const titles = byCollection[p.collection ?? "any"] ?? []
      return { count: titles.length, titles }
    },
  } as unknown as AuApiClient
}

const run = (api: AuApiClient, query: string) => searchLawFallbacks(api, { query, limit: 5 })

beforeEach(() => lawCache.clear())

describe("reading what kind of miss this is", () => {
  it("recognises the subjects that are state law everywhere", () => {
    expect(looksLikeStateLawQuery("residential tenancy bond")).toBe(true)
    expect(looksLikeStateLawQuery("retail lease outgoings")).toBe(true)
    expect(looksLikeStateLawQuery("stamp duty on a transfer")).toBe(true)
    // A federal subject must not be diverted.
    expect(looksLikeStateLawQuery("unfair contract terms")).toBe(false)
  })

  it("recognises a named jurisdiction", () => {
    expect(looksLikeStateLawQuery("Queensland planning approvals")).toBe(true)
    expect(looksLikeStateLawQuery("NSW work health and safety")).toBe(true)
  })

  it("recognises delegated legislation by name", () => {
    expect(looksLikeInstrumentQuery("Fair Work Regulations")).toBe(true)
    expect(looksLikeInstrumentQuery("aged care quality standards")).toBe(true)
    expect(looksLikeInstrumentQuery("Fair Work Act")).toBe(false)
  })
})

describe("the ladder", () => {
  it("finds the instrument an Act search missed, and says why it was missed", async () => {
    const text = (await run(client({ LegislativeInstrument: [REGS] }), "Fair Work Regulations")).content[0].text
    expect(text).toContain("[FALLBACK]")
    expect(text).toContain("Fair Work Regulations 2009")
    expect(text).toContain("separate collection from Acts")
    expect(text).toContain("get_enabling_acts")
  })

  it("returns a renamed Act and refuses to let a rename read as a repeal", async () => {
    // The Trade Practices Act is not absent; it is C2004A00109 under another
    // name, still in force.
    const text = (await run(client({ any: [TPA] }), "Trade Practices Act 1974")).content[0].text
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("A renamed Act is NOT a repealed one")
  })

  it("points at the state registers rather than searching one at random", async () => {
    // The registers need a nominated jurisdiction, two of eight are blocked,
    // and a Queensland content search alone runs up to 90 seconds. Guessing one
    // and reporting its silence is worse than naming the right tool.
    const text = (await run(client({}), "residential tenancy bond")).content[0].text
    expect(text).toContain("not a finding that no such law exists")
    expect(text).toContain('search_state_law(jurisdiction="QLD"')
    expect(text).toContain("get_state_equivalents")
    expect(text).toContain("state_law_compare")
  })

  it("always reports what it tried", async () => {
    const text = (await run(client({}), "residential tenancy bond")).content[0].text
    expect(text).toContain("Searched so far:")
  })

  it("falls through to a hint that names full-text search", async () => {
    // A title search cannot find a phrase that lives in a section: "stand down"
    // is in s 524 of the Fair Work Act and in no title at all.
    const result = await run(client({}), "stand down without pay")
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("search_ai_law")
    expect(text).toContain("Commonwealth law only")
  })

  it("never lets a broken rung become the answer", async () => {
    const broken = {
      searchTitles: async () => {
        throw new Error("upstream refused")
      },
    } as unknown as AuApiClient
    const result = await run(broken, "Fair Work Regulations")
    // Falls through rather than throwing, and still refuses to claim absence.
    // [NOT_FOUND] is the one label that permits reporting absence and nothing
    // was successfully searched here, so it must not be the one used.
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).not.toContain("[NOT_FOUND]")
    expect(text).toContain("upstream refused")
    expect(text).toContain("Do not report this as 'no such Act'")
  })

  it("does not tell a state-law question that the register 'was just searched' when it was not", async () => {
    // The state rung's whole message rests on a completed Commonwealth search:
    // "none of it is on the Commonwealth register that was just searched". With
    // a dead register that sentence is an absence nobody established — but the
    // state-law pointer is still the useful thing to say, so it survives.
    const broken = {
      searchTitles: async () => {
        throw new Error("502 Bad Gateway")
      },
    } as unknown as AuApiClient
    const result = await run(broken, "residential tenancy bond")
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).not.toContain("Nothing on the Federal Register matched")
    expect(text).not.toContain("that was just searched")
    expect(text).toContain("502 Bad Gateway")
    expect(text).toContain('search_state_law(jurisdiction="QLD"')
  })

  it("prefers a rung's real hits over a sibling rung's failure", async () => {
    // Partial data beats an error: the instrument rung failing does not hide
    // the renamed Act the next rung found.
    let call = 0
    const flaky = {
      searchTitles: async (p: { collection?: string }) => {
        call += 1
        if (p.collection === "LegislativeInstrument") throw new Error("instrument index down")
        return { count: 1, titles: [TPA] }
      },
    } as unknown as AuApiClient
    const result = await run(flaky, "Trade Practices Regulations")
    expect(call).toBe(2)
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain("Competition and Consumer Act 2010")
  })
})
