import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { advancedSearch } from "./advanced-search.js"

const CCA_SEARCH = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-search-cca.json", import.meta.url), "utf8"),
) as { "@odata.count": number; value: FrlTitle[] }

function client(payload: unknown = CCA_SEARCH): { api: AuApiClient; calls: Array<{ path: string; query: Record<string, unknown> }> } {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = []
  const api = {
    fetchJson: async (_host: string, path: string, opts: { query?: Record<string, unknown> }) => {
      calls.push({ path, query: opts.query ?? {} })
      return payload
    },
  } as unknown as AuApiClient
  return { api, calls }
}

const base = { searchType: "nameAndText", matchType: "contains", combine: "and", orderBy: "relevance", limit: 10 }

beforeEach(() => lawCache.clear())

describe("advanced_search criteria construction", () => {
  it("double-encodes the search phrase the way the DSL requires", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, text: "misleading or deceptive" } as never)
    // One encoding inside the criteria, one on the wire.
    expect(calls[0].path).toContain("misleading%2520or%2520deceptive")
  })

  it("uses function-style and(), never infix (infix is silently ignored upstream)", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, text: "carbon", collections: ["Act"], statuses: ["InForce"] } as never)
    const criteria = decodeURIComponent(calls[0].path)
    expect(criteria).toContain("and(text(")
    expect(criteria).not.toMatch(/\bAND\b/)
  })

  it("passes enum facets unquoted and dates quoted", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, text: "carbon", collections: ["Act"], pointInTime: "2015-06-30" } as never)
    const criteria = decodeURIComponent(calls[0].path)
    expect(criteria).toContain("collection(Act)")
    expect(criteria).toContain('pointintime("2015-06-30")')
  })

  it("honours an OR combination", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, text: "carbon", collections: ["Act"], combine: "or" } as never)
    expect(decodeURIComponent(calls[0].path)).toContain("or(text(")
  })

  it("never sends $search (the server ignores it) and never orders by makingDate (it 500s)", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, text: "carbon", orderBy: "year" } as never)
    expect(calls[0].query.$search).toBeUndefined()
    expect(String(calls[0].query.$orderby ?? "")).not.toContain("makingDate")
    expect(calls[0].query.$orderby).toBe("year asc")
  })

  it("uses a plain $filter when there is no criteria facet", async () => {
    const { api, calls } = client()
    await advancedSearch(api, { ...base, yearFrom: 2020, yearTo: 2021 } as never)
    expect(calls[0].path).toBe("Titles")
    expect(calls[0].query.$filter).toBe("year ge 2020 and year le 2021")
  })
})

describe("advanced_search honesty about the local year filter", () => {
  it("says the year range was applied to the page and the count is unfiltered", async () => {
    const { api } = client()
    const text = (
      await advancedSearch(api, { ...base, text: "competition", yearFrom: 2020, yearTo: 2021 } as never)
    ).content[0].text
    expect(text).toContain("applied to this page only")
    expect(text).toContain("`count` above is the unfiltered total")
  })

  it("does not add that caveat when no range was given", async () => {
    const { api } = client()
    const text = (await advancedSearch(api, { ...base, text: "competition" } as never)).content[0].text
    expect(text).not.toContain("applied to this page only")
  })
})

describe("advanced_search results", () => {
  it("annotates repealed hits with what repealed them", async () => {
    const { api } = client()
    const text = (await advancedSearch(api, { ...base, text: "competition and consumer act" } as never)).content[0].text
    expect(text).toContain("⚠️ REPEALED")
  })

  it("explains the usual causes of an empty result instead of leaving it bare", async () => {
    const { api } = client({ "@odata.count": 0, value: [] })
    const text = (await advancedSearch(api, { ...base, text: "zzzq" } as never)).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("PHRASE match")
    expect(text).toContain("Do not fill this in from memory")
  })

  it("refuses a query with no facets at all", async () => {
    const { api } = client()
    const result = await advancedSearch(api, { ...base } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
  })

  it("numbers results from the offset so paging stays legible", async () => {
    const { api } = client()
    const text = (await advancedSearch(api, { ...base, text: "competition", skip: 20 } as never)).content[0].text
    expect(text).toContain("21. ")
  })
})
