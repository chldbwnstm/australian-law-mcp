import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { searchLaw } from "./search.js"

/** Recorded live 2026-09-04 — see __fixtures__/PROVENANCE.txt. */
const SEARCH_CCA = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-search-cca.json", import.meta.url), "utf8"),
) as { "@odata.count": number; value: FrlTitle[] }
const TPA = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-title-tpa-rename.json", import.meta.url), "utf8"),
) as { value: FrlTitle[] }

function client(titles: FrlTitle[], count = titles.length): AuApiClient {
  return {
    searchTitles: async () => ({ count, titles }),
    getTitle: async (id: string) => titles.find((title) => title.id === id) ?? titles[0],
  } as unknown as AuApiClient
}

const run = (c: AuApiClient, input: Record<string, unknown> = {}) =>
  searchLaw(c, { query: "competition and consumer act", limit: 10, ...input } as never)

beforeEach(() => lawCache.clear())

describe("search_law ranking", () => {
  it("puts the principal Act first even though FRL relevance ranks it 4th", async () => {
    // The fixture's own order is: amending Act, two repealed declarations, then
    // the CCA. Taking the first hit would answer a CCA question with a 2016
    // price-notification declaration.
    expect(SEARCH_CCA.value[0].id).not.toBe("C2004A00109")
    const text = (await run(client(SEARCH_CCA.value, SEARCH_CCA["@odata.count"]))).content[0].text
    expect(text).toMatch(/1\. Competition and Consumer Act 2010\n\s+id: C2004A00109/)
  })

  it("reports the true upstream count, not the page size", async () => {
    const text = (await run(client(SEARCH_CCA.value, 42))).content[0].text
    expect(text).toContain("42 matching title(s)")
  })
})

describe("search_law annotations", () => {
  it("reads the TPA→CCA rename as a rename, never as a repeal", async () => {
    const text = (await run(client(TPA.value), { query: "Trade Practices Act 1974" })).content[0].text
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toMatch(/former name|previously named/i)
    expect(text).toContain("NOT a repeal")
    expect(text).not.toContain("⚠️ REPEALED")
  })

  it("names the repealing act and calls it the successor", async () => {
    const repealed = SEARCH_CCA.value.find((title) => title.status === "Repealed")!
    const text = (await run(client([repealed]))).content[0].text
    expect(text).toContain("⚠️ REPEALED")
    expect(text).toMatch(/\[F\d{4}[A-Z]\d{5}\]|\[C\d{4}[A-Z]\d{5}\]/)
    expect(text).toContain("successor")
  })

  it("warns when commenced amendments are not yet incorporated", async () => {
    const text = (await run(client(TPA.value), { query: "Trade Practices Act 1974" })).content[0].text
    expect(TPA.value[0].hasCommencedUnincorporatedAmendments).toBe(true)
    expect(text).toContain("NOT yet incorporated")
  })
})

describe("search_law guards", () => {
  it("refuses to present an unrelated result set as the answer", async () => {
    const unrelated: FrlTitle[] = [{ id: "C2004A00001", name: "Aged Care Act 1997", collection: "Act", status: "InForce" }]
    const result = await run(client(unrelated), { query: "Competition and Consumer Act" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
    expect(result.content[0].text).toContain("did not connect")
    expect(result.content[0].text).toContain("Aged Care Act 1997")
  })

  it("asks for a jurisdiction rather than picking one", async () => {
    const result = await run(client([]), { query: "Evidence Act" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[AMBIGUOUS]")
    expect(result.content[0].text).toContain("(NSW)")
  })

  it("looks a register id up directly instead of searching for it", async () => {
    let searched = false
    const c = {
      searchTitles: async () => {
        searched = true
        return { count: 0, titles: [] }
      },
      getTitle: async () => TPA.value[0],
    } as unknown as AuApiClient
    const text = (await run(c, { query: "C2004A00109" })).content[0].text
    expect(searched).toBe(false)
    expect(text).toContain("is a register id")
  })

  it("returns a NOT_FOUND hint, not an empty body, when nothing matches", async () => {
    const result = await run(client([]), { query: "Zzzz Nonexistent Act 1899" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
    expect(result.content[0].text).toContain("Do not guess")
  })

  it("explains an alias expansion so the changed search text is not a surprise", async () => {
    const text = (await run(client(TPA.value), { query: "CCA" })).content[0].text
    expect(text).toContain('Alias "CCA" resolved to Competition and Consumer Act 2010')
  })
})
