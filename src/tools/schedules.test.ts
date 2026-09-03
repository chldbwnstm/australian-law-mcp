import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import { getSchedules } from "./schedules.js"

const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))
const VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-schedule2.html", import.meta.url), "utf8")

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
}

function client(entries = ENTRIES): AuApiClient {
  return {
    getTitle: async () => CCA,
    getToc: async () => entries,
    getVolumeHtml: async () => VOL4,
  } as unknown as AuApiClient
}

const run = (input: Record<string, unknown> = {}, c = client()) =>
  getSchedules(c, { registerId: "C2004A00109", includeText: false, maxChars: 20000, ...input } as never)

beforeEach(() => lawCache.clear())

describe("get_schedules listing", () => {
  it("lists both schedules with their provision counts", async () => {
    const text = (await run()).content[0].text
    expect(text).toContain("Schedule 1—The Schedule version of Part IV")
    expect(text).toContain("Schedule 2—The Australian Consumer Law")
    expect(text).toMatch(/numbered provisions/)
  })

  it("flags the ACL and spells out that it is sch 2 s 18, not s 18", async () => {
    const text = (await run()).content[0].text
    expect(text).toContain("This is the Australian Consumer Law")
    expect(text).toContain('"sch 2 s 18", NOT "s 18"')
  })

  it("prints the exact follow-up call for each schedule", async () => {
    const text = (await run()).content[0].text
    expect(text).toContain('provision:"sch 2 s <n>"')
    expect(text).toContain('schedule:"2", includeText:true')
  })

  it("does not treat a nested Schedule heading as a top-level schedule", async () => {
    const text = (await run()).content[0].text
    expect(text.match(/^Schedule /gm)?.length).toBe(2)
  })
})

describe("get_schedules opening one", () => {
  it("outlines the schedule's structure by default", async () => {
    const text = (await run({ schedule: "2" })).content[0].text
    expect(text).toContain("Chapter 2—General protections")
    expect(text).toContain("Part 2-1—Misleading or deceptive conduct")
    expect(text).toContain("includeText:true")
  })

  it("returns the schedule text when asked, sliced from the volume", async () => {
    const text = (await run({ schedule: "2", includeText: true })).content[0].text
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("in trade or commerce")
  })

  it("lists the schedules that DO exist when the number is wrong", async () => {
    const result = await run({ schedule: "9" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Schedules present: 1, 2")
  })
})

describe("get_schedules empty and filtered cases", () => {
  it("says a compilation without schedules is an observation, not a finding", async () => {
    const bodyOnly = ENTRIES.filter((entry) => entry.volumeDoc.includes("document_1"))
    const text = (await run({}, client(bodyOnly))).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("not a claim that the Act never had one")
  })

  it("narrows by heading keyword", async () => {
    const text = (await run({ titleContains: "consumer" })).content[0].text
    expect(text).toContain("Schedule 2—The Australian Consumer Law")
    expect(text).not.toContain("Schedule 1—The Schedule version")
  })

  it("shows the real headings when the keyword filter matches nothing", async () => {
    const text = (await run({ titleContains: "zzz" })).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("Headings present:")
    expect(text).toContain("Schedule 2—The Australian Consumer Law")
  })
})
