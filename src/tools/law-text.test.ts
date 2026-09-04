import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import { findNavPoint, sliceProvision } from "../lib/provision-slicer.js"
import { parseSectionRef } from "../lib/section-ref.js"
import type { FrlTitle } from "../lib/types.js"
import { getLawText } from "./law-text.js"

const NCX = readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8")
const VOL1 = readFileSync(new URL("../lib/__fixtures__/cca-vol1-slice.html", import.meta.url), "utf8")
const VOL4 = readFileSync(new URL("../lib/__fixtures__/cca-vol4-slice.html", import.meta.url), "utf8")
const ENTRIES = parseNcx(NCX)

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  isInForce: true,
}

interface Counters {
  toc: number
  volumes: string[]
}

function client(counters: Counters = { toc: 0, volumes: [] }): AuApiClient {
  const volumeHtml = (volume: number) => (volume === 1 ? VOL1 : VOL4)
  return {
    getTitle: async () => CCA,
    // The alias path: "ACL" is searched as "Competition and Consumer Act 2010".
    searchTitles: async () => ({ count: 1, titles: [CCA] }),
    getToc: async () => {
      counters.toc++
      return ENTRIES
    },
    getVolumeHtml: async (_id: string, volume: number) => {
      counters.volumes.push(`v${volume}`)
      return volumeHtml(volume)
    },
    // Mirrors the real client: TOC lookup, then a slice of the volume.
    getProvision: async (_id: string, provision: string) => {
      const ref = parseSectionRef(provision)!
      const entry = findNavPoint(ref, ENTRIES)!
      const volume = Number(/document_(\d+)/.exec(entry.volumeDoc)![1])
      counters.volumes.push(`v${volume}`)
      return {
        ref: provision,
        heading: entry.label,
        text: sliceProvision(volumeHtml(volume), entry, ENTRIES) ?? "",
        volumeDoc: entry.volumeDoc,
        breadcrumb: [],
      }
    },
  } as unknown as AuApiClient
}

const run = (input: Record<string, unknown>, c = client()) =>
  getLawText(c, { registerId: "C2004A00109", maxChars: 20000, ...input } as never)

beforeEach(() => lawCache.clear())

describe("get_law_text without a provision", () => {
  it("returns a map and an explicit refusal, not the whole Act", async () => {
    const counters: Counters = { toc: 0, volumes: [] }
    const text = (await run({}, client(counters))).content[0].text
    expect(counters.volumes).toEqual([]) // no megabyte download
    expect(text).toContain("the text itself is not returned")
    expect(text).toContain("Volume 1")
    expect(text).toContain("Volume 4")
    expect(text).toContain('provision:"s 18"')
  })

  it("reports the volume count so a multi-volume Act is not mistaken for one file", async () => {
    const text = (await run({})).content[0].text
    expect(text).toMatch(/across 2 volumes/)
  })
})

describe("get_law_text provision resolution", () => {
  it("sch 2 s 18 is the ACL provision, not the body's s 18", async () => {
    const text = (await run({ provision: "sch 2 s 18" })).content[0].text
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("Schedule 2—The Australian Consumer Law")
    expect(text).not.toContain("Meetings of Commission")
  })

  it("a bare s 18 is the body provision, not the ACL", async () => {
    const text = (await run({ provision: "s 18" })).content[0].text
    expect(text).toContain("Meetings of Commission")
    expect(text).not.toContain("misleading or deceptive")
  })

  it("a Part reference returns the whole subtree, not just its heading", async () => {
    const text = (await run({ provision: "pt 2-1" })).content[0].text
    expect(text).toContain("whole part")
    // The Part heading alone would stop before its sections.
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("Application of this Part to information providers")
  })

  it("names the source anchor and the human page so the answer is checkable", async () => {
    const text = (await run({ provision: "sch 2 s 18" })).content[0].text
    expect(text).toContain("document_4/document_4.html#_Toc235543096")
    expect(text).toContain("https://www.legislation.gov.au/C2004A00109")
  })
})

describe("get_law_text applies the schedule its alias names", () => {
  // The flagship trap: the ACL *is* sch 2 of the CCA. Resolving the alias and
  // then fetching the body's s 18 answers a different question confidently.
  const byQuery = (input: Record<string, unknown>) =>
    getLawText(client(), { maxChars: 20000, ...input } as never)

  it('query "ACL" + "s 18" returns the ACL section, not CCA s 18', async () => {
    const text = (await byQuery({ query: "ACL", provision: "s 18" })).content[0].text
    expect(text).toContain("Provision: sch 2 s 18")
    expect(text).toContain("Misleading or deceptive conduct")
    expect(text).toContain("Schedule 2—The Australian Consumer Law")
    // "quorum" appears only in the body provision (18 Meetings of Commission).
    expect(text).not.toContain("quorum")
  })

  it("says it rewrote the reference, rather than silently answering another one", async () => {
    const text = (await byQuery({ query: "ACL", provision: "s 18" })).content[0].text
    expect(text).toContain('Read "s 18" as "sch 2 s 18"')
  })

  it("does not double-prefix a schedule the caller wrote out", async () => {
    const text = (await byQuery({ query: "ACL", provision: "sch 2 s 18" })).content[0].text
    expect(text).toContain("Provision: sch 2 s 18")
    expect(text).not.toContain("sch 2 sch 2")
    expect(text).toContain("Misleading or deceptive conduct")
  })

  it("leaves an alias that names no schedule alone", async () => {
    const text = (await byQuery({ query: "CCA", provision: "s 18" })).content[0].text
    expect(text).toContain("Provision: s 18")
    expect(text).toContain("Meetings of Commission")
    expect(text).not.toContain("Misleading or deceptive conduct")
  })

  it("scopes a structural reference to the schedule too", async () => {
    const text = (await byQuery({ query: "ACL", provision: "pt 2-1" })).content[0].text
    expect(text).toContain("Provision: sch 2 pt 2-1")
    expect(text).toContain("Misleading or deceptive conduct")
  })

  it("a miss inside the schedule says the reference was rewritten", async () => {
    const result = await byQuery({ query: "ACL", provision: "s 4242" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[LAW_NOT_FOUND]")
    expect(result.content[0].text).toContain('was looked up as "sch 2 s 4242"')
  })

  it("a registerId with no query is unaffected", async () => {
    const text = (await run({ provision: "s 18" })).content[0].text
    expect(text).toContain("Provision: s 18")
    expect(text).toContain("Meetings of Commission")
  })

  it("drops the schedule when the alias names a different Act than registerId resolved", async () => {
    // `registerId` decides the title; an alias for some *other* Act cannot
    // carry its schedule across. Live 2026-09-05
    // `{registerId:"C1914A00012", query:"ACL", provision:"s 18"}` looked
    // `sch 2 s 18` up in the Crimes Act 1914 and returned `[LAW_NOT_FOUND]` for
    // a section that exists — the schedule asserted of a title that has none.
    const crimes: FrlTitle = { id: "C1914A00012", name: "Crimes Act 1914", collection: "Act", status: "InForce" }
    const api = { ...client(), getTitle: async () => crimes } as unknown as AuApiClient
    const text = (
      await getLawText(api, { registerId: "C1914A00012", query: "ACL", provision: "s 18", maxChars: 20000 } as never)
    ).content[0].text
    expect(text).toContain("Provision: s 18")
    expect(text).not.toContain("sch 2 s 18")
    expect(text).not.toContain("names sch 2 of this Act")
  })
})

describe("get_law_text misses", () => {
  it("suggests the schedule prefix when a bare reference is not found", async () => {
    const result = await run({ provision: "s 4242" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[LAW_NOT_FOUND]")
    expect(result.content[0].text).toContain('"sch 2 s 18"')
  })

  it("rejects an unparsable reference without guessing at one", async () => {
    const result = await run({ provision: "the bit about advertising" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not a recognisable provision reference/i)
  })
})
