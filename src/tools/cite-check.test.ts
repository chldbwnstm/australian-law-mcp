import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { lawCache } from "../lib/cache.js"
import { ErrorCodes, LawApiError } from "../lib/errors.js"
import { parseNcx } from "../lib/ncx-parser.js"
import type { FrlTitle } from "../lib/types.js"
import { citeCheck } from "./cite-check.js"

const read = (name: string, base = "../lib/sources/__fixtures__/"): string =>
  readFileSync(new URL(`${base}${name}`, import.meta.url), "utf8")

const NSW_MNC = read("nsw-mnc-lookup.html")
const NSW_SEARCH = read("nsw-search-negligence.html")
const QLD_SEARCH = read("qld-search-negligence.html")
const HCA_LIST = read("hca-search-native-title.html")
const HCA_DETAIL = read("hca-detail-potter.html")
const OVERRULING = read("nsw-decision-overruling.html", "./__fixtures__/")
const ENTRIES = parseNcx(read("cca-schedules.ncx", "./__fixtures__/"))
const ENDNOTE = read("cca-endnote-amendments.html", "./__fixtures__/")

const CCA: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
}

interface Options {
  /** Hosts whose requests should fail, to exercise the incomplete-back-trace paths. */
  failing?: string[]
  /** NSW simple-search body — defaults to a fixture with hits. */
  nswSearch?: string
  /** NSW exact medium-neutral lookup body. */
  nswMnc?: string
  decision?: string
  /** Make the compilation volume read fail, to exercise the unread-endnote path. */
  volumeError?: string
}

function client(options: Options = {}): AuApiClient {
  const failing = new Set(options.failing ?? [])
  return {
    searchTitles: async (p: { text?: string; filter?: string }) => {
      const text = `${p.text ?? ""}${p.filter ?? ""}`.toLowerCase()
      if (text.includes("competition and consumer") || text.includes("number eq")) return { count: 1, titles: [CCA] }
      return { count: 0, titles: [] }
    },
    getTitle: async () => CCA,
    getToc: async () => ENTRIES,
    getVolumeHtml: async () => {
      if (options.volumeError) throw new LawApiError(options.volumeError, ErrorCodes.API_ERROR)
      return ENDNOTE
    },
    fetchHtml: async (host: string, path: string) => {
      if (failing.has(host)) throw new LawApiError(`${host} upstream server error (503)`, ErrorCodes.API_ERROR)
      if (host === "nswCaselaw" && path.startsWith("search/advanced")) return options.nswMnc ?? NSW_MNC
      if (host === "nswCaselaw" && path.startsWith("decision/")) return options.decision ?? OVERRULING
      if (host === "nswCaselaw") return options.nswSearch ?? NSW_SEARCH
      if (host === "qldJudgments") return QLD_SEARCH
      if (host === "hcourt") return path.includes("judgments-1998-current/") ? HCA_DETAIL : HCA_LIST
      throw new LawApiError(`no fixture for ${host}`, ErrorCodes.API_ERROR)
    },
  } as unknown as AuApiClient
}

async function run(caseNumber: string, options?: Options, extra?: Partial<{ deepScan: boolean; display: number }>): Promise<string> {
  const result = await citeCheck(client(options), {
    caseNumber,
    display: extra?.display ?? 20,
    deepScan: extra?.deepScan ?? true,
  } as never)
  return result.content[0].text
}

beforeEach(() => lawCache.clear())

describe("cite_check — input", () => {
  it("pulls the citation out of a sentence", async () => {
    const text = await run("Is Dela Cruz v R [2010] NSWCCA 333 still good law?")
    expect(text).toContain("Citation check — [2010] NSWCCA 333")
  })

  it("refuses to invent a citation it cannot read", async () => {
    const result = await citeCheck(client(), { caseNumber: "the leading authority", display: 20, deepScan: true } as never)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("[NOT_FOUND]")
  })

  it("sends a reported-only citation to LawCite instead of guessing", async () => {
    const text = await run("Mabo v Queensland (No 2) (1992) 175 CLR 1")
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("lawcite")
  })
})

describe("cite_check — verdicts", () => {
  it("reports overruled_candidate when a later judgment overrules the case", async () => {
    // hcourt failing keeps NSW appellate judgments at the head of the scan
    // queue, and exercises the "one source failed" path at the same time.
    const text = await run("[2010] NSWCCA 333", { failing: ["hcourt"] })
    expect(text).toContain("▶ Verdict: overruled_candidate")
    expect(text).toContain("🚨")
    expect(text).toContain("OVERRULING")
  })

  it("flags the dissent in the passage rather than presenting it as the Court's view", async () => {
    const text = await run("[2010] NSWCCA 333", { failing: ["hcourt"] })
    expect(text).toContain("dissent language in the same passage")
  })

  it("falls back to cited when the deep scan is turned off", async () => {
    // NSW Caselaw's search matches the phrase, so its rows are mentions even
    // with no scan to confirm them.
    const text = await run("[2010] NSWCCA 333", {}, { deepScan: false })
    expect(text).toContain("▶ Verdict: cited")
    expect(text).toContain("Treatment scan: skipped")
  })

  it("does not manufacture citing cases out of the High Court's any-word search", async () => {
    // Live 2026-09-05, `[2019] HCA 99` — a citation the Court's own complete
    // 2019 list does not contain, and which this tool marks ✗ two lines above —
    // came back "Verdict: cited — later judgments mention this case" over
    // twelve real, unrelated judgments. hcourt.gov.au's `keywords` matches ANY
    // of the words, so "[2019] HCA 99" matches anything containing 2019, HCA or
    // 99. Manufactured corroboration for an invented citation is the single
    // worst answer this server can give.
    // Only the High Court answers, so every row in hand is a candidate.
    const text = await run(
      "[2019] HCA 99",
      { failing: ["nswCaselaw", "qldJudgments"], nswMnc: NSW_MNC.replace(/Displaying 1 - 1 of 1/g, "Displaying 0 - 0 of 0") },
      { deepScan: false },
    )
    expect(text).not.toContain("▶ Verdict: cited")
    expect(text).toContain("▶ Verdict: unverified_treatment")
    expect(text).toContain("candidate row(s)")
    expect(text).toContain("NOT confirmed mentions")
  })

  it("labels the High Court rows as candidates rather than mentions", async () => {
    const text = await run("[2010] NSWCCA 333")
    expect(text).toMatch(/High Court of Australia: \d+ candidate row/)
    expect(text).toContain("matches ANY of the words")
  })

  it("does not claim not_found while a source is failing", async () => {
    const text = await run("[2010] NSWCCA 9999", {
      failing: ["qldJudgments"],
      nswMnc: NSW_MNC.replace(/Displaying 1 - 1 of 1/g, "Displaying 0 - 0 of 0"),
      nswSearch: NSW_SEARCH.replace(/Displaying[^<]*/g, "Displaying 0 - 0 of 0 results"),
    })
    expect(text).not.toContain("Verdict: not_found")
    expect(text).toContain("SEARCH FAILED")
    expect(text).toContain("Absence here means nothing")
  })

  it("never lets a blocked or failed source read as absence of citing cases", async () => {
    const text = await run("[2010] NSWCCA 333", { failing: ["nswCaselaw", "qldJudgments", "hcourt"] })
    expect(text).toContain("SEARCH FAILED")
    expect(text).toContain("this is not evidence of no citation")
    expect(text).not.toContain("Verdict: not_found")
  })
})

describe("cite_check — legislative override", () => {
  it("checks the provision named alongside the case", async () => {
    const text = await run("Is [2010] NSWCCA 333 on s 18 of the Competition and Consumer Act 2010 (Cth) still good law?", {
      failing: ["nswCaselaw", "qldJudgments", "hcourt"],
    })
    expect(text).toContain("▶ Legislative override")
    expect(text).toContain("Competition and Consumer Act 2010")
  })

  it("says the check was skipped when no provision was named", async () => {
    const text = await run("[2010] NSWCCA 333")
    expect(text).toContain("Legislative override: not checked")
    expect(text).toContain("no provision was named")
  })

  it("does not turn an unread endnote table into 'no amending Act'", async () => {
    // The volume the endnote lives in never arrived, so the table shows
    // nothing — least of all that s 18 has never been amended.
    const text = await run("Is [2010] NSWCCA 333 on s 18 of the Competition and Consumer Act 2010 (Cth) still good law?", {
      failing: ["nswCaselaw", "qldJudgments", "hcourt"],
      volumeError: "frlDocs upstream server error (503)",
    })
    expect(text).not.toContain("shows no amending Act")
    expect(text).toContain("Legislative override: could not be checked")
    expect(text).toContain("[UPSTREAM_NO_DATA]")
    expect(text).toContain("frlDocs upstream server error (503)")
    expect(text).toContain("nothing here says the provision was never amended")
  })

  it("still reports a read-but-empty endnote result as no amending Act", async () => {
    // The table was read; no Act numbered that late appears against s 18. That
    // is a real observation and keeps its wording — and no error label.
    const text = await run("Is [2099] NSWCCA 1 on s 18 of the Competition and Consumer Act 2010 (Cth) still good law?", {
      failing: ["nswCaselaw", "qldJudgments", "hcourt"],
    })
    expect(text).toContain("shows no amending Act numbered 2099 or later")
    expect(text).not.toContain("[UPSTREAM_NO_DATA]")
  })

  it("explains that the endnote compares years, not commencement dates", async () => {
    const text = await run("[1985] NSWCCA 1 on s 18 of the Competition and Consumer Act 2010 (Cth)", {
      failing: ["nswCaselaw", "qldJudgments", "hcourt"],
    })
    expect(text).toContain("never by commencement date")
  })
})

describe("cite_check — honesty about the source", () => {
  it("always prints the LawCite link and the not-a-citator caveat", async () => {
    const text = await run("[2010] NSWCCA 333")
    expect(text).toContain("LawCite (free citation graph, browser only)")
    expect(text).toContain("not a Shepard's-style citator")
    expect(text).toContain("CaseBase")
  })

  it("lists the later citing cases so a human can finish the job", async () => {
    const text = await run("[2010] NSWCCA 333")
    expect(text).toContain("▶ Later cases that may cite [2010] NSWCCA 333")
    expect(text).toMatch(/NSW Caselaw: \d+ mention/)
  })

  it("warns that no signal is not the same as still good law", async () => {
    const text = await run("[2010] NSWCCA 333")
    expect(text).toContain('"No signal" is not "still good law"')
  })
})
