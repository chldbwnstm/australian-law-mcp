/**
 * The extractors, tested away from the routing table.
 *
 * Most of what is asserted here is a *guard*, not a capability: the provision
 * scanner is case-insensitive and will read "applied" as appendix "lie" unless
 * something stops it, and Australian short titles end in a year that a date
 * parser will happily read as a search window. Those two guards are the
 * difference between plausible parameters and correct ones, and neither is
 * visible from the destination a query routes to.
 */

import { describe, expect, it } from "vitest"
import {
  extractCitations,
  extractDates,
  extractDomainHint,
  extractJurisdictions,
  extractLawMentions,
  extractProvisions,
  firstMnc,
  firstProvision,
  isBareTermQuery,
  pointInTimeDate,
  primaryLawMention,
  provisionParam,
  searchExtract,
  statePreference,
  stripQuestionNoise,
  wantsFullText,
} from "./query-extract.js"

describe("law names", () => {
  it("reads an abbreviation through the alias table", () => {
    expect(primaryLawMention("s 46 CCA")?.name).toBe("Competition and Consumer Act 2010")
    expect(primaryLawMention("FW Act s 387")?.name).toBe("Fair Work Act 2009")
  })

  it("reads a title-case Act name with its year", () => {
    expect(primaryLawMention("Competition and Consumer Act 2010 section 18")?.name).toBe(
      "Competition and Consumer Act 2010",
    )
  })

  it("keeps the year when the year is what identifies the Act", () => {
    // Two Crimes Acts of 1900 (NSW and ACT) and two others of other years.
    // Dropping the year would put four jurisdictions back in play.
    const mention = primaryLawMention("Crimes Act 1900 s 61I")
    expect(mention?.jurisdiction).toBe("NSW")
    expect(mention?.otherJurisdictions).toContain("ACT")
  })

  it("drops a trailing year only when keeping it resolves to nothing", () => {
    // "Fair Work Act 2024" is the FW Act plus an amendment year.
    expect(primaryLawMention("amendments to the Fair Work Act 2024")?.name).toBe("Fair Work Act 2009")
  })

  it("drops a jurisdiction written in front of the title", () => {
    expect(primaryLawMention("QLD WHS Act duties")?.name).toBe("Work Health and Safety Act 2011")
  })

  it("records the schedule an alias actually names", () => {
    expect(primaryLawMention("the ACL")?.sch).toBe("2")
    expect(primaryLawMention("the CCA")?.sch).toBeUndefined()
  })

  it("marks a regulator as a body rather than a statute", () => {
    const mentions = extractLawMentions("gazette notice appointing the ACCC chair")
    expect(mentions.some((mention) => mention.body)).toBe(true)
    expect(primaryLawMention("ACCC")?.body).toBe(true)
  })

  it("prefers the first statute over a regulator named alongside it", () => {
    expect(primaryLawMention("three-tier: FW Act → Regulations → FWC Rules")?.name).toBe("Fair Work Act 2009")
  })

  it("marks a title the Act no longer carries", () => {
    expect(primaryLawMention("TPA s 52")?.superseded).toBe(true)
    expect(primaryLawMention("CCA s 46")?.superseded).toBe(false)
  })

  it("does not read the bare noun `Act` as a statute name", () => {
    // The pasted-letter case: "as required by the Act" names nothing, and
    // resolving it to whatever the table returns first is a confident wrong
    // answer rather than a missing one.
    expect(primaryLawMention('"the Act" s 18 in a pasted letter that never named the Act')).toBeUndefined()
  })

  it("returns the mentions in order of appearance", () => {
    const mentions = extractLawMentions("s 18 of the ACL vs CCA s 18")
    expect(mentions.map((mention) => mention.raw)).toEqual(["ACL", "CCA"])
  })
})

describe("provisions", () => {
  it("parses the ordinary shapes", () => {
    expect(firstProvision("Fair Work Act s 387")).toBe("s 387")
    expect(firstProvision("Corporations Act s 588G")).toBe("s 588G")
    expect(firstProvision("Crimes Act 1900 s 61I")).toBe("s 61I")
  })

  it("applies an alias's schedule to a bare section number", () => {
    const mention = primaryLawMention("s 18 of the ACL")
    expect(firstProvision("s 18 of the ACL", mention)).toBe("sch 2 s 18")
  })

  it("leaves a reference that already names a schedule alone", () => {
    const mention = primaryLawMention("ACL sch 2 s 18")
    expect(firstProvision("ACL sch 2 s 18", mention)).toBe("sch 2 s 18")
  })

  it("does not turn a hyphenated part number into a section", () => {
    expect(firstProvision("Part 2-1 of the ACL", primaryLawMention("Part 2-1 of the ACL"))).toContain("pt 2-1")
  })

  it("ignores numbers that belong to the Act's own title", () => {
    // "Fair Work Regulations 2009" would otherwise parse as regulation 2009,
    // and that reading wins on position — the real reference comes after it.
    expect(firstProvision("Fair Work Regulations 2009 reg 1.07")).toBe("reg 1.07")
    expect(firstProvision("High Court Rules 2004 r 42.02")).toBe("r 42.02")
  })

  it("rejects a reference that is a fragment of an ordinary word", () => {
    // The scanner is case-insensitive, so its roman-numeral branch matches
    // lower-case letters: "applied" is appendix "lie", "since" is section
    // "in". Both would travel as a provision the caller never wrote.
    expect(extractProvisions("which version of the Migration Act applied on 20 March 2020")).toHaveLength(0)
    expect(extractProvisions("what changed in the Privacy Act since 2020")).toHaveLength(0)
    expect(extractProvisions("dispute prep: ACCC vs a merger")).toHaveLength(0)
  })

  it("still finds a real reference in the same sentence shape", () => {
    expect(firstProvision("which version of the Migration Act s 501 applied on 20 March 2020")).toBe("s 501")
  })

  it("finds every reference in a list, each with the schedule applied", () => {
    const mention = primaryLawMention("ACL s 18 and s 29")
    const refs = extractProvisions("ACL s 18 and s 29")
    expect(refs.map((ref) => provisionParam(ref, mention))).toEqual(["sch 2 s 18", "sch 2 s 29"])
  })

  it("keeps a range as a range", () => {
    expect(firstProvision("Fair Work Act ss 60-62")).toBe("ss 60–62")
  })

  it("finds none where there are none", () => {
    expect(extractProvisions("latest High Court judgment")).toHaveLength(0)
    expect(extractProvisions("Dela Cruz v R")).toHaveLength(0)
    expect(extractProvisions("[2010] NSWCCA 333")).toHaveLength(0)
    expect(extractProvisions("175 CLR 1")).toHaveLength(0)
  })
})

describe("citations", () => {
  it("finds a medium-neutral citation", () => {
    expect(firstMnc("is [2019] HCA 23 still good law")?.court).toBe("HCA")
    expect(firstMnc("[2010] NSWCCA 333")?.number).toBe(333)
  })

  it("finds a reported citation", () => {
    const found = extractCitations("is Mabo (1992) 175 CLR 1 still cited").find((result) => result.ok)
    expect(found?.ok && found.citation.kind).toBe("report")
  })

  it("does not invent one out of a Register id", () => {
    expect(extractCitations("C2004A00109").filter((result) => result.ok)).toHaveLength(0)
    expect(extractCitations("F2011L00287").filter((result) => result.ok)).toHaveLength(0)
  })
})

describe("dates", () => {
  it("reads a day-first date", () => {
    expect(pointInTimeDate("Corporations Act 1 July 2018")).toBe("2018-07-01")
    expect(pointInTimeDate("applied on 20 March 2020")).toBe("2020-03-20")
  })

  it("reads `as at`", () => {
    expect(pointInTimeDate("Privacy Act as at 1 December 2022")).toBe("2022-12-01")
  })

  it("resolves a bare year to the end of the period", () => {
    // A point-in-time question about "2009" wants the law as it stood at the
    // end of that year, not on 1 January — the same convention the date table
    // uses for "last year".
    expect(pointInTimeDate("what did s 52 say in 2009")).toBe("2009-12-31")
  })

  it("reads a window", () => {
    expect(extractDates("what changed since 2020").range?.range.from).toBe("2020-01-01")
  })

  it("does not read a statute's own year as a window", () => {
    expect(extractDates("amendments to the Fair Work Act 2024").range).toBeUndefined()
    expect(extractDates("Competition and Consumer Act 2010 section 18").range).toBeUndefined()
  })
})

describe("jurisdictions", () => {
  it("reads abbreviations case-sensitively", () => {
    expect(extractJurisdictions("QLD WHS Act duties")).toContain("Qld")
    expect(extractJurisdictions("Vic Civil Liability Act")).toContain("Vic")
    // Lower-case "act" is the ordinary noun, in nearly every legislation query.
    expect(extractJurisdictions("what act applies here")).not.toContain("ACT")
  })

  it("reads full names", () => {
    expect(extractJurisdictions("New South Wales tenancy law")).toContain("NSW")
    expect(extractJurisdictions("Commonwealth legislation")).toContain("Cth")
    expect(extractJurisdictions("federal law")).toContain("Cth")
  })

  it("reads more than one, in order", () => {
    expect(extractJurisdictions("compare unfair contract terms NSW vs Cth")).toEqual(["NSW", "Cth"])
  })

  it("picks the State when the Commonwealth is only the comparison", () => {
    expect(statePreference("compare unfair contract terms NSW vs Cth")).toBe("NSW")
    expect(statePreference("Commonwealth statutory declaration")).toBeUndefined()
  })
})

describe("domain hints", () => {
  it("maps subject vocabulary to a specialist body", () => {
    expect(extractDomainHint("unfair dismissal claim")).toBe("workplace")
    expect(extractDomainHint("ACCC merger authorisation")).toBe("competition")
    expect(extractDomainHint("data breach notification")).toBe("privacy")
  })

  it("returns nothing rather than guessing", () => {
    expect(extractDomainHint("tree falls on my shed")).toBeUndefined()
  })
})

describe("search-term shaping", () => {
  it("strips trigger words without cutting into real ones", () => {
    expect(searchExtract(/\bgazette\b/gi)("gazette notice appointing the ACCC chair")).toBe(
      "notice appointing the ACCC chair",
    )
  })

  it("returns the original when the trigger words were the whole query", () => {
    expect(searchExtract(/\bgazette\b/gi)("gazette")).toBe("gazette")
  })

  it("keeps prepositions, because a broken phrase searches worse than a long one", () => {
    expect(stripQuestionNoise("what is the code of conduct")).toBe("code of conduct")
    expect(stripQuestionNoise("what are the rules of origin")).toBe("rules of origin")
  })

  it("removes interrogatives and articles", () => {
    expect(stripQuestionNoise("which tools should I use")).toBe("tools use")
  })
})

describe("full-text requests", () => {
  it("recognises a request for the unabridged text", () => {
    expect(wantsFullText("give me the full text of the judgment")).toBe(true)
    expect(wantsFullText("full reasons please")).toBe(true)
  })

  it("is not fooled by the word `full` in other compounds", () => {
    // Each of these would otherwise switch off the abridgement that keeps a
    // judgment inside a context window.
    expect(wantsFullText("full-time employee entitlements")).toBe(false)
    expect(wantsFullText("Full Court of the Federal Court")).toBe(false)
    expect(wantsFullText("in full force and effect")).toBe(false)
  })
})

describe("bare concept queries", () => {
  it("accepts a short lower-case noun phrase", () => {
    expect(isBareTermQuery("penalty unit")).toBe(true)
    expect(isBareTermQuery("unconscionable conduct")).toBe(true)
  })

  it("rejects anything with a number, a proper noun or a question word", () => {
    expect(isBareTermQuery("s 18")).toBe(false)
    expect(isBareTermQuery("penalty unit under the Crimes Act")).toBe(false)
    expect(isBareTermQuery("what is a penalty unit")).toBe(false)
    expect(isBareTermQuery("FW Act")).toBe(false)
    expect(isBareTermQuery("a very long phrase with far too many words in it")).toBe(false)
  })
})
