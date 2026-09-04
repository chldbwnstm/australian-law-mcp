/**
 * The base-law resolver, with the Federal Register stubbed.
 *
 * The fixture in `MISLEADING_CONDUCT_HITS` is the live wire response, recorded
 * 2026-09-04 from
 * `Titles/Search(criteria='text("penalty for misleading conduct",nameAndText,all)')`
 * — 1,094 matches, of which these are the first sixteen in the Register's own
 * relevance order. It is the exact ordering the Wave-5 QA report saw: once
 * `rankTitles` lifts the principal Acts, the *Foreign Passports (Law
 * Enforcement and Security) Act 2005* is hit #1 and the *Competition and
 * Consumer Act 2010* is hit #4. Taking hit #1 is how a research chain ends up
 * describing passport law to someone asking about consumer protection.
 */
import { describe, expect, it } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import type { FrlTitle } from "../lib/types.js"
import {
  contentWords,
  domainAnchorFor,
  hasScenarioHint,
  rankFullTextCandidates,
  resolveChainBaseLaw,
  type ChainBaseLaw,
} from "./chain-law-lookup.js"
import { rankTitles } from "./statute-helpers/title-lookup.js"

// ── fixtures ──────────────────────────────────────────────────────────────

function title(
  id: string,
  name: string,
  extra: Partial<FrlTitle> = {},
): FrlTitle {
  return { id, name, collection: "Act", status: "InForce", isPrincipal: false, ...extra }
}

const principal = (id: string, name: string, extra: Partial<FrlTitle> = {}): FrlTitle =>
  title(id, name, { isPrincipal: true, ...extra })

const CCA = principal("C2004A00109", "Competition and Consumer Act 2010")
const FW_ACT = principal("C2009A00028", "Fair Work Act 2009")

/** Live relevance order, 2026-09-04. Unmodified. */
const MISLEADING_CONDUCT_HITS: FrlTitle[] = [
  title("C2007A00147", "International Trade Integrity Act 2007"),
  principal("C1938A00015", "Foreign Passports (Law Enforcement and Security) Act 2005"),
  title("C2006A00039", "Therapeutic Goods Amendment Act (No. 1) 2006"),
  principal(
    "F2006L00254",
    "National Transport Commission (Road Transport Legislation – Compliance and Enforcement Bill) Regulations 2006",
    { collection: "LegislativeInstrument" },
  ),
  title("C2004A00730", "Criminal Code Amendment (Theft, Fraud, Bribery and Related Offences) Act 2000"),
  title("C2010A00103", "Trade Practices Amendment (Australian Consumer Law) Act (No. 2) 2010"),
  principal("C2019A00081", "Inspector-General of Animal Welfare and Live Animal Exports Act 2019"),
  principal("C2015Q00131", "Fair Trading Act 1995 (NI)", { collection: "ContinuedLaw" }),
  title("C2004A00794", "Law and Justice Legislation Amendment (Application of Criminal Code) Act 2001"),
  title("C2010A00044", "Trade Practices Amendment (Australian Consumer Law) Act (No. 1) 2010"),
  title("C2004A01360", "Anti-terrorism Act (No. 3) 2004"),
  principal("C2020A00119", "Recycling and Waste Reduction Act 2020"),
  principal("C2015Q00110", "Criminal Code 2007 (NI)", { collection: "ContinuedLaw" }),
  title("C2017A00101", "Fair Work Amendment (Protecting Vulnerable Workers) Act 2017"),
  title("F2021L01862", "Agricultural and Veterinary Chemicals Legislation Amendment (Improvements) Regulations 2021", {
    collection: "LegislativeInstrument",
    status: "Repealed",
  }),
  CCA,
]

// ── stub client ───────────────────────────────────────────────────────────

interface StubOptions {
  /** Title-name search results, keyed by the exact text searched for. */
  nameSearch?: Record<string, FrlTitle[]>
  /** What the full-text rung's single request answers with. */
  fullText?: FrlTitle[]
  /** Titles reachable by register id; anything else throws, as upstream does. */
  titles?: Record<string, FrlTitle>
}

function stubClient(options: StubOptions) {
  const calls = { nameSearches: [] as string[], getTitle: [] as string[], fullText: 0 }
  const client = {
    async searchTitles({ text }: { text: string }) {
      calls.nameSearches.push(text)
      const titles = options.nameSearch?.[text] ?? []
      return { count: titles.length, titles }
    },
    async fetchJson() {
      calls.fullText += 1
      const titles = options.fullText ?? []
      return { "@odata.count": titles.length, value: titles }
    },
    async getTitle(id: string) {
      calls.getTitle.push(id)
      const found = options.titles?.[id]
      if (!found) throw new Error(`FRL reports no title with id ${id}`)
      return found
    },
  }
  return { client: client as unknown as AuApiClient, calls }
}

// ── the words a query and a title share ───────────────────────────────────

describe("content words", () => {
  it.each([
    ["penalty for misleading conduct", ["penalty", "mislead", "conduct"]],
    // Plural and participle fold onto the singular stem, so "penalties" in a
    // title matches "penalty" in the question.
    ["maximum penalties", ["maximum", "penalty"]],
    // Everything every Australian statute is called drops out: left in, "act"
    // alone would make every candidate overlap every query.
    ["the Australian law and the Commonwealth Act", []],
    ["what can I do about it", []],
  ])("%s → %j", (query, expected) => {
    expect([...contentWords(query)]).toEqual(expected)
  })
})

// ── the subject anchor ────────────────────────────────────────────────────

describe("domain anchor", () => {
  it.each([
    ["penalty for misleading conduct", "Competition and Consumer Act 2010", "C2004A00109"],
    ["unfair dismissal small business", "Fair Work Act 2009", "C2009A00028"],
    ["director duties penalty", "Corporations Act 2001", "C2004A00818"],
  ])("anchors %j to %s", (query, official, titleId) => {
    expect(domainAnchorFor(query)).toMatchObject({ official, titleId })
  })

  it.each([
    // No scenario vocabulary at all — the gate the fix is specified against.
    ["foreign passports"],
    // A scenario, but a subject the bundled term table does not cover. A miss
    // in the table is a miss in the table, never a guess.
    ["penalty for cartel conduct"],
    ["what forms do I lodge to register a business name"],
  ])("declines to anchor %j", (query) => {
    expect(domainAnchorFor(query)).toBeUndefined()
  })

  it("needs the scenario gate as well as the term", () => {
    // The term itself matches either way; only the scenario-shaped query is
    // allowed to override the Register's own ordering.
    expect(hasScenarioHint("penalty for misleading conduct")).toBe(true)
    expect(hasScenarioHint("misleading conduct")).toBe(false)
    expect(domainAnchorFor("misleading conduct")).toBeUndefined()
  })
})

// ── the re-ranker itself ──────────────────────────────────────────────────

describe("rankFullTextCandidates", () => {
  const pool: ChainBaseLaw[] = [
    { registerId: "C1938A00015", name: "Foreign Passports (Law Enforcement and Security) Act 2005", collection: "Act", isPrincipal: true },
    { registerId: "F2006L00254", name: "Road Transport Compliance and Enforcement Regulations 2006", collection: "LegislativeInstrument", isPrincipal: true },
    { registerId: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", isPrincipal: true },
  ]

  it("puts a name that shares words with the question above relevance order", () => {
    const ranked = rankFullTextCandidates("consumer competition inquiry", pool)
    expect(ranked.laws[0].registerId).toBe("C2004A00109")
    expect(ranked.notes).toEqual([])
  })

  it("prefers the principal Act over an instrument with the same overlap", () => {
    const withRegs: ChainBaseLaw[] = [
      { registerId: "F2009L01673", name: "Fair Work Regulations 2009", collection: "LegislativeInstrument", isPrincipal: true },
      { registerId: "C2009A00028", name: "Fair Work Act 2009", collection: "Act", isPrincipal: true },
    ]
    expect(rankFullTextCandidates("fair work stand down", withRegs).laws[0].registerId).toBe("C2009A00028")
  })

  it("never lets an amending Act win on the strength of its name", () => {
    // The live trap: "Trade Practices Amendment (Cartel Conduct…)" shares two
    // words with the question and the CCA shares none, but a chain built on a
    // spent amendment has nothing under it.
    const cartel: ChainBaseLaw[] = [
      { registerId: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", isPrincipal: true },
      {
        registerId: "C2009A00059",
        name: "Trade Practices Amendment (Cartel Conduct and Other Measures) Act 2009",
        collection: "Act",
        isPrincipal: false,
      },
    ]
    const ranked = rankFullTextCandidates("maximum penalty for a cartel offence", cartel)
    expect(ranked.laws[0].registerId).toBe("C2004A00109")
  })

  it("keeps the Register's order when nothing else separates two titles", () => {
    const ranked = rankFullTextCandidates("penalty for cartel conduct", pool)
    expect(ranked.laws.map((law) => law.registerId)).toEqual([
      "C1938A00015",
      "C2004A00109",
      "F2006L00254",
    ])
  })

  it("adds the anchored Act when the search never found it", () => {
    const anchor = { term: "unfair dismissal", official: "Fair Work Act 2009", titleId: "C2009A00028" }
    const law: ChainBaseLaw = { registerId: "C2009A00028", name: "Fair Work Act 2009", collection: "Act", isPrincipal: true }
    const ranked = rankFullTextCandidates("unfair dismissal penalty", pool, { anchor, law })
    expect(ranked.laws[0].registerId).toBe("C2009A00028")
    expect(ranked.laws).toHaveLength(pool.length + 1)
  })
})

// ── the resolver end to end ───────────────────────────────────────────────

describe("resolveChainBaseLaw — the full-text rung", () => {
  it("is the ordering the QA report saw, before the anchor is applied", () => {
    // The candidate pool exactly as the pipeline builds it, so this pins the
    // "before": relevance plus rankTitles puts an Act about passports first and
    // the CCA fourth, and neither of them shares a word with the question.
    const pool: ChainBaseLaw[] = rankTitles("penalty for misleading conduct", MISLEADING_CONDUCT_HITS)
      .slice(0, 8)
      .map((found) => ({
        registerId: found.id,
        name: found.name,
        ...(found.collection ? { collection: found.collection } : {}),
        ...(found.isPrincipal !== undefined ? { isPrincipal: found.isPrincipal } : {}),
      }))

    const ranked = rankFullTextCandidates("penalty for misleading conduct", pool)
    expect(ranked.laws[0].registerId).toBe("C1938A00015")
    expect(ranked.laws.findIndex((law) => law.registerId === "C2004A00109")).toBe(3)
    expect(ranked.notes[0]).toContain("full-text relevance alone")
  })

  it("picks the Competition and Consumer Act for 'penalty for misleading conduct'", async () => {
    const { client, calls } = stubClient({ fullText: MISLEADING_CONDUCT_HITS })
    const result = await resolveChainBaseLaw(client, "penalty for misleading conduct", 3)

    expect(result.laws[0]).toMatchObject({
      registerId: "C2004A00109",
      name: "Competition and Consumer Act 2010",
    })
    // The Act the Register ranked first is still on the list — the fix
    // re-orders the candidates, it never hides them.
    expect(result.laws.map((law) => law.registerId)).toContain("C1938A00015")
    expect(result.notes?.join(" ")).toContain("misleading or deceptive conduct")
    expect(result.notes?.join(" ")).toContain("Foreign Passports")
    // Already in the candidate pool, so no second round trip for the anchor.
    expect(calls.getTitle).toEqual([])
    expect(calls.fullText).toBe(1)
  })

  it("leaves a relevance order that was already right alone", async () => {
    const { client } = stubClient({
      fullText: [
        principal("C2004A00109", "Competition and Consumer Act 2010"),
        principal("C2004A00819", "Australian Securities and Investments Commission Act 2001"),
        principal("C2004A01426", "Telecommunications Act 1997"),
      ],
    })
    const result = await resolveChainBaseLaw(client, "unsolicited consumer agreements", 3)

    expect(result.laws.map((law) => law.registerId)).toEqual([
      "C2004A00109",
      "C2004A00819",
      "C2004A01426",
    ])
    // The name carries a word of the question, so there is nothing to warn about.
    expect(result.notes).toEqual([])
  })

  it("keeps a relevance-only pick but says so, with the runners-up", async () => {
    const { client } = stubClient({
      fullText: [
        principal("C1938A00015", "Foreign Passports (Law Enforcement and Security) Act 2005"),
        principal("C2019A00081", "Inspector-General of Animal Welfare and Live Animal Exports Act 2019"),
        principal("C2020A00119", "Recycling and Waste Reduction Act 2020"),
      ],
    })
    const result = await resolveChainBaseLaw(client, "penalty for cartel conduct", 1)

    expect(result.laws[0].registerId).toBe("C1938A00015")
    const note = result.notes?.join(" ") ?? ""
    expect(note).toContain("full-text relevance alone")
    expect(note).toContain("Verify it is the Act you meant")
    // The next two candidates, so the caller can correct the pick without
    // running the search again.
    expect(note).toContain("Inspector-General of Animal Welfare and Live Animal Exports Act 2019 [C2019A00081]")
    expect(note).toContain("Recycling and Waste Reduction Act 2020 [C2020A00119]")
  })

  it("fetches the anchored Act by id when the full-text search missed it", async () => {
    const { client, calls } = stubClient({
      fullText: [
        principal("C2004A01360", "Anti-terrorism Act (No. 3) 2004"),
        principal("C2020A00119", "Recycling and Waste Reduction Act 2020"),
      ],
      titles: { C2009A00028: FW_ACT },
    })
    const result = await resolveChainBaseLaw(client, "unfair dismissal penalty", 2)

    expect(result.laws[0]).toMatchObject({ registerId: "C2009A00028", name: "Fair Work Act 2009" })
    expect(calls.getTitle).toEqual(["C2009A00028"])
    // The extra lookup is recorded, so a later failure can print what was tried.
    expect(result.attempts.some((attempt) => attempt.includes("subject anchor"))).toBe(true)
  })

  it("falls back to relevance, annotated, when the anchor cannot be fetched", async () => {
    // `titles` is empty, so getTitle throws — the rung must still answer.
    const { client, calls } = stubClient({
      fullText: [principal("C2004A01360", "Anti-terrorism Act (No. 3) 2004")],
    })
    const result = await resolveChainBaseLaw(client, "unfair dismissal penalty", 1)

    expect(calls.getTitle).toEqual(["C2009A00028"])
    expect(result.laws[0].registerId).toBe("C2004A01360")
    expect(result.notes?.join(" ")).toContain("full-text relevance alone")
  })

  it("never reaches the full-text rung when a name search answers", async () => {
    const { client, calls } = stubClient({
      nameSearch: { "Fair Work Act 2009": [FW_ACT] },
      fullText: MISLEADING_CONDUCT_HITS,
    })
    const result = await resolveChainBaseLaw(client, "when does the Fair Work Act 2009 allow a stand down", 2)

    expect(result.laws[0].registerId).toBe("C2009A00028")
    expect(result.searchedWith).toBe("Fair Work Act 2009")
    expect(calls.fullText).toBe(0)
    // Nothing to explain: the question named the Act.
    expect(result.notes).toBeUndefined()
  })

  it("answers from the anchor alone when the full-text search found nothing", async () => {
    // An empty search is not an empty subject: the term table still knows which
    // Act unfair dismissal lives in.
    const { client } = stubClient({ fullText: [], titles: { C2009A00028: FW_ACT } })
    const result = await resolveChainBaseLaw(client, "unfair dismissal penalty", 2)

    expect(result.laws).toHaveLength(1)
    expect(result.laws[0].registerId).toBe("C2009A00028")
    expect(result.notes?.join(" ")).toContain("chosen by subject")
  })

  it("still reports every term it tried when nothing matched at all", async () => {
    const { client } = stubClient({ fullText: [] })
    const result = await resolveChainBaseLaw(client, "penalty for misleading conduct", 2)

    expect(result.laws).toEqual([])
    expect(result.attempts).toContain("penalty for misleading conduct (full text)")
  })
})
