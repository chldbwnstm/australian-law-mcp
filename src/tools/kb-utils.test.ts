import { describe, expect, it } from "vitest"
import type { GlossaryEntry } from "../lib/glossary.js"
import type { LegalTermEntry } from "../lib/legal-terms-data.js"
import { LEGAL_TERM_ENTRIES } from "../lib/legal-terms-data.js"
import {
  findSeedTerm,
  fold,
  formatMatchNote,
  formatProvision,
  formatSeedEntry,
  glossaryNote,
  rankGlossary,
  rankPlainTerms,
  rankSeedTerms,
  scoreCandidate,
  stem,
  termNotFound,
  tokens,
} from "./kb-utils.js"

describe("fold and stem", () => {
  it("drops case, punctuation and curly quotes", () => {
    expect(fold("Director’s Duties!")).toBe("director s duties")
    expect(fold("  UNFAIR   contract-term ")).toBe("unfair contract term")
  })

  it("collapses simple plurals without wrecking short words", () => {
    expect(stem("duties")).toBe("duty")
    expect(stem("provisions")).toBe("provision")
    expect(stem("gas")).toBe("gas")
    expect(stem("class")).toBe("class")
  })

  it("drops stop words that appear in nearly every legal query", () => {
    expect(tokens("what is the duty of care")).toEqual(["duty", "care"])
  })
})

describe("scoreCandidate", () => {
  it("ranks an exact match above an alias, prefix, contains and text match", () => {
    const exact = scoreCandidate("unfair contract term", "unfair contract term")
    const alias = scoreCandidate("unfair clause", "unfair contract term", { aliases: ["unfair clause"] })
    const prefix = scoreCandidate("unfair contract", "unfair contract term")
    const contains = scoreCandidate("contract term", "unfair contract term")
    const text = scoreCandidate("significant imbalance", "unfair contract term", {
      text: "causes significant imbalance in the parties' rights",
    })
    expect(exact?.matchedBy).toBe("exact")
    expect(alias?.matchedBy).toBe("alias")
    expect(prefix?.matchedBy).toBe("prefix")
    expect(contains?.matchedBy).toBe("contains")
    expect(text?.matchedBy).toBe("text")
    const scores = [exact, alias, prefix, contains, text].map((hit) => hit?.score ?? 0)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("matches across punctuation and pluralisation", () => {
    expect(scoreCandidate("Directors Duty", "directors' duties")).not.toBeNull()
    expect(scoreCandidate("duties of directors", "directors' duties")?.matchedBy).toBe("words")
  })

  it("returns nothing for an unrelated query and for an empty one", () => {
    expect(scoreCandidate("xylophone repair", "unfair contract term")).toBeNull()
    expect(scoreCandidate("   ", "unfair contract term")).toBeNull()
  })

  it("does not let a two-character query reach the definition text", () => {
    expect(scoreCandidate("of", "unfair contract term", { text: "a lot of words" })).toBeNull()
  })
})

const SEED: LegalTermEntry[] = [
  { term: "unfair contract term", plain: "A one-sided clause.", plainAliases: ["unfair clause"] },
  { term: "unfair contract terms regime", plain: "The statutory scheme." },
  { term: "genuine redundancy", plain: "The job is gone.", plainAliases: ["made redundant"] },
]

describe("ranking", () => {
  it("puts the exact hit first and breaks ties toward the shorter headword", () => {
    const ranked = rankSeedTerms("unfair contract term", SEED)
    expect(ranked[0].item.term).toBe("unfair contract term")
    expect(ranked.map((hit) => hit.item.term)).toContain("unfair contract terms regime")
  })

  it("finds a seed entry from an everyday phrasing", () => {
    expect(rankPlainTerms("made redundant", SEED)[0].item.term).toBe("genuine redundancy")
  })

  it("honours the limit", () => {
    expect(rankSeedTerms("unfair", SEED, 1)).toHaveLength(1)
  })

  it("searches the real dictionary the way a caller would type", () => {
    expect(findSeedTerm("misleading and deceptive conduct", LEGAL_TERM_ENTRIES)?.term)
      .toBe("misleading or deceptive conduct")
    expect(findSeedTerm("insolvent trading", LEGAL_TERM_ENTRIES)?.term).toBe("insolvent trading")
    expect(findSeedTerm("input tax credits", LEGAL_TERM_ENTRIES)?.term).toBe("input tax credit")
  })

  it("ranks glossary entries by headword and by the extra headwords of a joint dt", () => {
    const glossary: GlossaryEntry[] = [
      { term: "Accused, Defendant", definition: "A person charged.", aliases: ["Accused", "Defendant"] },
      { term: "Bail", definition: "Liberty pending trial.", aliases: [] },
    ]
    expect(rankGlossary("defendant", glossary)[0].item.term).toBe("Accused, Defendant")
    expect(rankGlossary("bail", glossary)[0].item.term).toBe("Bail")
    expect(rankGlossary("mortgage", glossary)).toEqual([])
  })
})

describe("formatting", () => {
  it("prints a register id only when one exists", () => {
    expect(formatProvision({ title: "Fair Work Act 2009 (Cth)", titleId: "C2009A00028", ref: "s 389" }))
      .toBe("Fair Work Act 2009 (Cth) s 389 [titleId C2009A00028]")
    expect(formatProvision({ title: "Bail Act 2013 (NSW)", ref: "s 19" }))
      .toBe("Bail Act 2013 (NSW) s 19")
  })

  it("labels a definition-text hit as a suggestion rather than a lookup", () => {
    expect(formatMatchNote("text")).toContain("suggestion")
    expect(formatMatchNote("exact")).toBe("exact term match")
  })

  it("renders a full entry with anchors, links and cross references", () => {
    const entry = LEGAL_TERM_ENTRIES.find((item) => item.term === "genuine redundancy")!
    const text = formatSeedEntry(entry, ["Fair Work Act 2009 (Cth) — https://example.test/x"])
    expect(text).toContain("genuine redundancy")
    expect(text).toContain("Plain English:")
    expect(text).toContain("Statutory anchors:")
    expect(text).toContain("s 389")
    expect(text).toContain("Read the current text:")
    expect(text).toContain("See also:")
  })
})

describe("honesty of the empty and degraded answers", () => {
  it("says a glossary failure is not a statement about the term", () => {
    const note = glossaryNote({ entries: [], unavailable: "the host timed out" })
    expect(note).toContain("not consulted")
    expect(note).toContain("the host timed out")
    expect(note).toContain("says nothing about whether the term exists")
  })

  it("counts the entries when the glossary did load", () => {
    expect(glossaryNote({ entries: [{ term: "Bail", definition: "x", aliases: [] }] })).toContain("1 plain-language")
  })

  it("marks a miss as a miss in the named sources, never as absence", () => {
    const response = termNotFound("frobnication", ["bundled dictionary"], ["genuine redundancy"])
    expect(response.isError).toBe(true)
    const text = response.content[0].text
    expect(text).toContain("[NOT_FOUND]")
    expect(text).toContain("NOT evidence")
    expect(text).toContain("bundled dictionary")
    expect(text).toContain("genuine redundancy")
  })
})
