import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { authorisedby, authorises, enablingProvisionFor } from "./statute-helpers/instruments.js"
import { getThreeTier } from "./three-tier.js"

const AUTHORISES = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-authorises-cca.json", import.meta.url), "utf8"),
) as { "@odata.count": number; value: Array<FrlTitle & { authorisedBy?: Array<Record<string, unknown>> }> }

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

function client(payload: unknown = AUTHORISES): { api: AuApiClient; paths: string[] } {
  const paths: string[] = []
  const api = {
    getTitle: async () => CCA,
    fetchJson: async (_host: string, path: string) => {
      paths.push(path)
      return payload
    },
  } as unknown as AuApiClient
  return { api, paths }
}

const run = (c: AuApiClient, input: Record<string, unknown> = {}) =>
  getThreeTier(c, {
    registerId: "C2004A00109",
    includeRepealed: false,
    includeGazetteNotices: false,
    limit: 10,
    ...input,
  } as never)

beforeEach(() => lawCache.clear())

describe("the authorises() discovery", () => {
  it("builds the criteria FRL actually accepts", () => {
    expect(authorises("C2004A00109")).toBe('authorises("C2004A00109")')
    expect(authorisedby("F1996B01420")).toBe('authorisedby("F1996B01420")')
    expect(() => authorises("not an id!")).toThrow(/Invalid FRL title id/)
  })

  it("sends the criteria search with the authorisedBy expansion", async () => {
    const { api, paths } = client()
    await run(api)
    expect(paths[0]).toContain("Titles/Search(criteria=")
    expect(decodeURIComponent(paths[0])).toContain('authorises("C2004A00109")')
    expect(decodeURIComponent(paths[0])).toContain("collection(LegislativeInstrument)")
    expect(decodeURIComponent(paths[0])).toContain("status(InForce)")
  })

  it("restricts to legislative instruments unless gazette notices are asked for", async () => {
    const { api, paths } = client()
    await run(api, { includeGazetteNotices: true })
    expect(decodeURIComponent(paths[0])).not.toContain("collection(")
  })

  it("drops the status facet when repealed instruments are wanted", async () => {
    const { api, paths } = client()
    await run(api, { includeRepealed: true })
    expect(decodeURIComponent(paths[0])).not.toContain("status(InForce)")
  })

  it("reads the enabling provision off the expansion, including schedule powers", () => {
    const rows = AUTHORISES.value.flatMap((title) => (title.authorisedBy ?? []) as never[])
    expect(enablingProvisionFor(rows, "C2004A00109")).toBeTruthy()
    const schedulePower = AUTHORISES.value.find((title) =>
      (title.authorisedBy ?? []).some((row) => String(row.affectingProvisions ?? "").includes("sch 2")),
    )
    expect(schedulePower).toBeDefined()
  })
})

describe("get_three_tier output", () => {
  it("groups by instrument kind and prints ids and enabling provisions", async () => {
    const { api } = client()
    const text = (await run(api)).content[0].text
    expect(text).toContain("── ")
    expect(text).toMatch(/\[F\d{4}[A-Z]\d{5}\]/)
    expect(text).toContain("made under Competition and Consumer Act 2010 s ")
  })

  it("reports the real total and how to page, not just the page size", async () => {
    const { api } = client({ ...AUTHORISES, "@odata.count": 146 })
    const text = (await run(api, { limit: 3 })).content[0].text
    expect(text).toContain("146 instrument(s) in force")
    expect(text).toContain("Page with skip=")
  })

  it("offers ordinary explanations before 'this Act delegates nothing'", async () => {
    const { api } = client({ "@odata.count": 0, value: [] })
    const text = (await run(api)).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("includeRepealed:true")
    expect(text).toContain("no regulation-making power")
  })

  it("caches the criteria search so a repeat call does not re-query", async () => {
    const { api, paths } = client()
    await run(api)
    await run(api)
    expect(paths).toHaveLength(1)
  })
})
