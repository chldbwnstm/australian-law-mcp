import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle, FrlVersion } from "../lib/types.js"
import { applicableLaw } from "./applicable-law.js"

const read = (name: string): string => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")
const ENTRIES = parseNcx(read("cca-schedules.ncx"))
const ENDNOTE = read("cca-endnote-amendments.html")
const VERSIONS = (JSON.parse(read("frl-versions-cca.json")) as { value: unknown[] }).value.map(normalizeFrlVersion)

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  nameHistory: [
    { name: "Trade Practices Act 1974", start: "1974-08-24T00:00:00", affecterTitleId: null, affecterName: null },
    { name: "Competition and Consumer Act 2010", start: "2011-01-01T00:00:00", affecterTitleId: null, affecterName: null },
  ],
}

/**
 * `Versions/Find(titleId='C2004A00109',asAt=2010-12-31T00:00:00)`, re-verified
 * live on 2026-09-04: name "Trade Practices Act 1974", window 2010-12-18 →
 * 2011-01-01, registerId null. The name field is the whole point of the rename
 * handling, and the null registerId exercises the "compilation not registered"
 * wording at the same time.
 */
const TPA_VERSION: FrlVersion = {
  titleId: "C2004A00109",
  start: "2010-12-18T00:00:00",
  end: "2011-01-01T00:00:00",
  isCurrent: false,
  isLatest: false,
  name: "Trade Practices Act 1974",
  status: "InForce",
  registerId: null,
}

interface Options {
  title?: FrlTitle
  versions?: FrlVersion[]
  findVersion?: (asAt: string) => FrlVersion | undefined
  provisionThen?: string | Error
  provisionNow?: string | Error
}

const DEFAULT_THEN = "52 Misleading or deceptive conduct\n(1) A corporation shall not, in trade or commerce, engage in conduct that is misleading or deceptive."
const DEFAULT_NOW = "18 Meetings of Commission\n(1) The Chairperson may convene such meetings as the Chairperson thinks necessary."

function client(options: Options = {}): AuApiClient {
  const title = options.title ?? CCA
  return {
    searchTitles: async (p: { text?: string; filter?: string }) => {
      const text = `${p.text ?? ""}${p.filter ?? ""}`.toLowerCase()
      if (text.includes("competition and consumer") || text.includes("trade practices") || text.includes("number eq")) {
        return { count: 1, titles: [title] }
      }
      return { count: 0, titles: [] }
    },
    getTitle: async () => title,
    listVersions: async () => options.versions ?? VERSIONS,
    findVersion: async (p: { asAt?: string }) => {
      const found = options.findVersion ? options.findVersion(p.asAt ?? "") : TPA_VERSION
      if (!found) throw new LawApiError("frlApi returned 404", ErrorCodes.NOT_FOUND)
      return found
    },
    getToc: async () => ENTRIES,
    getVolumeHtml: async () => ENDNOTE,
    getProvision: async (_id: string, provision: string, date?: string) => {
      const value = date === undefined ? (options.provisionNow ?? DEFAULT_NOW) : (options.provisionThen ?? DEFAULT_THEN)
      if (value instanceof Error) throw value
      return { ref: provision, heading: "", text: value, volumeDoc: "document_1/document_1.html", breadcrumb: [] }
    },
  } as unknown as AuApiClient
}

async function run(input: { lawName: string; date: string; provision?: string }, options?: Options): Promise<string> {
  const result = await applicableLaw(client(options), input as never)
  return result.content[0].text
}

beforeEach(() => lawCache.clear())

describe("applicable_law — the version in force", () => {
  it("reports the name the Act bore on that date, and calls the change a rename", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15" })
    expect(text).toContain('On that date this law was titled "Trade Practices Act 1974"')
    expect(text).toContain("NOT repealed and replaced")
    expect(text).toContain('Cite it as "Trade Practices Act 1974" for conduct on 2010-12-15')
  })

  it("accepts an English date phrase", async () => {
    const text = await run({ lawName: "CCA", date: "15 December 2010" })
    expect(text).toContain("as at 2010-12-15")
  })

  it("rejects a date it cannot read rather than guessing one", async () => {
    const result = await applicableLaw(client(), { lawName: "CCA", date: "whenever" } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("could not be read as a date")
  })

  it("points at the as-made text when the date precedes every compilation", async () => {
    const text = await run({ lawName: "CCA", date: "1975-01-01" }, { findVersion: () => undefined })
    expect(text).toContain("as made")
    expect(text).toContain('date:"asmade"')
    expect(text).toContain("do not report the Act as non-existent on that date")
  })
})

describe("applicable_law — repeal", () => {
  const repealed: FrlTitle = {
    ...CCA,
    status: "Repealed",
    statusHistory: [
      {
        status: "Repealed",
        start: "2020-06-01T00:00:00",
        reasons: [
          {
            affect: "Repeal",
            affectedByTitle: {
              titleId: "C2020A00001",
              name: "Repealing Act 2020",
              provisions: "sch 1 item 1",
              year: 2020,
              number: 1,
              seriesType: "Act",
            },
          },
        ],
      },
    ],
  }

  it("says an Act repealed later still governed the earlier date", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15" }, { title: repealed })
    expect(text).toContain("still in force on 2010-12-15")
    expect(text).toContain("Repealing Act 2020")
  })

  it("names the repealing Act and its successor role when the repeal had already happened", async () => {
    const text = await run(
      { lawName: "CCA", date: "2021-03-01" },
      { title: repealed, findVersion: () => ({ ...TPA_VERSION, name: "Competition and Consumer Act 2010" }) },
    )
    expect(text).toContain("was already repealed on 2021-03-01")
    expect(text).toContain("repealed law often continues to govern events")
  })
})

describe("applicable_law — unincorporated amendments", () => {
  it("keeps 'in force now' and 'latest registered' apart", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15" })
    expect(text).toContain("is NOT the latest registered one")
    expect(text).toContain("already behind the law in force")
  })
})

describe("applicable_law — the provision", () => {
  it("diffs the point-in-time text against today", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15", provision: "s 52" })
    expect(text).toContain("▶ s 52 as at 2010-12-15")
    expect(text).toContain("Compared with today: CHANGED")
    expect(text).toContain("Cite the 2010-12-15 wording")
  })

  it("says so plainly when the wording has not changed", async () => {
    const text = await run(
      { lawName: "CCA", date: "2010-12-15", provision: "s 18" },
      { provisionThen: DEFAULT_NOW, provisionNow: DEFAULT_NOW },
    )
    expect(text).toContain("identical wording")
  })

  it("does not let an unreadable provision look like a repealed one", async () => {
    const text = await run(
      { lawName: "CCA", date: "2010-12-15", provision: "s 52" },
      { provisionThen: new LawApiError("frlDocs upstream server error (503)", ErrorCodes.API_ERROR) },
    )
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("the two look the same from here")
    expect(text).toContain("Do not guess the wording")
  })

  it("lists the amendments since the date, with the year caveat", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15", provision: "s 19" })
    expect(text).toContain("▶ Amendments to s 19 since 2010-12-15")
    expect(text).toContain("No 63, 2019")
    expect(text).toContain("never by commencement date")
  })

  it("reports a provision with no amendments since the date without inventing one", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15", provision: "s 18" })
    expect(text).toContain("No amending Act numbered 2010 or later appears against s 18")
  })

  it("surfaces the amending Acts' application and transitional headings without interpreting them", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15", provision: "s 19" })
    expect(text).toContain("▶ Application / saving / transitional provisions")
    expect(text).toMatch(/Application|transitional/)
    expect(text).toContain("a pointer, not a finding")
  })

  it("prompts for a provision when none was given rather than diffing the whole Act", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15" })
    expect(text).toContain("Add `provision`")
  })
})

describe("applicable_law — closing warning", () => {
  it("refuses to decide which law governs the facts", async () => {
    const text = await run({ lawName: "CCA", date: "2010-12-15" })
    expect(text).toContain("NOT interpreted here")
  })
})
