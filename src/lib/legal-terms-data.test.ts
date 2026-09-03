import { describe, expect, it } from "vitest"
import { LAW_ALIAS_ENTRIES } from "./law-alias-data.js"
import { LEGAL_TERM_ENTRIES, type LegalTermEntry } from "./legal-terms-data.js"
import { parseSectionRef } from "./section-ref.js"

const byTerm = new Map(LEGAL_TERM_ENTRIES.map((entry) => [entry.term.toLowerCase(), entry]))
const find = (term: string): LegalTermEntry => {
  const entry = byTerm.get(term.toLowerCase())
  if (!entry) throw new Error(`no seed entry for ${term}`)
  return entry
}

describe("seed dictionary shape", () => {
  it("carries a substantial curated set", () => {
    expect(LEGAL_TERM_ENTRIES.length).toBeGreaterThanOrEqual(120)
  })

  it("has no duplicate terms", () => {
    expect(byTerm.size).toBe(LEGAL_TERM_ENTRIES.length)
  })

  it("gives every entry a non-trivial plain-English meaning", () => {
    for (const entry of LEGAL_TERM_ENTRIES) {
      expect(entry.term.length, entry.term).toBeGreaterThan(1)
      expect(entry.plain.length, entry.term).toBeGreaterThan(20)
    }
  })

  it("cites every jurisdiction bracket in a title or names the register id", () => {
    for (const entry of LEGAL_TERM_ENTRIES) {
      for (const provision of entry.provisions ?? []) {
        expect(provision.title.length, entry.term).toBeGreaterThan(5)
        expect(provision.ref.trim(), entry.term).not.toBe("")
      }
    }
  })

  it("only uses register ids that the alias table already verified", () => {
    const known = new Set(LAW_ALIAS_ENTRIES.map((entry) => entry.titleId).filter(Boolean))
    for (const entry of LEGAL_TERM_ENTRIES) {
      for (const provision of entry.provisions ?? []) {
        if (provision.titleId) expect(known, `${entry.term} -> ${provision.titleId}`).toContain(provision.titleId)
      }
    }
  })

  it("gives every state or territory anchor no register id (they are not on the FRL)", () => {
    for (const entry of LEGAL_TERM_ENTRIES) {
      for (const provision of entry.provisions ?? []) {
        if (/\((?:NSW|Vic|Qld|SA|WA|Tas|ACT|NT)\)/.test(provision.title)) {
          expect(provision.titleId, `${entry.term} -> ${provision.title}`).toBeUndefined()
        }
      }
    }
  })

  it("writes every pinpoint in the section-ref grammar", () => {
    for (const entry of LEGAL_TERM_ENTRIES) {
      for (const provision of entry.provisions ?? []) {
        expect(parseSectionRef(provision.ref), `${entry.term}: ${provision.ref}`).not.toBeNull()
      }
    }
  })

  it("points see-also at terms that exist in the table", () => {
    for (const entry of LEGAL_TERM_ENTRIES) {
      for (const related of entry.seeAlso ?? []) {
        expect(byTerm.has(related.toLowerCase()), `${entry.term} -> ${related}`).toBe(true)
      }
    }
  })
})

describe("the anchors that carry the flagship traps", () => {
  it("puts the ACL in schedule 2 of the CCA, never in its body", () => {
    for (const term of ["misleading or deceptive conduct", "unfair contract term", "consumer"]) {
      for (const provision of find(term).provisions ?? []) {
        if (provision.titleId === "C2004A00109") {
          expect(provision.ref, term).toMatch(/^sch 2 /)
          expect(provision.title).toContain("sch 2")
        }
      }
    }
  })

  it("anchors misleading or deceptive conduct at ACL s 18 with the CCA register id", () => {
    const [first] = find("misleading or deceptive conduct").provisions ?? []
    expect(first).toEqual({
      title: "Competition and Consumer Act 2010 (Cth) sch 2 (Australian Consumer Law)",
      titleId: "C2004A00109",
      ref: "sch 2 s 18",
    })
  })

  it("keeps the Criminal Code without a register id, because its schedule is unnumbered", () => {
    for (const provision of find("mens rea").provisions ?? []) {
      expect(provision.title).toContain("Criminal Code")
      expect(provision.titleId).toBeUndefined()
    }
  })

  it("anchors the named employment, corporate and tax terms where practitioners cite them", () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["genuine redundancy", "s 389", "C2009A00028"],
      ["adverse action", "pt 3-1", "C2009A00028"],
      ["officer", "s 9", "C2004A00818"],
      ["directors' duties", "s 180", "C2004A00818"],
      ["CGT event", "s 102-20", "C2004A05138"],
      ["input tax credit", "s 11-20", "C2004A00446"],
      ["PAYG withholding", "sch 1 div 12", "C1953A00001"],
      ["serious harm", "s 10A", undefined],
    ]
    for (const [term, ref, titleId] of cases) {
      const provisions = find(term).provisions ?? []
      const hit = provisions.find((provision) => provision.ref === ref)
      expect(hit, `${term} ${ref}`).toBeDefined()
      expect(hit?.titleId, term).toBe(titleId)
    }
  })

  it("covers each practice area the tool surface promises", () => {
    for (const term of [
      "consumer", "unconscionable conduct", "genuine redundancy", "constructive dismissal",
      "officer", "insolvent trading", "CGT event", "input tax credit", "PAYG withholding",
      "personal information", "serious harm", "subpoena", "discovery", "interlocutory",
      "ex parte", "mandamus", "certiorari", "habeas corpus", "Torrens title", "easement",
      "caveat", "mens rea", "actus reus", "committal", "parole", "probation",
    ]) {
      expect(byTerm.has(term.toLowerCase()), term).toBe(true)
    }
  })
})
