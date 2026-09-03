import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle, FrlVersion } from "../lib/types.js"
import { getHistoricalLaw, searchHistoricalLaw } from "./historical-law.js"

const VERSIONS = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-versions-cca.json", import.meta.url), "utf8")) as { value: unknown[] }
).value.map(normalizeFrlVersion)
const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

function client(opts: { versions?: FrlVersion[] } = {}): AuApiClient {
  const versions = opts.versions ?? VERSIONS
  return {
    getTitle: async () => CCA,
    listVersions: async () => versions,
    findVersion: async (p: { asAt?: string; registerId?: string }) =>
      p.registerId
        ? versions.find((v) => v.registerId === p.registerId) ?? versions[0]
        : versions.find((v) => (v.start ?? "") <= `${p.asAt}T00:00:00`) ?? versions[versions.length - 1],
    getToc: async () => ENTRIES,
    getProvision: async () => ({
      ref: "s 18",
      heading: "18  Meetings of Commission",
      text: "18 Meetings of Commission\n(1) The Chairperson may convene meetings.",
      volumeDoc: "document_1/document_1.html",
      breadcrumb: ["Volume 1", "Part II"],
    }),
  } as unknown as AuApiClient
}

beforeEach(() => lawCache.clear())

describe("search_historical_law", () => {
  it("identifies the compilation in force on a date and how to fetch it", async () => {
    const text = (
      await searchHistoricalLaw(client(), { registerId: "C2004A00109", asAt: "2026-07-15", limit: 5, withReasons: true } as never)
    ).content[0].text
    expect(text).toContain("In force on 2026-07-15:")
    expect(text).toContain('date:"2026-07-15"')
    expect(text).toContain("returns this compilation")
  })

  it("keeps 'in force now' and 'latest registered' apart", async () => {
    const text = (
      await searchHistoricalLaw(client(), { registerId: "C2004A00109", limit: 6, withReasons: false } as never)
    ).content[0].text
    expect(text).toContain("in force now")
    expect(text).toContain("latest registered")
  })

  it("says so when a compilation has not been registered yet", async () => {
    const text = (
      await searchHistoricalLaw(client(), { registerId: "C2004A00109", limit: 6, withReasons: false } as never)
    ).content[0].text
    expect(text).toContain("registerId: none yet (compilation pending)")
  })

  it("attributes each compilation to its amending Acts", async () => {
    const text = (
      await searchHistoricalLaw(client(), { registerId: "C2004A00109", limit: 6, withReasons: true } as never)
    ).content[0].text
    expect(text).toContain("Amend: Treasury Laws Amendment (Payday Superannuation) Act 2025")
  })

  it("gives the real date range when the requested window is empty", async () => {
    const text = (
      await searchHistoricalLaw(client(), { registerId: "C2004A00109", from: "1901-01-01", to: "1901-12-31", limit: 5, withReasons: false } as never)
    ).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("Full range on the Register:")
  })

  it("treats an empty version list as a lookup result, not a finding", async () => {
    const text = (
      await searchHistoricalLaw(client({ versions: [] }), { registerId: "C2004A00109", limit: 5, withReasons: false } as never)
    ).content[0].text
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("not a finding that the Act was never compiled")
  })
})

describe("get_historical_law", () => {
  it("resolves a compilation id to the date the text is addressed by", async () => {
    const text = (
      await getHistoricalLaw(client(), { registerId: "C2004A00109", compilationId: "C2026C00323", maxChars: 8000 } as never)
    ).content[0].text
    expect(text).toContain("compilation addressed as 2026-07-01")
  })

  it("returns the compilation's structure when no provision is asked for", async () => {
    const text = (
      await getHistoricalLaw(client(), { registerId: "C2004A00109", date: "2026-07-15", maxChars: 8000 } as never)
    ).content[0].text
    expect(text).toContain("Structure:")
    expect(text).toContain("Volume 1")
    expect(text).toContain("Add `provision`")
  })

  it("returns the provision text as it stood in that compilation", async () => {
    const text = (
      await getHistoricalLaw(client(), { registerId: "C2004A00109", date: "2026-07-15", provision: "s 18", maxChars: 8000 } as never)
    ).content[0].text
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("The Chairperson may convene meetings")
  })

  it("reads a missing provision in an old compilation as evidence, not as a fetch failure", async () => {
    const text = (
      await getHistoricalLaw(client(), { registerId: "C2004A00109", date: "2026-07-15", provision: "s 4242", maxChars: 8000 } as never)
    ).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("may not have existed yet")
    expect(text).toContain("get_provision_history")
  })

  it("supports the as-made text and labels it as pre-compilation", async () => {
    const text = (
      await getHistoricalLaw(client(), { registerId: "C2004A00109", date: "asmade", maxChars: 8000 } as never)
    ).content[0].text
    expect(text).toContain("compilation addressed as asmade")
    expect(text).toContain("as made")
  })

  it("insists on a date or compilation id rather than defaulting silently", async () => {
    const result = await getHistoricalLaw(client(), { registerId: "C2004A00109", maxChars: 8000 } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
  })
})
