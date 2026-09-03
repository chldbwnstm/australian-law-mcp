import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import {
  getEnabledInstruments,
  getEnablingActs,
  getInstrumentProvisions,
  getStateEquivalents,
} from "./law-linkage.js"
import { findFamilies } from "./statute-helpers/state-equivalents.js"

const AUTHORISES = JSON.parse(readFileSync(new URL("./__fixtures__/frl-authorises-cca.json", import.meta.url), "utf8"))
const AUTHORISED_BY = JSON.parse(
  readFileSync(new URL("./__fixtures__/frl-authorisedby-ccr.json", import.meta.url), "utf8"),
) as { value: Array<FrlTitle & { authorisedBy: Array<Record<string, unknown>> }> }
const ENTRIES = parseNcx(readFileSync(new URL("./__fixtures__/cca-schedules.ncx", import.meta.url), "utf8"))

const CCA: FrlTitle = { id: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce", isPrincipal: true }
const CCR: FrlTitle = {
  id: "F1996B01420",
  name: "Competition and Consumer Regulations 2010",
  collection: "LegislativeInstrument",
  subCollection: "Regulations",
  status: "InForce",
  isPrincipal: true,
}

/** Routes the three FRL shapes this file needs by looking at the request path. */
function client(overrides: { search?: unknown; expand?: unknown; title?: FrlTitle; html?: string } = {}): AuApiClient {
  return {
    getTitle: async () => overrides.title ?? CCR,
    getToc: async () => ENTRIES,
    getVolumeHtml: async () => overrides.html ?? "<p>text</p>",
    getProvision: async () => ({
      ref: "reg 2.01",
      heading: "2.01 Interpretation",
      text: "2.01 Interpretation\nIn these Regulations…",
      volumeDoc: "document_1/document_1.html",
      breadcrumb: ["Part 1"],
    }),
    fetchJson: async (_host: string, path: string) => {
      if (path.includes("Search(criteria=")) {
        const decoded = decodeURIComponent(path)
        if (decoded.includes("authorisedby(")) return overrides.search ?? { "@odata.count": 1, value: [CCA] }
        return overrides.search ?? AUTHORISES
      }
      return overrides.expand ?? AUTHORISED_BY
    },
  } as unknown as AuApiClient
}

beforeEach(() => lawCache.clear())

describe("get_enabled_instruments", () => {
  it("lists instruments with ids and enabling provisions", async () => {
    const text = (
      await getEnabledInstruments(client({ title: CCA }), {
        registerId: "C2004A00109",
        includeRepealed: false,
        includeGazetteNotices: false,
        limit: 10,
      } as never)
    ).content[0].text
    expect(text).toContain("[F1996B00357]")
    expect(text).toContain("made under s 172")
    expect(text).toContain("146 on the Register")
  })

  it("says the name filter only saw one page", async () => {
    const text = (
      await getEnabledInstruments(client({ title: CCA }), {
        registerId: "C2004A00109",
        nameContains: "Consumer Data Right",
        includeRepealed: false,
        includeGazetteNotices: false,
        limit: 10,
      } as never)
    ).content[0].text
    expect(text).toContain("applied to this page only")
    expect(text).toContain("Consumer Data Right")
  })

  it("tells the caller to check for a principal Act when nothing is authorised", async () => {
    const text = (
      await getEnabledInstruments(client({ title: CCA, search: { "@odata.count": 0, value: [] } }), {
        registerId: "C2004A00109",
        includeRepealed: false,
        includeGazetteNotices: false,
        limit: 10,
      } as never)
    ).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("PRINCIPAL Act")
  })
})

describe("get_instrument_provisions", () => {
  it("outlines the instrument when no provision is given", async () => {
    const text = (
      await getInstrumentProvisions(client(), { registerId: "F1996B01420", depth: 2 } as never)
    ).content[0].text
    expect(text).toContain("Legislative Instrument (Regulations)")
    expect(text).toContain("Structure:")
    expect(text).toContain("get_enabling_acts")
  })

  it("returns a provision's text with its breadcrumb", async () => {
    const text = (
      await getInstrumentProvisions(client(), { registerId: "F1996B01420", provision: "s 18", depth: 2 } as never)
    ).content[0].text
    expect(text).toContain("2.01 Interpretation")
    expect(text).toContain("In: Part 1")
  })

  it("explains instrument numbering conventions when a reference misses", async () => {
    const text = (
      await getInstrumentProvisions(client(), { registerId: "F1996B01420", provision: "reg 99.99", depth: 2 } as never)
    ).content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("regulations use 'reg'")
  })
})

describe("get_enabling_acts", () => {
  it("reads the authoritative relation and names the enabling provision", async () => {
    const text = (
      await getEnablingActs(client(), { registerId: "F1996B01420", allowTextFallback: true } as never)
    ).content[0].text
    expect(text).toContain("authoritative")
    expect(text).toContain("Competition and Consumer Act 2010 [C2004A00109] — made under s 172")
    expect(text).toContain('provision:"s 172"')
  })

  it("falls back to the 'made under' recital only when the Register has no link, and labels it", async () => {
    const noLink = client({
      search: { "@odata.count": 0, value: [] },
      expand: { value: [{ id: "F1996B01420", name: "X", authorisedBy: [] }] },
      html: "<p>I, the Minister, make the following regulations under the Competition and Consumer Act 2010.</p>",
    })
    const text = (await getEnablingActs(noLink, { registerId: "F1996B01420", allowTextFallback: true } as never)).content[0].text
    expect(text).toContain("Heuristic fallback")
    expect(text).toContain("Competition and Consumer Act 2010")
    expect(text).toContain("NOT from the Register's authorisation data")
  })

  it("does not claim the instrument is unauthorised when neither source says anything", async () => {
    const nothing = client({
      search: { "@odata.count": 0, value: [] },
      expand: { value: [{ id: "F1996B01420", name: "X", authorisedBy: [] }] },
      html: "<p>Nothing useful here.</p>",
    })
    const text = (await getEnablingActs(nothing, { registerId: "F1996B01420", allowTextFallback: true } as never)).content[0].text
    expect(text).toContain("a gap in the record, not proof the")
  })
})

describe("get_state_equivalents", () => {
  it("maps the ACL onto every state application Act and says the text is identical", async () => {
    const text = (await getStateEquivalents(client(), { query: "Australian Consumer Law" } as never)).content[0].text
    expect(text).toContain("APPLIED")
    expect(text).toContain("Australian Consumer Law and Fair Trading Act 2012 (Vic)")
    expect(text).toContain("Fair Trading (Australian Consumer Law) Act 1992 (ACT)")
    expect(text).toContain("identical provision everywhere")
  })

  it("names the WHS non-adopter instead of leaving Victoria out", async () => {
    const text = (await getStateEquivalents(client(), { query: "WHS Act" } as never)).content[0].text
    expect(text).toContain("Occupational Health and Safety Act 2004 (Vic)")
    expect(text).toContain("DID NOT ADOPT")
    expect(text).toContain("Work Health and Safety Act 2020 (WA)")
  })

  it("warns that section numbers do not carry across non-UEA jurisdictions", async () => {
    const text = (await getStateEquivalents(client(), { query: "Evidence Act" } as never)).content[0].text
    expect(text).toContain("Evidence Act 1977 (Qld)")
    expect(text).toContain("citation error")
  })

  it("labels the criminal family as comparable, not equivalent", async () => {
    const text = (await getStateEquivalents(client(), { query: "Crimes Act" } as never)).content[0].text
    expect(text).toContain("COMPARABLE")
    expect(text).toContain("Never translate a section number across this family")
  })

  it("narrows to one jurisdiction on request", async () => {
    const text = (await getStateEquivalents(client(), { query: "Australian Consumer Law", jurisdiction: "Qld" } as never)).content[0].text
    expect(text).toContain("Fair Trading Act 1989 (Qld)")
    expect(text).not.toContain("Fair Trading Act 2010 (WA)")
  })

  it("says a miss is a gap in the table, not a finding about the law", async () => {
    const result = await getStateEquivalents(client(), { query: "Space Activities" } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("NOT a finding that no state equivalent exists")
  })

  it("matches families by fragment, longest match first", () => {
    expect(findFamilies("ACL")[0].key).toBe("acl")
    expect(findFamilies("defamation")[0].key).toBe("defamation")
    expect(findFamilies("zzzz")).toHaveLength(0)
  })
})
