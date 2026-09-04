import { describe, expect, it } from "vitest"
import {
  extractSectionRefs,
  formatRef,
  normaliseRef,
  parseSectionRef,
  refToNcxLabelPattern,
  type RefKind,
  type SectionRef,
} from "./section-ref.js"

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

  it("still reads en, em, figure, horizontal-bar and minus as ranges", () => {
    for (const dash of ["\u2013", "\u2014", "\u2012", "\u2015", "\u2212"]) {
      expect(normaliseRef(`s 5${dash}6`), dash).toBe("ss 5\u20136")
    }
  })
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

  it("matches a dashed part number", () => {
    expect(match("pt 2-1", "Part 2-1—Misleading or deceptive conduct")).toBe(true)
    expect(match("pt 2-1", "Part 2-2—Unconscionable conduct")).toBe(false)
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
})
