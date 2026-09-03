import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import type { FrlTitle } from "../lib/types.js"
import { getLawSystemTree } from "./law-system-tree.js"

const TPA = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-title-tpa-rename.json", import.meta.url), "utf8")) as { value: FrlTitle[] }
).value[0]
const ASIC89 = (
  JSON.parse(readFileSync(new URL("./__fixtures__/frl-title-asic1989-repealed.json", import.meta.url), "utf8")) as { value: FrlTitle[] }
).value[0]
const AUTHORISES = JSON.parse(readFileSync(new URL("./__fixtures__/frl-authorises-cca.json", import.meta.url), "utf8"))

const AMENDERS: FrlTitle[] = [
  { id: "C2010A00103", name: "Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010", year: 2010 },
  { id: "C2022A00054", name: "Treasury Laws Amendment (More Competition, Better Prices) Act 2022", year: 2022 },
]

function client(opts: { title?: FrlTitle; amenders?: () => Promise<unknown>; instruments?: unknown } = {}): AuApiClient {
  return {
    getTitle: async () => opts.title ?? TPA,
    listAmenders: opts.amenders ?? (async () => ({ count: 201, titles: AMENDERS })),
    fetchJson: async () => opts.instruments ?? AUTHORISES,
  } as unknown as AuApiClient
}

const run = (c: AuApiClient, input: Record<string, unknown> = {}) =>
  getLawSystemTree(c, {
    registerId: "C2004A00109",
    instrumentLimit: 5,
    amenderLimit: 5,
    includeRepealedInstruments: false,
    ...input,
  } as never)

beforeEach(() => lawCache.clear())

describe("get_law_system_tree", () => {
  it("assembles status, amenders and instruments in one tree", async () => {
    const text = (await run(client())).content[0].text
    expect(text).toContain("Amended/repealed by:")
    expect(text).toContain("Treasury Laws Amendment (More Competition, Better Prices) Act 2022")
    expect(text).toContain("Delegated legislation made under it")
    expect(text).toContain("under s 172")
  })

  it("renders nameHistory forwards — `start` is when a name BEGAN", async () => {
    const text = (await run(client())).content[0].text
    // "until 1974-08-24" would say the Act lapsed on the day it was enacted.
    expect(text).toContain("Trade Practices Act 1974 from 1974-08-24")
    expect(text).not.toContain("until 1974-08-24")
    expect(text).toContain("(current name)")
  })

  it("names the Act that performed the rename", async () => {
    const text = (await run(client())).content[0].text
    expect(text).toContain("renamed by Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010 [C2010A00103]")
  })

  it("marks a failed branch as unavailable rather than empty", async () => {
    const failing = client({
      amenders: async () => {
        throw new Error("upstream 503")
      },
    })
    const text = (await run(failing)).content[0].text
    expect(text).toContain("⚠️ Not retrieved: upstream 503")
    expect(text).toContain("not an absence of amendments")
  })

  it("distinguishes a genuinely empty branch from a broken one", async () => {
    const text = (await run(client({ instruments: { "@odata.count": 0, value: [] } }))).content[0].text
    expect(text).toContain("(the Register records none authorised by this title)")
    expect(text).not.toContain("Not retrieved")
  })

  it("shows the repealing act as the successor for a repealed title", async () => {
    const text = (await run(client({ title: ASIC89 }))).content[0].text
    expect(text).toContain("Repealed by: Corporations (Repeals, Consequentials and Transitionals) Act 2001 [C2004A00823]")
  })

  it("says the 'what does X amend' direction does not exist, for an amending title", async () => {
    const amending: FrlTitle = { ...TPA, isPrincipal: false }
    const text = (await run(client({ title: amending }))).content[0].text
    expect(text).toContain("NOT")
    expect(text).toContain("'what does X amend'")
    expect(text).toContain("search_historical_law")
  })

  it("skips a branch when its limit is zero, and says so", async () => {
    const text = (await run(client(), { amenderLimit: 0 })).content[0].text
    expect(text).toContain("(skipped — amenderLimit was 0)")
  })

  it("reports the true amender count, not the page size", async () => {
    const text = (await run(client(), { amenderLimit: 1 })).content[0].text
    expect(text).toContain("more of 201")
  })
})
