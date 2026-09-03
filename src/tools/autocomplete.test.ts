import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { suggestLawNames } from "./autocomplete.js"

const PRIVACY: FrlTitle[] = [
  { id: "C2004A03712", name: "Privacy Act 1988", collection: "Act", status: "InForce", isPrincipal: true },
  { id: "C2004A01156", name: "Private Health Insurance (Collapsed Insurer Levy) Act 2003", collection: "Act", status: "InForce", isPrincipal: true },
  { id: "C2004A09999", name: "Privacy Amendment Act 1990", collection: "Act", status: "Repealed", isPrincipal: false },
]

function client(titles: FrlTitle[] = PRIVACY): { api: AuApiClient; filters: string[] } {
  const filters: string[] = []
  const api = {
    searchTitles: async (p: { filter?: string }) => {
      filters.push(p.filter ?? "")
      return { count: titles.length, titles }
    },
  } as unknown as AuApiClient
  return { api, filters }
}

const run = (c: AuApiClient, input: Record<string, unknown> = {}) =>
  suggestLawNames(c, { partial: "Priv", inForceOnly: true, limit: 10, ...input } as never)

beforeEach(() => lawCache.clear())

describe("suggest_law_names", () => {
  it("uses a prefix filter, which is what the Register actually supports", async () => {
    const { api, filters } = client()
    await run(api)
    expect(filters[0]).toBe("startswith(name,'Priv')")
  })

  it("escapes an apostrophe rather than breaking the OData literal", async () => {
    const { api, filters } = client()
    await run(api, { partial: "Governor-General's" })
    expect(filters[0]).toBe("startswith(name,'Governor-General''s')")
  })

  it("filters out non-in-force titles locally (the server rejects that combination)", async () => {
    const { api } = client()
    const text = (await run(api)).content[0].text
    expect(text).toContain("Privacy Act 1988")
    expect(text).not.toContain("Privacy Amendment Act 1990")
  })

  it("surfaces abbreviations the Register has no field for", async () => {
    const { api } = client()
    const text = (await run(api, { partial: "CC" })).content[0].text
    expect(text).toContain("Abbreviations / known names")
    expect(text).toContain('"CCA" → Competition and Consumer Act 2010 (Cth)')
  })

  it("still answers from the local table when the prefix search fails", async () => {
    const failing = {
      searchTitles: async () => {
        throw new Error("upstream 500")
      },
    } as unknown as AuApiClient
    const text = (await run(failing, { partial: "ACL" })).content[0].text
    expect(text).toContain("prefix search failed")
    expect(text).toContain("Competition and Consumer Act 2010")
  })

  it("propagates the failure when there is nothing local to fall back on", async () => {
    const failing = {
      searchTitles: async () => {
        throw new Error("upstream 500")
      },
    } as unknown as AuApiClient
    const result = await run(failing, { partial: "Zzzq" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("upstream 500")
  })

  it("tells the caller not to invent a title when nothing matches", async () => {
    const { api } = client([])
    const result = await run(api, { partial: "Zzzq" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
    expect(result.content[0].text).toContain("Do not invent a title")
    expect(result.content[0].text).toContain("get_state_equivalents")
  })

  it("puts principal Acts above amending ones", async () => {
    const mixed: FrlTitle[] = [
      { id: "C1", name: "Privacy Amendment (X) Act 2020", collection: "Act", status: "InForce", isPrincipal: false },
      { id: "C2", name: "Privacy Act 1988", collection: "Act", status: "InForce", isPrincipal: true },
    ]
    const { api } = client(mixed)
    const text = (await run(api)).content[0].text
    expect(text.indexOf("Privacy Act 1988")).toBeLessThan(text.indexOf("Privacy Amendment (X) Act 2020"))
  })
})
