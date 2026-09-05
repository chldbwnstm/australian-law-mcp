import { describe, expect, it } from "vitest"
import {
  DASH_LIKE,
  extractSectionRefs,
  formatRef,
  normaliseRef,
  parseSectionRef,
  refToNcxLabelPattern,
  type RefKind,
  type SectionRef,
} from "./section-ref.js"
import { KIND_VOCAB } from "./section-ref-vocab.js"

type Expected = Partial<SectionRef> & { kind: RefKind }

const CASES: Array<[input: string, expected: Expected, canonical: string]> = [
  // ── sections ──────────────────────────────────────────────────────────
  ["s 18", { kind: "section", number: "18" }, "s 18"],
  ["s18", { kind: "section", number: "18" }, "s 18"],
  ["S 18", { kind: "section", number: "18" }, "s 18"],
  ["section 18", { kind: "section", number: "18" }, "s 18"],
  ["Section 18", { kind: "section", number: "18" }, "s 18"],
  ["sections 18", { kind: "section", number: "18", plural: true }, "ss 18"],
  ["s 10AA", { kind: "section", number: "10", letterSuffix: "AA" }, "s 10AA"],
  ["s 41A", { kind: "section", number: "41", letterSuffix: "A" }, "s 41A"],
  ["s 56BM", { kind: "section", number: "56", letterSuffix: "BM" }, "s 56BM"],
  // TAA 1953: the letter run really does go past four.
  ["s 8AAZLGA", { kind: "section", number: "8", letterSuffix: "AAZLGA" }, "s 8AAZLGA"],
  // ITAA 1997 dotted/dashed numbering: one number, not a range.
  ["s 355-25", { kind: "section", number: "355-25" }, "s 355-25"],
  ["s 8-1", { kind: "section", number: "8-1" }, "s 8-1"],
  // ── ranges ────────────────────────────────────────────────────────────
  ["ss 5-6", { kind: "section", number: "5", rangeEnd: "6", plural: true }, "ss 5–6"],
  ["ss 5–6", { kind: "section", number: "5", rangeEnd: "6", plural: true }, "ss 5–6"],
  ["s 5–6", { kind: "section", number: "5", rangeEnd: "6" }, "ss 5–6"],
  ["regs 2.01-2.02", { kind: "regulation", number: "2.01-2.02", plural: true }, "regs 2.01-2.02"],
  // ── subdivisions of a section ─────────────────────────────────────────
  ["s 5(2)(a)", { kind: "section", number: "5", subsections: ["2", "a"] }, "s 5(2)(a)"],
  ["s 5(1)(a)(ii)", { kind: "section", number: "5", subsections: ["1", "a", "ii"] }, "s 5(1)(a)(ii)"],
  ["s 51(xx)", { kind: "section", number: "51", subsections: ["xx"] }, "s 51(xx)"],
  ["sub-s (2)", { kind: "subsection", number: "2" }, "sub-s (2)"],
  ["subsection (2)", { kind: "subsection", number: "2" }, "sub-s (2)"],
  ["para (a)", { kind: "paragraph", number: "a" }, "para (a)"],
  // ── structural ────────────────────────────────────────────────────────
  ["pt IVA", { kind: "part", number: "IVA" }, "pt IVA"],
  ["Part IVA", { kind: "part", number: "IVA" }, "pt IVA"],
  ["pt XI", { kind: "part", number: "XI" }, "pt XI"],
  ["pt 2-1", { kind: "part", number: "2-1" }, "pt 2-1"],
  ["div 2", { kind: "division", number: "2" }, "div 2"],
  ["division 2AA", { kind: "division", number: "2", letterSuffix: "AA" }, "div 2AA"],
  ["sub-div B", { kind: "subdivision", number: "B" }, "sub-div B"],
  // ITAA/GST structural numbering: `152-A` names one subdivision.
  ["Subdiv 152-A", { kind: "subdivision", number: "152-A" }, "sub-div 152-A"],
  ["Div 815-B", { kind: "division", number: "815-B" }, "div 815-B"],
  ["ch 3", { kind: "chapter", number: "3" }, "ch 3"],
  // ── schedules ─────────────────────────────────────────────────────────
  ["sch 2", { kind: "schedule", number: "2" }, "sch 2"],
  ["Schedule 2", { kind: "schedule", number: "2" }, "sch 2"],
  ["sch 2 s 18", { kind: "section", number: "18", schedule: "2" }, "sch 2 s 18"],
  ["Schedule 2 section 18", { kind: "section", number: "18", schedule: "2" }, "sch 2 s 18"],
  ["sch 2 s 18(1)", { kind: "section", number: "18", schedule: "2", subsections: ["1"] }, "sch 2 s 18(1)"],
  ["sch 1 item 4", { kind: "schedule", number: "1", item: "4" }, "sch 1 item 4"],
  // ── delegated legislation ─────────────────────────────────────────────
  ["reg 2.01", { kind: "regulation", number: "2.01" }, "reg 2.01"],
  ["regulation 2.01", { kind: "regulation", number: "2.01" }, "reg 2.01"],
  ["r 42.02.2", { kind: "rule", number: "42.02.2" }, "r 42.02.2"],
  ["cl 5", { kind: "clause", number: "5" }, "cl 5"],
  ["clause 5", { kind: "clause", number: "5" }, "cl 5"],
  ["art 12", { kind: "article", number: "12" }, "art 12"],
  // ── compound numbers whose front carries a letter ─────────────────────
  // The Corporations Act numbers 125 Parts this way (2A.1 … 2N.5), and the
  // ITAA 1997 names Subdivisions 83A-A … 83A-E.
  ["Part 2D.1", { kind: "part", number: "2D.1" }, "pt 2D.1"],
  ["pt 2F.1A", { kind: "part", number: "2F.1A" }, "pt 2F.1A"],
  ["Subdivision 83A-C", { kind: "subdivision", number: "83A-C" }, "sub-div 83A-C"],
  ["sub-div 12A-C", { kind: "subdivision", number: "12A-C" }, "sub-div 12A-C"],
  // Crimes Act 1914 Part IAABA: the widest real roman tail is four letters.
  ["Part IAABA", { kind: "part", number: "IAABA" }, "pt IAABA"],
  // ── the drafting-standard bracketed forms ─────────────────────────────
  // `subsection 5(2)` is section 5's subsection (2); wrapping the 5 —
  // `sub-s (5)` — renamed the provision and dropped the (2).
  ["subsection 5(2)", { kind: "subsection", number: "5", subsections: ["2"] }, "sub-s 5(2)"],
  ["paragraph 23(1)(a)", { kind: "paragraph", number: "23", subsections: ["1", "a"] }, "para 23(1)(a)"],
  ["subparagraph 23(1)(a)(ii)", { kind: "subparagraph", number: "23", subsections: ["1", "a", "ii"] }, "sub-para 23(1)(a)(ii)"],
  ["sub-reg 5(2)", { kind: "subregulation", number: "5", subsections: ["2"] }, "sub-reg 5(2)"],
]

describe("parseSectionRef", () => {
  for (const [input, expected, canonical] of CASES) {
    it(`parses ${JSON.stringify(input)}`, () => {
      const ref = parseSectionRef(input)
      expect(ref, `${input} did not parse`).not.toBeNull()
      for (const [key, value] of Object.entries(expected)) {
        expect(ref![key as keyof SectionRef], `${input} -> ${key}`).toEqual(value)
      }
      expect(formatRef(ref!), `${input} -> canonical`).toBe(canonical)
    })
  }

  it("normalises a non-breaking space between designation and number", () => {
    expect(normaliseRef("s 18")).toBe("s 18")
    expect(normaliseRef("Part IVA")).toBe("pt IVA")
  })

  it("returns null rather than guessing at prose", () => {
    for (const junk of ["", "   ", "the Act", "Competition and Consumer Act 2010", "2010", "misleading conduct"]) {
      expect(parseSectionRef(junk), junk).toBeNull()
    }
  })

  // Structural units are sometimes lettered. Allowing a bare letter as a
  // number is exactly how "part of" would become part "of", so it is limited
  // to structural kinds and to an uppercase letter.
  it("accepts a lettered structural unit", () => {
    expect(normaliseRef("sub-div B")).toBe("sub-div B")
    expect(normaliseRef("Division A")).toBe("div A")
    expect(normaliseRef("Sub-div AB")).toBe("sub-div AB")
  })

  it("does not read a lowercase word after a designation as a letter number", () => {
    expect(parseSectionRef("part of")).toBeNull()
    expect(parseSectionRef("division and")).toBeNull()
  })

  it("does not allow a bare letter as a section number", () => {
    expect(parseSectionRef("s B")).toBeNull()
  })
})

// The flagship trap: CCA s 18 is "Meetings of Commission"; the misleading-or-
// deceptive-conduct provision is sch 2 (the Australian Consumer Law) s 18.
// If the schedule were dropped here the two would be indistinguishable.
describe("schedule is part of the reference", () => {
  it("keeps sch 2 s 18 distinct from s 18", () => {
    const body = parseSectionRef("s 18")!
    const acl = parseSectionRef("sch 2 s 18")!
    expect(body.schedule).toBeUndefined()
    expect(acl.schedule).toBe("2")
    expect(formatRef(body)).not.toBe(formatRef(acl))
  })

  it("accepts an em dash between the schedule and the section", () => {
    expect(normaliseRef("sch 2 — s 18")).toBe("sch 2 s 18")
  })
})

// U+2011 NON-BREAKING HYPHEN is how the Federal Register and Word print the
// hyphen inside an ITAA-style section number; `provision-slicer.ts` folds the
// same character for the same reason. Reading it as a range dash turned a real
// provision into an impossible one and the caller reported it as NOT_FOUND.
describe("a typographic hyphen is not a range dash", () => {
  it("keeps U+2011 inside an ITAA section number", () => {
    const ref = parseSectionRef("s 355\u201125")!
    expect(ref.number).toBe("355-25")
    expect(ref.rangeEnd).toBeUndefined()
    expect(formatRef(ref)).toBe("s 355-25")
  })

  it("keeps U+2010 inside an ITAA section number", () => {
    expect(normaliseRef("s 8\u20101")).toBe("s 8-1")
  })

  it("keeps a spaced U+2011 inside the number too", () => {
    expect(parseSectionRef("s 355\u2011 25")!.number).toBe("355-25")
  })

  // The scanner sees the author's typography, not the normalised form. It used
  // to stop at the dash, so `s 355‑25` was harvested as `s 355` and `ss 5–6`
  // as `ss 5` — a different provision, reported without a word about the tail.
  it("keeps a typographic hyphen inside the number when scanning prose", () => {
    expect(extractSectionRefs("See s 355‑25 of the ITAA 1997.").map(formatRef)).toEqual(["s 355-25"])
    expect(extractSectionRefs("See s 8‐1 of the ITAA 1997.").map(formatRef)).toEqual(["s 8-1"])
  })

  it("keeps an en-dash range whole when scanning prose", () => {
    expect(extractSectionRefs("ss 5–6 of the Act").map(formatRef)).toEqual(["ss 5–6"])
  })

  it("still reads en, em, figure, horizontal-bar and minus as ranges", () => {
    for (const dash of ["\u2013", "\u2014", "\u2012", "\u2015", "\u2212"]) {
      expect(normaliseRef(`s 5${dash}6`), dash).toBe("ss 5\u20136")
    }
  })
})

// The Federal Register separates a heading's number from its title with an EM
// DASH — all 284 navLabels of `__fixtures__/cca-document.ncx` do it, and so
// does its body text. Reading that dash as a range dash made the scanner
// swallow the heading: "Schedule 1—2019 measures" came back as the schedule
// range `sch 1-2019`, "Part 1—2015 transitional provisions" as `pts 1–2015`
// and "s 45 — 1 January 2011" as the fabricated ITAA-style `s 45-1`.
//
// The three lists below are the whole dash class, split by role. The first
// test fails if a character is ever added to `DASH_LIKE` without being given
// one, so a new dash cannot silently opt out of these cases.
describe("a heading separator is not a range dash", () => {
  const HYPHEN_SPELLINGS = ["-", "‐", "‑"]
  const RANGE_DASHES = ["-", "‒", "–", "−"]
  const HEADING_DASHES = ["—", "―"]
  const codePoint = (dash: string) => `U+${dash.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`

  it("gives every dash character this module folds a role", () => {
    const classified = [...new Set([...HYPHEN_SPELLINGS, ...RANGE_DASHES, ...HEADING_DASHES])].sort()
    expect(classified).toEqual([...new Set(["-", ...DASH_LIKE])].sort())
  })

  for (const dash of HEADING_DASHES) {
    it(`reads ${codePoint(dash)} between a number and a title as a separator`, () => {
      expect(extractSectionRefs(`Schedule 1${dash}2019 measures`).map(formatRef)).toEqual(["sch 1"])
      expect(extractSectionRefs(`Part 1${dash}2015 transitional provisions`).map(formatRef)).toEqual(["pt 1"])
      expect(extractSectionRefs(`Division 3${dash}30 day rule`).map(formatRef)).toEqual(["div 3"])
      expect(extractSectionRefs(`Schedule 2${dash}The Australian Consumer Law`).map(formatRef)).toEqual(["sch 2"])
      expect(extractSectionRefs(`s 45 ${dash} 1 January 2011`).map(formatRef)).toEqual(["s 45"])
      expect(extractSectionRefs(`Part IVA${dash}News media and digital platforms`).map(formatRef)).toEqual(["pt IVA"])
    })

    // The other half of the trade, stated rather than left to be rediscovered:
    // prose that writes a range with a heading dash (AGLC r 1.9 writes an en
    // dash) scans as its first half — a reference the author did write —
    // while the anchored parser still reads the range, because there the
    // caller has said the whole string is one reference.
    it(`scans a ${codePoint(dash)} range as its first half, and still parses it whole when anchored`, () => {
      expect(extractSectionRefs(`ss 5${dash}6 of the Act`).map(formatRef)).toEqual(["ss 5"])
      expect(normaliseRef(`ss 5${dash}6`)).toBe("ss 5–6")
    })
  }

  for (const dash of RANGE_DASHES) {
    it(`still scans a range written with ${codePoint(dash)}`, () => {
      expect(extractSectionRefs(`ss 5${dash}6 of the Act`).map(formatRef)).toEqual(["ss 5–6"])
      expect(extractSectionRefs(`ss 5 ${dash} 6 of the Act`).map(formatRef)).toEqual(["ss 5–6"])
    })
  }

  for (const dash of HYPHEN_SPELLINGS) {
    it(`still scans ${codePoint(dash)} as the hyphen inside a number`, () => {
      expect(extractSectionRefs(`See s 355${dash}25 of the ITAA 1997.`).map(formatRef)).toEqual(["s 355-25"])
      expect(extractSectionRefs(`Subdivision 152${dash}A applies.`).map(formatRef)).toEqual(["sub-div 152-A"])
      expect(refToNcxLabelPattern(parseSectionRef("pt 2-1")!).test(`Part 2${dash}1${"—"}Misleading`)).toBe(true)
    })
  }
})

// `ss 355-25, 355-30` is the ITAA cited as a list: the plural belongs to the
// list, not to a range. "Sections 355 to 25" cannot be looked up, and the
// caller reports the failure as the provision not existing.
describe("a pair that runs backwards is not a range", () => {
  it("reads ss 355-25 as the single ITAA section", () => {
    const ref = parseSectionRef("ss 355-25")!
    expect(ref.number).toBe("355-25")
    expect(ref.rangeEnd).toBeUndefined()
    expect(ref.plural).toBe(true)
  })

  it("applies the same reading to the spaced form", () => {
    expect(parseSectionRef("ss 355 - 25")!.number).toBe("355-25")
    expect(parseSectionRef("ss 355 - 25")!.rangeEnd).toBeUndefined()
  })

  it("applies it to a long dash as well, so Part 2-1 of the ACL survives", () => {
    const ref = parseSectionRef("pt 2\u20131")!
    expect(ref.number).toBe("2-1")
    expect(ref.rangeEnd).toBeUndefined()
  })

  // Documented choice: a backwards typo in a real range reads as one number.
  // `s 20-15` either exists upstream or comes back honestly as not in the
  // table of contents; sections 20 to 15 is guaranteed nonsense reported as
  // an absence.
  it("reads a backwards typo as a section number rather than an impossible range", () => {
    expect(parseSectionRef("ss 20-15")!.number).toBe("20-15")
    expect(parseSectionRef("ss 20-15")!.rangeEnd).toBeUndefined()
  })

  it("leaves an ascending range alone", () => {
    expect(normaliseRef("ss 5-6")).toBe("ss 5\u20136")
    expect(normaliseRef("ss 20-22")).toBe("ss 20\u201322")
    expect(normaliseRef("s 5\u20136")).toBe("ss 5\u20136")
  })
})

// The Constitution's heads of power run to s 51(xxxix); (xxxvii), the referral
// power, is seven characters. A four-character cap parsed `s 51(xxxvii)` as
// null and, in prose, silently echoed the citation back as plain `s 51`.
describe("long roman placita", () => {
  for (const placitum of ["xxxvi", "xxxvii", "xxxviii", "xxxix", "xxxi", "xx"]) {
    it(`parses s 51(${placitum})`, () => {
      const ref = parseSectionRef(`s 51(${placitum})`)
      expect(ref, `s 51(${placitum}) did not parse`).not.toBeNull()
      expect(ref!.subsections).toEqual([placitum])
      expect(formatRef(ref!)).toBe(`s 51(${placitum})`)
    })
  }

  it("does not let bracketed prose become a subsection", () => {
    expect(parseSectionRef("s 5(civil)")).toBeNull()
    expect(parseSectionRef("s 5(interest)")).toBeNull()
  })

  it("finds a placitum in prose instead of dropping it", () => {
    expect(extractSectionRefs("Australian Constitution s 51(xxxvii) is the referral power.").map(formatRef))
      .toEqual(["s 51(xxxvii)"])
  })
})

// The Commonwealth's lettered sections run well past four letters: the
// *Taxation Administration Act 1953* has s 8AAZLGA sitting among
// ss 8AAZLA–8AAZLH. A four-letter cap did not merely reject them — the
// scanner harvested `s 8AAZLGA` as `s 8AAZL`, itself a real section, and a
// citation checker then ticked the citation off against that section's heading.
describe("long lettered sections", () => {
  it("parses the TAA's long-lettered sections", () => {
    expect(normaliseRef("s 8AAZLGA")).toBe("s 8AAZLGA")
    expect(normaliseRef("s 8AAZLG")).toBe("s 8AAZLG")
    expect(normaliseRef("s 8AAZLH")).toBe("s 8AAZLH")
    expect(parseSectionRef("s 8AAZLGA")!.letterSuffix).toBe("AAZLGA")
  })

  it("does not collapse two of them into one when scanning prose", () => {
    expect(extractSectionRefs("See s 8AAZLGA and s 8AAZLH.").map(formatRef))
      .toEqual(["s 8AAZLGA", "s 8AAZLH"])
  })

  it("addresses the long-lettered NCX label, and only that one", () => {
    const label = "8AAZLGA  Retaining refunds"
    expect(refToNcxLabelPattern(parseSectionRef("s 8AAZLGA")!).test(label)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("s 8AAZL")!).test(label)).toBe(false)
  })

  // The dangerous outcome is not the rejection, it is the shorter reference
  // left behind: `s 8AAZL` exists, so the truncation reads as a verified cite.
  it("drops a tail it cannot read instead of leaving a shorter reference behind", () => {
    expect(parseSectionRef("s 8AAZLGABCDEFGHIJ")).toBeNull()
    expect(extractSectionRefs("See s 8AAZLGABCDEFGHIJ.")).toEqual([])
  })
})

// Commonwealth Parts carry a two- and three-letter tail: the CCA has Parts
// IIIAA, IVBA, IVBB, XIAA, XICA and XICB (all navLabels in this repo's own
// `__fixtures__/cca-document.ncx`) and the Crimes Act 1914 has Part IABA. A
// one-letter tail rejected `pt IVBA` outright, and because the scanner's
// right-edge guard refuses a truncated tail it dropped them out of a scanned
// document silently — verify_citations then reported on the rest of the
// document as though that citation had been checked.
describe("roman Parts with a lettered tail", () => {
  const REAL_PARTS = ["I", "IIA", "III", "IIIA", "IIIAA", "IV", "IVA", "IVBA", "IVBB", "VIIC", "XI", "XIAA", "XICA", "XICB", "IAB", "IABA"]
  for (const number of REAL_PARTS) {
    it(`parses pt ${number}`, () => {
      expect(normaliseRef(`pt ${number}`), `pt ${number}`).toBe(`pt ${number}`)
      expect(normaliseRef(`Part ${number}`), `Part ${number}`).toBe(`pt ${number}`)
    })
  }

  it("finds them in prose instead of dropping them", () => {
    expect(
      extractSectionRefs("The bargaining code is in pt IVBA of the Competition and Consumer Act 2010 (Cth).").map(formatRef),
    ).toEqual(["pt IVBA"])
    expect(extractSectionRefs("Part IIIAA—The Australian Energy Regulator (AER)").map(formatRef)).toEqual(["pt IIIAA"])
  })

  it("addresses its own navLabel, never the Part it is a longer name than", () => {
    const aer = "Part IIIAA—The Australian Energy Regulator (AER)"
    const code = "Part IVBA—News media and digital platforms mandatory bargaining code"
    expect(refToNcxLabelPattern(parseSectionRef("pt IIIAA")!).test(aer)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("pt IIIA")!).test(aer)).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("pt IVBA")!).test(code)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("pt IVB")!).test(code)).toBe(false)
  })

  // The widest tail in the statute book is four letters, not three: the
  // *Crimes Act 1914*'s Part IAABA (ss 3ZZUHA–3ZZUHC, in force since 8
  // December 2023) sits between Part IAAB and Part IAB in
  // `__fixtures__/crimes-act-toc.ncx`. A three-letter tail rejected it
  // outright, and the scanner's right-edge guard then dropped it from prose
  // without a trace, so a query naming it fell back to a text search.
  it("parses the widest real tail, Part IAABA", () => {
    expect(normaliseRef("pt IAABA")).toBe("pt IAABA")
    expect(normaliseRef("Part IAABA")).toBe("pt IAABA")
    expect(extractSectionRefs("what does Part IAABA of the Crimes Act say").map(formatRef)).toEqual(["pt IAABA"])
    const label = "Part IAABA—Monitoring of compliance with community safety supervision orders etc."
    expect(refToNcxLabelPattern(parseSectionRef("pt IAABA")!).test(label)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("pt IAAB")!).test(label)).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("pt IAABA")!).test("Part IAAB—Monitoring of compliance")).toBe(false)
  })

  // The fourth letter is admitted only when the whole tail is a series letter.
  // An unrestricted `[A-Z]{0,4}` matches 709 words of /usr/share/dict/words
  // against this pattern's 324 — and every one of those is a pinpoint the
  // caller then reports as a provision the Act does not contain.
  it("does not let a fourth arbitrary letter into the tail", () => {
    expect(parseSectionRef("pt IVANOV")).toBeNull()
    expect(parseSectionRef("s IGLOO")).toBeNull()
    expect(extractSectionRefs("The VISION statement and the IDIOM were considered.")).toEqual([])
  })
})

// Structural units are lettered as often as they are numbered, and
// `extractSectionRefs` had no branch for them at all: `REF_BODY` requires a
// `NUMBER_PATTERN`, and a bare letter is not one. So ~90 real
// `Subdivision C`/`D`/`CA`/`DA` labels in the *Competition and Consumer Act
// 2010* alone were not merely unresolved — they were not found, and
// `verify_citations` counted a document's citations without them.
describe("bare lettered structural units in prose", () => {
  it("harvests the lettered units a document really cites", () => {
    expect(extractSectionRefs("Subdivision C—Common provisions").map(formatRef)).toEqual(["sub-div C"])
    expect(extractSectionRefs("Subdivision D—Other").map(formatRef)).toEqual(["sub-div D"])
    expect(extractSectionRefs("See Division D of the Competition and Consumer Act 2010 (Cth).").map(formatRef))
      .toEqual(["div D"])
    expect(extractSectionRefs("Subdivision CA and Subdivision DA apply.").map(formatRef))
      .toEqual(["sub-div CA", "sub-div DA"])
    expect(extractSectionRefs("Part B, Schedule A and Appendix C").map(formatRef))
      .toEqual(["pt B", "sch A", "app C"])
  })

  it("keeps them in document order beside the numbered ones", () => {
    expect(extractSectionRefs("see Subdivision C of Division 3 of Part 5.3B").map(formatRef))
      .toEqual(["sub-div C", "div 3", "pt 5.3B"])
    expect(
      extractSectionRefs(
        "The prohibition in Subdivision C of Division 3 of Part IV of the Competition and Consumer " +
          "Act 2010 (Cth) applies, as does Division D of that Act.",
      ).map(formatRef),
    ).toEqual(["sub-div C", "div 3", "pt IV", "div D"])
  })

  // Two rules keep this out of ordinary prose, and both are load-bearing.
  it("matches the letters case-sensitively, so a lowercase word is a word", () => {
    expect(extractSectionRefs("part of the agreement")).toEqual([])
    expect(extractSectionRefs("division and control of the company")).toEqual([])
    expect(extractSectionRefs("the schedule as amended")).toEqual([])
  })

  it("only accepts a series letter, so an all-caps word is not a unit", () => {
    for (const prose of ["SCHEDULE OF FEES", "PART TO BE REPEALED", "DIVISION OR PART", "Part TWO", "Division ONE"]) {
      expect(extractSectionRefs(prose).map(formatRef), prose).toEqual([])
    }
  })

  it("does not report the same unit twice when both scanners see it", () => {
    expect(extractSectionRefs("Part I—Preliminary").map(formatRef)).toEqual(["pt I"])
    expect(extractSectionRefs("Part IVA—News media").map(formatRef)).toEqual(["pt IVA"])
    expect(extractSectionRefs("Division 2—Establishment of the AER").map(formatRef)).toEqual(["div 2"])
  })
})

// The tail is only safe to widen because the numeral in front of it is a real
// numeral and the whole thing has to be capitalised. The scanner matches
// case-insensitively — designations are written "Part", "part" and "PART" —
// so without both rules every English word built from numeral letters becomes
// a provision number, and each phantom routes to a lookup that answers
// [NOT_FOUND] for a reference the document never contained.
describe("a roman number is a numeral, in capitals", () => {
  it("does not read an ordinary word after a designation as a roman number", () => {
    for (const prose of [
      "the rules can be amended",
      "the order made under it",
      "div id attribute",
      "which sections mix the two",
      "s civil",
      "part dill",
      "item did",
    ]) {
      expect(extractSectionRefs(prose).map(formatRef), prose).toEqual([])
    }
    expect(parseSectionRef("pt iva")).toBeNull()
    expect(parseSectionRef("item can")).toBeNull()
  })

  // The same guard `statute-citations.ts` needs for `SIS`/`SDA`: an all-caps
  // abbreviation must not become a pinpoint that inherits the cited Act.
  it("does not read an everyday abbreviation as a Part number", () => {
    expect(extractSectionRefs("The SDA and the RDA were both considered.")).toEqual([])
    expect(parseSectionRef("s DA")).toBeNull()
  })

  it("still reads the roman pinpoints AGLC writes, and the bare lettered units", () => {
    expect(normaliseRef("s IV")).toBe("s IV")
    expect(normaliseRef("pt XIII")).toBe("pt XIII")
    expect(normaliseRef("pt XXXIX")).toBe("pt XXXIX")
    // `pt C` is the lettered structural unit, not the numeral 100 — no Part is
    // numbered L, C, D or M, and reading those letters as numerals is what let
    // "civil", "did" and "made" through.
    expect(normaliseRef("pt C")).toBe("pt C")
    expect(parseSectionRef("s C")).toBeNull()
  })
})

// The other half of the same rule, and the one that decides whether widening
// the roman tail was safe: a designation spelling *glued* to letters is not a
// designation, it is the front of an ordinary all-capitals word. `SIS` (the
// Superannuation Industry (Supervision) Act's own abbreviation) read as
// `s IS`, `SIX` as `s IX`, `SCHIV` as `sch IV`, and once the tail reached
// three letters `PARTIES` — which appears verbatim in the party block of every
// judgment, and in this repo's own `sources/qld-judgments` fixture — read as
// `pt IES`.
//
// The vocabulary is enumerated from `KIND_VOCAB` rather than listed here, so a
// spelling added to the table tomorrow is covered the day it lands instead of
// silently opting out of the rule.
describe("a designation glued to letters is a word, not a pinpoint", () => {
  const ROMAN_TAILS = [
    "I", "II", "III", "IV", "V", "VI", "IX", "X", "XI", "XIII",
    "IS", "IES", "IVA", "IAB", "IXA", "XICA", "IIIAA",
  ]
  const SPELLINGS = KIND_VOCAB.flatMap((entry) => entry.spellings)

  it("covers every spelling the vocabulary table knows", () => {
    // Guards the enumeration itself: if `KIND_VOCAB` were ever restructured so
    // `spellings` stopped being the list of spellings, the loop below would
    // quietly test nothing.
    expect(SPELLINGS.length).toBeGreaterThanOrEqual(KIND_VOCAB.length)
    expect(SPELLINGS).toContain("part")
    expect(SPELLINGS).toContain("sch")
  })

  it("never reads a spelling glued to roman letters as a reference", () => {
    const phantoms: string[] = []
    for (const spelling of SPELLINGS) {
      for (const tail of ROMAN_TAILS) {
        const word = `${spelling}${tail}`.toUpperCase()
        const scanned = extractSectionRefs(`The ${word} was considered.`).map(formatRef)
        if (scanned.length > 0) phantoms.push(`${word} -> ${scanned.join(", ")}`)
        const parsed = parseSectionRef(word)
        if (parsed) phantoms.push(`parseSectionRef(${word}) -> ${formatRef(parsed)}`)
      }
    }
    expect(phantoms).toEqual([])
  })

  it("names the abbreviations that motivated the rule", () => {
    for (const word of ["SIS", "SIV", "SIX", "SI", "CHI", "RIX", "ARTIX", "APPIX", "SCHIV", "PARTIES"]) {
      expect(extractSectionRefs(`The ${word} was considered.`).map(formatRef), word).toEqual([])
      expect(parseSectionRef(word), word).toBeNull()
    }
  })

  // The no-space tolerance only ever existed for what a keyboard produces, and
  // that is still honoured: a number that starts with a digit needs no gap.
  it("still tolerates the spaceless arabic pinpoint AGLC does not write", () => {
    expect(normaliseRef("s18")).toBe("s 18")
    expect(normaliseRef("s10AA")).toBe("s 10AA")
    expect(normaliseRef("sch2 s18")).toBe("sch 2 s 18")
    expect(normaliseRef("sch1 item4")).toBe("sch 1 item 4")
    expect(extractSectionRefs("see s18 and ss5-6").map(formatRef)).toEqual(["s 18", "ss 5–6"])
  })

  it("still reads the spaced forms of the same words", () => {
    expect(normaliseRef("s IS")).toBe("s IS")
    expect(normaliseRef("pt IV")).toBe("pt IV")
    expect(normaliseRef("sch IV")).toBe("sch IV")
    expect(normaliseRef("pt B")).toBe("pt B")
    expect(normaliseRef("sub-div B")).toBe("sub-div B")
    expect(extractSectionRefs("Part IVBA—News media").map(formatRef)).toEqual(["pt IVBA"])
  })
})

// ITAA/GST structural units are numbered `152-A`, not `152`: there is no
// Subdivision 152, only 152-A to 152-D. A number pattern that only continued
// past a dash with digits rejected `Subdiv 152-A` outright while `Subdiv 328-D`
// slipped through (D is a roman-numeral letter), and in prose it degraded
// `Subdiv 152-C` to `sub-div 152` — one subdivision answered with another's text.
describe("ITAA structural numbers", () => {
  for (const input of ["Subdiv 152-A", "Subdiv 900-B", "Subdiv 30-B", "Subdiv 115-A", "Subdivision 118-B", "Div 974-B"]) {
    it(`parses ${JSON.stringify(input)} as one number`, () => {
      const ref = parseSectionRef(input)
      expect(ref, `${input} did not parse`).not.toBeNull()
      expect(ref!.number).toMatch(/^\d+-[A-Z]$/)
      expect(ref!.rangeEnd).toBeUndefined()
    })
  }

  it("keeps the lettered half when scanning prose", () => {
    expect(extractSectionRefs("Income Tax Assessment Act 1997 (Cth) Subdiv 152-C of the ITAA 1997").map(formatRef))
      .toEqual(["sub-div 152-C"])
    expect(extractSectionRefs("Subdivision 152‑A applies.").map(formatRef)).toEqual(["sub-div 152-A"])
  })

  it("resolves to its own subdivision, never to the first lettered one", () => {
    const basic = "Subdivision 152‑A—Basic conditions for relief"
    const reduction = "Subdivision 152‑C—Small business 50% reduction"
    expect(refToNcxLabelPattern(parseSectionRef("Subdiv 152-C")!).test(reduction)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("Subdiv 152-C")!).test(basic)).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("Subdiv 152-A")!).test(basic)).toBe(true)
    // `Subdivision 152` does not exist; answering with 152-A would be a guess.
    expect(refToNcxLabelPattern(parseSectionRef("Subdiv 152")!).test(basic)).toBe(false)
  })

  // Same rule as `sub-div B`: lowercase after a dash is hyphenated prose.
  it("requires the letter after the dash to be uppercase", () => {
    expect(parseSectionRef("s 3-in")).toBeNull()
    expect(extractSectionRefs("a s 3-in-1 test")).toEqual([])
    expect(extractSectionRefs("the s 18-based claim under Part IVA-style rules").map(formatRef))
      .toEqual(["s 18", "pt IVA"])
  })
})

// A compound number's *first* component carries letters as often as its last.
// The *Corporations Act 2001* numbers 68 Parts `2A.1` … `2N.5` (plus `2F.1A`
// and `5C.10`), the ITAA 1997 has Subdivisions `83A-A` … `83A-E`, and sch 1 to
// the *Taxation Administration Act 1953* has `12A-A` … `12A-C`. Requiring
// digits on both sides of the separator did not merely reject them: because
// the scanner's right-edge guard does not fire on a `.` or a `-`, `Part 2D.1`
// was harvested as `pt 2D` — a Part the Act does not have — and a citation
// checker answered `NOT_FOUND … has no pt 2D` about a correct citation.
describe("a compound number whose first component carries a letter", () => {
  const REAL: Array<[input: string, canonical: string]> = [
    ["Part 2D.1", "pt 2D.1"],
    ["pt 2A.1", "pt 2A.1"],
    ["Part 2N.5", "pt 2N.5"],
    ["Part 2F.1A", "pt 2F.1A"],
    ["Part 5C.10", "pt 5C.10"],
    ["Subdivision 83A-A", "sub-div 83A-A"],
    ["Subdiv 83A-C", "sub-div 83A-C"],
    ["sub-div 12A-C", "sub-div 12A-C"],
  ]

  for (const [input, canonical] of REAL) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(normaliseRef(input), input).toBe(canonical)
      expect(parseSectionRef(input)!.rangeEnd, input).toBeUndefined()
    })
  }

  // The dangerous outcome is not the rejection. It is the shorter reference
  // left behind: `pt 2D` and `sub-div 83A` look like citations, and neither
  // exists.
  it("does not truncate one to a Part the Act does not have", () => {
    expect(
      extractSectionRefs("Directors owe duties under Part 2D.1 of the Corporations Act 2001 (Cth)").map(formatRef),
    ).toEqual(["pt 2D.1"])
    expect(extractSectionRefs("Subdivision 83A-C applies to the employee share scheme.").map(formatRef))
      .toEqual(["sub-div 83A-C"])
    expect(extractSectionRefs("sch 1 sub-div 12A-C of the TAA").map(formatRef)).toEqual(["sch 1 sub-div 12A-C"])
  })

  it("addresses its own navLabel, and not the neighbouring Part", () => {
    const duties = "Part 2D.1—Duties and powers"
    expect(refToNcxLabelPattern(parseSectionRef("pt 2D.1")!).test(duties)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("pt 2D.2")!).test(duties)).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("pt 2D")!).test(duties)).toBe(false)
    const objects = "Subdivision 83A-A—Objects of Division and key concepts"
    expect(refToNcxLabelPattern(parseSectionRef("sub-div 83A-A")!).test(objects)).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("sub-div 83A-C")!).test(objects)).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("sub-div 83A")!).test(objects)).toBe(false)
  })
})

// `subsection 5(2)` is how Commonwealth drafting writes a subsection, and the
// phrase appears verbatim in nearly every Act. Printing it as `sub-s (5)`
// moved the reference to section 5's *own* number and dropped the (2), so a
// document saying "for the purposes of subsection 5(2) of the Act" was routed
// to a lookup for a provision nobody cited. The bare `sub-s (2)` — where the
// bracket is the whole reference — still prints as it always did.
describe("a bracketed designation that carries its own section number", () => {
  const CASES: Array<[input: string, canonical: string]> = [
    ["subsection 5(2)", "sub-s 5(2)"],
    ["sub-s 5(2)", "sub-s 5(2)"],
    ["paragraph 23(1)(a)", "para 23(1)(a)"],
    ["subparagraph 23(1)(a)(ii)", "sub-para 23(1)(a)(ii)"],
    ["sub-reg 5(2)", "sub-reg 5(2)"],
    ["sub-cl 12(3)", "sub-cl 12(3)"],
    ["para 1020F(1)(c)", "para 1020F(1)(c)"],
  ]

  for (const [input, canonical] of CASES) {
    it(`keeps the subsection of ${JSON.stringify(input)}`, () => {
      expect(normaliseRef(input), input).toBe(canonical)
      // What formatRef emits has to be readable back, or a caller that
      // normalises before looking up gets [INVALID_PARAM] for its own output.
      expect(normaliseRef(canonical), canonical).toBe(canonical)
    })
  }

  it("still prints the bare bracketed form, which has no number to carry", () => {
    expect(normaliseRef("sub-s (2)")).toBe("sub-s (2)")
    expect(normaliseRef("subsection (2)")).toBe("sub-s (2)")
    expect(normaliseRef("para (a)")).toBe("para (a)")
  })

  it("routes the drafting-standard phrase to the provision it names", () => {
    expect(extractSectionRefs("for the purposes of subsection 5(2) of the Act").map(formatRef))
      .toEqual(["sub-s 5(2)"])
    expect(extractSectionRefs("see paragraph 23(1)(a) and subsection 912A(1)").map(formatRef))
      .toEqual(["para 23(1)(a)", "sub-s 912A(1)"])
  })
})

// The plural-hyphen rule was defended only by `runsBackwards`, which rescues
// the ITAA numbers whose serial is below their division (`355-25`) and none of
// the ones whose serial is above it. `165-210` is one real ITAA 1997 section —
// the Act's own navLabel reads "165-212E  Entry history rule does not apply
// for the purposes of sections 165-210 and 165-211" — and read as a range it
// becomes a lookup for 46 provisions the Act does not have, reported back as
// an absence.
describe("a wide hyphenated pair is a number, not a range", () => {
  it("reads the ITAA's own cross-reference as the section it cites", () => {
    const ref = parseSectionRef("ss 165-210")!
    expect(ref.number).toBe("165-210")
    expect(ref.rangeEnd).toBeUndefined()
    expect(
      extractSectionRefs(
        "165-212E  Entry history rule does not apply for the purposes of sections 165-210 and 165-211",
      ).map(formatRef),
    ).toEqual(["ss 165-210"])
  })

  it("does not hang a bracketed subdivision off the end of a range", () => {
    const ref = parseSectionRef("paragraphs 230-395(2)(c)")!
    expect(ref.number).toBe("230-395")
    expect(ref.rangeEnd).toBeUndefined()
    expect(ref.subsections).toEqual(["2", "c"])
    expect(
      extractSectionRefs("Commissioner discretion to waive requirements in paragraphs 230-395(2)(c) and (e)")
        .map(formatRef),
    ).toEqual(["paras 230-395(2)(c)"])
  })

  it("still reads the ranges a writer actually writes", () => {
    expect(normaliseRef("ss 5-6")).toBe("ss 5–6")
    expect(normaliseRef("ss 20-22")).toBe("ss 20–22")
    expect(normaliseRef("ss 51-53")).toBe("ss 51–53")
    expect(normaliseRef("ss 100-120")).toBe("ss 100–120")
    expect(extractSectionRefs("ss 44-46 of the Act").map(formatRef)).toEqual(["ss 44–46"])
  })

  // An en dash only ever means "to" (AGLC r 1.9), so it overrides the ceiling:
  // a writer who used one asked for the range, however wide.
  it("leaves a real range dash alone however wide the span", () => {
    expect(normaliseRef("ss 165–210")).toBe("ss 165–210")
    expect(parseSectionRef("ss 165–210")!.rangeEnd).toBe("210")
    expect(extractSectionRefs("ss 1–500 of the Act").map(formatRef)).toEqual(["ss 1–500"])
  })
})

describe("refToNcxLabelPattern", () => {
  const match = (input: string, label: string) =>
    refToNcxLabelPattern(parseSectionRef(input)!).test(label)

  it("matches a number-led section label", () => {
    expect(match("s 18", "18  Meetings of Commission")).toBe(true)
    expect(match("s 18", "18  Misleading or deceptive conduct")).toBe(true)
  })

  it("does not let s 1 match section 18 or 1A", () => {
    expect(match("s 1", "18  Meetings of Commission")).toBe(false)
    expect(match("s 1", "1A  Something else")).toBe(false)
    expect(match("s 1", "1  Application of this Schedule")).toBe(true)
  })

  it("matches lettered sections exactly", () => {
    expect(match("s 17A", "17A  Disclosure of certain interests")).toBe(true)
    expect(match("s 17", "17A  Disclosure of certain interests")).toBe(false)
  })

  it("matches a worded label across the non-breaking space FRL uses", () => {
    expect(match("pt IVA", "Part IVA—News media and digital platforms mandatory bargaining code")).toBe(true)
    expect(match("sch 2", "Schedule 2—The Australian Consumer Law")).toBe(true)
    expect(match("ch 1", "Chapter 1—Introduction")).toBe(true)
    expect(match("div 2", "Division 2—Establishment of the AER")).toBe(true)
  })

  it("does not let div 2 match Division 2AA or Division 20", () => {
    expect(match("div 2", "Division 2AA—Services that are ineligible to be declared")).toBe(false)
    expect(match("div 2", "Division 20—Something")).toBe(false)
    expect(match("div 2AA", "Division 2AA—Services that are ineligible to be declared")).toBe(true)
  })

  it("does not let pt IV match Part IVA", () => {
    expect(match("pt IV", "Part IVA—Notification of acquisitions")).toBe(false)
    expect(match("pt IV", "Part IV—Restrictive trade practices")).toBe(true)
  })

  // FRL sets the hyphen of a structural number as U+2011; `htmlToText` folds it
  // for body text, but navLabels reach this pattern exactly as printed.
  it("matches a dashed number printed with a non-breaking hyphen", () => {
    expect(match("pt 2-1", "Part 2‑1—Misleading or deceptive conduct")).toBe(true)
    expect(match("pt 2-1", "Part 2‑2—Unconscionable conduct")).toBe(false)
    expect(match("pt 2", "Part 2‑1—Misleading or deceptive conduct")).toBe(false)
  })

  it("matches a dashed part number", () => {
    expect(match("pt 2-1", "Part 2-1—Misleading or deceptive conduct")).toBe(true)
    expect(match("pt 2-1", "Part 2-2—Unconscionable conduct")).toBe(false)
  })
})

// A structural number continues past its first component in two ways, and a
// guard that knew only the hyphen answered one Part with another. The
// *Corporations Act 2001* has Chapter 5 with Parts 5.1 to 5.9 and no bare
// Part 5 — the same shape as "Subdivision 152 does not exist".
describe("refToNcxLabelPattern — a bare number is not a numbered subdivision of itself", () => {
  const match = (input: string, label: string) =>
    refToNcxLabelPattern(parseSectionRef(input)!).test(label)

  it("refuses the dotted continuation as well as the hyphenated one", () => {
    expect(match("pt 5", "Part 5.1—Arrangements and reconstructions")).toBe(false)
    expect(match("pt 5", "Part 5.3A—Administration of a company's affairs")).toBe(false)
    expect(match("pt 5", "Part 5-1—Enforcement")).toBe(false)
    expect(match("pt 5", "Part 5‑1—Enforcement")).toBe(false)
    expect(match("div 2", "Division 2.1—Something")).toBe(false)
    expect(match("sub-div 152", "Subdivision 152.1—Something")).toBe(false)
    expect(match("ch 9", "Chapter 9.4AAA—Whistleblowers")).toBe(false)
  })

  it("still matches the numbered Part that was asked for", () => {
    expect(match("pt 5.1", "Part 5.1—Arrangements and reconstructions")).toBe(true)
    expect(match("pt 5.1", "Part 5.10—Something else")).toBe(false)
    expect(match("pt 5", "Part 5—Something")).toBe(true)
    expect(match("pt 5", "Part 5 Something")).toBe(true)
    // A stop the number does not continue through is 1900 typography, not a
    // component separator, so it still matches.
    expect(match("sch 1", "Schedule 1. Amendments")).toBe(true)
  })
})

describe("refToNcxLabelPattern — the Constitution's 1900 typography", () => {
  const match = (input: string, label: string) =>
    refToNcxLabelPattern(parseSectionRef(input)!).test(label)

  // FRL prints modern Acts as "18  Meetings of Commission" but leaves the
  // pre-Federation continued laws as they were set. Without the optional stop
  // no section of the Constitution could be fetched at all.
  it("matches the full-stop label form", () => {
    expect(match("s 51", "51. Legislative powers of the Parliament.")).toBe(true)
    expect(match("s 92", "92. Trade within the Commonwealth to be free.")).toBe(true)
    expect(match("s 51(xx)", "51. Legislative powers of the Parliament.")).toBe(true)
  })

  it("does not widen the section number", () => {
    expect(match("s 51", "51A. Something else.")).toBe(false)
    expect(match("s 51", "51.2 Something else")).toBe(false)
    expect(match("s 5", "51. Legislative powers of the Parliament.")).toBe(false)
  })

  // Two of the Constitution's navLabels are byte-exactly "86." and "87." —
  // the number and its stop, and no heading text at all (they are navPoints
  // 105 and 106 of `__fixtures__/constitution-toc.ncx`, under "Chapter
  // IV.—Finance and Trade."). A lookahead that insisted on whitespace could
  // not be satisfied at the end of a string, so `get_law_text` answered
  // "[LAW_NOT_FOUND] s 86 is not in the latest table of contents" about a
  // section that is in it — an absence reported without being established,
  // and with no other address to reach the section by.
  it("matches a label that is nothing but the number", () => {
    expect(match("s 86", "86.")).toBe(true)
    expect(match("s 87", "87.")).toBe(true)
    expect(match("cl 86", "86.")).toBe(true)
    expect(match("s 86", "86")).toBe(true)
  })

  it("still refuses the neighbouring numbers of a bare label", () => {
    expect(match("s 8", "86.")).toBe(false)
    expect(match("s 86", "87.")).toBe(false)
    expect(match("s 86", "86A.")).toBe(false)
    expect(match("s 86", "86.1")).toBe(false)
  })
})

describe("extractSectionRefs", () => {
  it("finds every reference in a sentence, in order", () => {
    const found = extractSectionRefs(
      "See s 18 and ss 20-22, together with pt IVA and sch 2 s 18(1) of the Act.",
    )
    expect(found.map(formatRef)).toEqual(["s 18", "ss 20–22", "pt IVA", "sch 2 s 18(1)"])
  })

  it("does not harvest the s inside an ordinary word", () => {
    expect(extractSectionRefs("Acts 2010 are laws; this class 5 is not a reference.")).toEqual([])
  })

  it("finds nothing in text without a designation", () => {
    expect(extractSectionRefs("Mabo v Queensland (No 2) (1992) 175 CLR 1")).toEqual([])
  })

  // Bounded quantifiers only — a scanner that runs over whole documents must
  // not be a denial-of-service surface.
  it("does not backtrack catastrophically on adversarial input", () => {
    const evil = `s ${"1".repeat(2000)}${"(".repeat(400)}`
    const started = Date.now()
    extractSectionRefs(evil)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("does not backtrack catastrophically on adversarial dashed input", () => {
    const evil = [
      `sub-div ${"9".repeat(2000)}-${"A".repeat(500)}`,
      `ss ${"5-".repeat(1000)}`,
      `s ${"A".repeat(3000)}`,
    ]
    const started = Date.now()
    for (const text of evil) extractSectionRefs(text)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  // One string per dash role and one per branch of the roman numeral, because
  // every one of them is compiled into the pattern that runs over documents.
  it("does not backtrack catastrophically on adversarial dashes or roman numbers", () => {
    const evil = [
      `sch ${"1—".repeat(1000)}`,
      `ss ${"5–".repeat(1000)}`,
      `pt ${"2‑".repeat(1000)}`,
      `s 45 ${"— 1 ".repeat(1000)}`,
      `pt ${"IVBA".repeat(1000)}`,
      `pt ${"I".repeat(3000)}`,
      `pt ${"X".repeat(3000)}`,
      // The gap between a designation and its number is the one unbounded
      // quantifier the pattern still has, in both the schedule prefix and the
      // designation, so each is fed whitespace that never reaches a number.
      `s${" ".repeat(20000)}`,
      `sch${" ".repeat(20000)}`,
      `${"part ".repeat(5000)}`,
      `sch${" ".repeat(5000)}s${" ".repeat(5000)}`,
    ]
    const started = Date.now()
    for (const text of evil) extractSectionRefs(text)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("compound numbers in scanned prose", () => {
  it("harvests the whole number, never its front half", () => {
    expect(
      extractSectionRefs("Directors owe duties under Part 2D.1 of the Corporations Act 2001 (Cth)").map(formatRef),
    ).toEqual(["pt 2D.1"])
    expect(extractSectionRefs("The Corporations Act 2001 (Cth) pt 2D.1 imposes duties").map(formatRef)).toEqual([
      "pt 2D.1",
    ])
    expect(extractSectionRefs("shares acquired under Subdivision 83A-C of the ITAA 1997").map(formatRef)).toEqual([
      "sub-div 83A-C",
    ])
  })

  it("drops a number it cannot read whole instead of truncating it", () => {
    // Five components is past the grammar; serving "1.2.3.4" for it would be
    // a different provision reported without a word about the dropped tail.
    expect(extractSectionRefs("see r 1.2.3.4.5 of the rules")).toEqual([])
  })

  it("does not let scientific notation or lowercase prose become a compound number", () => {
    expect(parseSectionRef("s 5e-10")).toBeNull()
    expect(parseSectionRef("pt 2d.1")).toBeNull()
    expect(extractSectionRefs("a tolerance of s 5e-10 units")).toEqual([])
  })
})

describe("lettered structural units in scanned prose", () => {
  it("harvests them, with their multi-letter names whole", () => {
    expect(extractSectionRefs("see Subdivision C of Division 3 of Part 5.3B").map(formatRef)).toEqual([
      "sub-div C",
      "div 3",
      "pt 5.3B",
    ])
    expect(extractSectionRefs("Subdivision CA—Reporting on exercise of powers").map(formatRef)).toEqual([
      "sub-div CA",
    ])
    expect(extractSectionRefs("Division D of that Act applies").map(formatRef)).toEqual(["div D"])
  })

  it("does not read all-caps prose as a multi-letter unit", () => {
    // "PART WAS" passes the uppercase gate that stops "part of"; the
    // mixed-case rule is what tells a citation from a heading's words.
    expect(extractSectionRefs("THE PART WAS DECIDED FIRST")).toEqual([])
    expect(extractSectionRefs("THE RULES CAN BE AMENDED")).toEqual([])
  })

  it("still reads a single-letter unit from any case", () => {
    expect(extractSectionRefs("SCHEDULE A—FORMS").map(formatRef)).toEqual(["sch A"])
  })
})

describe("a plural hyphen pair that names one ITAA section", () => {
  it("keeps the FRL's own typography whole: U+2011 is never a range", () => {
    const ref = parseSectionRef("sections 165‑210")!
    expect(ref.number).toBe("165-210")
    expect(ref.rangeEnd).toBeUndefined()
  })

  it("finds the section a plural pair names, when the Act has it", () => {
    // Scanned text has had its U+2011 folded (htmlToText does it), so
    // "sections 165-210 and 165-211" is byte-identical to the range a writer
    // spells "sections 165 to 210", and the plural is the signal that would
    // make the hyphen mean "to". HYPHEN_RANGE_SPAN_MAX is what decides it:
    // 210 - 165 is far past the width a plain hyphen is allowed to span, so
    // the number stays whole and the reference is the section the ITAA really
    // has — which is what the label pattern below then finds.
    const [ref] = extractSectionRefs("for the purposes of sections 165-210 and 165-211")
    expect(ref.rangeEnd).toBeUndefined()
    expect(ref.number).toBe("165-210")
    const pattern = refToNcxLabelPattern(ref)
    expect(pattern.test("165-210  The business continuity test—carrying on the same business")).toBe(true)
    expect(pattern.test("165-211  The business continuity test—carrying on a similar business")).toBe(false)
    expect(pattern.test("165-21  Some other section")).toBe(false)
  })

  it("still serves a genuine range by its start", () => {
    const ref = parseSectionRef("ss 45-47")!
    expect(ref.rangeEnd).toBe("47")
    const pattern = refToNcxLabelPattern(ref)
    expect(pattern.test("45 Contracts, arrangements or understandings")).toBe(true)
    expect(pattern.test("47 Exclusive dealing")).toBe(false)
  })
})

describe("refToNcxLabelPattern — a label that is only a number", () => {
  it("matches the Constitution's untitled ss 86 and 87", () => {
    // The real C2004Q00685 NCX labels them "86." and "87.", with no heading.
    const pattern = refToNcxLabelPattern(parseSectionRef("s 86")!)
    expect(pattern.test("86.")).toBe(true)
    expect(pattern.test("86")).toBe(true)
    expect(refToNcxLabelPattern(parseSectionRef("s 8")!).test("86.")).toBe(false)
    expect(refToNcxLabelPattern(parseSectionRef("s 86")!).test("86.5  Other")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The bare lettered series, measured rather than sampled.
//
// Round 5 set `SERIES_UNIT_LETTER` to `[A-H]{1,2}` from the tables of contents
// of five Acts. Measured over all 126,207 navLabels of the 1,177 in-force
// principal Commonwealth Acts (`document.ncx` for each, fetched from the
// Federal Register on 2026-09-05) the real series runs A–N in runs of up to
// three, and `[A-H]{1,2}` silently dropped 29 real units — including three of
// the CCA's own. Each label below is quoted verbatim from that capture.
//
// "Silently" is the whole problem: `extractSectionRefs` did not report them as
// unreadable, it reported a document without them, so `verify_citations`
// counted its citations as though the Subdivision had never been cited.
describe("bare lettered units past the front of the alphabet", () => {
  const REAL_LABELS: Array<[label: string, expected: string]> = [
    // Migration Act 1958 (C1958A00062) — Part 2 Division 3.
    ["Subdivision AH—Limit on visas", "sub-div AH"],
    ["Subdivision AI—Safe third countries", "sub-div AI"],
    ["Subdivision AJ—Temporary safe haven visas", "sub-div AJ"],
    ["Subdivision AL—Other provisions about protection visas", "sub-div AL"],
    ["Subdivision AGA—Arrival control determinations", "sub-div AGA"],
    // Customs Act 1901 (C1901A00006).
    ["Subdivision J—General powers to monitor and audit", "sub-div J"],
    ["Subdivision JA—Powers to monitor and audit—Australia-United States Free Trade Agreement", "sub-div JA"],
    ["Subdivision K—Miscellaneous", "sub-div K"],
    // Competition and Consumer Act 2010 (C2004A00109) — this repo's flagship
    // Act has three of the units its own grammar could not read.
    ["Subdivision J—Adverse publicity orders", "sub-div J"],
    ["Subdivision K—Non-punitive orders", "sub-div K"],
    ["Subdivision L—Orders (other than awards of damages) to redress loss or damage", "sub-div L"],
    // Bankruptcy Act 1966 (C1966A00033).
    ["Subdivision K—Rolled-over superannuation interests etc.", "sub-div K"],
    // Veterans' Entitlements Act 1986 (C2004A03268) — the widest single
    // letters in the statute book.
    ["Subdivision M—Decision-making principles", "sub-div M"],
    ["Subdivision N—Information management", "sub-div N"],
    // Three-letter runs: Taxation Administration Act 1953 (C1953A00001) and
    // Social Security (Administration) Act 1999 (C2004A00580).
    ["Subdivision BAA—Offences relating to electronic sales suppression tools", "sub-div BAA"],
    ["Subdivision DAA—Other State/Territory referrals", "sub-div DAA"],
    ["Subdivision FAA—Time limit for claims for Disaster Recovery Allowance", "sub-div FAA"],
  ]

  it("harvests every lettered unit the register really prints", () => {
    const missed: string[] = []
    for (const [label, expected] of REAL_LABELS) {
      const found = extractSectionRefs(label).map(formatRef)
      if (found[0] !== expected) missed.push(`${JSON.stringify(label)} -> ${JSON.stringify(found)}`)
    }
    expect(missed).toEqual([])
  })

  // The sentence from the review that opened this: the Subdivision it is about
  // was the one reference that did not come back.
  it("keeps the lettered unit in a sentence that also names numbered ones", () => {
    expect(extractSectionRefs("The applicant relied on Subdivision AL of Division 3 of Part 2.").map(formatRef))
      .toEqual(["sub-div AL", "div 3", "pt 2"])
    expect(extractSectionRefs("Subdivision AI of the Migration Act applies.").map(formatRef))
      .toEqual(["sub-div AI"])
    expect(extractSectionRefs("See Subdivision J and Subdivision K of Division 3.").map(formatRef))
      .toEqual(["sub-div J", "sub-div K", "div 3"])
  })

  // The other edge of the same measurement. Widening the class is only safe
  // because it stops where the register stops: `[A-Z]{1,3}` run over the same
  // 126,207 labels matched 59 things that are not units, and these are the
  // ones that came out of real recorded text.
  it("still refuses the all-caps words one letter past the series", () => {
    for (const prose of [
      "SCHEDULE OF FEES",
      "PART TO BE REPEALED",
      "DIVISION OR PART",
      "Part TWO",
      "Division ONE",
      // Two adjacent ITAA navLabels in this repo's own fixture: "…object of
      // this Subdivision" followed by "CGT consequences".
      "Application and object of this Subdivision CGT consequences",
      "PART FWC",
      "SCHEDULE PDF",
      "SUBDIVISION TOTAL",
      "PART SUBJECT TO",
    ]) {
      expect(extractSectionRefs(prose).map(formatRef), prose).toEqual([])
    }
  })

  it("still needs the letters in capitals and off the designation", () => {
    expect(extractSectionRefs("part of the agreement")).toEqual([])
    expect(extractSectionRefs("division and control of the company")).toEqual([])
    expect(extractSectionRefs("The PARTIES agreed.")).toEqual([])
    expect(extractSectionRefs("Subdivision al")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The hyphen ceiling belongs to the kinds that are numbered with a hyphen.
//
// `HYPHEN_RANGE_SPAN_MAX` was measured on ITAA 1997 *section* numbers, where a
// plain hyphen really is part of the number. Applied to every kind it inverted
// its own purpose: `items 1-30 of Schedule 2` became one schedule item
// numbered "1-30", which no amending Act has, so a real range of thirty items
// came back as an absence — and item ranges are routine in amending-Act and
// explanatory-memorandum citations.
//
// Which kinds are hyphenated is measured, not assumed: over all 1,177 in-force
// principal Acts the register prints a hyphen inside the number only for
// Parts, Subdivisions and sections.
describe("a wide hyphen range is only a number for the kinds numbered that way", () => {
  it("reads a wide range of schedule items as the range it is", () => {
    expect(normaliseRef("items 1-30")).toBe("items 1–30")
    expect(normaliseRef("items 1-100")).toBe("items 1–100")
    const ref = parseSectionRef("items 1-30")!
    expect(ref.number).toBe("1")
    expect(ref.rangeEnd).toBe("30")
    expect(extractSectionRefs("Fair Work Act 2009 (Cth) items 1-30 of Schedule 2.").map(formatRef))
      .toEqual(["items 1–30", "sch 2"])
  })

  it("reads a wide range of the other never-hyphenated kinds as a range too", () => {
    expect(normaliseRef("chs 1-30")).toBe("chs 1–30")
    expect(normaliseRef("divs 100-200")).toBe("divs 100–200")
    expect(normaliseRef("schs 1-30")).toBe("schs 1–30")
    expect(normaliseRef("cls 1-40")).toBe("cls 1–40")
    expect(normaliseRef("rr 1-30")).toBe("rr 1–30")
    expect(normaliseRef("regs 1-100")).toBe("regs 1–100")
    expect(normaliseRef("arts 1-50")).toBe("arts 1–50")
  })

  // The rule the ceiling was built for is untouched. "165-212E  Entry history
  // rule does not apply for the purposes of sections 165-210 and 165-211" is
  // the ITAA's own navLabel.
  it("still keeps a wide plain-hyphen pair whole for a kind that is hyphenated", () => {
    expect(normaliseRef("ss 165-210")).toBe("ss 165-210")
    expect(parseSectionRef("ss 165-210")!.rangeEnd).toBeUndefined()
    expect(normaliseRef("pts 2-40")).toBe("pts 2-40")
    expect(normaliseRef("sub-divs 100-200")).toBe("sub-divs 100-200")
    // A paragraph's number is the section's, so it is hyphenated too. (AGLC
    // brackets a bare paragraph pinpoint, hence the fields rather than the
    // canonical form.)
    expect(parseSectionRef("paras 230-395")!.number).toBe("230-395")
    expect(parseSectionRef("paras 230-395")!.rangeEnd).toBeUndefined()
    // An en dash still means "to" for those kinds, however wide.
    expect(normaliseRef("ss 165–210")).toBe("ss 165–210")
    // And a narrow hyphen range is still a range.
    expect(normaliseRef("ss 5-6")).toBe("ss 5–6")
    expect(normaliseRef("pts 2-3")).toBe("pts 2–3")
  })
})

// ---------------------------------------------------------------------------
// A pair whose two halves are the same token is one number, not a range.
//
// The Australian Consumer Law really has a Part 2-2, 3-3, 4-4 and 5-5, and the
// ITAA 1997 a section 1-1, 5-5, 15-15, 20-20 and 40-40 — 14 labels in this
// repo's own recorded tables of contents, every one of which the plural form
// read as the range "2 to 2", naming Part 2 instead. The corpus harness is
// where they are counted; these are the named cases.
describe("a degenerate pair is a number, not a range", () => {
  it("reads two identical halves as the provision they spell", () => {
    expect(normaliseRef("pts 2-2")).toBe("pts 2-2")
    expect(normaliseRef("Parts 3-3")).toBe("pts 3-3")
    expect(normaliseRef("ss 20-20")).toBe("ss 20-20")
    expect(normaliseRef("ss 1-1")).toBe("ss 1-1")
    expect(parseSectionRef("ss 40-40")!.rangeEnd).toBeUndefined()
    // An en dash does not rescue it either: "sections 40 to 40" is not a range
    // anyone writes, and s 40-40 is a section the ITAA has.
    expect(normaliseRef("ss 40–40")).toBe("ss 40-40")
  })

  // Equality is only decidable where both halves are a bare number. Only the
  // *leading* integer of a dashed ITAA number is comparable, and `ss 355-25 to
  // 355-30` — a real range — has the same leading integer on both sides, so
  // the test lives at the split rather than in `runsBackwards`.
  // (`statute-citations.ts` spaces the join it builds for exactly this reason:
  // unspaced, `355-25-355-30` is one four-component number to `NUMBER_PATTERN`
  // and never reaches the range branch at all.)
  it("still reads a spaced range whose two sides begin with the same number", () => {
    expect(normaliseRef("ss 355-25 – 355-30")).toBe("ss 355-25–355-30")
    expect(normaliseRef("ss 355-25 - 355-30")).toBe("ss 355-25–355-30")
    const ref = parseSectionRef("ss 355-25 - 355-30")!
    expect(ref.number).toBe("355-25")
    expect(ref.rangeEnd).toBe("355-30")
  })
})

// ---------------------------------------------------------------------------
// The schedule branch answers before the range branch, and had no range
// reading of its own: `schs 1–3` — a range spelled out with an en dash — came
// back as one schedule named "1-3", which no Act has.
describe("a schedule range is a range", () => {
  it("reads a plural schedule pinpoint with a dash as a range", () => {
    expect(normaliseRef("schs 1-3")).toBe("schs 1–3")
    expect(normaliseRef("Schedules 1–3")).toBe("schs 1–3")
    const ref = parseSectionRef("schs 1-3")!
    expect(ref.kind).toBe("schedule")
    expect(ref.number).toBe("1")
    expect(ref.rangeEnd).toBe("3")
    // It round-trips, so the canonical form is one this module can read back.
    expect(normaliseRef(formatRef(ref))).toBe("schs 1–3")
  })

  it("still keeps a singular schedule pinpoint whole", () => {
    expect(normaliseRef("sch 1-3")).toBe("sch 1-3")
    expect(normaliseRef("sch 2")).toBe("sch 2")
    expect(normaliseRef("sch 1 item 4")).toBe("sch 1 item 4")
    // And the heading separator is still a separator, not a range dash.
    expect(extractSectionRefs("Schedule 1—2019 measures").map(formatRef)).toEqual(["sch 1"])
    expect(extractSectionRefs("Schedule 2—The Australian Consumer Law").map(formatRef)).toEqual(["sch 2"])
  })
})
