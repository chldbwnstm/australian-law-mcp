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
import { allTools } from "../tool-registry.js"
import type { AuApiClient } from "./api-client.js"
import { normalizeFrlVersion } from "./api-client.js"
import { lawCache } from "./cache.js"
import { resolveLawAlias } from "./law-alias.js"
import { parseNcx } from "./ncx-parser.js"
import { findNavPoint, sliceProvision } from "./provision-slicer.js"
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
 * Every tool that takes (law words, provision) must apply the alias's schedule.
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
 * registered.
 *
 * A lib test reaching up to `tool-registry.ts` inverts the usual layering, and
 * that is the point — the registry is the only place that knows every tool, and
 * this rule is worth less than nothing if it is enforced only over the tools
 * somebody remembered to list.
 *
 * What it proves for each tool: it never asks the Register for the *body's*
 * s 18, and it says `sch 2 s 18` somewhere in its answer. What it does not
 * prove: that a tool building a deep link rewrites the link itself rather than
 * warning beside it (`get_external_links` passes on the warning alone).
 */
const LAW_FIELD = /^(?:query|lawName|law|act|title|name)$/
const PROVISION_FIELD = /^provisions?$/

/**
 * Tools that do NOT apply the schedule, verified 2026-09-04.
 *
 * This is a ledger of open bugs, not a list of exemptions — each entry is a
 * tool that answers "ACL s 18" with the body's s 18 today. **Delete the line
 * when you fix the tool.** Adding a line is how a new tool opts out of the one
 * rule this project's flagship example exists to state, so a reviewer should
 * treat a new entry the way they would treat a new `@ts-expect-error`.
 */
const KNOWN_GAPS: Record<string, string> = {
  get_instrument_provisions:
    "parses `provision` with parseSectionRef and never consults `query` — prints the alias note, then serves the body provision under it.",
  get_historical_law:
    "same shape: requireRef(input.provision) with no mention, so a point-in-time read of 'ACL s 18' is the body's s 18 as at that date.",
}

/** Zod object shape, defensively: the tests must not go quietly vacuous on a zod upgrade. */
function schemaFields(schema: unknown): string[] {
  const holder = schema as { shape?: unknown; _def?: { shape?: unknown } }
  const shape = holder?.shape ?? holder?._def?.shape
  const resolved = typeof shape === "function" ? (shape as () => object)() : shape
  return resolved ? Object.keys(resolved as object) : []
}

function toolsWith(predicate: (fields: string[]) => boolean): RegistryTool[] {
  return (allTools as RegistryTool[]).filter((tool) => predicate(schemaFields(tool.schema)))
}

interface RegistryTool {
  name: string
  schema: unknown
  handler: (client: AuApiClient, input: never) => Promise<{ content: Array<{ text: string }> }>
}

const CCA_NCX = readFileSync(new URL("../tools/__fixtures__/cca-schedules.ncx", import.meta.url), "utf8")
const CCA_VOL1 = readFileSync(new URL("./__fixtures__/cca-vol1-slice.html", import.meta.url), "utf8")
const CCA_VOL4 = readFileSync(new URL("./__fixtures__/cca-vol4-slice.html", import.meta.url), "utf8")
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
 * carries both s 18s). `asked` records every provision string that reached the
 * upstream boundary — that is where "did the tool apply the schedule" is
 * answered, rather than in the prose.
 */
function registerStub(asked: string[]): AuApiClient {
  const volumeHtml = (volume: number): string => (volume === 1 ? CCA_VOL1 : CCA_VOL4)
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
 * Fields the harness fills so a tool gets far enough to use the provision at
 * all. Only ever a neutral value for a field whose *absence* short-circuits the
 * handler — `get_historical_law` refuses without a date, `legal_analysis`
 * without a mode.
 */
const NEUTRAL_FIELDS: Record<string, unknown> = {
  date: "2020-01-01",
  fromDate: "2026-01-15",
  mode: "impact_map",
}

async function runWithAclSection18(tool: RegistryTool): Promise<{ text: string; asked: string[] }> {
  lawCache.clear()
  const input: Record<string, unknown> = {}
  for (const field of schemaFields(tool.schema)) {
    if (LAW_FIELD.test(field)) input[field] = "ACL"
    else if (field === "provision") input[field] = "s 18"
    else if (field === "provisions") input[field] = ["s 18"]
    else if (NEUTRAL_FIELDS[field] !== undefined) input[field] = NEUTRAL_FIELDS[field]
  }
  const asked: string[] = []
  try {
    const parsed = (tool.schema as { parse: (value: unknown) => never }).parse(input)
    const result = await tool.handler(registerStub(asked), parsed)
    return { text: result.content.map((part) => part.text).join("\n"), asked }
  } catch (error) {
    return { text: `threw: ${error instanceof Error ? error.message : String(error)}`, asked }
  }
}

describe("the alias's schedule, across the whole registry", () => {
  it("finds the tools that take a law and a provision", () => {
    // Guards the enumeration itself: a zod upgrade that changes `.shape` would
    // otherwise leave every test below passing over an empty list.
    const found = toolsWith(
      (fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)),
    ).map((tool) => tool.name)
    expect(found).toEqual(
      expect.arrayContaining(["get_law_text", "get_batch_provisions", "get_provision_history", "compare_old_new"]),
    )
    expect(found.length).toBeGreaterThanOrEqual(10)
  })

  it("every one of them reads 'ACL' + 's 18' as sch 2 s 18", async () => {
    const candidates = toolsWith(
      (fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)),
    ).filter((tool) => KNOWN_GAPS[tool.name] === undefined)

    for (const tool of candidates) {
      const { text, asked } = await runWithAclSection18(tool)
      const bodySection = asked.filter((provision) => /^s\.?\s*18$/i.test(provision.trim()))
      expect(
        bodySection,
        `${tool.name} asked the Register for the Act's own s 18 ("Meetings of Commission"). ` +
          "Route (query|lawName, provision) through scopeProvisionsToLaw().",
      ).toEqual([])
      expect(
        text,
        `${tool.name} never says "sch 2 s 18" — it either dropped the schedule or applied it silently. ` +
          "Route (query|lawName, provision) through scopeProvisionsToLaw() and print its note.",
      ).toContain("sch 2 s 18")
    }
  }, 60_000)

  it("keeps the ledger of tools that still drop it honest", () => {
    // A stale entry is worse than none: it would silently exempt a tool that no
    // longer has the field, or a name that no longer exists.
    const candidates = new Set(
      toolsWith(
        (fields) => fields.some((f) => LAW_FIELD.test(f)) && fields.some((f) => PROVISION_FIELD.test(f)),
      ).map((tool) => tool.name),
    )
    for (const name of Object.keys(KNOWN_GAPS)) {
      expect(candidates.has(name), `${name} is listed as a known gap but is no longer such a tool — delete the entry`).toBe(
        true,
      )
      expect(KNOWN_GAPS[name].length, `${name}'s ledger entry must say what is wrong`).toBeGreaterThan(20)
    }
  })

  it("scopes a provision read out of the question itself, in every tool that reads one", async () => {
    // The other half of the class, and the one round 3 missed: a tool with no
    // `provision` field that lifts the reference out of the query and prints it
    // as the follow-up call (`search_ai_law`, and every chain that embeds it).
    // s 29 rather than s 18 because "s 18" is also the canned example in
    // get_law_text's "Next:" block, and a canned example is not a reading of
    // this question.
    const swept = toolsWith(
      (fields) => fields.some((f) => LAW_FIELD.test(f)) && !fields.some((f) => PROVISION_FIELD.test(f)),
    )
    expect(swept.map((tool) => tool.name)).toContain("search_ai_law")

    for (const tool of swept) {
      lawCache.clear()
      const input: Record<string, unknown> = {}
      for (const field of schemaFields(tool.schema)) {
        if (LAW_FIELD.test(field)) input[field] = "ACL s 29 false representations"
      }
      const asked: string[] = []
      let text = ""
      try {
        const parsed = (tool.schema as { parse: (value: unknown) => never }).parse(input)
        text = (await tool.handler(registerStub(asked), parsed)).content.map((part) => part.text).join("\n")
      } catch {
        continue // A tool this stub cannot satisfy prints no follow-up call at all.
      }
      const hinted = [...text.matchAll(/provision\s*[:=]\s*"([^"]{1,24})"/g)].map((match) => match[1].trim())
      expect(
        hinted.filter((provision) => /^s\.?\s*29$/i.test(provision)),
        `${tool.name} printed a follow-up call at the body's s 29 for a question about the ACL. ` +
          "Read provisions out of the query with scopeProvisionsToLaw({ query }).",
      ).toEqual([])
      expect(
        asked.filter((provision) => /^s\.?\s*29$/i.test(provision.trim())),
        `${tool.name} asked the Register for the body's s 29 for a question about the ACL.`,
      ).toEqual([])
    }
  }, 60_000)
})
