import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { getLawStatistics } from "./law-statistics.js"

function client(counts: Record<string, number> = {}): { api: AuApiClient; calls: Array<{ path: string; query: Record<string, unknown> }> } {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = []
  const api = {
    fetchJson: async (_host: string, path: string, opts: { query?: Record<string, unknown> }) => {
      const query = opts.query ?? {}
      calls.push({ path, query })
      const key = decodeURIComponent(`${path}${query.$filter ?? ""}`)
      const match = Object.entries(counts).find(([needle]) => key.includes(needle))
      return { "@odata.count": match ? match[1] : 7, value: [{ id: "C2004A00109" }] }
    },
  } as unknown as AuApiClient
  return { api, calls }
}

beforeEach(() => lawCache.clear())

describe("get_law_statistics", () => {
  it("never calls the broken /Titles/$count endpoint", async () => {
    const { api, calls } = client()
    await getLawStatistics(api, { breakdown: "collection" } as never)
    expect(calls.every((call) => !call.path.includes("$count"))).toBe(true)
    expect(calls.every((call) => call.query.$count === "true" && call.query.$top === 1)).toBe(true)
  })

  it("counts every collection and shows the sum", async () => {
    const { api } = client({ "collection(Act)": 13732, "collection(Gazette)": 18593 })
    const text = (await getLawStatistics(api, { breakdown: "collection" } as never)).content[0].text
    expect(text).toContain("13,732")
    expect(text).toContain("18,593")
    expect(text).toContain("(sum of the above)")
  })

  it("uses the criteria DSL for a status breakdown, which is what the server accepts", async () => {
    const { api, calls } = client()
    await getLawStatistics(api, { breakdown: "status", collection: "Act" } as never)
    const criteria = calls.map((call) => decodeURIComponent(call.path)).join(" ")
    expect(criteria).toContain("and(collection(Act),status(InForce))")
    expect(criteria).toContain("status(Repealed)")
  })

  it("warns that a title counts once, under its current status", async () => {
    const { api } = client()
    const text = (await getLawStatistics(api, { breakdown: "status", collection: "Act" } as never)).content[0].text
    expect(text).toContain("counts once, under its CURRENT status")
  })

  it("queries year buckets one year at a time (a year range 500s when combined)", async () => {
    const { api, calls } = client()
    await getLawStatistics(api, { breakdown: "year", collection: "Act", yearFrom: 2020, yearTo: 2022 } as never)
    const filters = calls.map((call) => String(call.query.$filter ?? ""))
    expect(filters).toContain("collection eq 'Act' and year eq 2020")
    expect(filters).toContain("collection eq 'Act' and year eq 2022")
    expect(filters.every((filter) => !filter.includes(" ge "))).toBe(true)
  })

  it("refuses a year span past the cap rather than firing hundreds of queries", async () => {
    const { api } = client()
    const result = await getLawStatistics(api, { breakdown: "year", yearFrom: 1900, yearTo: 2026 } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("one query per year")
  })

  it("rejects a backwards year range", async () => {
    const { api } = client()
    const result = await getLawStatistics(api, { breakdown: "year", yearFrom: 2026, yearTo: 2020 } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("runs backwards")
  })

  it("caches counts so a repeat breakdown costs nothing", async () => {
    const { api, calls } = client()
    await getLawStatistics(api, { breakdown: "collection" } as never)
    const first = calls.length
    await getLawStatistics(api, { breakdown: "collection" } as never)
    expect(calls.length).toBe(first)
  })

  it("says the figures are live upstream counts, not estimates", async () => {
    const { api } = client()
    const text = (await getLawStatistics(api, { breakdown: "collection" } as never)).content[0].text
    expect(text).toContain("upstream @odata.count")
  })
})
