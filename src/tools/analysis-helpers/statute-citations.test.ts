import { describe, expect, it } from "vitest"
import { DASH_LIKE, extractSectionRefs, formatRef, parseSectionRef } from "../../lib/section-ref.js"
import {
  extractStatuteCitations,
  findFullCites,
  findShortForms,
  preferredStatuteName,
  statuteNameCandidates,
} from "./statute-citations.js"

describe("statuteNameCandidates", () => {
  it("keeps the full reading first so an Act that begins with an article survives", () => {
    const candidates = statuteNameCandidates("A New Tax System (Goods and Services Tax) Act")
    expect(candidates[0]).toBe("A New Tax System (Goods and Services Tax) Act")
  })

  it("offers progressively shorter readings when prose was swallowed", () => {
    expect(statuteNameCandidates("Under the Competition and Consumer Act")).toContain(
      "Competition and Consumer Act",
    )
  })

  it("orders longest first so the real title is tried before a fragment of it", () => {
    const candidates = statuteNameCandidates("Under the Competition and Consumer Act")
    expect(candidates.indexOf("Competition and Consumer Act")).toBeLessThan(candidates.indexOf("Consumer Act"))
  })
})

describe("preferredStatuteName", () => {
  it("picks the reading the alias table knows", () => {
    expect(preferredStatuteName("Under the Competition and Consumer Act")).toBe("Competition and Consumer Act")
  })

  it("falls back to trimming prose when no reading is a known alias", () => {
    expect(preferredStatuteName("Under the Widget Regulation Act")).toBe("Widget Regulation Act")
  })

  it("does not strip the leading article of a real short title", () => {
    const name = "A New Tax System (Goods and Services Tax) Act"
    expect(preferredStatuteName(name)).toBe(name)
  })
})

describe("extractStatuteCitations", () => {
  it("reads a canonical AGLC citation with its jurisdiction", () => {
    const [cite] = extractStatuteCitations("See Competition and Consumer Act 2010 (Cth) s 18 for the rule.", 5)
    expect(cite.lawName).toContain("Competition and Consumer Act")
    expect(cite.jurisdiction).toBe("Cth")
    expect(cite.year).toBe(2010)
    expect(cite.pinpoint).toBe("s 18")
    expect(cite.attachedBy).toBe("trailing-cite")
  })

  it("tolerates markdown italics around the short title", () => {
    const [cite] = extractStatuteCitations("Under the *Fair Work Act 2009* (Cth) s 394 an application lies.", 5)
    expect(cite.lawName).toBe("Fair Work Act")
    expect(cite.jurisdiction).toBe("Cth")
    expect(cite.pinpoint).toBe("s 394")
  })

  it("reads a pinpoint that precedes its Act", () => {
    const [cite] = extractStatuteCitations("s 18 of the Competition and Consumer Act 2010 (Cth) applies.", 5)
    expect(cite.attachedBy).toBe("leading-cite")
    expect(cite.lawName).toBe("Competition and Consumer Act")
    expect(cite.jurisdiction).toBe("Cth")
  })

  it("reads a bare abbreviation and keeps the citation as written", () => {
    const [cite] = extractStatuteCitations("CCA s 18 prohibits misleading or deceptive conduct.", 5)
    expect(cite.attachedBy).toBe("abbreviation")
    expect(cite.lawName).toBe("CCA")
    expect(cite.raw).toBe("CCA s 18")
    expect(cite.claim).toBe("misleading or deceptive conduct")
  })

  // "Under <Act> <section>, <thing> is prohibited" is how a model actually
  // writes the sentence. Before this shape was recognised the claim was never
  // extracted, so the flagship trap — CCA s 18 is 'Meetings of Commission' —
  // was ticked off on existence alone.
  it("reads a claim that follows the pinpoint in the passive", () => {
    const [cite] = extractStatuteCitations(
      "Under the Competition and Consumer Act 2010 (Cth) s 18, misleading conduct is prohibited.",
      5,
    )
    expect(cite.claim).toBe("misleading conduct")
  })

  it("does not manufacture a claim out of a bare comma clause", () => {
    const [cite] = extractStatuteCitations(
      "Under the Competition and Consumer Act 2010 (Cth) s 18, the applicant filed on 3 March.",
      5,
    )
    expect(cite.claim).toBeUndefined()
  })

  it("rewrites an ACL pinpoint into the schedule it actually lives in", () => {
    const [cite] = extractStatuteCitations("ACL s 18 prohibits misleading or deceptive conduct.", 5)
    expect(cite.pinpoint).toBe("sch 2 s 18")
    expect(cite.ref.schedule).toBe("2")
  })

  it("leaves the jurisdiction absent when the writer omitted it", () => {
    const [cite] = extractStatuteCitations("The accused was charged under the Crimes Act s 61.", 5)
    expect(cite.lawName).toBe("Crimes Act")
    expect(cite.jurisdiction).toBeUndefined()
    expect(cite.attachedBy).toBe("bare-name")
  })

  it("inherits the last full citation for 'the Act' inside one paragraph", () => {
    const text = "The Fair Work Act 2009 (Cth) s 382 defines dismissal. The Act s 394 sets the time limit."
    const cites = extractStatuteCitations(text, 5)
    const anaphoric = cites.find((cite) => cite.attachedBy === "anaphora")
    expect(anaphoric?.lawName).toBe("Fair Work Act")
    expect(anaphoric?.pinpoint).toBe("s 394")
    expect(anaphoric?.antecedent).toContain("Fair Work Act 2009 (Cth)")
  })

  it("NEVER inherits across a blank line", () => {
    const text =
      "The Fair Work Act 2009 (Cth) s 382 defines dismissal.\n\nA different topic entirely. That Act s 394 is cited."
    const anaphoric = extractStatuteCitations(text, 5).find((cite) => cite.attachedBy === "anaphora")
    expect(anaphoric).toBeDefined()
    expect(anaphoric?.lawName).toBeUndefined()
  })

  it("binds a short form defined in the text", () => {
    const text =
      "The Fair Work Act 2009 (Cth) ('FW Act') applies.\n\nIn a later paragraph the FW Act s 394 is the source."
    const bound = extractStatuteCitations(text, 5).find((cite) => cite.pinpoint === "s 394")
    expect(bound?.attachedBy).toBe("short-form")
    expect(bound?.lawName).toBe("Fair Work Act")
  })

  it("does not read the year of a titled instrument as a pinpoint", () => {
    const cites = extractStatuteCitations("See Migration Regulations 1994 (Cth) reg 2.01 for the criteria.", 5)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["reg 2.01"])
  })

  it("keeps a pinpoint with no statute at all, rather than dropping it silently", () => {
    const [cite] = extractStatuteCitations("The tribunal considered s 61 at length.", 5)
    expect(cite?.attachedBy).toBe("none")
    expect(cite?.pinpoint).toBe("s 61")
  })

  it("honours maxCitations", () => {
    const text = "Crimes Act 1900 (NSW) s 61, s 62, s 63, s 64, s 65."
    expect(extractStatuteCitations(text, 2)).toHaveLength(2)
  })

  it("de-duplicates the same citation written twice", () => {
    const text = "Competition and Consumer Act 2010 (Cth) s 18 and again Competition and Consumer Act 2010 (Cth) s 18."
    expect(extractStatuteCitations(text, 10)).toHaveLength(1)
  })
})

// The Australian Consumer Law, the Constitution and the two Income Tax
// Assessment Acts are among the most cited law in the country, and none of
// them could reach a pinpoint: the title pattern needed three characters in
// front of its suffix word (so a name that *is* the suffix word never
// matched), "Law" was not a suffix word at all, and the abbreviation shape was
// letters-only.
describe("statutes whose name is, or ends in, a suffix word", () => {
  it("attaches the Australian Consumer Law and rewrites the pinpoint into sch 2", () => {
    const [cite] = extractStatuteCitations(
      "The Australian Consumer Law s 18 prohibits misleading or deceptive conduct.",
      5,
    )
    expect(cite.lawName).toBe("Australian Consumer Law")
    expect(cite.attachedBy).toBe("bare-name")
    expect(cite.pinpoint).toBe("sch 2 s 18")
    expect(cite.ref.schedule).toBe("2")
  })

  it("attaches the Constitution named on its own, before and after the pinpoint", () => {
    const [bare] = extractStatuteCitations("The Constitution s 51(xx) is the corporations power.", 5)
    expect(bare.lawName).toBe("Constitution")
    expect(bare.attachedBy).toBe("bare-name")

    const [lead] = extractStatuteCitations("s 92 of the Constitution guarantees free trade.", 5)
    expect(lead.lawName).toBe("Constitution")
    expect(lead.attachedBy).toBe("leading-cite")
  })

  it("keeps the placitum the writer actually cited", () => {
    const [cite] = extractStatuteCitations("Australian Constitution s 51(xxxvii) is the referral power.", 5)
    expect(cite.pinpoint).toBe("s 51(xxxvii)")
    expect(cite.raw).toBe("Australian Constitution s 51(xxxvii)")
  })

  it("attaches an abbreviation that carries its year", () => {
    const [full] = extractStatuteCitations("ITAA 1997 s 355-25 gives the offset.", 5)
    expect(full.lawName).toBe("ITAA 1997")
    expect(full.attachedBy).toBe("abbreviation")

    const [short] = extractStatuteCitations("ITAA97 s 8-1 allows a deduction.", 5)
    expect(short.lawName).toBe("ITAA97")
    expect(short.attachedBy).toBe("abbreviation")
  })

  // "Law" is a suffix word only inside a name. Lower case is ordinary English
  // and the patterns are case sensitive; a bare `Law` needs a title body in
  // front of it, and trimming never strips a capture down to it.
  it("does not turn ordinary prose into a statute called Law", () => {
    const [lower] = extractStatuteCitations("the law s 5 says otherwise.", 5)
    expect(lower.attachedBy).toBe("none")
    expect(lower.lawName).toBeUndefined()

    const [upper] = extractStatuteCitations("Under this Law s 5 nothing follows.", 5)
    expect(upper.lawName).not.toBe("Law")

    const [away] = extractStatuteCitations("The tribunal noted the Law Reform Commission report s 5.", 5)
    expect(away.lawName).toBeUndefined()
  })

  // A mandatory title body in front of `Law` blocks the bare word and nothing
  // else: "this Law" and "Australian Law" both satisfy it, and a statute the
  // author never named costs a live title lookup and one of `maxCitations`.
  it("does not read a prose phrase that merely ends in Law as a statute", () => {
    const [demonstrative] = extractStatuteCitations("Under this Law s 5 the tribunal may act.", 20)
    expect(demonstrative.lawName).toBeUndefined()
    expect(demonstrative.attachedBy).toBe("none")

    const [adjectival] = extractStatuteCitations("a matter of Australian Law s 5 requires notice.", 20)
    expect(adjectival.lawName).toBeUndefined()
    expect(adjectival.attachedBy).toBe("none")

    const [leading] = extractStatuteCitations("The answer is s 5 of the Australian Law, broadly.", 20)
    expect(leading.lawName).toBeUndefined()
    expect(leading.attachedBy).toBe("none")
  })

  it("reads a plural ITAA pinpoint as the section it names, not an impossible range", () => {
    const [cite] = extractStatuteCitations(
      "Income Tax Assessment Act 1997 (Cth) ss 355-25, 355-30 apply.",
      5,
    )
    expect(cite.ref.number).toBe("355-25")
    expect(cite.ref.rangeEnd).toBeUndefined()
    expect(cite.pinpoint).toBe("ss 355-25")
  })
})

// `ROMAN_NUMBER` is also the tail of half the abbreviations an Australian
// lawyer writes. Read without an edge guard, `SIS` is `s IS` — and sitting
// after a real citation it inherits that Act, so `verify_citations` reports a
// section the Act does not have and calls correct prose a hallucination.
describe("all-caps abbreviations are not roman pinpoints", () => {
  it("does not turn an acronym after a full citation into an impossible pinpoint", () => {
    const cites = extractStatuteCitations(
      "Under the Superannuation Industry (Supervision) Act 1993 (Cth) SIS trustees owe covenants under s 52.",
      15,
    )
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["s 52"])
  })

  it("does not read the other everyday abbreviations as pinpoints", () => {
    expect(extractStatuteCitations("The SDA and the RDA were both considered.", 15)).toEqual([])
    expect(extractStatuteCitations("Chapter SIX of the report deals with it.", 15)).toEqual([])
    expect(extractStatuteCitations("SCHEDULE 2 s 18 of the CCA applies.", 15).map((cite) => cite.pinpoint)).toEqual([
      "s 18",
    ])
  })

  it("does not let phantoms spend the maxCitations budget", () => {
    const cites = extractStatuteCitations(
      "SIS SDA RDA. Competition and Consumer Act 2010 (Cth) s 18 and s 45 and s 46.",
      3,
    )
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["s 18", "s 45", "s 46"])
  })

  it("still reads the roman pinpoints AGLC actually writes", () => {
    const cites = extractStatuteCitations("Constitution s 51(xx), pt IVA and s IV all apply.", 15)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["s 51(xx)", "pt IVA", "s IV"])
  })
})

// One pinpoint, more than one provision. Reading only the first is the failure
// mode this module is built against: the extractor is what `verify_citations`
// counts, so a section dropped here is a section the report says was found and
// checked when it was neither, under a `[VERIFIED]` banner.
//
// The table is the point. Every shape a writer uses lives in it, so a form that
// is not handled is a failing row rather than a silent gap — the earlier fix
// covered the dash and left "and", "to", "&" and the comma list behind.
const MULTI_PROVISION_SHAPES: ReadonlyArray<[string, string[]]> = [
  ["ss 45 and 46", ["ss 45", "s 46"]],
  ["ss 45 & 46", ["ss 45", "s 46"]],
  ["sections 45 and 46", ["ss 45", "s 46"]],
  ["ss 45, 46", ["ss 45", "s 46"]],
  ["ss 45, 46, 47", ["ss 45", "s 46", "s 47"]],
  ["ss 45, 46 and 47", ["ss 45", "s 46", "s 47"]],
  ["ss 45 to 46", ["ss 45–46"]],
  ["ss 45-46", ["ss 45–46"]],
  ["ss 45–46", ["ss 45–46"]],
  ["ss 45 to 47 and 50", ["ss 45–47", "s 50"]],
  ["ss 45AD and 45AF", ["ss 45AD", "s 45AF"]],
  ["ss 355-25, 355-30", ["ss 355-25", "s 355-30"]],
  ["pts IVA and IVB", ["pt IVA", "pt IVB"]],
  ["regs 2.01, 2.02", ["regs 2.01", "reg 2.02"]],
  // The bracketed form of the same list. A "to" here names its two ends: a
  // bracketed range has no representation in `SectionRef`, and the members
  // between them are citations the writer did not make.
  ["sub-ss (2) and (3)", ["sub-s (2)", "sub-s (3)"]],
  ["paras (a), (b) and (c)", ["para (a)", "para (b)", "para (c)"]],
  ["sub-ss (2) to (4)", ["sub-s (2)", "sub-s (4)"]],
]

describe("a pinpoint that names more than one provision", () => {
  it.each(MULTI_PROVISION_SHAPES)("reads every provision of %s", (pinpoint, expected) => {
    const cites = extractStatuteCitations(`Fair Work Act 2009 (Cth) ${pinpoint} apply.`, 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(expected)
    // Each one has to carry the Act, or it reaches the checker as "no statute
    // named" and is reported as unchecked instead of checked.
    expect(cites.every((cite) => cite.lawName === "Fair Work Act")).toBe(true)
    expect(cites.every((cite) => cite.attachedBy !== "unread")).toBe(true)
  })

  it("counts and checks the invented member of a list, which is the whole point", () => {
    const cites = extractStatuteCitations(
      "Anti-competitive agreements are prohibited by Competition and Consumer Act 2010 (Cth) ss 45 and 999.",
      20,
    )
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["ss 45", "s 999"])
    expect(cites[1].raw).toBe("Competition and Consumer Act 2010 (Cth) s 999")
  })

  it("attaches the Act that follows the whole list, not just its first member", () => {
    const cites = extractStatuteCitations("ss 45 and 46 of the Competition and Consumer Act 2010 (Cth) were pleaded.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["ss 45", "s 46"])
    expect(cites.map((cite) => cite.lawName)).toEqual(["Competition and Consumer Act", "Competition and Consumer Act"])
  })

  it("carries the schedule of the list onto every member", () => {
    const cites = extractStatuteCitations("Australian Consumer Law ss 18 and 29 apply.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["sch 2 ss 18", "sch 2 s 29"])
  })

  // A claim describes the list, not either member of it. Matching it against
  // one member's heading is how `✗ CONTENT_MISMATCH` — the verdict that calls
  // correct prose a hallucination — gets invented out of correct writing.
  it("does not attribute a claim about a list to one member of it", () => {
    const cites = extractStatuteCitations(
      "Under the Competition and Consumer Act 2010 (Cth) ss 45 and 46, anti-competitive conduct is prohibited.",
      20,
    )
    expect(cites).toHaveLength(2)
    expect(cites.every((cite) => cite.claim === undefined)).toBe(true)
  })
})

// The reason the list was left unhandled for so long: a rule loose enough to
// read "ss 45, 46" also reads the comma in ordinary prose, and a fabricated
// citation reported as one the writer made is worse than a missing line.
describe("a list never harvests ordinary prose", () => {
  it("does not read the day of a date as a section", () => {
    const singular = extractStatuteCitations("Under s 18, 3 March 2020 the applicant filed.", 20)
    expect(singular.map((cite) => cite.pinpoint)).toEqual(["s 18"])

    const plural = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45, 3 March 2020 was the filing date.", 20)
    expect(plural.map((cite) => cite.pinpoint)).toEqual(["ss 45"])

    const ordinal = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45, 3rd of March 2020 was the date.", 20)
    expect(ordinal.map((cite) => cite.pinpoint)).toEqual(["ss 45"])
  })

  it("does not continue a list after a singular designation", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) s 45, 46 and 47 were mentioned.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["s 45"])
  })

  // `(2020)` is a legal `SUBDIVISION_TOKEN`, so a bracketed list has the same
  // harvest available to it: the year of a reported case, sitting after a
  // citation, would become a subsection nobody cited.
  it("does not read the year of a reported citation as a bracketed member", () => {
    expect(
      extractStatuteCitations("See Fair Work Act 2009 (Cth) ss 18, (2020) 15 ALJ 3.", 20).map((cite) => cite.pinpoint),
    ).toEqual(["ss 18"])
    expect(
      extractStatuteCitations("Fair Work Act 2009 (Cth) sub-ss (2), (2020) 15 ALJ 3.", 20).map((cite) => cite.pinpoint),
    ).toEqual(["sub-s (2)"])
  })

  it("does not continue a bracketed list after a singular designation", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) sub-s (2) and (3) apply.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["sub-s (2)"])
  })

  it("does not read a year in a list of sections as a section", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45, 2010 amendments aside.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toEqual(["ss 45"])
  })

  it("stops at an item that does not keep the shape of the first — and says so", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45 and 46A apply.", 20)
    expect(cites.map((cite) => cite.pinpoint)[0]).toBe("ss 45")
    expect(cites.map((cite) => cite.attachedBy)).toContain("unread")
    expect(cites.some((cite) => cite.raw.includes("46A"))).toBe(true)
  })

  it("reports the item a long list runs past rather than dropping it", () => {
    const numbers = Array.from({ length: 15 }, (_, index) => 45 + index)
    const cites = extractStatuteCitations(`Fair Work Act 2009 (Cth) ss ${numbers.join(", ")} apply.`, 40)
    expect(cites.some((cite) => cite.attachedBy === "unread")).toBe(true)
  })
})

// Round 5: refusing to read one member used to end the whole scan, so every
// member after the first refusal vanished with no unread line — and a bare
// "52" carries no designation, so not even the `PINPOINT_SHAPE` audit could
// find it again. `verify_citations` then printed `[VERIFIED]` over a sentence
// it had only partly read. A refusal is a fact about one member, never a
// licence to stop reading the list.
describe("a refused member never takes the rest of the list with it", () => {
  it("covers every member after a shape change, not only the first mismatch", () => {
    const cites = extractStatuteCitations("The Trade Practices Act 1974 (Cth) ss 51AC, 52 and 53 were considered.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toContain("ss 51AC")
    const unread = cites.filter((cite) => cite.attachedBy === "unread")
    expect(unread.some((cite) => cite.raw.includes("52"))).toBe(true)
    expect(unread.some((cite) => cite.raw.includes("53"))).toBe(true)
  })

  it("keeps reading same-shape members past a mismatched one", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45, 45D and 46 apply.", 20)
    expect(cites.map((cite) => cite.pinpoint)).toContain("ss 45")
    expect(cites.map((cite) => cite.pinpoint)).toContain("s 46")
    expect(cites.some((cite) => cite.attachedBy === "unread" && cite.raw.includes("45D"))).toBe(true)
  })

  // A range joined onto a member that was never read must not fold down onto
  // the last member that was: "ss 45, 46A to 50" is not "ss 45–50", and
  // inventing that range would be a citation the writer did not make.
  it("never folds a range onto a member it did not read", () => {
    const cites = extractStatuteCitations("Fair Work Act 2009 (Cth) ss 45, 46A to 50 apply.", 20)
    expect(cites.map((cite) => cite.pinpoint)).not.toContain("ss 45–50")
    expect(
      cites.some((cite) => cite.attachedBy === "unread" && cite.raw.includes("46A") && cite.raw.includes("50")),
    ).toBe(true)
  })

  // Round 5: past MAX_LIST_ITEMS the scanner returned at the thirteenth
  // continuation, so only that one was reported unread and everything after it
  // disappeared — "14 checked of 14 found" over a sentence naming twenty.
  it("covers every member past the ceiling, not only the first one refused", () => {
    const numbers = Array.from({ length: 20 }, (_, index) => 340 + index)
    const cites = extractStatuteCitations(`The Fair Work Act 2009 (Cth) ss ${numbers.join(", ")} apply.`, 40)
    const read = cites.filter((cite) => cite.attachedBy !== "unread")
    const unread = cites.filter((cite) => cite.attachedBy === "unread")
    for (const number of numbers) {
      const covered =
        read.some((cite) => cite.ref.number === String(number)) ||
        unread.some((cite) => cite.raw.includes(String(number)))
      expect(covered, `s ${number} was neither read nor reported unread`).toBe(true)
    }
  })

  it("covers every bracketed member past the ceiling", () => {
    const tokens = [..."abcdefghijklmno"].map((letter) => `(${letter})`)
    const cites = extractStatuteCitations(`Fair Work Act 2009 (Cth) paras ${tokens.join(", ")} apply.`, 40)
    const read = cites.filter((cite) => cite.attachedBy !== "unread")
    const unread = cites.filter((cite) => cite.attachedBy === "unread")
    for (const token of tokens) {
      const covered =
        read.some((cite) => cite.pinpoint === `para ${token}`) || unread.some((cite) => cite.raw.includes(token))
      expect(covered, `para ${token} was neither read nor reported unread`).toBe(true)
    }
  })
})

// AGLC roman pinpoints are not exotic: 10 of the 16 Part labels of the *Crimes
// Act 1914* carry a two- or three-letter tail, and six of the *Competition and
// Consumer Act 2010*'s do — the six below are navLabels of this repo's own
// `src/lib/__fixtures__/cca-document.ncx`. A tail this scanner cannot span is a
// Part that never reaches the report at all.
const ROMAN_PART_LABELS: ReadonlyArray<[string, string]> = [
  ["Crimes Act 1914", "IAA"],
  ["Crimes Act 1914", "IAAA"],
  ["Crimes Act 1914", "IAAB"],
  ["Crimes Act 1914", "IAAC"],
  ["Crimes Act 1914", "IAB"],
  ["Crimes Act 1914", "IABA"],
  ["Crimes Act 1914", "IAC"],
  ["Crimes Act 1914", "IACA"],
  ["Crimes Act 1914", "IAD"],
  ["Crimes Act 1914", "IAE"],
  ["Competition and Consumer Act 2010", "IIIAA"],
  ["Competition and Consumer Act 2010", "IVA"],
  ["Competition and Consumer Act 2010", "IVBA"],
  ["Competition and Consumer Act 2010", "XIAA"],
  ["Competition and Consumer Act 2010", "XICA"],
  ["Competition and Consumer Act 2010", "XICB"],
]

describe("roman Part numbers with a multi-letter tail", () => {
  it.each(ROMAN_PART_LABELS)("reads %s Part %s", (act, part) => {
    const cites = extractStatuteCitations(`${act} (Cth) Part ${part} sets out the regime.`, 10)
    expect(cites.map((cite) => cite.pinpoint)).toEqual([`pt ${part}`])
    expect(cites[0].lawName).toContain("Act")
  })
})

// The scanner locates, the parser decides. Where the two disagree about how far
// a number runs, the scanner wins — and every disagreement so far handed the
// checker a *different, real* provision to tick the citation off against:
// `s 8AAZLGA` read as `s 8AAZL`, the Register's own `s 355‑25` read as `s 355`,
// `Subdiv 152-A` read as the `sub-div 152` that does not exist.
const NUMBER_SHAPES = [
  "s 18",
  "s 10AA",
  "s 8AAZLGA",
  "s 355-25",
  "s 355‑25",
  "s 51(xx)",
  "s 51(xxxvii)",
  "sub-div 152-A",
  "pt IVA",
  "pt IIIAA",
  "reg 2.01",
  "r 42.02.2",
  "cl 3",
  "sch 2 s 18",
  "ss 5-6",
]

describe("the scanner reads exactly what the parser reads", () => {
  it.each(NUMBER_SHAPES)("does not truncate %s", (pinpoint) => {
    const parsed = parseSectionRef(pinpoint)
    expect(parsed).not.toBeNull()
    const cites = extractStatuteCitations(`Taxation Administration Act 1953 (Cth) ${pinpoint} applies.`, 10)
    expect(cites.map((cite) => cite.pinpoint)).toEqual([formatRef(parsed!)])
    // The whole pinpoint, not a readable prefix of it: a prefix is another real
    // provision, and a prefix is what the checker would report on.
    expect(cites[0].raw.endsWith(pinpoint)).toBe(true)
  })

  // `section-ref.ts` gives every dash character exactly one of three roles —
  // hyphen inside a number, "to" between two numbers, heading separator — and
  // its own document scanner, `extractSectionRefs`, is where those roles are
  // decided. This asserts the two scanners agree character by character, so a
  // dash added to `DASH_LIKE` there cannot quietly change what this one
  // harvests out of a document. (The em dash and the horizontal bar read as the
  // first half on both sides, deliberately: `Schedule 1—2019 measures` is an
  // FRL heading, not the range `sch 1-2019`.)
  it.each([...DASH_LIKE])("agrees with the single source about the dash %s", (dash) => {
    for (const pinpoint of [`s 355${dash}25`, `ss 5${dash}6`]) {
      const cites = extractStatuteCitations(`Income Tax Assessment Act 1997 (Cth) ${pinpoint} applies.`, 10)
      expect(cites.filter((cite) => cite.attachedBy === "unread")).toEqual([])
      expect(cites.map((cite) => cite.pinpoint)).toEqual(extractSectionRefs(pinpoint).map(formatRef))
    }
  })
})

// The audit. A gap in the grammar is not a licence to say nothing: what this
// module cannot read, it counts and names, so `verify_citations` cannot print
// `[VERIFIED]` over a document it only partly read.
describe("nothing located is dropped in silence", () => {
  it("reports a number it cannot read instead of truncating it to one it can", () => {
    const cites = extractStatuteCitations("The tribunal considered s 1234567 at length.", 5)
    expect(cites).toHaveLength(1)
    expect(cites[0].attachedBy).toBe("unread")
    expect(cites[0].raw).toBe("s 1234567")
    expect(cites[0].pinpoint).toContain("PARSE_ERROR")
    expect(cites.some((cite) => cite.pinpoint === "s 1234")).toBe(false)
  })

  it("reports a letter tail longer than any real section rather than cutting it down", () => {
    const cites = extractStatuteCitations("Taxation Administration Act 1953 (Cth) s 8AAZLGAX applies.", 5)
    expect(cites.map((cite) => cite.attachedBy)).toEqual(["unread"])
    expect(cites[0].raw).toBe("s 8AAZLGAX")
  })

  // The invariant every consumer of an unread citation depends on:
  // `statute-check.ts` answers ⚠ before it reads `ref`, and `cite-check.ts`
  // skips the citation entirely — both because there is no `lawName`. An unread
  // fragment that carried one would be looked up as a provision nobody cited.
  it("never attributes a statute to something it could not read", () => {
    const texts = [
      "The tribunal considered s 1234567 at length.",
      "Taxation Administration Act 1953 (Cth) s 8AAZLGAX applies.",
      "Fair Work Act 2009 (Cth) ss 45 and 46A apply.",
      "Competition and Consumer Act 2010 (Cth) s 12345678901 applies.",
    ]
    for (const text of texts) {
      const unread = extractStatuteCitations(text, 20).filter((cite) => cite.attachedBy === "unread")
      expect(unread.length).toBeGreaterThan(0)
      for (const cite of unread) {
        expect(cite.lawName).toBeUndefined()
        expect(cite.jurisdiction).toBeUndefined()
        expect(cite.claim).toBeUndefined()
      }
    }
  })

  // The other half of the audit: a reading refused on purpose is accounted for,
  // so it never comes back as an unread line. Without this the report would
  // carry a `[PARSE_ERROR]` for every acronym and every titled instrument, and
  // a warning that fires on everything is read as firing on nothing.
  it("does not report the readings it refuses on purpose", () => {
    const texts = [
      "The SDA and the RDA were both considered.",
      "Chapter SIX of the report deals with it.",
      "SCHEDULE 2 s 18 of the CCA applies.",
      "See Migration Regulations 1994 (Cth) reg 2.01 for the criteria.",
      "Under the Superannuation Industry (Supervision) Act 1993 (Cth) SIS trustees owe covenants under s 52.",
      "The employee was dismissed under the Fair Work Act 2009 (Cth) s 394, and the s 18-based claim in the " +
        "Competition and Consumer Act 2010 (Cth) failed. See also the Act s 382 and pt IVA.",
      "The rules can be amended; the item is not in issue; the tribunal made a decision in 2019.",
    ]
    for (const text of texts) {
      const unread = extractStatuteCitations(text, 30).filter((cite) => cite.attachedBy === "unread")
      expect(unread.map((cite) => cite.raw)).toEqual([])
    }
  })
})

describe("findFullCites / findShortForms", () => {
  it("locates every complete citation", () => {
    const cites = findFullCites("Fair Work Act 2009 (Cth) and Crimes Act 1900 (NSW) both apply.")
    expect(cites.map((cite) => cite.jurisdiction)).toEqual(["Cth", "NSW"])
  })

  it("registers a parenthetical short-form definition", () => {
    const text = "Fair Work Act 2009 (Cth) ('FW Act')"
    const forms = findShortForms(text, findFullCites(text))
    expect([...forms.keys()]).toContain("fwact")
  })
})
