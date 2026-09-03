import { describe, expect, it } from "vitest"
import {
  LAW_ALIAS_ENTRIES,
  aliasesFor,
  hasRelatedHit,
  normaliseAliasKey,
  resolveLawAlias,
} from "./law-alias.js"

const officials = (query: string) => resolveLawAlias(query).candidates.map((c) => c.official)

describe("unambiguous Commonwealth aliases", () => {
  const cases: Array<[alias: string, official: string, titleId?: string]> = [
    ["CCA", "Competition and Consumer Act 2010", "C2004A00109"],
    ["cca", "Competition and Consumer Act 2010", "C2004A00109"],
    ["TPA", "Competition and Consumer Act 2010", "C2004A00109"],
    ["Trade Practices Act", "Competition and Consumer Act 2010", "C2004A00109"],
    ["FW Act", "Fair Work Act 2009", "C2009A00028"],
    ["fwact", "Fair Work Act 2009", "C2009A00028"],
    ["Corps Act", "Corporations Act 2001", "C2004A00818"],
    ["ASIC Act", "Australian Securities and Investments Commission Act 2001", "C2004A00819"],
    ["AIA", "Acts Interpretation Act 1901", "C1901A00002"],
    ["LA 2003", "Legislation Act 2003", "C2004A01224"],
    ["ART Act", "Administrative Review Tribunal Act 2024", "C2024A00040"],
    ["ITAA 1997", "Income Tax Assessment Act 1997", "C2004A05138"],
    ["GST Act", "A New Tax System (Goods and Services Tax) Act 1999", "C2004A00446"],
    ["EPBC Act", "Environment Protection and Biodiversity Conservation Act 1999", "C2004A00485"],
    ["PGPA Act", "Public Governance, Performance and Accountability Act 2013", "C2013A00123"],
  ]

  for (const [alias, official, titleId] of cases) {
    it(`resolves ${alias}`, () => {
      const resolution = resolveLawAlias(alias)
      expect(resolution.candidates[0]?.official).toBe(official)
      expect(resolution.candidates[0]?.jurisdiction).toBe("Cth")
      if (titleId) expect(resolution.candidates[0]?.titleId).toBe(titleId)
      expect(resolution.needsJurisdiction).toBe(false)
      expect(resolution.searchText).toBe(official)
    })
  }
})

// TPA and CCA are one title id and one Act. Treating the rename as a repeal
// is the trap the research report calls out by name.
describe("TPA/CCA is a rename, not a repeal", () => {
  it("maps both names to the same title id", () => {
    expect(resolveLawAlias("TPA").candidates[0].titleId).toBe(
      resolveLawAlias("CCA").candidates[0].titleId,
    )
  })

  it("says so in the notes", () => {
    expect(resolveLawAlias("TPA").candidates[0].notes).toMatch(/rename, not a repeal/i)
  })
})

// ACL s 18 is misleading or deceptive conduct; CCA s 18 is meetings of the
// Commission. The schedule is the whole difference.
describe("ACL is a schedule of the CCA", () => {
  it("carries sch 2 and the same title id", () => {
    const acl = resolveLawAlias("ACL").candidates[0]
    expect(acl.titleId).toBe("C2004A00109")
    expect(acl.sch).toBe("2")
  })

  it("warns about the s 18 collision in the notes", () => {
    expect(resolveLawAlias("ACL").candidates[0].notes).toMatch(/s 18/)
  })

  it("does not attach a schedule to the CCA alias itself", () => {
    expect(resolveLawAlias("CCA").candidates[0].sch).toBeUndefined()
  })
})

describe("ambiguous bare names need a jurisdiction", () => {
  it("returns every Crimes Act rather than picking one", () => {
    const resolution = resolveLawAlias("Crimes Act")
    expect(resolution.needsJurisdiction).toBe(true)
    expect(resolution.candidates.length).toBeGreaterThan(2)
    expect(resolution.candidates.map((c) => c.jurisdiction)).toEqual(
      expect.arrayContaining(["NSW", "Vic", "Cth"]),
    )
    expect(resolution.candidates.every((c) => c.needsJurisdiction)).toBe(true)
  })

  it("does not fabricate a searchText when the jurisdiction is unknown", () => {
    expect(resolveLawAlias("Crimes Act").searchText).toBe("Crimes Act")
  })

  it("returns every Evidence Act, uniform and non-uniform", () => {
    const resolution = resolveLawAlias("Evidence Act")
    expect(resolution.needsJurisdiction).toBe(true)
    const jurisdictions = resolution.candidates.map((c) => c.jurisdiction)
    for (const value of ["Cth", "NSW", "Vic", "Tas", "ACT", "NT", "Qld", "WA", "SA"]) {
      expect(jurisdictions, value).toContain(value)
    }
  })

  it("flags the non-uniform evidence jurisdictions", () => {
    const resolution = resolveLawAlias("Evidence Act")
    for (const jurisdiction of ["Qld", "WA", "SA"] as const) {
      const entry = resolution.candidates.find((c) => c.jurisdiction === jurisdiction)!
      expect(entry.notes, jurisdiction).toMatch(/[Nn]ot a uniform evidence jurisdiction/)
    }
  })

  it("returns every Civil Liability Act, including Victoria's differently named one", () => {
    const resolution = resolveLawAlias("Civil Liability Act")
    expect(resolution.needsJurisdiction).toBe(true)
    expect(officials("Civil Liability Act")).toContain("Wrongs Act 1958")
  })

  it("narrows once a jurisdiction is written in the query", () => {
    const nsw = resolveLawAlias("Crimes Act (NSW)")
    expect(nsw.needsJurisdiction).toBe(false)
    expect(nsw.jurisdiction).toBe("NSW")
    expect(nsw.candidates).toHaveLength(1)
    expect(nsw.candidates[0].official).toBe("Crimes Act 1900")
    expect(nsw.searchText).toBe("Crimes Act 1900")

    expect(resolveLawAlias("Crimes Act (Vic)").candidates[0].official).toBe("Crimes Act 1958")
    expect(resolveLawAlias("Evidence Act (Qld)").candidates[0].official).toBe("Evidence Act 1977")
  })

  it("keeps the Commonwealth Act when the stated jurisdiction has no entry", () => {
    // `CCA (NSW)` is a user error, but the useful answer is the Cth CCA, not
    // silence — an empty candidate list would read as "no such Act".
    const resolution = resolveLawAlias("CCA (NSW)")
    expect(resolution.candidates[0].official).toBe("Competition and Consumer Act 2010")
  })
})

describe("bodies used as if they were statutes", () => {
  it("maps ACCC to the CCA and marks it as a body", () => {
    const entry = resolveLawAlias("ACCC").candidates[0]
    expect(entry.official).toBe("Competition and Consumer Act 2010")
    expect(entry.body).toBe(true)
    expect(entry.notes).toMatch(/not a statute/i)
  })

  it("maps the tribunals and regulators from the research table", () => {
    expect(officials("ASIC")[0]).toBe("Australian Securities and Investments Commission Act 2001")
    expect(officials("FWC")[0]).toBe("Fair Work Act 2009")
    expect(officials("OAIC")[0]).toBe("Privacy Act 1988")
    expect(officials("ART")[0]).toBe("Administrative Review Tribunal Act 2024")
    expect(officials("NCAT")[0]).toBe("Civil and Administrative Tribunal Act 2013")
  })

  it("keeps the AAT citable and names its successor", () => {
    expect(resolveLawAlias("AAT Act").candidates[0].notes).toMatch(/Administrative Review Tribunal Act 2024/)
  })
})

describe("misses", () => {
  it("returns no candidates without claiming the Act does not exist", () => {
    const resolution = resolveLawAlias("Zzzz Widgets Act 2099")
    expect(resolution.candidates).toEqual([])
    expect(resolution.needsJurisdiction).toBe(false)
    // The query is passed through so the caller can still search upstream.
    expect(resolution.searchText).toBe("Zzzz Widgets Act 2099")
  })

  it("handles empty input", () => {
    expect(resolveLawAlias("").candidates).toEqual([])
  })
})

describe("hasRelatedHit", () => {
  it("accepts a result whose name contains the query", () => {
    expect(hasRelatedHit("Fair Work Act", [{ name: "Fair Work Act 2009" }])).toBe(true)
  })

  it("accepts a result whose name is contained by the query", () => {
    expect(hasRelatedHit("Fair Work Act 2009 (Cth)", [{ name: "Fair Work Act 2009" }])).toBe(true)
  })

  it("accepts a result matching the official title an alias expands to", () => {
    expect(hasRelatedHit("CCA", [{ name: "Competition and Consumer Act 2010" }])).toBe(true)
    expect(hasRelatedHit("ACL", [{ name: "Competition and Consumer Act 2010" }])).toBe(true)
  })

  it("accepts a match on a previous name carried in altName", () => {
    expect(
      hasRelatedHit("Trade Practices Act 1974", [
        { name: "Competition and Consumer Act 2010", altName: "Trade Practices Act 1974" },
      ]),
    ).toBe(true)
  })

  // An upstream that ignores the query and returns a generic list must not be
  // read as confirmation — that is how "here is your Act" gets said about
  // something else entirely.
  it("rejects an unrelated result set", () => {
    expect(
      hasRelatedHit("Fair Work Act", [
        { name: "Biosecurity Act 2015" },
        { name: "Norfolk Island Act 1979" },
      ]),
    ).toBe(false)
  })

  it("rejects an empty result set", () => {
    expect(hasRelatedHit("Fair Work Act", [])).toBe(false)
  })

  // Containment on a folded key is meaningless for short strings: "act" is a
  // substring of nearly every Australian statute title.
  it("does not let a short query match everything", () => {
    expect(hasRelatedHit("act", [{ name: "Biosecurity Act 2015" }])).toBe(false)
    expect(hasRelatedHit("law", [{ name: "Biosecurity Act 2015" }])).toBe(false)
  })
})

describe("table integrity", () => {
  it("normalises keys past case, spacing and punctuation", () => {
    expect(normaliseAliasKey("FW Act")).toBe(normaliseAliasKey("fwact"))
    expect(normaliseAliasKey("EP&A Act")).toBe("epaact")
    expect(normaliseAliasKey("Governor-General's")).toBe("governorgenerals")
  })

  it("uses only AGLC jurisdiction abbreviations", () => {
    const allowed = new Set(["Cth", "NSW", "Vic", "Qld", "SA", "WA", "Tas", "ACT", "NT"])
    for (const entry of LAW_ALIAS_ENTRIES) {
      expect(allowed.has(entry.jurisdiction), `${entry.alias}: ${entry.jurisdiction}`).toBe(true)
    }
  })

  it("gives every official title a year", () => {
    for (const entry of LAW_ALIAS_ENTRIES) {
      if (entry.official === "Commonwealth of Australia Constitution Act") continue
      expect(entry.official, entry.alias).toMatch(/\b(?:1[89]|20)\d{2}$/)
    }
  })

  it("uses the Commonwealth title-id grammar wherever an id is given", () => {
    for (const entry of LAW_ALIAS_ENTRIES) {
      if (!entry.titleId) continue
      expect(entry.titleId, entry.alias).toMatch(/^C\d{4}[ALNQG]\d{5}$/)
      expect(entry.jurisdiction, entry.alias).toBe("Cth")
    }
  })

  it("has no duplicate alias/jurisdiction/schedule rows", () => {
    const keys = LAW_ALIAS_ENTRIES.map(
      (e) => `${normaliseAliasKey(e.alias)}|${e.jurisdiction}|${e.official}|${e.sch ?? ""}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("lists every alias pointing at one official title", () => {
    expect(aliasesFor("Competition and Consumer Act 2010", "Cth")).toEqual(
      expect.arrayContaining(["CCA", "TPA", "ACL", "ACCC"]),
    )
  })
})
