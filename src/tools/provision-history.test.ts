import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import { parseSectionRef } from "../lib/section-ref.js"
import type { FrlTitle } from "../lib/types.js"
import { getProvisionHistory } from "./provision-history.js"
import { entriesForRef, parseAmendmentHistory } from "./statute-helpers/endnotes.js"

const ENDNOTE_HTML = readFileSync(new URL("./__fixtures__/cca-endnote-amendments.html", import.meta.url), "utf8")
const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }

const ACTS: Record<string, FrlTitle> = {
  "2010/103": { id: "C2010A00103", name: "Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010", year: 2010, number: 103 },
  "2007/159": { id: "C2007A00159", name: "Corporations (NZ Closer Economic Relations) and Other Legislation Amendment Act 2007", year: 2007, number: 159 },
}

function client(opts: { html?: string; entries?: typeof ENTRIES } = {}): AuApiClient {
  return {
    getTitle: async () => CCA,
    getToc: async () => opts.entries ?? ENTRIES,
    getVolumeHtml: async () => opts.html ?? ENDNOTE_HTML,
    searchTitles: async (p: { filter?: string }) => {
      const match = /year eq (\d+) and number eq (\d+)/.exec(p.filter ?? "")
      const hit = match ? ACTS[`${match[1]}/${match[2]}`] : undefined
      return { count: hit ? 1 : 0, titles: hit ? [hit] : [] }
    },
  } as unknown as AuApiClient
}

const run = (input: Record<string, unknown>, c = client()) =>
  getProvisionHistory(c, { registerId: "C2004A00109", resolveActs: false, ...input } as never)

beforeEach(() => lawCache.clear())

describe("endnote amendment-history parser", () => {
  const rows = parseAmendmentHistory(ENDNOTE_HTML)

  it("reads dotted rows as provisions and the lines under them as effects", () => {
    const s18 = rows.filter((row) => row.provision === "s 18")
    expect(s18.length).toBeGreaterThanOrEqual(2)
    expect(s18[0].effects[0].code).toBe("am")
    expect(s18[0].effects[0].meaning).toBe("amended")
  })

  it("tracks schedule scope, so the ACL's s 18 and the body's s 18 stay apart", () => {
    const body = entriesForRef(rows, parseSectionRef("s 18")!)
    const acl = entriesForRef(rows, parseSectionRef("sch 2 s 18")!)
    expect(body).toHaveLength(1)
    expect(acl).toHaveLength(1)
    expect(body[0].schedule).toBeUndefined()
    expect(acl[0].schedule).toBe("2")
    expect(body[0].effects[0].code).toBe("am")
    expect(acl[0].effects[0].code).toBe("ad")
  })

  it("parses every Act citation on a multi-Act line", () => {
    const body = entriesForRef(rows, parseSectionRef("s 18")!)[0]
    expect(body.effects[0].acts.map((act) => act.raw)).toEqual(["No 17, 1986", "No 88, 1995", "No 159, 2007"])
  })

  it("keeps the raw line so nothing is lost to the parser's judgement", () => {
    const body = entriesForRef(rows, parseSectionRef("s 18")!)[0]
    expect(body.effects[0].raw).toContain("am No 17, 1986;")
  })
})

describe("get_provision_history", () => {
  it("gives different answers for sch 2 s 18 and s 18", async () => {
    const acl = (await run({ provision: "sch 2 s 18" })).content[0].text
    const body = (await run({ provision: "s 18" })).content[0].text
    expect(acl).toContain("ad (added or inserted)")
    expect(acl).toContain("No 103, 2010")
    expect(body).toContain("am (amended)")
    expect(body).toContain("No 17, 1986")
    expect(body).not.toContain("No 103, 2010")
  })

  it("resolves the cited Acts to register ids when asked", async () => {
    const text = (await run({ provision: "sch 2 s 18", resolveActs: true })).content[0].text
    expect(text).toContain("Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010 [C2010A00103]")
  })

  it("still prints a citation it could not resolve", async () => {
    const text = (await run({ provision: "s 18", resolveActs: true })).content[0].text
    expect(text).toContain("No 17, 1986 — register id not resolved")
    expect(text).toContain("Corporations (NZ Closer Economic Relations)") // the one that did resolve
  })

  it("explains the endnote abbreviation codes rather than emitting bare 'am'", async () => {
    const text = (await run({ provision: "s 18" })).content[0].text
    expect(text).toContain("ad = added/inserted")
    expect(text).toContain("rs = repealed and substituted")
  })

  it("says an absent row usually means never amended, and how to confirm", async () => {
    const text = (await run({ provision: "s 4242" })).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("never been amended")
    expect(text).toContain("get_law_text")
  })

  it("does not claim absence when the compilation carries no endnote at all", async () => {
    const noEndnote = ENTRIES.filter((entry) => !/amendment history/i.test(entry.label))
    const text = (await run({ provision: "s 18" }, client({ entries: noEndnote }))).content[0].text
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("Not a finding that the provision was never amended")
    expect(text).toContain("search_historical_law")
  })
})
