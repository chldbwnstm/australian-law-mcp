import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import {
  GetBatchProvisionsSchema,
  MAX_BATCH_LAWS,
  MAX_BATCH_PROVISIONS,
  MAX_PROVISIONS_PER_LAW,
  getBatchProvisions,
} from "./batch-provisions.js"

const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const VOL1 = readFileSync(new URL("../lib/__fixtures__/cca-vol1-slice.html", import.meta.url), "utf8")
const VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-schedule2.html", import.meta.url), "utf8")

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

function client(counters = { toc: 0, volumes: [] as number[] }): { api: AuApiClient; counters: typeof counters } {
  const api = {
    getTitle: async () => CCA,
    getToc: async () => {
      counters.toc++
      return ENTRIES
    },
    getVolumeHtml: async (_id: string, volume: number) => {
      counters.volumes.push(volume)
      return volume === 1 ? VOL1 : VOL4
    },
  } as unknown as AuApiClient
  return { api, counters }
}

beforeEach(() => lawCache.clear())

describe("get_batch_provisions cost", () => {
  it("fetches the table of contents once per title, not once per provision", async () => {
    const { api, counters } = client()
    await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 19", "s 17A"],
      maxCharsPerProvision: 2500,
    } as never)
    expect(counters.toc).toBe(1)
  })

  it("fetches each volume once even when several provisions share it", async () => {
    const { api, counters } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "s 19", "sch 2 s 18"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(counters.volumes.filter((volume) => volume === 1)).toHaveLength(1)
    expect(counters.volumes.filter((volume) => volume === 4)).toHaveLength(1)
    expect(text).toContain("(volumes read for this title: 2)")
  })
})

describe("get_batch_provisions results", () => {
  it("keeps the body and the schedule provision apart", async () => {
    const { api } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "sch 2 s 18"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("Misleading or deceptive conduct")
  })

  it("lists misses explicitly and counts them, rather than dropping them", async () => {
    const { api } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "s 9999", "not a reference"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(text).toContain("3 requested, 1 retrieved, 2 not found")
    expect(text).toContain("✗ s 9999")
    expect(text).toContain("not a recognisable provision reference")
    expect(text).toContain("Do not fill the gaps from memory")
  })

  it("marks a title that could not be resolved without abandoning the rest", async () => {
    const api = {
      getTitle: async (id: string) => {
        if (id === "C9999X99999") throw new Error("FRL reports no title with id C9999X99999")
        return CCA
      },
      getToc: async () => ENTRIES,
      getVolumeHtml: async () => VOL1,
    } as unknown as AuApiClient
    const text = (
      await getBatchProvisions(api, {
        laws: [
          { registerId: "C9999X99999", provisions: ["s 1"] },
          { registerId: "C2004A00109", provisions: ["s 18"] },
        ],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text
    expect(text).toContain("[UNRESOLVED]")
    expect(text).toContain("Meetings of Commission")
  })

  it("marks the provisions of a dead volume and keeps everything already retrieved", async () => {
    // The CCA's body is volume 1 and schedule 2 is volume 4; only the second
    // fails. Before the fix the exception escaped runTask and the whole call
    // became one error, discarding the volume-1 text and the budget spent on it.
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        if (volume === 4) throw new Error("frlDocs upstream server error (500)")
        return VOL1
      },
    } as unknown as AuApiClient

    const result = await getBatchProvisions(api, {
      registerId: "C2004A00109",
      provisions: ["s 18", "s 19", "sch 2 s 18"],
      maxCharsPerProvision: 2500,
    } as never)
    const text = result.content[0].text

    expect(result.isError).toBeFalsy()
    expect(text).toContain("3 requested, 2 retrieved, 1 not found")
    expect(text).toContain("Meetings of Commission")
    expect(text).toContain("could not be read: frlDocs upstream server error (500)")
    // A failed volume is not a missing provision — the reason travels with it.
    expect(text).not.toContain("not in this compilation's table of contents")
  })

  it("does not re-fetch a volume that already failed once in the same batch", async () => {
    // Thirty sections of one dead volume must cost one attempt, not thirty.
    const attempts: number[] = []
    const api = {
      getTitle: async () => CCA,
      getToc: async () => ENTRIES,
      getVolumeHtml: async (_id: string, volume: number) => {
        attempts.push(volume)
        throw new Error("frlDocs upstream server error (500)")
      },
    } as unknown as AuApiClient

    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18", "s 19", "s 17A"],
        maxCharsPerProvision: 2500,
      } as never)
    ).content[0].text

    expect(attempts).toEqual([1])
    expect(text).toContain("3 requested, 0 retrieved, 3 not found")
  })

  it("shortens a long provision rather than letting it crowd out the others", async () => {
    const { api } = client()
    const text = (
      await getBatchProvisions(api, {
        registerId: "C2004A00109",
        provisions: ["s 18"],
        maxCharsPerProvision: 200,
      } as never)
    ).content[0].text
    expect(text).toContain("(provision shortened to 200 characters)")
  })
})

describe("get_batch_provisions limits", () => {
  it("caps the total number of provisions across titles", () => {
    const laws = Array.from({ length: 5 }, () => ({
      registerId: "C2004A00109",
      provisions: Array.from({ length: 30 }, (_, index) => `s ${index + 1}`),
    }))
    const parsed = GetBatchProvisionsSchema.safeParse({ laws })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed)).toContain(String(MAX_BATCH_PROVISIONS))
  })

  it("caps provisions per title and titles per call", () => {
    expect(
      GetBatchProvisionsSchema.safeParse({
        registerId: "C2004A00109",
        provisions: Array.from({ length: MAX_PROVISIONS_PER_LAW + 1 }, (_, i) => `s ${i}`),
      }).success,
    ).toBe(false)
    expect(
      GetBatchProvisionsSchema.safeParse({
        laws: Array.from({ length: MAX_BATCH_LAWS + 1 }, () => ({ registerId: "C2004A00109", provisions: ["s 1"] })),
      }).success,
    ).toBe(false)
  })

  it("requires provisions in the single-title form", () => {
    expect(GetBatchProvisionsSchema.safeParse({ registerId: "C2004A00109" }).success).toBe(false)
  })
})
