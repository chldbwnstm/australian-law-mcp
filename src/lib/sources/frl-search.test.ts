import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../api-client.js"
import { frlSearchUrl, searchTitlesMatching } from "./frl-search.js"

/** Records the path/query a search would send, and answers with a fixed payload. */
function recordingClient(payload: unknown = { "@odata.count": 2, value: [] }) {
  const calls: Array<{ host: string; path: string; query: unknown }> = []
  const client = {
    async fetchJson(host: string, path: string, opts?: { query?: unknown }) {
      calls.push({ host, path, query: opts?.query })
      return payload
    },
  } as unknown as AuApiClient
  return { client, calls }
}

describe("searchTitlesMatching", () => {
  it("asks for `all` word matching, not the DSL's phrase default", async () => {
    // Measured live: collection(NotifiableInstrument) + "CSIRO determination"
    // returns 0 with `contains` and 2 with `all`.
    const { client, calls } = recordingClient()
    await searchTitlesMatching(client, { query: "CSIRO determination", collection: "NotifiableInstrument" })
    expect(decodeURIComponent(calls[0].path)).toContain("nameAndText,all")
  })

  it("wraps text and collection in and(), never infix", async () => {
    const { client, calls } = recordingClient()
    await searchTitlesMatching(client, { query: "gazette", collection: "Gazette" })
    const criteria = decodeURIComponent(decodeURIComponent(calls[0].path))
    expect(criteria).toContain("and(text(")
    expect(criteria).toContain("collection(Gazette)")
  })

  it("omits and() when there is only one criterion", async () => {
    const { client, calls } = recordingClient()
    await searchTitlesMatching(client, { query: "privacy" })
    const criteria = decodeURIComponent(decodeURIComponent(calls[0].path))
    expect(criteria).toContain("text(")
    expect(criteria).not.toContain("and(")
  })

  it("honours searchType and clamps $top to the API's ceiling", async () => {
    const { client, calls } = recordingClient()
    await searchTitlesMatching(client, { query: "x", searchType: "name", top: 5000 })
    expect(decodeURIComponent(calls[0].path)).toContain("name,all")
    expect((calls[0].query as { $top: number }).$top).toBe(100)
  })

  it("sends $skip only when a page offset was asked for", async () => {
    const { client, calls } = recordingClient()
    await searchTitlesMatching(client, { query: "x" })
    expect((calls[0].query as Record<string, unknown>).$skip).toBeUndefined()
    await searchTitlesMatching(client, { query: "x", skip: 20 })
    expect((calls[1].query as Record<string, unknown>).$skip).toBe(20)
  })

  it("falls back to the row count when the API omits @odata.count", async () => {
    const { client } = recordingClient({ value: [{ id: "A", name: "n" }] })
    const result = await searchTitlesMatching(client, { query: "x" })
    expect(result.count).toBe(1)
    expect(result.titles).toHaveLength(1)
  })
})

describe("frlSearchUrl", () => {
  it("builds the human search page URL", () => {
    expect(frlSearchUrl("privacy act")).toBe("https://www.legislation.gov.au/search/text/privacy%20act")
  })
})
