import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { getLawHistory } from "./law-history.js"

const VERSIONS_RAW = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-versions-cca.json", import.meta.url), "utf8"),
) as { "@odata.count": number; value: Array<Record<string, unknown>> }

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

function client(): { api: AuApiClient; queries: Array<Record<string, unknown>> } {
  const queries: Array<Record<string, unknown>> = []
  const api = {
    getTitle: async () => CCA,
    listVersions: async () => VERSIONS_RAW.value.map((v) => ({ ...v })) as never,
    fetchJson: async (_host: string, _path: string, opts: { query?: Record<string, unknown> }) => {
      queries.push(opts.query ?? {})
      return VERSIONS_RAW
    },
  } as unknown as AuApiClient
  return { api, queries }
}

beforeEach(() => lawCache.clear())

describe("get_law_history across the Register", () => {
  it("asks for versions starting inside the window, with an exclusive upper bound one day later", async () => {
    const { api, queries } = client()
    await getLawHistory(api, { date: "2026-07-01", limit: 5 } as never)
    expect(queries[0].$filter).toBe("start ge 2026-07-01T00:00:00 and start lt 2026-07-02T00:00:00")
  })

  it("reports the upstream total, not the page it was given", async () => {
    const { api } = client()
    const text = (await getLawHistory(api, { date: "2026-07-01", limit: 2 } as never)).content[0].text
    expect(text).toContain("210 version row(s) in the window")
  })

  it("labels the kind of change, so a repeal is not read as an amendment", async () => {
    const { api } = client()
    const text = (await getLawHistory(api, { date: "2026-07-01", limit: 5 } as never)).content[0].text
    expect(text).toMatch(/— Amend/)
    expect(text).toContain("Amend: Treasury Laws Amendment (Payday Superannuation) Act 2025")
  })

  it("filters by affect kind and says how many survived", async () => {
    const { api } = client()
    const text = (await getLawHistory(api, { date: "2026-07-01", affect: "Repeal", limit: 5 } as never)).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("of kind Repeal")
  })

  it("does not let 'nothing starts in this window' read as 'the law did not change'", async () => {
    const { api } = client()
    const text = (await getLawHistory(api, { date: "2026-07-01", affect: "Disallow", limit: 5 } as never)).content[0].text
    expect(text).toContain("not as 'the law did not change'")
  })
})

describe("get_law_history for one title", () => {
  it("filters that title's own versions to the window", async () => {
    const { api, queries } = client()
    const text = (
      await getLawHistory(api, { registerId: "C2004A00109", from: "2026-07-01", to: "2026-12-31", limit: 10 } as never)
    ).content[0].text
    expect(queries).toHaveLength(0) // uses listVersions, not the Register-wide sweep
    expect(text).toContain("Competition and Consumer Act 2010 [C2004A00109]")
    expect(text).toContain("2026-08-27")
    expect(text).not.toContain("2026-05-27")
  })
})

describe("get_law_history validation", () => {
  it("requires a date or a window", async () => {
    const { api } = client()
    const result = await getLawHistory(api, { limit: 5 } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
  })

  it("rejects a backwards window instead of quietly returning nothing", async () => {
    const { api } = client()
    const result = await getLawHistory(api, { from: "2026-12-31", to: "2026-01-01", limit: 5 } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("runs backwards")
  })
})
