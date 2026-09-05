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

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { allTools, unwrapZodEffects } from "../tool-registry.js"
import type { AuApiClient } from "./api-client.js"
import { normalizeFrlVersion } from "./api-client.js"
import { lawCache } from "./cache.js"
import { ErrorCodes } from "./errors.js"
import { resolveLawAlias } from "./law-alias.js"
import { parseNcx } from "./ncx-parser.js"
import { findNavPoint, htmlToText, sliceProvision } from "./provision-slicer.js"
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
  mentionForTitle,
  pointInTimeDate,
  primaryLawMention,
  provisionParam,
  scopeProvisionsToLaw,
  searchExtract,
  statePreference,
  stripQuestionNoise,
  wantsFullText,
} from "./query-extract.js"
import { formatRef, parseSectionRef } from "./section-ref.js"
import type { FrlTitle } from "./types.js"

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
    expect(firstProvision("Fair Work Act s 387", undefined)).toBe("s 387")
    expect(firstProvision("Corporations Act s 588G", undefined)).toBe("s 588G")
    expect(firstProvision("Crimes Act 1900 s 61I", undefined)).toBe("s 61I")
  })

  it("applies an alias's schedule to a bare section number", () => {
    const mention = primaryLawMention("s 18 of the ACL")
    expect(firstProvision("s 18 of the ACL", mention)).toBe("sch 2 s 18")
  })

  it("leaves a reference that already names a schedule alone", () => {
    const mention = primaryLawMention("ACL sch 2 s 18")
    expect(firstProvision("ACL sch 2 s 18", mention)).toBe("sch 2 s 18")
  })

  describe("mentionForTitle — the schedule belongs to one Act", () => {
    it("keeps the mention when the words and the resolved title agree", () => {
      const mention = primaryLawMention("ACL s 18")
      expect(mentionForTitle(mention, "C2004A00109")).toBe(mention)
    })

    it("drops it when the resolved title is a different Act", () => {
      // `{registerId:"C1914A00012", query:"ACL"}` is a real shape — a tool that
      // takes both, and `chain_amendment_track` hands `compare_old_new` both.
      // Applied blind, CCA sch 2 was asserted of the Crimes Act 1914.
      expect(mentionForTitle(primaryLawMention("ACL s 18"), "C1914A00012")).toBeUndefined()
    })

    it("does not gate an alias the table never pinned to a register id", () => {
      const mention = primaryLawMention("Residential Tenancies Act s 3")
      expect(mention?.titleId).toBeUndefined()
      expect(mentionForTitle(mention, "C1914A00012")).toBe(mention)
    })

    it("is a no-op when the caller holds no title", () => {
      const mention = primaryLawMention("ACL s 18")
      expect(mentionForTitle(mention, undefined)).toBe(mention)
    })

    it("scopeProvisionsToLaw applies it, so no call site can forget", () => {
      const scoped = scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"], titleId: "C1914A00012" })
      expect(scoped.provisions[0].provision).toBe("s 18")
      expect(scoped.rewritten).toBe(false)
      expect(scoped.note).toBeUndefined()
      expect(scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"], titleId: "C2004A00109" }).provisions[0].provision).toBe(
        "sch 2 s 18",
      )
    })
  })

  it("does not turn a hyphenated part number into a section", () => {
    expect(firstProvision("Part 2-1 of the ACL", primaryLawMention("Part 2-1 of the ACL"))).toContain("pt 2-1")
  })

  it("ignores numbers that belong to the Act's own title", () => {
    // "Fair Work Regulations 2009" would otherwise parse as regulation 2009,
    // and that reading wins on position — the real reference comes after it.
    expect(firstProvision("Fair Work Regulations 2009 reg 1.07", undefined)).toBe("reg 1.07")
    expect(firstProvision("High Court Rules 2004 r 42.02", undefined)).toBe("r 42.02")
  })

  it("rejects a reference that is a fragment of an ordinary word", () => {
    // The scanner is case-insensitive, so its roman-numeral branch matches
    // lower-case letters: "applied" is appendix "lie", "since" is section
    // "in". Both would travel as a provision the caller never wrote.
    expect(extractProvisions("which version of the Migration Act applied on 20 March 2020")).toHaveLength(0)
    expect(extractProvisions("what changed in the Privacy Act since 2020")).toHaveLength(0)
    expect(extractProvisions("dispute prep: ACCC vs a merger")).toHaveLength(0)
  })

  it("rejects a designation followed by a whole lower-case roman-letter word", () => {
    // The word-fragment guard passes these — "mix", "id", "is" and "civil"
    // are whole words with clean edges — but every one of them is an ordinary
    // English word the case-insensitive roman branch read as a number. Routed
    // as a provision, "s MIX" comes back [NOT_FOUND] for a section nobody
    // cited, instead of running the search the question asked for.
    expect(extractProvisions("which sections mix civil and criminal penalties")).toHaveLength(0)
    expect(extractProvisions("div id attribute")).toHaveLength(0)
    expect(extractProvisions("the item is")).toHaveLength(0)
    expect(extractProvisions("clause civil liability")).toHaveLength(0)
  })

  it("keeps a genuine roman-numeral part, which AGLC writes in capitals", () => {
    expect(firstProvision("what does pt IVA of the CCA cover", undefined)).toBe("pt IVA")
    expect(firstProvision("Constitution s 51(xx)", undefined)).toBe("s 51(xx)")
    expect(firstProvision("sch IV cl 3", undefined)).toBe("sch IV cl 3")
  })

  it("still finds a real reference in the same sentence shape", () => {
    expect(firstProvision("which version of the Migration Act s 501 applied on 20 March 2020", undefined)).toBe("s 501")
  })

  it("finds every reference in a list, each with the schedule applied", () => {
    const mention = primaryLawMention("ACL s 18 and s 29")
    const refs = extractProvisions("ACL s 18 and s 29")
    expect(refs.map((ref) => provisionParam(ref, mention))).toEqual(["sch 2 s 18", "sch 2 s 29"])
  })

  it("keeps a range as a range", () => {
    expect(firstProvision("Fair Work Act ss 60-62", undefined)).toBe("ss 60–62")
  })

  it("finds none where there are none", () => {
    expect(extractProvisions("latest High Court judgment")).toHaveLength(0)
    expect(extractProvisions("Dela Cruz v R")).toHaveLength(0)
    expect(extractProvisions("[2010] NSWCCA 333")).toHaveLength(0)
    expect(extractProvisions("175 CLR 1")).toHaveLength(0)
  })
})

describe("the (law, provision) choke point", () => {
  it("resolves the law and scopes the provision in one call", () => {
    const scope = scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"] })
    expect(scope.mention?.name).toBe("Competition and Consumer Act 2010")
    expect(scope.schedule).toBe("2")
    expect(scope.provisions[0]).toMatchObject({ raw: "s 18", asked: "s 18", provision: "sch 2 s 18", rewritten: true })
    expect(scope.rewritten).toBe(true)
  })

  it("writes the note the caller has to be shown", () => {
    // A silent substitution is its own trap: the caller asked about s 18 and is
    // being handed a different number, and only the note says why.
    const scope = scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"] })
    expect(scope.note).toContain("sch 2")
    expect(scope.note).toContain("Competition and Consumer Act 2010")
    expect(scope.note).toContain("body of the Act")
  })

  it("reads the provisions out of the query when none are given", () => {
    // The `search_ai_law` shape: no provision parameter, the reference is in
    // the sentence. Same guards as `extractProvisions`, then the schedule.
    const scope = scopeProvisionsToLaw({ query: "ACL s 18 misleading conduct" })
    expect(scope.provisions.map((entry) => entry.provision)).toEqual(["sch 2 s 18"])
    // An empty list means "none asked for" and is NOT read out of the query.
    expect(scopeProvisionsToLaw({ query: "ACL s 18", provisions: [] }).provisions).toEqual([])
  })

  it("scopes every provision in a batch, in order", () => {
    const scope = scopeProvisionsToLaw({ query: "the ACL", provisions: ["s 18", "sch 2 s 29", "pt 2-1"] })
    expect(scope.provisions.map((entry) => entry.provision)).toEqual(["sch 2 s 18", "sch 2 s 29", "sch 2 pt 2-1"])
    expect(scope.provisions.map((entry) => entry.rewritten)).toEqual([true, false, true])
  })

  it("changes nothing when the law named is not a schedule", () => {
    const scope = scopeProvisionsToLaw({ query: "CCA", provisions: ["s 45"] })
    expect(scope.provisions[0]).toMatchObject({ provision: "s 45", rewritten: false })
    expect(scope.schedule).toBeUndefined()
    expect(scope.note).toBeUndefined()
  })

  it("changes nothing when there are no law words at all", () => {
    // `registerId` without `query` — the id fixes the title, and nothing in it
    // says which schedule a bare reference belongs to.
    const scope = scopeProvisionsToLaw({ provisions: ["s 18"] })
    expect(scope.provisions[0]).toMatchObject({ provision: "s 18", rewritten: false })
    expect(scope.mention).toBeUndefined()
  })

  it("passes an unparseable provision through untouched", () => {
    // Validity is the tool's own error path; this function decides schedules.
    const scope = scopeProvisionsToLaw({ query: "ACL", provisions: ["Application of amendments"] })
    expect(scope.provisions[0]).toMatchObject({ provision: "Application of amendments", rewritten: false })
    expect(scope.provisions[0].ref).toBeUndefined()
  })

  it("hands back a parsed ref that matches the scoped string", () => {
    // Callers that need a `SectionRef` (TOC lookup) must not re-parse the
    // *unscoped* text — that is how a rewritten provision is looked up in the
    // wrong place.
    const scope = scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"] })
    expect(scope.provisions[0].ref?.schedule).toBe("2")
    expect(formatRef(scope.provisions[0].ref!)).toBe("sch 2 s 18")
  })

  it("covers the other schedule-carried bodies of law, not just the ACL", () => {
    expect(scopeProvisionsToLaw({ query: "National Credit Code", provisions: ["s 47"] }).provisions[0].provision).toBe(
      "sch 1 s 47",
    )
  })

  it("reads an alias out of a whole sentence, where the alias table needs the whole string", () => {
    // `resolveLawAlias("ACL s 18 misleading conduct")` returns no candidates —
    // it matches a whole query. Tools that consult only that see no schedule.
    expect(resolveLawAlias("ACL s 18 misleading conduct").candidates).toHaveLength(0)
    expect(scopeProvisionsToLaw({ query: "ACL s 18 misleading conduct", provisions: ["s 18"] }).schedule).toBe("2")
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

  it("reads a month and a year as that month, not that year", () => {
    // "as at June 2015" used to fall through to the bare-year rule and hand
    // applicable_law 31 December 2015 — past the 1 July commencement date most
    // Commonwealth amendments take, so the compilation returned included
    // amendments that were not in force on the date asked about.
    expect(pointInTimeDate("Privacy Act as at June 2015")).toBe("2015-06-30")
    // The whole phrase goes, lead-in included: a leftover "as at June" would
    // travel on as a search term.
    expect(extractDates("Privacy Act as at June 2015").rest).toBe("")
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
// ──────────────────────────────────────────────────────────────────────────
// The registry-wide guard
// ──────────────────────────────────────────────────────────────────────────

/**
 * Every tool that takes (law words, provision) must **serve** the provision the
 * alias's schedule names — not merely mention it.
 *
 * This block is the reason `scopeProvisionsToLaw` exists. The ACL **is**
 * schedule 2 of the *Competition and Consumer Act 2010*, so "ACL" + "s 18"
 * means `sch 2 s 18` ("Misleading or deceptive conduct"); the Act's own s 18 is
 * "Meetings of Commission" and it returns real text, so a tool that drops the
 * schedule hands back a confident wrong answer with nothing in it that looks
 * wrong.
 *
 * The rewrite was patched into `law-text.ts`, `batch-provisions.ts`,
 * `provision-history.ts` and `route-patterns.ts` one tool at a time, and three
 * review rounds running a *different* tool was found without it. Site-by-site
 * does not converge, so the check is enumerated instead of listed: the schemas
 * in `allTools` decide who is in scope, and a tool added tomorrow with a
 * law-ish field and a provision-ish field is in scope the moment it is
 * registered. A lib test reaching up to `tool-registry.ts` inverts the usual
 * layering, and that is the point — the registry is the only place that knows
 * every tool.
 *
 * ## Why this was rebuilt (round 5)
 *
 * The first version of this guard asserted two things: that no `s 18` reached
 * `apiClient.getProvision`, and that the answer contained the string
 * `"sch 2 s 18"`. Both are satisfiable without ever reading the right
 * provision. Four of the in-scope tools never call `getProvision` at all — they
 * fetch the TOC and the volume HTML and slice it themselves — so for them the
 * first assertion compared `[]` with `[]`, and all that remained was a
 * substring that the alias table's own note supplies for free. A tool could
 * print the note and then serve "Meetings of Commission" underneath it and pass.
 *
 * So the guard now asserts the **outcome**, over three channels, and a tool
 * must produce evidence on at least one of them:
 *
 *  - `fetched`   — the provision string that crossed the client boundary.
 *  - `served`    — wording that only one of the two provisions' answers can
 *                  carry, taken from the recorded fixtures (the section's own
 *                  text, and its row in `Endnote 4—Amendment history` for the
 *                  tools that answer with an amendment history rather than
 *                  text).
 *  - `addressed` — the follow-up calls and deep links the answer hands the
 *                  caller to act on. A link to the body provision is the same
 *                  wrong answer in a form the user clicks.
 *
 * A tool with **no** evidence on any channel fails: it is not covered by
 * anything, and treating "the harness could not tell" as a pass is what made
 * the previous version vacuous. Two further properties close the two ways a
 * string check can be gamed: the run is repeated for a **second collision**
 * (`s 19`) under a **second alias** ("Australian Consumer Law", which unlike
 * "ACL" carries no explanatory note), so canned `sch 2 s 18` example prose in a
 * tool's own output proves nothing; and a **negative control** drives the same
 * tools with "CCA", which names no schedule, and requires the body provision —
 * over-applying a schedule is the mirror-image wrong answer.
 *
 * ## What is not covered
 *
 * The drive is the CCA only. The other schedule-carried body of law in the
 * alias table, the *National Credit Code* (sch 1 of the *National Consumer
 * Credit Protection Act 2009*), has no recorded fixture, and inventing one is
 * banned for good reason — it would test the tools against an idea of the
 * document rather than the document. The alias itself is pinned at the choke
 * point instead ("covers the other schedule-carried bodies of law", above);
 * what the CCA drive establishes is that each tool routes through that choke
 * point at all, which is the part that kept regressing.
 */
const LAW_FIELD = /^(?:query|lawName|law|act|title|name)$/
const PROVISION_FIELD = /^provisions?$/

/**
 * Zod object shape, defensively: the tests must not go quietly vacuous on a
 * zod upgrade. `unwrapZodEffects` first, because a wrapper hides the shape:
 * `legal_research` sits behind `z.preprocess`, read no fields, and so was
 * silently OUT of this guard's scope until the schema was unwrapped.
 */
function schemaFields(schema: unknown): string[] {
  const holder = unwrapZodEffects(schema) as { shape?: unknown; _def?: { shape?: unknown } }
  const shape = holder?.shape ?? holder?._def?.shape
  const resolved = typeof shape === "function" ? (shape as () => object)() : shape
  return resolved ? Object.keys(resolved as object) : []
}

function toolsWith(predicate: (fields: string[]) => boolean): RegistryTool[] {
  return (allTools as RegistryTool[]).filter((tool) => predicate(schemaFields(tool.schema)))
}

/** The tools this guard governs: they take law words and a provision. */
function inScopeTools(): RegistryTool[] {
  return toolsWith((fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)))
}

interface RegistryTool {
  name: string
  schema: unknown
  handler: (client: AuApiClient, input: never) => Promise<{ content: Array<{ text: string }> }>
}

const CCA_NCX = readFileSync(new URL("../tools/__fixtures__/cca-schedules.ncx", import.meta.url), "utf8")
const CCA_VOL1 = readFileSync(new URL("./__fixtures__/cca-vol1-slice.html", import.meta.url), "utf8")
const CCA_VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-slice.html", import.meta.url), "utf8")
/**
 * `Endnote 4—Amendment history`, which lives at the far end of the same
 * `document_4.html` the schedule text was trimmed from (both captures 2026-09-04
 * — see `src/tools/__fixtures__/PROVENANCE.txt`). It is appended to volume 4
 * below rather than served separately, because that is where the Register puts
 * it, and without it the tools that answer with an amendment history instead of
 * text (`get_provision_history`, `impact_map`, `legal_analysis`) produce nothing
 * this guard can read an outcome from.
 */
const CCA_ENDNOTES = readFileSync(new URL("../tools/__fixtures__/cca-endnote-amendments.html", import.meta.url), "utf8")
const CCA_ENTRIES = parseNcx(CCA_NCX)
const CCA_VERSIONS = (
  JSON.parse(readFileSync(new URL("../tools/__fixtures__/frl-versions-cca.json", import.meta.url), "utf8")) as {
    value: unknown[]
  }
).value.map(normalizeFrlVersion)
const CCA_TITLE: FrlTitle = {
  id: "C2004A00109",
  name: "Competition and Consumer Act 2010",
  collection: "Act",
  status: "InForce",
  isPrincipal: true,
  isInForce: true,
}

/**
 * One Register, stubbed: the CCA, its compilations and its real NCX (which
 * carries both s 18s and both s 19s). `asked` records every provision string
 * that reached the upstream boundary.
 */
function registerStub(asked: string[]): AuApiClient {
  const volumeHtml = (volume: number): string => (volume === 1 ? CCA_VOL1 : CCA_VOL4 + CCA_ENDNOTES)
  return {
    getTitle: async () => CCA_TITLE,
    searchTitles: async () => ({ count: 1, titles: [CCA_TITLE] }),
    listVersions: async () => CCA_VERSIONS,
    listAmenders: async () => ({ count: 0, titles: [] }),
    findVersion: async (p: { asAt?: string; registerId?: string }) =>
      (p.registerId
        ? CCA_VERSIONS.find((version) => version.registerId === p.registerId)
        : CCA_VERSIONS.find((version) => (version.start ?? "") <= `${p.asAt}T00:00:00`)) ??
      CCA_VERSIONS[CCA_VERSIONS.length - 1],
    getToc: async () => CCA_ENTRIES,
    getVolumeHtml: async (_id: string, volume: number) => volumeHtml(volume),
    getProvision: async (_id: string, provision: string, date?: string) => {
      asked.push(provision)
      const ref = parseSectionRef(provision)
      const entry = ref ? findNavPoint(ref, CCA_ENTRIES) : undefined
      if (!entry) throw new Error(`no such provision: ${provision}`)
      const volume = Number(/document_(\d+)/.exec(entry.volumeDoc)?.[1] ?? 1)
      return {
        ref: provision,
        heading: entry.label,
        text: sliceProvision(volumeHtml(volume), entry, CCA_ENTRIES) ?? `${provision} as at ${date ?? "latest"}`,
        volumeDoc: entry.volumeDoc,
        breadcrumb: [],
      }
    },
    fetchJson: async () => ({ "@odata.count": 1, value: [CCA_TITLE] }),
    fetchHtml: async () => "<html></html>",
    fetchBinary: async () => new Uint8Array(),
  } as unknown as AuApiClient
}

/**
 * A number the CCA uses twice: once in the body, once in Schedule 2 (the ACL).
 * Every string here is lifted from the recorded fixtures, and the test below
 * proves each side's wording cannot appear in the other's answer — a guard on
 * the guard, because a marker that stopped discriminating would make this whole
 * block pass silently.
 */
interface Collision {
  /** What a caller writes after naming a body of law that is really a schedule. */
  bare: string
  /** The provision that reference actually means. */
  scoped: string
  /** The provision's own text, from the volume fixtures. */
  text: { schedule: string; body: string }
  /** Its row in `Endnote 4—Amendment history`, for the tools that answer with one. */
  history: { schedule: string; body: string }
}

const COLLISIONS: readonly Collision[] = [
  {
    bare: "s 18",
    scoped: "sch 2 s 18",
    text: {
      schedule: "A person must not, in trade or commerce, engage in conduct that is misleading or deceptive",
      body: "Subject to this section, the Chairperson shall convene",
    },
    // ACL s 18 was inserted whole in 2010 and never amended; the body's s 18
    // predates it by decades. The two rows share no Act number.
    history: { schedule: "No 103, 2010", body: "No 17, 1986" },
  },
  {
    bare: "s 19",
    scoped: "sch 2 s 19",
    text: {
      schedule: "This Part does not apply to a publication of matter by an information provider",
      body: "direct that the powers of the Commission under this Act",
    },
    history: { schedule: "No 109, 2014", body: "No 63, 2019" },
  },
]

/** Which of the two provisions a piece of evidence points at. */
type Side = "schedule" | "body"

interface Evidence {
  channel: "fetched" | "served" | "addressed"
  side: Side
  detail: string
}

/**
 * Fields the harness fills so a tool gets far enough to use the provision at
 * all. Only ever a neutral value for a field whose *absence* short-circuits the
 * handler — `get_historical_law` refuses without a date, `legal_analysis`
 * without a mode, `search_state_law` without a jurisdiction. A tool that needs
 * a field which is not here fails the drive rather than being skipped: see
 * `drive`.
 */
const NEUTRAL_FIELDS: Record<string, unknown> = {
  date: "2020-01-01",
  fromDate: "2026-01-15",
  // Deliberate rather than arbitrary: `legal_analysis`'s other modes do not
  // take a provision, so the first enum option would exercise nothing.
  mode: "impact_map",
  jurisdiction: "NSW",
  // `legal_research` defaults to `full_research`, which never touches
  // `provisions`; `law_system` is its provision-carrying leg.
  task: "law_system",
}

/**
 * Parse the harness's input, repairing what the schema itself can tell us how
 * to repair.
 *
 * A required enum (`search_decisions.domain`, `search_rulings.domain` — same
 * field name, disjoint option sets) cannot be given one neutral value in the
 * table above, and hard-coding a per-tool value is how this sweep would start
 * going stale one tool at a time. A zod `invalid_value` issue carries the
 * options, so the harness reads the answer off the rejection instead. Anything
 * it still cannot satisfy is reported, never skipped.
 */
function parseInput(tool: RegistryTool, input: Record<string, unknown>): { parsed?: never; failure?: string } {
  const schema = tool.schema as { parse: (value: unknown) => never }
  const candidate = { ...input }
  let lastError = ""
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return { parsed: schema.parse(candidate) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      const issues = (error as { issues?: Array<{ path?: unknown[]; values?: unknown[] }> }).issues
      if (!Array.isArray(issues)) return { failure: lastError }
      let repaired = false
      for (const issue of issues) {
        const field = issue.path?.[0]
        if (typeof field !== "string" || !Array.isArray(issue.values) || issue.values.length === 0) continue
        candidate[field] = issue.values[0]
        repaired = true
      }
      if (!repaired) return { failure: lastError }
    }
  }
  return { failure: `schema still rejects the harness input after 4 repairs: ${lastError}` }
}

interface Drive {
  text: string
  asked: string[]
  /** Set when the tool could not be driven at all — never swallowed. */
  failure?: string
}

/** Run one registered tool against the stubbed Register, filling its schema. */
async function drive(tool: RegistryTool, fill: (field: string) => unknown): Promise<Drive> {
  lawCache.clear()
  const input: Record<string, unknown> = {}
  for (const field of schemaFields(tool.schema)) {
    const value = fill(field)
    if (value !== undefined) input[field] = value
  }
  const asked: string[] = []
  const { parsed, failure } = parseInput(tool, input)
  if (failure !== undefined) return { text: "", asked, failure }
  try {
    const result = await tool.handler(registerStub(asked), parsed!)
    return { text: result.content.map((part) => part.text).join("\n"), asked }
  } catch (error) {
    return {
      text: "",
      asked,
      failure: `${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Drive one in-scope tool with a law name and a bare provision reference. */
function driveWithLawAndProvision(tool: RegistryTool, law: string, provision: string): Promise<Drive> {
  return drive(tool, (field) => {
    if (LAW_FIELD.test(field)) return law
    if (field === "provision") return provision
    if (field === "provisions") return [provision]
    return NEUTRAL_FIELDS[field]
  })
}

/**
 * The addresses an answer hands the caller to act on: the follow-up calls it
 * prints and the deep links it builds. Percent- and plus-encoding is undone so
 * a query string is read the way the site will read it.
 */
function addressesIn(text: string): string[] {
  const found = [...text.matchAll(/provision\s*[:=]\s*"([^"]{1,40})"/g)].map((match) => match[1])
  for (const url of text.match(/https?:\/\/\S+/g) ?? []) {
    try {
      found.push(decodeURIComponent(url.replace(/\+/g, " ")))
    } catch {
      found.push(url)
    }
  }
  return found
}

/**
 * Everything the run says about *which* of the two provisions was served.
 * Silence is not a pass: an empty list is a tool this harness cannot observe,
 * and the test treats that as a failure.
 */
function outcomeEvidence(run: Drive, collision: Collision): Evidence[] {
  const evidence: Evidence[] = []
  const number = parseSectionRef(collision.bare)!.number
  const scopedForm = new RegExp(`sch\\s*2\\b[\\s,]*s\\.?\\s*${number}(?![0-9A-Za-z])`, "i")
  const bareForm = new RegExp(`(?:^|[^0-9A-Za-z])s\\.?\\s*${number}(?![0-9A-Za-z])`, "i")

  for (const provision of run.asked) {
    const ref = parseSectionRef(provision)
    const normalised = ref ? formatRef(ref) : provision.trim()
    if (normalised === collision.scoped) evidence.push({ channel: "fetched", side: "schedule", detail: provision })
    else if (normalised === collision.bare) evidence.push({ channel: "fetched", side: "body", detail: provision })
  }

  for (const [side, markers] of [
    ["schedule", [collision.text.schedule, collision.history.schedule]],
    ["body", [collision.text.body, collision.history.body]],
  ] as ReadonlyArray<[Side, string[]]>) {
    for (const marker of markers) {
      if (run.text.includes(marker)) evidence.push({ channel: "served", side, detail: marker })
    }
  }

  for (const address of addressesIn(run.text)) {
    if (scopedForm.test(address)) evidence.push({ channel: "addressed", side: "schedule", detail: address })
    else if (bareForm.test(address)) evidence.push({ channel: "addressed", side: "body", detail: address })
  }

  return evidence
}

const show = (evidence: Evidence[]): string =>
  evidence.map((item) => `    [${item.channel}] ${item.detail.slice(0, 160)}`).join("\n")

/**
 * Assert that one run served the provision it was supposed to. Two failures are
 * possible and they mean different things, so they are reported differently.
 */
function expectServed(tool: string, scenario: string, run: Drive, collision: Collision, want: Side): void {
  expect(
    run.failure,
    `${tool} could not be driven (${scenario}): ${run.failure}\n` +
      "An untestable tool is an untested tool. Add whatever neutral value its schema needs to " +
      "NEUTRAL_FIELDS, or fix the handler — do not remove it from the sweep.",
  ).toBeUndefined()

  const evidence = outcomeEvidence(run, collision)
  const wrong = evidence.filter((item) => item.side !== want)
  const wanted = want === "schedule" ? collision.scoped : collision.bare
  const other = want === "schedule" ? collision.bare : collision.scoped

  expect(
    wrong,
    `${tool} (${scenario}) answered with ${other} where ${wanted} was asked for:\n${show(wrong)}\n` +
      "Route (query|lawName, provision) through scopeProvisionsToLaw() and use its result for the " +
      "fetch, the text, and every link and follow-up call printed beside it.",
  ).toEqual([])

  expect(
    evidence.length,
    `${tool} (${scenario}) gave this harness nothing to check: it never fetched the provision, never ` +
      `printed either provision's wording, and never addressed one in a link or follow-up call.\n` +
      "That is not a pass — the previous version of this guard accepted exactly this and let a tool " +
      "serve the wrong provision for three review rounds. Make the outcome observable (print the " +
      "provision text, or address it in the call you suggest), or add a marker for whatever it does " +
      "answer with to COLLISIONS.",
  ).toBeGreaterThan(0)
}


/**
 * The two s 18s, as the recorded fixtures serve them (case-sensitive, and
 * checked against the fixtures below so a re-captured fixture cannot silently
 * blunt the assertions):
 *
 *  - sch 2 s 18 lives in `document_4` and its operative words are the
 *    misleading-conduct prohibition;
 *  - the body's s 18 lives in `document_1` under "Meetings of Commission".
 *
 * The alias table's own note spells the trap out in *lower case* ("meetings
 * of Commission"), so these exact strings can only come from served text —
 * a tool cannot satisfy or trip them by printing the note.
 */
const SCHEDULE_S18_TEXT = "misleading or deceptive or is likely to mislead or deceive"
const BODY_S18_HEADING = "Meetings of Commission"
const BODY_S18_TEXT = "convene such meetings of the Commission"

type OutcomeContract =
  /** The tool serves provision text: the schedule's words must be in it. */
  | { outcome: "serves_schedule_text" }
  /** The tool answers *about* the provision: the subject it names must be the schedule's. */
  | { outcome: "names_schedule_subject"; subject: RegExp }
  /**
   * The tool hands addresses to a browser: every URL that pinpoints s 18
   * must carry the schedule, because the browser follows the URL, not any
   * warning printed beside it.
   */
  | { outcome: "addresses_carry_schedule" }

/**
 * What each in-scope tool owes for "ACL" + "s 18", on top of the universal
 * assertions (no bare `s 18` to the Register, no body-provision text served,
 * the `sch 2 s 18` rewrite visible). Keyed by tool name; the enumeration test
 * holds this table equal to the live in-scope set, so a new (law, provision)
 * tool FAILS until it gets a line here — there is no skip and no exemption.
 */
const IN_SCOPE: Record<string, OutcomeContract> = {
  get_law_text: { outcome: "serves_schedule_text" },
  get_batch_provisions: { outcome: "serves_schedule_text" },
  get_instrument_provisions: { outcome: "serves_schedule_text" },
  get_historical_law: { outcome: "serves_schedule_text" },
  applicable_law: { outcome: "serves_schedule_text" },
  chain_law_system: { outcome: "serves_schedule_text" },
  legal_research: { outcome: "serves_schedule_text" },
  get_provision_history: { outcome: "names_schedule_subject", subject: /Amendment history of sch 2 s 18/ },
  compare_old_new: { outcome: "names_schedule_subject", subject: /Text of sch 2 s 18/ },
  chain_amendment_track: { outcome: "names_schedule_subject", subject: /Text of sch 2 s 18/ },
  impact_map: { outcome: "names_schedule_subject", subject: /Provision: sch 2 s 18 — "Misleading or deceptive conduct"/ },
  legal_analysis: { outcome: "names_schedule_subject", subject: /Provision: sch 2 s 18 — "Misleading or deceptive conduct"/ },
  get_external_links: { outcome: "addresses_carry_schedule" },
}

/**
 * The `ACL` + `s 18` drive, in the shape the contract table above reads: a
 * tool the harness cannot drive is a FAILING test with the message attached,
 * never a silently weaker assertion.
 */
async function runWithAclSection18(tool: RegistryTool): Promise<{ text: string; asked: string[]; threw?: string }> {
  const run = await driveWithLawAndProvision(tool, "ACL", "s 18")
  return { text: run.text, asked: run.asked, threw: run.failure }
}

describe("the alias's schedule, across the whole registry", () => {
  it("the fixtures keep the two s 18s distinguishable — the guard of the guard", () => {
    // If a re-captured fixture, a marker typo or a rewritten alias note ever
    // stops these holding, every outcome assertion below would still run and
    // prove nothing; this is the test that makes that loud instead of quiet.
    expect(CCA_VOL4).toContain(SCHEDULE_S18_TEXT)
    expect(CCA_VOL4).not.toContain(BODY_S18_HEADING)
    expect(CCA_VOL4).not.toContain(BODY_S18_TEXT)
    expect(CCA_VOL1).toContain(BODY_S18_HEADING)
    expect(CCA_VOL1).toContain(BODY_S18_TEXT)
    expect(CCA_VOL1).not.toContain(SCHEDULE_S18_TEXT)
    // The notes the tools print about the alias must satisfy or trip nothing
    // by themselves — that vacuity is exactly what this guard was rebuilt for.
    const aliasNote = resolveLawAlias("ACL").candidates[0]?.notes ?? ""
    const rewriteNote = scopeProvisionsToLaw({ query: "ACL", provisions: ["s 18"] }).note ?? ""
    expect(aliasNote.length).toBeGreaterThan(20)
    expect(rewriteNote.length).toBeGreaterThan(20)
    for (const note of [aliasNote, rewriteNote]) {
      expect(note).not.toContain(SCHEDULE_S18_TEXT)
      expect(note).not.toContain(BODY_S18_HEADING)
      expect(note).not.toContain(BODY_S18_TEXT)
    }
  })

  it("the fixtures make the two provisions distinguishable", () => {
    // The guard on the guard. Every assertion below is a string comparison
    // against these markers, so if a fixture recapture ever made one side's
    // wording appear in the other's text the whole block would go quietly
    // vacuous — the exact failure mode this rebuild exists to remove.
    for (const collision of COLLISIONS) {
      const slice = (reference: string, html: string): string => {
        const ref = parseSectionRef(reference)
        expect(ref, `${reference} no longer parses`).not.toBeNull()
        const entry = findNavPoint(ref!, CCA_ENTRIES)
        expect(entry, `${reference} is not in the recorded CCA NCX`).toBeDefined()
        return sliceProvision(html, entry!, CCA_ENTRIES) ?? ""
      }
      const scheduleText = slice(collision.scoped, CCA_VOL4)
      const bodyText = slice(collision.bare, CCA_VOL1)

      expect(scheduleText).toContain(collision.text.schedule)
      expect(bodyText).toContain(collision.text.body)
      expect(bodyText).not.toContain(collision.text.schedule)
      expect(scheduleText).not.toContain(collision.text.body)

      // The endnote rows are two different amending Acts, and the table that
      // holds both is what the history tools read. It is checked as text, not
      // markup: the fixture splits "No" and "103, 2010" across sibling spans.
      const endnotes = htmlToText(CCA_ENDNOTES)
      expect(endnotes).toContain(collision.history.schedule)
      expect(endnotes).toContain(collision.history.body)
      expect(collision.history.schedule).not.toBe(collision.history.body)
    }
  })

  describe("the guard on the guard — what this check would let through", () => {
    // A registry sweep is only worth its complexity if it rejects the answer it
    // was built to reject, and the previous version did not. These three drive
    // `expectServed` with answers written by hand, so the sweep's own verdict is
    // pinned instead of being taken on trust.
    const collision = COLLISIONS[0]

    it("rejects the answer shape the round-4 version accepted", () => {
      // Verbatim in shape: the alias table's note (which spells out
      // "sch 2 s 18"), and underneath it the body provision's text, sliced from
      // the volume by the tool itself so nothing reached `getProvision`. That
      // satisfies both of the old assertions — `asked` is empty and the text
      // contains "sch 2 s 18" — while answering "ACL s 18" with "Meetings of
      // Commission".
      const decoy: Drive = {
        asked: [],
        text:
          'Alias "ACL" → Competition and Consumer Act 2010 (Cth), sch 2. Read "s 18" as "sch 2 s 18".\n' +
          "18 Meetings of Commission\n" +
          `    (1) ${collision.text.body} such meetings of the Commission as he or she thinks necessary.`,
      }
      expect(decoy.asked, "the round-4 assertion").toEqual([])
      expect(decoy.text, "the round-4 assertion").toContain("sch 2 s 18")
      expect(() => expectServed("decoy", "ACL + s 18", decoy, collision, "schedule")).toThrow(
        /answered with s 18 where sch 2 s 18 was asked for/,
      )
    })

    it("rejects an answer that says the right thing and shows nothing", () => {
      const decoy: Drive = { asked: [], text: "Read 'ACL s 18' as sch 2 s 18. See the Register for the text." }
      expect(outcomeEvidence(decoy, collision)).toEqual([])
      expect(() => expectServed("decoy", "ACL + s 18", decoy, collision, "schedule")).toThrow(
        /gave this harness nothing to check/,
      )
    })

    it("accepts an answer that actually serves the schedule's provision", () => {
      const honest: Drive = {
        asked: ["sch 2 s 18"],
        text: `18 Misleading or deceptive conduct\n    (1) ${collision.text.schedule} or is likely to mislead.`,
      }
      expect(() => expectServed("decoy", "ACL + s 18", honest, collision, "schedule")).not.toThrow()
    })
  })

  /**
   * The scenarios every in-scope tool is driven through. Two aliases and two
   * section numbers, so neither the literal string "ACL" nor a canned
   * `sch 2 s 18` example in a tool's own prose can carry a tool through.
   */
  const SCHEDULE_ALIASES: ReadonlyArray<[string, Collision]> = [
    ["ACL", COLLISIONS[0]],
    // No `notes` entry in the alias table, so nothing prints the schedule for
    // this one unless the tool applied it.
    ["Australian Consumer Law", COLLISIONS[1]],
  ]

  it.each(SCHEDULE_ALIASES)(
    "every in-scope tool serves the schedule's provision for '%s'",
    async (law, collision) => {
      const candidates = inScopeTools()
      for (const tool of candidates) {
        const run = await driveWithLawAndProvision(tool, law, collision.bare)
        expectServed(tool.name, `${law} + ${collision.bare}`, run, collision, "schedule")
      }
    },
    60_000,
  )

  it("no in-scope tool applies a schedule the caller never named", async () => {
    // The mirror-image error, and the one a fix for the above is most likely to
    // introduce: "CCA" is the Act itself, so "s 18" means the body's s 18
    // ("Meetings of Commission") and rewriting it to sch 2 would be the same
    // confident wrong answer pointing the other way.
    for (const tool of inScopeTools()) {
      for (const collision of COLLISIONS) {
        const run = await driveWithLawAndProvision(tool, "CCA", collision.bare)
        expectServed(tool.name, `CCA + ${collision.bare}`, run, collision, "body")
      }
    }
  }, 60_000)

  it("the in-scope set is exactly the contracted set — a new (law, provision) tool fails here until it gets an outcome contract", () => {
    // Also guards the enumeration itself: a zod upgrade that changed `.shape`
    // would read [] fields off every tool and shrink `found` to nothing, which
    // this equality reports instead of letting the outcome test loop over an
    // empty list.
    const found = toolsWith(
      (fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)),
    )
      .map((tool) => tool.name)
      .sort()
    expect(
      found,
      "The live registry's (law, provision) tools and the IN_SCOPE contract table have diverged. " +
        "A name only in the left list is a new in-scope tool: give it an OutcomeContract (and make it pass the " +
        "outcome test) — do not exempt it. A name only in the right list is a stale contract: delete it.",
    ).toEqual(Object.keys(IN_SCOPE).sort())
  })

  it("every in-scope tool answers 'ACL' + 's 18' with schedule 2 — the outcome, not the call shape", async () => {
    const candidates = toolsWith(
      (fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)),
    )
    // Belt to the enumeration test's braces: this loop must never quietly run
    // over nothing.
    expect(candidates.length).toBeGreaterThanOrEqual(13)

    for (const tool of candidates) {
      const contract = IN_SCOPE[tool.name]
      if (!contract) {
        expect.fail(
          `${tool.name} takes a law and a provision but has no outcome contract — add it to IN_SCOPE and make it ` +
            "pass this test. There is no skip path: an undriven tool is exactly where the body-for-schedule " +
            "substitution hides.",
        )
      }
      const { text, asked, threw } = await runWithAclSection18(tool)
      expect(
        threw,
        `${tool.name} could not be driven by this harness — fix the input table (NEUTRAL_FIELDS) or the tool. ` +
          "A tool the harness cannot drive fails; it is never skipped.",
      ).toBeUndefined()

      // Universal, for every contract kind: the Register must never be asked
      // for the body's s 18, the body provision's text must never be served,
      // and the rewrite must be visible (a silent substitution is its own trap).
      const bodySection = asked.filter((provision) => /^s\.?\s*18$/i.test(provision.trim()))
      expect(
        bodySection,
        `${tool.name} asked the Register for the Act's own s 18 ("Meetings of Commission"). ` +
          "Route (query|lawName, provision) through scopeProvisionsToLaw().",
      ).toEqual([])
      expect(
        text,
        `${tool.name} served the BODY s 18's heading for an ACL question — the exact confusion this project exists ` +
          "to prevent. However this tool fetches text (getProvision or its own volume slice), the alias's schedule " +
          "must be applied first.",
      ).not.toContain(BODY_S18_HEADING)
      expect(
        text,
        `${tool.name} served the BODY s 18's operative text for an ACL question.`,
      ).not.toContain(BODY_S18_TEXT)
      expect(
        text,
        `${tool.name} never says "sch 2 s 18" — it either dropped the schedule or applied it silently. ` +
          "Route (query|lawName, provision) through scopeProvisionsToLaw() and print its note.",
      ).toContain("sch 2 s 18")

      // The contract: what THIS tool's answer must positively establish.
      if (contract.outcome === "serves_schedule_text") {
        expect(
          text,
          `${tool.name} claims to serve provision text but the schedule s 18's operative words are not in its ` +
            "answer — the alias note alone does not satisfy this guard.",
        ).toContain(SCHEDULE_S18_TEXT)
      } else if (contract.outcome === "names_schedule_subject") {
        expect(
          text,
          `${tool.name} does not name sch 2 s 18 as the subject of its answer (expected ${String(contract.subject)}).`,
        ).toMatch(contract.subject)
      } else if (contract.outcome === "addresses_carry_schedule") {
        const urls = [...text.matchAll(/https?:\/\/\S+/g)].map((match) =>
          decodeURIComponent(match[0]).replace(/\+/g, " "),
        )
        const pinpointed = urls.filter((url) => /\bs ?18\b/i.test(url))
        expect(
          pinpointed.length,
          `${tool.name} built no s 18 address at all — this contract no longer tests anything; re-examine it.`,
        ).toBeGreaterThan(0)
        for (const url of pinpointed) {
          expect(
            url,
            `${tool.name}: a browser follows the URL, not the warning beside it — a section-18 address for an ` +
              "ACL question must carry the schedule.",
          ).toMatch(/\bsch ?2\b/i)
        }
      }
    }
  }, 60_000)
})

// ──────────────────────────────────────────────────────────────────────────
// The second sweep: the tools that read a provision out of the question
// ──────────────────────────────────────────────────────────────────────────

/**
 * The other half of the class, and the one round 3 missed: a tool with no
 * `provision` field that lifts the reference out of the query itself and acts
 * on it — `search_ai_law`, and every chain that embeds it. "ACL s 29" means
 * `sch 2 s 29` (*False or misleading representations about goods or services*)
 * exactly as "ACL s 18" does, and a follow-up call printed at the bare `s 29`
 * sends the caller to the Act's own s 29 (*Delegation by Commission*).
 *
 * s 29 rather than s 18 because "s 18" is the canned example in
 * `get_law_text`'s "Next:" block, and a canned example is not a reading of this
 * question. s 29 is not in the recorded NCX, so nothing here can be established
 * from served text; what the answer **addresses** is the evidence.
 *
 * ## Why this needed a table
 *
 * The sweep used to drive every tool and make one negative assertion — nothing
 * may address the bare `s 29`. For the two tools that read a provision that is
 * the whole point; for the other thirty-six it compares `[]` with `[]`, and a
 * tool that stopped scoping tomorrow would only be caught if it happened to be
 * one of the two. Worse, the set was open: a tool registered tomorrow was swept
 * in silence, and if the harness could not drive it there was nothing to say so.
 *
 * So each swept tool now carries a row saying what its answer to this question
 * must establish, the table is held **equal** to the live swept set (a new tool
 * fails here until someone writes it a row), and every class is asserted rather
 * than assumed:
 *
 *  - `scopes_from_query` — it reads the provision and applies the schedule. The
 *    scoped form must appear in what it addresses, and the bare form must not.
 *  - `names_no_provision` — it answers this question without naming a provision
 *    at all. That is asserted, not assumed: a tool that starts reading one and
 *    prints it fails here, and the fix is to scope it and move the row up.
 *  - `unreachable_offline` — its only source has no recorded fixture, so it
 *    refuses before it ever looks at the question. An exclusion with a reason,
 *    and the reason is checked: the answer must still open with a bracket label
 *    from `ErrorCodes`, so a row cannot outlive the gap that justified it. If
 *    someone records that source, the row fails and the tool must be
 *    re-classified rather than quietly staying out of the sweep.
 *
 * There is no fourth class and no skip path. A tool this harness cannot drive
 * is a failing test naming the tool and the field its schema needs.
 */
type QuerySweepContract =
  /** Reads the provision out of the query and applies the alias's schedule to it. */
  | { outcome: "scopes_from_query" }
  /** Answers without naming a provision — asserted, so one that starts naming one fails. */
  | { outcome: "names_no_provision" }
  /** No recorded fixture for its source: it refuses before reaching the question. */
  | { outcome: "unreachable_offline"; reason: string }

const QUERY_SWEEP: Record<string, QuerySweepContract> = {
  // ── reads the provision out of the question ──────────────────────────────
  search_ai_law: { outcome: "scopes_from_query" },
  chain_full_research: { outcome: "scopes_from_query" },

  // ── answers this question without naming a provision ─────────────────────
  chain_action_basis: { outcome: "names_no_provision" },
  chain_dispute_prep: { outcome: "names_no_provision" },
  chain_procedure_detail: { outcome: "names_no_provision" },
  chain_state_law_compare: { outcome: "names_no_provision" },
  get_enabled_instruments: { outcome: "names_no_provision" },
  get_enabling_acts: { outcome: "names_no_provision" },
  get_law_history: { outcome: "names_no_provision" },
  get_law_system_tree: { outcome: "names_no_provision" },
  get_law_tree: { outcome: "names_no_provision" },
  get_legal_term_kb: { outcome: "names_no_provision" },
  get_plain_term: { outcome: "names_no_provision" },
  get_related_laws: { outcome: "names_no_provision" },
  get_schedules: { outcome: "names_no_provision" },
  get_state_equivalents: { outcome: "names_no_provision" },
  get_three_tier: { outcome: "names_no_provision" },
  instrument_radar: { outcome: "names_no_provision" },
  search_agency_rules: { outcome: "names_no_provision" },
  search_all: { outcome: "names_no_provision" },
  search_explanatory: { outcome: "names_no_provision" },
  search_gazettes: { outcome: "names_no_provision" },
  search_historical_law: { outcome: "names_no_provision" },
  search_law: { outcome: "names_no_provision" },
  search_treaties: { outcome: "names_no_provision" },

  // ── no recorded fixture for the source they read ─────────────────────────
  // Each of these is a decision or state-legislation corpus this repository has
  // no capture of, and inventing one is banned for the reason `CLAUDE.md` gives:
  // it would test the tool against an idea of the page. The reason is what a
  // reviewer needs to decide whether the row should still be here.
  search_cases: {
    outcome: "unreachable_offline",
    reason:
      "the case-law sources (AustLII, LawCite, judgments.fedcourt.gov.au) are blocked hosts with no recorded page, so the tool refuses before it reads the question",
  },
  search_decisions: {
    outcome: "unreachable_offline",
    reason:
      "the 18-domain dispatcher lands on the same case-law sources as search_cases for its default domain, and none of them has a fixture",
  },
  search_admin_appeals: {
    outcome: "unreachable_offline",
    reason: "NCAT and QCAT are scraped HTML with no recorded page in this repository",
  },
  search_rulings: {
    outcome: "unreachable_offline",
    reason: "the ATO Legal Database is a separate search API with no recorded response",
  },
  search_competition_decisions: {
    outcome: "unreachable_offline",
    reason:
      "the ACCC public registers and the Competition Tribunal return 403 to non-browser clients — a blocked host, so there is nothing to record",
  },
  search_constitutional_decisions: {
    outcome: "unreachable_offline",
    reason: "hcourt.gov.au is scraped HTML with no recorded page",
  },
  search_integrity_decisions: {
    outcome: "unreachable_offline",
    reason: "nacc.gov.au is scraped HTML with no recorded page",
  },
  search_privacy_decisions: {
    outcome: "unreachable_offline",
    reason: "oaic.gov.au is scraped HTML with no recorded page",
  },
  search_public_service_decisions: {
    outcome: "unreachable_offline",
    reason: "mpc.gov.au is scraped HTML with no recorded page",
  },
  search_tax_tribunal_decisions: {
    outcome: "unreachable_offline",
    reason: "ato.gov.au's decision-impact listing is scraped HTML with no recorded page",
  },
  search_workplace_decisions: {
    outcome: "unreachable_offline",
    reason: "fwc.gov.au is scraped HTML with no recorded page",
  },
  search_state_law: {
    outcome: "unreachable_offline",
    reason:
      "the NSW and SA registers are blocked hosts — this server does not fetch them, which is not evidence they have no such Act",
  },
  search_university_rules: {
    outcome: "unreachable_offline",
    reason: "it reads the same blocked state registers as search_state_law",
  },
}

/** The tools this second sweep governs: law words, and no provision field. */
function querySweepTools(): RegistryTool[] {
  return toolsWith((fields) => fields.some((f) => LAW_FIELD.test(f)) && !fields.some((f) => PROVISION_FIELD.test(f)))
}

const QUERY_SWEEP_QUESTION = "ACL s 29 false representations"

/** Every bracket label this server may open a refusal with. */
const REFUSAL_LABEL = new RegExp(`^\\[(?:${Object.values(ErrorCodes).join("|")})\\]`)

/**
 * What a run says about the provision it read out of the question: the
 * follow-up calls it prints, the deep links it builds, and the provision
 * strings that crossed the client boundary.
 *
 * The question is stripped out of each address first, and that is not a
 * loophole — it is the difference between a reading and an echo. This question
 * contains the words "s 29", so a tool that puts it in a search box builds
 * `.../search/text/ACL s 29 false representations`, which opens a search for
 * the caller's own sentence and pinpoints nothing. `search_ai_law` does exactly
 * that and is right to. What has to be judged is the `s 29` a tool writes
 * itself — the follow-up call, the section link — so the echoed sentence comes
 * out before the address is read.
 */
function provisionsAddressed(run: Drive): string[] {
  const found = [...run.text.matchAll(/provision\s*[:=]\s*"([^"]{1,40})"/g)].map((match) => match[1].trim())
  for (const url of run.text.match(/https?:\/\/\S+/g) ?? []) {
    try {
      found.push(decodeURIComponent(url.replace(/\+/g, " ")))
    } catch {
      found.push(url)
    }
  }
  return [...found, ...run.asked.map((provision) => provision.trim())].map((item) =>
    item.split(QUERY_SWEEP_QUESTION).join(" "),
  )
}

const SCOPED_29 = /sch\s*2\b[\s,]*s\.?\s*29(?![0-9A-Za-z])/i
const BARE_29 = /(?:^|[^0-9A-Za-z])s\.?\s*29(?![0-9A-Za-z])/i

/** Assert one run against its row. Split out so the decoys below can drive it. */
function expectQueryScoped(tool: string, run: Drive, contract: QuerySweepContract): void {
  expect(
    run.failure,
    `${tool} could not be driven with { ${QUERY_SWEEP_QUESTION} }: ${run.failure}\n` +
      "An untestable tool is an untested tool. Add the neutral value its schema needs to NEUTRAL_FIELDS, or " +
      "fix the handler — there is no skip path out of this sweep.",
  ).toBeUndefined()

  const addressed = provisionsAddressed(run)
  const bare = addressed.filter((item) => BARE_29.test(item) && !SCOPED_29.test(item))
  const scoped = addressed.filter((item) => SCOPED_29.test(item))

  // Universal, whatever the row says: a browser follows the address, not the
  // warning printed beside it, and the Act's own s 29 is a real provision that
  // returns real text.
  expect(
    bare,
    `${tool} addressed the Act's own s 29 ("Delegation by Commission") for a question about the ACL. ` +
      "Read provisions out of the query with scopeProvisionsToLaw({ query }) and use the result for the " +
      "fetch and for every link and follow-up call printed beside it.",
  ).toEqual([])

  if (contract.outcome === "scopes_from_query") {
    expect(
      scoped,
      `${tool} is contracted to read the provision out of the question and apply the alias's schedule, ` +
        "but nothing in its answer addresses sch 2 s 29. Either it stopped reading the question, or the " +
        "row belongs in names_no_provision.",
    ).not.toEqual([])
    return
  }

  if (contract.outcome === "names_no_provision") {
    expect(
      run.text.length,
      `${tool} answered this question with nothing at all, so this row establishes nothing.`,
    ).toBeGreaterThan(0)
    expect(
      addressed.filter((item) => /\b29\b/.test(item)),
      `${tool} is contracted to name no provision for this question, and it named one. That is not a ` +
        "failure by itself — it is a row that is out of date. Move it to scopes_from_query and make it " +
        "apply the alias's schedule.",
    ).toEqual([])
    return
  }

  // unreachable_offline: the exclusion, and the check that keeps it honest.
  expect(contract.reason.length, `${tool}'s exclusion must say why it cannot be driven`).toBeGreaterThan(20)
  expect(
    run.text,
    `${tool} is excluded from this sweep because its source has no recorded fixture, but it answered ` +
      "instead of refusing. Someone recorded that source: delete the exclusion and give the tool a real " +
      "outcome row.",
  ).toMatch(REFUSAL_LABEL)
}

function driveWithQuestion(tool: RegistryTool): Promise<Drive> {
  return drive(tool, (field) => (LAW_FIELD.test(field) ? QUERY_SWEEP_QUESTION : NEUTRAL_FIELDS[field]))
}

describe("the alias's schedule, in the tools that read the provision out of the question", () => {
  it("the swept set is exactly the contracted set — a new query-reading tool fails here until it gets a row", () => {
    const found = querySweepTools()
      .map((tool) => tool.name)
      .sort()
    // Belt to the braces: the enumeration must never go quietly empty, and the
    // exemplar the sweep was built around must always be in it.
    expect(found).toContain("search_ai_law")
    expect(found.length).toBeGreaterThanOrEqual(30)
    expect(
      found,
      "The live registry's (law words, no provision) tools and the QUERY_SWEEP table have diverged. " +
        "A name only in the left list is a new tool that reads its provision out of the query: give it a " +
        "row and make it pass — do not exempt it. A name only in the right list is a stale row: delete it.",
    ).toEqual(Object.keys(QUERY_SWEEP).sort())
  })

  describe("the guard on the guard — what this sweep would let through", () => {
    // The sweep is only worth its size if it rejects the answer it was built to
    // reject. These drive `expectQueryScoped` with answers written by hand, so
    // its verdict is pinned rather than taken on trust.
    it("rejects a follow-up call printed at the Act's own s 29", () => {
      const decoy: Drive = {
        asked: [],
        text:
          'Alias "ACL" → Competition and Consumer Act 2010 (Cth), sch 2.\n' +
          'Next: get_law_text { registerId: "C2004A00109", provision: "s 29" }',
      }
      expect(() => expectQueryScoped("decoy", decoy, { outcome: "scopes_from_query" })).toThrow(
        /addressed the Act's own s 29/,
      )
    })

    it("rejects a deep link that pinpoints the section without the schedule", () => {
      const decoy: Drive = {
        asked: [],
        text: "See https://www.legislation.gov.au/C2004A00109/latest?q=s%2029 for the text.",
      }
      expect(() => expectQueryScoped("decoy", decoy, { outcome: "names_no_provision" })).toThrow(
        /addressed the Act's own s 29/,
      )
    })

    it("rejects a scoping tool whose answer addresses nothing at all", () => {
      const decoy: Drive = { asked: [], text: "Read 'ACL s 29' as sch 2 s 29. See the Register." }
      expect(() => expectQueryScoped("decoy", decoy, { outcome: "scopes_from_query" })).toThrow(
        /nothing in its answer addresses sch 2 s 29/,
      )
    })

    it("rejects an exclusion whose tool has started answering", () => {
      const decoy: Drive = { asked: [], text: "3 decisions matching this search:\n1. Some v Body [2020] X 1" }
      expect(() =>
        expectQueryScoped("decoy", decoy, {
          outcome: "unreachable_offline",
          reason: "a reason long enough to pass the non-empty check on this row",
        }),
      ).toThrow(/answered instead of refusing/)
    })

    it("accepts an answer that reads the question and applies the schedule", () => {
      const honest: Drive = {
        asked: ["sch 2 s 29"],
        text: 'Next: get_law_text { registerId: "C2004A00109", provision: "sch 2 s 29" }',
      }
      expect(() => expectQueryScoped("honest", honest, { outcome: "scopes_from_query" })).not.toThrow()
    })
  })

  it("scopes a provision read out of the question itself, in every tool that reads one", async () => {
    for (const tool of querySweepTools()) {
      const contract = QUERY_SWEEP[tool.name]
      if (!contract) {
        expect.fail(
          `${tool.name} takes law words and no provision but has no row in QUERY_SWEEP — add one and make it ` +
            "pass. There is no skip path: an undriven tool is exactly where the body-for-schedule " +
            "substitution hides.",
        )
      }
      expectQueryScoped(tool.name, await driveWithQuestion(tool), contract)
    }
  }, 60_000)
})
