import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import { parseSectionRef } from "../lib/section-ref.js"
import type { FrlTitle } from "../lib/types.js"
import { impactMap, scanLabel, scanScope, searchPhrases } from "./impact-map.js"

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
  /** Override the Register's `@odata.count` — the recorded rows are unchanged. */
  instrumentCount?: number
  /** The Register answered and this Act really has no instruments under it. */
  noInstruments?: boolean
}

function client(options: Options = {}): AuApiClient {
  const failing = new Set(options.failing ?? [])
  const authorises = options.noInstruments
    ? { "@odata.count": 0, value: [] }
    : options.instrumentCount === undefined
      ? AUTHORISES
      : { ...AUTHORISES, "@odata.count": options.instrumentCount }
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
      return authorises
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

/** The Register's own in-force count for the CCA, as recorded: 146 against 10 fetched rows. */
const RECORDED_COUNT = AUTHORISES["@odata.count"] ?? 0
const RECORDED_ROWS = (AUTHORISES.value ?? []).length

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

  it("maps the ACL's s 18, not the body's, when the alias names a schedule", async () => {
    // Live 2026-09-05 this printed the alias note — which says in terms that
    // ACL s 18 is NOT CCA s 18 (meetings of Commission) — and then
    // `Provision: s 18 — "Meetings of Commission"` directly under it, and built
    // the whole map (citing judgments, enabling instruments, amendments) around
    // the body section. Printing the trap and then walking into it is worse
    // than not printing it, because the note reads as though it was applied.
    const text = await run({ lawName: "ACL", provision: "s 18" })
    expect(text).toContain('Provision: sch 2 s 18 — "Misleading or deceptive conduct"')
    expect(text).not.toContain("Meetings of Commission")
    // Never silently: the caller asked about "s 18".
    expect(text).toContain('Read "s 18" as "sch 2 s 18"')
  })

  it("leaves an explicit schedule alone rather than double-prefixing it", async () => {
    const text = await run({ lawName: "ACL", provision: "sch 2 s 18" })
    expect(text).toContain('Provision: sch 2 s 18 — "Misleading or deceptive conduct"')
    expect(text).not.toContain("sch 2 sch 2")
  })

  it("lists the judgments that mention the provision, per source", async () => {
    const text = await run({ lawName: "CCA", provision: "s 18" })
    expect(text).toContain("▶ Judgments that may cite this provision")
    expect(text).toMatch(/NSW Caselaw: \d+ mention/)
    // The High Court listing matches ANY of the words, so its rows are candidates.
    expect(text).toMatch(/High Court of Australia: \d+ candidate row/)
    expect(text).toContain("NOT confirmed mentions")
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

// ── a capped scan must never read as a complete one ────────────────────────

describe("impact_map labels the instrument scan wherever a derived number appears", () => {
  // `enabledInstruments(..., {top: 40})` returns the Register's whole
  // `@odata.count` beside at most 40 rows. Live: the CCA has 146 instruments in
  // force, the Corporations Act 410, the Fair Work Act 43 — every one of them
  // over the window. Before the fix the header printed
  // "Legislative instruments in force under …: 146, of which 2 name s 172 as
  // the enabling provision", which reads as 2-of-146 when 106 were never
  // fetched, and the only caveat line was emitted in the one case that needs
  // it least (when the tally is zero).
  it("the recorded fixture really is the capped case", () => {
    expect(RECORDED_COUNT).toBeGreaterThan(RECORDED_ROWS)
  })

  /** Every line that quotes a number derived from the fetched window. */
  function derivedLines(text: string): string[] {
    return text
      .split("\n")
      .filter((line) => /name[s]? .* as the enabling provision|records .* as its enabling|Instruments under the Act/.test(line))
  }

  it("no derived line states its tally without saying what it was computed over", async () => {
    // The enumeration: whichever branch produced the line — the header's
    // "of which N", the "none of the N examined" caveat, or the mermaid node —
    // it has to carry the scope.
    for (const provision of ["s 172", "s 18", "sch 2 s 18"]) {
      const text = await run({ lawName: "CCA", provision })
      const lines = derivedLines(text)
      expect(lines.length, provision).toBeGreaterThan(0)
      for (const line of lines) expect(line, `${provision}: ${line}`).toMatch(/examined/)
    }
  })

  it("says how many were read, out of how many are in force", async () => {
    const text = await run({ lawName: "CCA", provision: "s 172" })
    expect(text).toContain(`of ${RECORDED_COUNT} in force — a capped scan`)
    expect(text).toContain(`Enabling-provision figures below cover only the ${RECORDED_ROWS} instrument(s) this call read`)
    expect(text).toContain(`the other ${RECORDED_COUNT - RECORDED_ROWS} were never fetched`)
    expect(text).toMatch(/a floor, not a total/)
    expect(text).toContain('get_enabled_instruments({registerId:"C2004A00109"})')
  })

  it("carries the scope into the mermaid node too", async () => {
    const text = await run({ lawName: "CCA", provision: "s 172" })
    expect(text).toContain(`Instruments under the Act: ${RECORDED_COUNT} (${RECORDED_ROWS} examined)`)
  })

  it("drops the caveat when the window really did cover everything", async () => {
    // Same recorded rows, with the Register's count set to the number of rows.
    const text = await run({ lawName: "CCA", provision: "s 172" }, { instrumentCount: RECORDED_ROWS })
    expect(text).toContain("(all of them)")
    expect(text).not.toMatch(/a capped scan/)
    expect(text).not.toMatch(/never fetched/)
    expect(text).toContain(`Instruments under the Act: ${RECORDED_ROWS}`)
    expect(text).not.toContain(`${RECORDED_ROWS} examined)`)
  })
})

describe("a scan that never ran is not a scan that found nothing", () => {
  // The same class as the capped scan, one branch further along: when the
  // instrument scan is skipped or fails upstream the graph node used to read
  // "Instruments under the Act: 0", which is the absence claim this server
  // exists not to make — and the prose two sections above says the opposite.
  it("says 'not read' in the graph when instruments were skipped", async () => {
    const text = await run({ lawName: "CCA", provision: "s 172", includeInstruments: false })
    expect(text).toContain("skipped (includeInstruments=false)")
    expect(text).toContain("Instruments under the Act: not read")
    expect(text).not.toContain("Instruments under the Act: 0")
  })

  it("says 'not read' in the graph when the instrument lookup failed upstream", async () => {
    const text = await run(
      { lawName: "CCA", provision: "s 172" },
      { instrumentsError: new LawApiError("frlApi upstream server error (503)", ErrorCodes.API_ERROR) },
    )
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("Instruments under the Act: not read")
    expect(text).not.toContain("Instruments under the Act: 0")
  })

  it("still prints a real zero as a zero", async () => {
    // The Register answered with an empty set: that IS an absence, and it must
    // not be blurred into "not read".
    const text = await run({ lawName: "CCA", provision: "s 172" }, { noInstruments: true })
    expect(text).toContain("Instruments under the Act: 0")
    expect(text).not.toContain("not read")
  })
})

describe("scanScope / scanLabel", () => {
  it("is capped exactly when fewer were read than exist", () => {
    expect(scanScope(146, 40).capped).toBe(true)
    expect(scanScope(40, 40).capped).toBe(false)
    // A Register count that lags the rows it returned is not a cap.
    expect(scanScope(3, 10).capped).toBe(false)
  })

  it("never describes a sample with a word that reads as the whole corpus", () => {
    expect(scanLabel(scanScope(146, 40))).toContain("capped scan")
    expect(scanLabel(scanScope(146, 40))).toContain("146")
    expect(scanLabel(scanScope(40, 40))).toContain("all of them")
  })
})
