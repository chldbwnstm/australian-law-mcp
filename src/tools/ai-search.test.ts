import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { searchAiLaw, searchAiLawStructured } from "./ai-search.js"

const FW_ACT: FrlTitle = {
  id: "C2009A00028",
  name: "Fair Work Act 2009",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  year: 2009,
  number: 28,
}
const FW_REGS: FrlTitle = {
  id: "F2009L02356",
  name: "Fair Work Regulations 2009",
  collection: "LegislativeInstrument",
  status: "InForce",
  isPrincipal: true,
}

interface Call {
  path: string
}

function client(titles: FrlTitle[], count = titles.length): { api: AuApiClient; calls: Call[] } {
  const calls: Call[] = []
  const api = {
    fetchJson: async (_host: string, path: string) => {
      calls.push({ path })
      return { "@odata.count": count, value: titles }
    },
  } as unknown as AuApiClient
  return { api, calls }
}

const run = (api: AuApiClient, input: Record<string, unknown> = {}) =>
  searchAiLaw(api, { query: "stood down without pay", limit: 10, provisionHints: true, ...input } as never)

beforeEach(() => lawCache.clear())

describe("how the question is put to the Register", () => {
  it("asks for every word anywhere, not the exact phrase", async () => {
    // `contains` is a phrase match: no title or body contains "stood down
    // without pay" verbatim, so the DSL default returns nothing for an ordinary
    // question. Measured 2026-09-04: "CSIRO determination" → 0 under contains,
    // 2 under all.
    const { api, calls } = client([FW_ACT])
    await run(api)
    expect(calls[0].path).toContain("nameAndText")
    expect(calls[0].path).toContain("all")
    expect(calls[0].path).not.toContain(",contains")
  })

  it("searches the abbreviation as well as the words, without replacing them", async () => {
    // The expanded title becomes a SECOND pass, not a substitute: "ACL" is both
    // an abbreviation and a topic, and searching only the official title would
    // drop every instrument whose text discusses it.
    // (`resolveLawAlias` matches a whole query against the table, so the two-pass
    // path fires for the abbreviation itself rather than for a sentence
    // containing it.)
    const { api, calls } = client([FW_ACT])
    const text = (await run(api, { query: "ACL" })).content[0].text
    expect(calls.length).toBe(2)
    expect(text).toContain("Abbreviation recognised")
    expect(text).toContain("Both the original wording and that title were searched")
  })

  it("makes a single pass when there is no abbreviation to expand", async () => {
    const { api, calls } = client([FW_ACT])
    await run(api, { query: "stood down without pay" })
    expect(calls.length).toBe(1)
  })

  it("says so instead of guessing when an abbreviation spans jurisdictions", async () => {
    const { api } = client([FW_ACT])
    const text = (await run(api, { query: "Evidence Act" })).content[0].text
    expect(text).toMatch(/more than one jurisdiction|Fair Work Act/)
  })
})

describe("what the caller is told about the ordering", () => {
  it("names the ranking source, so hit #1 can be weighed", async () => {
    const { api } = client([FW_REGS, FW_ACT])
    const text = (await run(api)).content[0].text
    expect(text).toContain("ranking:")
    expect(text).toContain("Federal Register full-text relevance")
    expect(text).toContain("re-ranked locally")
  })

  it("puts the principal Act above its own regulations", async () => {
    // Relevance ranks by word overlap and a regulation repeats its enabling
    // Act's vocabulary, so the regulations routinely come back first.
    const { api } = client([FW_REGS, FW_ACT])
    const text = (await run(api)).content[0].text
    expect(text.indexOf("Fair Work Act 2009")).toBeLessThan(text.indexOf("Fair Work Regulations 2009"))
  })

  it("reports the upstream count, not the page size", async () => {
    const { api } = client([FW_ACT], 137)
    expect((await run(api)).content[0].text).toContain("137 matching title(s)")
  })

  it("never adds the two passes' counts together", async () => {
    // The alias pass is the same question asked with the expanded title, so the
    // two result sets overlap and the list below is de-duplicated. Summing them
    // taught the caller a corpus size no single upstream query returned.
    const counts = [120, 80]
    let call = 0
    const api = {
      fetchJson: async () => ({ "@odata.count": counts[call++] ?? 0, value: [FW_ACT] }),
    } as unknown as AuApiClient

    const text = (await run(api, { query: "ACL" })).content[0].text
    expect(call).toBe(2)
    expect(text).not.toContain("200 matching")
    expect(text).toContain('120 for "ACL"')
    expect(text).toContain("80 for")
    expect(text).toContain("do not add up")
    // One title survived de-duplication, and the count line says so.
    expect(text).toContain("Showing 1 after de-duplication")
  })

  it("still prints one plain count when only one pass ran", async () => {
    const { api } = client([FW_ACT], 137)
    const text = (await run(api)).content[0].text
    expect(text).toContain("137 matching title(s) upstream; showing 1.")
    expect(text).not.toContain("do not add up")
  })
})

describe("pointing, not answering", () => {
  it("prints the exact follow-up call for each hit", async () => {
    const { api } = client([FW_ACT])
    const text = (await run(api)).content[0].text
    expect(text).toContain('get_law_text(registerId="C2009A00028")')
  })

  it("carries a provision reference out of the question into the hint", async () => {
    const { api } = client([FW_ACT])
    const text = (await run(api, { query: "what does s 524 of the Fair Work Act mean" })).content[0].text
    expect(text).toContain('provision="s 524"')
  })

  it("does not read a provision out of an ordinary English word", async () => {
    // The document scanner is case-insensitive, so its roman-numeral branch
    // matches lower-case letters: "small" is section MA, "applies" appendix
    // LIE. Printed back as "the provision you cited" and offered as the next
    // call, that sends the caller to look up a section nobody wrote.
    const { api } = client([FW_ACT])
    const text = (await run(api, { query: "does the ACL cover services supplied to a small business" })).content[0].text
    expect(text).not.toContain("Provision reference(s) read out of your question")
    expect(text).not.toContain("s ma")
    expect(text).toContain('get_law_text(registerId="C2009A00028")')
  })

  it("says these are pointers rather than an answer", async () => {
    const { api } = client([FW_ACT])
    expect((await run(api)).content[0].text).toContain("pointers, not an answer")
  })
})

describe("the two kinds of nothing", () => {
  it("treats an empty result as a search result, never as 'unregulated'", async () => {
    const { api } = client([])
    const result = await run(api)
    const text = result.content[0].text
    expect(text).toContain("not a finding that the topic")
    expect(text).toContain("search_state_law")
    // Zero hits is information, not a failure.
    expect(result.isError).toBeFalsy()
  })

  it("treats a dead upstream as an error, with the distinct label", async () => {
    const api = {
      fetchJson: async () => {
        throw new Error("upstream refused")
      },
    } as unknown as AuApiClient
    const result = await run(api)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[UPSTREAM_NO_DATA]")
    expect(result.content[0].text).toContain("do not report the topic as unregulated")
  })
})

describe("the structured form chains use", () => {
  it("hands back ranked titles without a render-and-reparse round trip", async () => {
    const { api } = client([FW_REGS, FW_ACT])
    const structured = await searchAiLawStructured(api, {
      query: "stand down",
      limit: 10,
      provisionHints: false,
    } as never)
    expect(structured.titleSignals[0]).toMatchObject({ registerId: "C2009A00028", via: "query" })
    expect(structured.provisionRefs).toEqual([])
  })

  it("hands chains no phantom provision built out of a lower-case word", async () => {
    // Same guard as the router's `extractProvisions`: a chain that takes this
    // list feeds it straight to get_law_text.
    const { api } = client([FW_ACT])
    const structured = await searchAiLawStructured(api, {
      query: "which sections mix civil and criminal liability",
      limit: 10,
      provisionHints: false,
    } as never)
    expect(structured.provisionRefs).toEqual([])
  })

  it("lifts provision references out of the question", async () => {
    const { api } = client([FW_ACT])
    const structured = await searchAiLawStructured(api, {
      query: "s 524 and s 525 stand down",
      limit: 10,
      provisionHints: false,
    } as never)
    expect(structured.provisionRefs).toContain("s 524")
  })
})
