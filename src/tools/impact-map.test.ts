import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import { parseSectionRef } from "../lib/section-ref.js"
import type { FrlTitle } from "../lib/types.js"
import { impactMap, searchPhrases } from "./impact-map.js"

const read = (name: string, base = "./__fixtures__/"): string =>
  readFileSync(new URL(`${base}${name}`, import.meta.url), "utf8")

const ENTRIES = parseNcx(read("cca-schedules.ncx"))
const ENDNOTE = read("cca-endnote-amendments.html")
const AUTHORISES = JSON.parse(read("frl-authorises-cca.json")) as { "@odata.count"?: number; value?: unknown[] }
const NSW_SEARCH = read("nsw-search-negligence.html", "../lib/sources/__fixtures__/")
const QLD_SEARCH = read("qld-search-negligence.html", "../lib/sources/__fixtures__/")
const HCA_LIST = read("hca-search-native-title.html", "../lib/sources/__fixtures__/")

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
}

interface Options {
  failing?: string[]
  instrumentsError?: Error
  tocError?: Error
}

function client(options: Options = {}): AuApiClient {
  const failing = new Set(options.failing ?? [])
  return {
    searchTitles: async (p: { text?: string }) => {
      const text = (p.text ?? "").toLowerCase()
      if (text.includes("competition and consumer")) return { count: 1, titles: [CCA] }
      return { count: 0, titles: [] }
    },
    getTitle: async () => CCA,
    getToc: async () => {
      if (options.tocError) throw options.tocError
      return ENTRIES
    },
    getVolumeHtml: async () => ENDNOTE,
    fetchJson: async () => {
      if (options.instrumentsError) throw options.instrumentsError
      return AUTHORISES
    },
    fetchHtml: async (host: string) => {
      if (failing.has(host)) throw new LawApiError(`${host} upstream server error (503)`, ErrorCodes.API_ERROR)
      if (host === "nswCaselaw") return NSW_SEARCH
      if (host === "qldJudgments") return QLD_SEARCH
      if (host === "hcourt") return HCA_LIST
      throw new LawApiError(`no fixture for ${host}`, ErrorCodes.API_ERROR)
    },
  } as unknown as AuApiClient
}

async function run(
  input: { lawName: string; provision: string; includeInstruments?: boolean; includeMermaid?: boolean },
  options?: Options,
): Promise<string> {
  const result = await impactMap(client(options), {
    includeInstruments: true,
    includeMermaid: true,
    ...input,
  } as never)
  return result.content[0].text
}

beforeEach(() => lawCache.clear())

describe("searchPhrases", () => {
  it("searches the title without its year, plus a short alias", () => {
    const ref = parseSectionRef("s 18")!
    const phrases = searchPhrases(CCA, ref)
    expect(phrases[0]).toBe("Competition and Consumer Act s 18")
    expect(phrases.length).toBeLessThanOrEqual(2)
  })

  it("keeps the schedule prefix, because sch 2 s 18 is a different provision", () => {
    const ref = parseSectionRef("sch 2 s 18")!
    expect(searchPhrases(CCA, ref)[0]).toContain("sch 2 s 18")
  })
})

describe("impact_map", () => {
  it("rejects an unparseable provision instead of searching for nothing", async () => {
    const result = await impactMap(client(), { lawName: "CCA", provision: "the bit about ads", includeInstruments: true, includeMermaid: true } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[INVALID_PARAMETER]")
  })

  it("resolves the body section and prints its real heading", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain('Provision: s 18 — "Meetings of Commission"')
  })

  it("resolves the schedule provision separately from the body one", async () => {
    const text = await run({ lawName: "CCA", provision: "sch 2 s 18" })
    expect(text).toContain('Provision: sch 2 s 18 — "Misleading or deceptive conduct"')
  })

  it("lists the judgments that mention the provision, per source", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain("▶ Judgments mentioning this provision")
    expect(text).toMatch(/NSW Caselaw: \d+ mention/)
    expect(text).toMatch(/High Court of Australia: \d+ mention/)
  })

  it("never reads a failed search as an absence of cases", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" }, { failing: ["nswCaselaw", "qldJudgments", "hcourt"] })
    expect(text).toContain("SEARCH FAILED")
    expect(text).toContain("this is not evidence of absence")
  })

  it("lists the instruments made under the Act and flags the enabling provision", async () => {
    const text = await run({ lawName: "CCA", provision: "s 172" })
    expect(text).toContain("▶ Legislative instruments in force under Competition and Consumer Act 2010")
    expect(text).toContain("made under s 172")
  })

  it("says so when the instruments call fails rather than reporting none", async () => {
    const text = await run(
      { lawName: "CCA", provision: "s 18" },
      { instrumentsError: new LawApiError("frlApi upstream server error (503)", ErrorCodes.API_ERROR) },
    )
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("not a finding that there are none")
  })

  it("honours includeInstruments=false", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18", includeInstruments: false })
    expect(text).toContain("skipped (includeInstruments=false)")
  })

  it("shows the state counterparts with their caution", async () => {
    const text = await run({ lawName: "Competition and Consumer Act", provision: "sch 2 s 18" })
    expect(text).toContain("Australian Consumer Law")
    expect(text).toContain("APPLY the same text")
  })

  it("lists the provision's amendment rows from the endnotes", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain("▶ Amendments to s 18")
    expect(text).toContain("No 159, 2007")
  })

  it("keeps the ACL's amendment history apart from the body section's", async () => {
    const text = await run({ lawName: "CCA", provision: "sch 2 s 18" })
    expect(text).toContain("s 18 (Schedule 2): ad (added or inserted) by No 103, 2010")
    expect(text).not.toContain("No 17, 1986")
  })

  it("emits a bounded mermaid graph when asked", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain("```mermaid")
    expect(text).toContain("graph TD")
    expect((text.match(/^\s{2}[A-Z]\w*\["/gm) ?? []).length).toBeLessThanOrEqual(18)
  })

  it("omits the graph when includeMermaid=false", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18", includeMermaid: false })
    expect(text).not.toContain("```mermaid")
  })

  it("warns that these are mention counts, not treatment counts", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain("MENTION counts, not treatment counts")
  })

  it("says the map may be about nothing when the provision is not in the table of contents", async () => {
    const text = await run({ lawName: "CCA", provision: "s 4242" })
    expect(text).toContain("Provision heading unavailable")
  })
})
