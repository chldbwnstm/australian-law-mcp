import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { normalizeFrlVersion, type AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import { legalAnalysis } from "./legal-analysis.js"

const read = (name: string, base = "./__fixtures__/"): string =>
  readFileSync(new URL(`${base}${name}`, import.meta.url), "utf8")

const ENTRIES = parseNcx(read("cca-schedules.ncx"))
const ENDNOTE = read("cca-endnote-amendments.html")
const AUTHORISES = JSON.parse(read("frl-authorises-cca.json")) as unknown
const VERSIONS = (JSON.parse(read("frl-versions-cca.json")) as { value: unknown[] }).value.map(normalizeFrlVersion)
const NSW_MNC = read("nsw-mnc-lookup.html", "../lib/sources/__fixtures__/")
const NSW_SEARCH = read("nsw-search-negligence.html", "../lib/sources/__fixtures__/")

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
}

function client(): AuApiClient {
  return {
    searchTitles: async (p: { text?: string; filter?: string }) => {
      const text = `${p.text ?? ""}${p.filter ?? ""}`.toLowerCase()
      if (text.includes("competition and consumer") || text.includes("number eq")) return { count: 1, titles: [CCA] }
      return { count: 0, titles: [] }
    },
    getTitle: async () => CCA,
    getToc: async () => ENTRIES,
    getVolumeHtml: async () => ENDNOTE,
    listVersions: async () => VERSIONS,
    findVersion: async () => VERSIONS[2],
    getProvision: async (_id: string, provision: string) => ({
      ref: provision,
      heading: "18  Meetings of Commission",
      text: "18 Meetings of Commission",
      volumeDoc: "document_1/document_1.html",
      breadcrumb: [],
    }),
    fetchJson: async () => AUTHORISES,
    fetchHtml: async (host: string, path: string) => {
      if (host === "nswCaselaw" && path.startsWith("search/advanced")) return NSW_MNC
      if (host === "nswCaselaw") return NSW_SEARCH
      throw new LawApiError(`${host} upstream server error (503)`, ErrorCodes.API_ERROR)
    },
  } as unknown as AuApiClient
}

const run = async (input: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
  const result = await legalAnalysis(client(), input as never)
  return { text: result.content[0].text, ...(result.isError !== undefined ? { isError: result.isError } : {}) }
}

beforeEach(() => lawCache.clear())

describe("legal_analysis — dispatch", () => {
  it("routes verify_citations", async () => {
    const { text } = await run({ mode: "verify_citations", text: "CCA s 18 prohibits misleading or deceptive conduct." })
    expect(text).toContain("✗ CONTENT_MISMATCH: CCA s 18")
  })

  it("routes cite_check", async () => {
    const { text } = await run({ mode: "cite_check", caseNumber: "[2010] NSWCCA 333", deepScan: false })
    expect(text).toContain("Citation check — [2010] NSWCCA 333")
  })

  it("routes applicable_law", async () => {
    const { text } = await run({ mode: "applicable_law", lawName: "CCA", date: "2026-07-15" })
    expect(text).toContain("Applicable law — Competition and Consumer Act 2010")
  })

  it("routes impact_map", async () => {
    const { text } = await run({ mode: "impact_map", lawName: "CCA", provision: "sch 2 s 18", includeMermaid: false })
    expect(text).toContain("Impact map — Competition and Consumer Act 2010 sch 2 s 18")
  })
})

describe("legal_analysis — tolerant aliasing", () => {
  it("accepts query in place of caseNumber for cite_check", async () => {
    const { text } = await run({ mode: "cite_check", query: "Is [2010] NSWCCA 333 still good law?", deepScan: false })
    expect(text).toContain("Citation check — [2010] NSWCCA 333")
  })

  it("accepts citation in place of caseNumber", async () => {
    const { text } = await run({ mode: "cite_check", citation: "[2010] NSWCCA 333", deepScan: false })
    expect(text).toContain("Citation check — [2010] NSWCCA 333")
  })

  it("accepts query and asAt for applicable_law", async () => {
    const { text } = await run({ mode: "applicable_law", query: "CCA", asAt: "15 July 2026" })
    expect(text).toContain("as at 2026-07-15")
  })

  it("accepts section in place of provision for impact_map", async () => {
    const { text } = await run({ mode: "impact_map", lawName: "CCA", section: "s 18", includeMermaid: false })
    expect(text).toContain("Impact map — Competition and Consumer Act 2010 s 18")
  })

  it("accepts registerId wherever a law name is taken", async () => {
    const { text } = await run({ mode: "impact_map", registerId: "C2004A00109", provision: "s 18", includeMermaid: false })
    expect(text).toContain("[C2004A00109]")
  })

  it("accepts query as the text for verify_citations", async () => {
    const { text } = await run({ mode: "verify_citations", query: "See ACL s 18." })
    expect(text).toContain("ACL")
  })
})

describe("legal_analysis — validation", () => {
  it("names the missing parameter and shows a working call for verify_citations", async () => {
    const { text, isError } = await run({ mode: "verify_citations" })
    expect(isError).toBe(true)
    expect(text).toContain("mode=verify_citations needs `text`")
    expect(text).toContain('legal_analysis({mode:"verify_citations"')
  })

  it("says which of the two applicable_law parameters is missing", async () => {
    const { text } = await run({ mode: "applicable_law", lawName: "CCA" })
    expect(text).toContain("(date is missing)")
    const other = await run({ mode: "applicable_law", date: "2020-01-01" })
    expect(other.text).toContain("(lawName is missing)")
  })

  it("says which of the two impact_map parameters is missing", async () => {
    const { text } = await run({ mode: "impact_map", lawName: "CCA" })
    expect(text).toContain("(provision is missing)")
  })

  it("rejects cite_check without a citation", async () => {
    const { text, isError } = await run({ mode: "cite_check" })
    expect(isError).toBe(true)
    expect(text).toContain("mode=cite_check needs `caseNumber`")
  })
})

describe("legal_analysis — cost options pass through", () => {
  it("passes deepScan=false to cite_check", async () => {
    const { text } = await run({ mode: "cite_check", caseNumber: "[2010] NSWCCA 333", deepScan: false })
    expect(text).toContain("Treatment scan: skipped")
  })

  it("passes includeInstruments=false to impact_map", async () => {
    const { text } = await run({
      mode: "impact_map",
      lawName: "CCA",
      provision: "s 18",
      includeInstruments: false,
      includeMermaid: false,
    })
    expect(text).toContain("skipped (includeInstruments=false)")
  })

  it("passes maxCitations to verify_citations", async () => {
    const { text } = await run({
      mode: "verify_citations",
      text: "Competition and Consumer Act 2010 (Cth) s 18, s 19, s 17A all matter.",
      maxCitations: 1,
    })
    expect(text).toContain("Statute citations: 1")
  })
})
