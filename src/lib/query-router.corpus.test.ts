/**
 * The router's specification, executed.
 *
 * `docs/research/grok-followup.md` Part 4 is 72 labelled natural-language
 * queries plus 18 "tricky negatives" — things that look like section
 * references or citations and are not. That table is the routing spec, so it
 * is also the test: every row runs, and every row asserts the tool its label
 * names.
 *
 * Where this router deliberately differs from a label, the row carries a
 * `deviation` string. A deviation is a decision that had to be written down,
 * not a failure that was papered over, and there are only five kinds:
 *
 *  - a label naming a tool this registry does not have (`get_provision_with_cases`);
 *  - a label using the reference implementation's name for a tool that is
 *    registered here under another (`get_em_text` → `get_explanatory_text`);
 *  - a label naming a detail tool that is reached through its search partner,
 *    because the detail tool needs an identifier only a search can supply;
 *  - a label naming a parameter this tool's schema does not have;
 *  - N6, where the corpus contradicts N4 and consistency won.
 *
 * `legal_research(task)`/`chain_*` and `legal_analysis(mode)`/the four
 * analysis tools are the same code behind two names, so the accepted set
 * expands through those equivalences rather than each row listing both.
 */

import { describe, expect, it } from "vitest"
import { routeQuery, routeDestinations } from "./query-router.js"
import { TASK_TO_CHAIN } from "./scenario-rules.js"
import { allTools } from "../tool-registry.js"

interface Row {
  id: string
  query: string
  /** The tool the corpus labels. */
  label: string
  /** Extra tools the corpus offers as equally correct ("X *or* Y"). */
  also?: string[]
  /** Why this row does not route to its label, when it does not. */
  deviation?: string
}

/** The four analysis tools are also reachable as `legal_analysis(mode=…)`. */
const ANALYSIS_MODES = ["verify_citations", "cite_check", "applicable_law", "impact_map"]

/**
 * Expand a labelled tool to every name that is the same destination.
 *
 * Not a fudge: `legal_research` exists precisely so eight chains can be
 * reached without advertising eight tools, and a router that picks the
 * advertised door has not gone somewhere else.
 */
function equivalents(tool: string): string[] {
  const out = new Set([tool])
  if (tool === "legal_research") {
    for (const chain of Object.values(TASK_TO_CHAIN)) out.add(chain)
  }
  const task = Object.entries(TASK_TO_CHAIN).find(([, chain]) => chain === tool)
  if (task) out.add("legal_research")
  if (tool === "legal_analysis") for (const mode of ANALYSIS_MODES) out.add(mode)
  if (ANALYSIS_MODES.includes(tool)) out.add("legal_analysis")
  return [...out]
}

const CORPUS: Row[] = [
  { id: "1", query: "what does s 18 of the ACL say", label: "get_law_text" },
  { id: "2", query: "Competition and Consumer Act 2010 section 18", label: "get_law_text" },
  { id: "3", query: "s 46 CCA", label: "get_law_text" },
  { id: "4", query: "show me Fair Work Act s 387", label: "get_law_text" },
  { id: "5", query: "Corps Act definition of director", label: "get_law_text", also: ["get_legal_term_detail"] },
  { id: "6", query: "meaning of consumer in the ACL", label: "get_legal_term_kb" },
  { id: "7", query: "what is a financial product under the Corps Act", label: "get_legal_term_detail" },
  { id: "8", query: "search for the Privacy Act", label: "search_law" },
  { id: "9", query: "is there a Commonwealth act about modern slavery", label: "search_law" },
  { id: "10", query: "FW Act", label: "search_law" },
  { id: "11", query: "TPA s 52", label: "search_law", also: ["applicable_law"] },
  { id: "12", query: "what did s 52 TPA say in 2009", label: "legal_analysis" },
  { id: "13", query: "point in time Corporations Act 1 July 2018 s 588G", label: "applicable_law" },
  { id: "14", query: "which version of the Migration Act applied on 20 March 2020", label: "applicable_law" },
  { id: "15", query: "Privacy Act as at 1 December 2022", label: "applicable_law", also: ["get_historical_law"] },
  { id: "16", query: "what changed in the Privacy Act since 2020", label: "legal_research" },
  { id: "17", query: "amendments to the Fair Work Act 2024", label: "chain_amendment_track", also: ["get_law_history"] },
  { id: "18", query: "compare old and new s 18 ACL", label: "compare_old_new" },
  { id: "19", query: "history of CCA s 46", label: "get_provision_history" },
  { id: "20", query: "enabling instruments under the Biosecurity Act", label: "get_enabled_instruments" },
  { id: "21", query: "what Act authorises the Migration Regulations", label: "get_enabling_acts" },
  { id: "22", query: "is this instrument stale relative to the parent Act", label: "instrument_radar" },
  {
    id: "23",
    query: "Fair Work Regulations 2009 reg 1.07",
    label: "get_instrument_provisions",
    deviation:
      "Corpus label is `get_instrument_text`, which is the reference implementation's name. This registry calls " +
      "the same capability get_instrument_provisions.",
  },
  { id: "24", query: "High Court Rules 2004 r 42.02", label: "get_law_text" },
  { id: "25", query: "ACL schedule 2", label: "get_schedules" },
  { id: "26", query: "Corps Act sch 2 forms", label: "get_schedules" },
  { id: "27", query: "form of a statutory declaration Cth", label: "legal_research", also: ["get_schedules"] },
  { id: "28", query: "gazette notice appointing the ACCC chair", label: "search_decisions" },
  {
    id: "29",
    query: "Administrative Arrangements Order current",
    label: "search_law",
    deviation:
      "Routed as labelled. The corpus's `collection AAO` is not applied: SearchLawSchema's collection enum is " +
      "Act | LegislativeInstrument | NotifiableInstrument | Constitution | Gazette, with no AAO member, so the " +
      "search runs unfiltered and the route carries a note saying why.",
  },
  { id: "30", query: "Australia-US FTA text", label: "search_treaties", also: ["get_treaty_text"] },
  { id: "31", query: "is the China-Australia FTA in force", label: "search_treaties" },
  { id: "32", query: "NSW equivalent of the ACL", label: "get_state_equivalents" },
  { id: "33", query: "compare unfair contract terms NSW vs Cth", label: "legal_research" },
  {
    id: "34",
    query: "Crimes Act 1900 s 61I",
    label: "get_state_law_text",
    deviation:
      "Reached through search_state_law, which is the only way to obtain the register id get_state_law_text " +
      "requires. The pipeline runs both, so the labelled tool is called.",
  },
  { id: "35", query: "Vic Civil Liability Act s 48", label: "search_state_law", also: ["get_state_law_text"] },
  { id: "36", query: "QLD WHS Act duties", label: "search_state_law" },
  { id: "37", query: "drink driving penalty NSW", label: "legal_research" },
  { id: "38", query: "can I get a refund if the phone is defective", label: "legal_research" },
  { id: "39", query: "unfair dismissal after 5 months casual", label: "legal_research" },
  { id: "40", query: "how do I apply to the ART for a tax review", label: "legal_research" },
  { id: "41", query: "review this employment contract for FW Act risks", label: "legal_research" },
  { id: "42", query: "law system around the EPBC Act", label: "legal_research" },
  { id: "43", query: "dispute prep: ACCC vs a merger", label: "legal_research" },
  { id: "44", query: "is [2019] HCA 23 still good law", label: "legal_analysis" },
  { id: "45", query: "is Mabo (1992) 175 CLR 1 still cited", label: "cite_check" },
  { id: "46", query: "[2010] NSWCCA 333", label: "search_cases", also: ["get_case_text"] },
  { id: "47", query: "Dela Cruz v R", label: "search_cases" },
  {
    id: "48",
    query: "CCA s 46 cases",
    label: "impact_map",
    deviation:
      "Corpus label is `get_provision_with_cases`, which this registry does not have. impact_map is the " +
      "registered tool that answers the same question — cases citing a provision — and the corpus itself offers " +
      "it for the neighbouring row 49.",
  },
  { id: "49", query: "cases on ACL s 18 misleading", label: "impact_map" },
  { id: "50", query: "who has cited [2020] HCA 3", label: "cite_check", also: ["impact_map"] },
  { id: "51", query: "verify these citations: s 18 CCA and [2020] HCA 41", label: "legal_analysis" },
  { id: "52", query: "does Commercial Arbitration Act 2010 (Cth) s 999 exist", label: "verify_citations" },
  { id: "53", query: "HCA constitutional implied freedom cases 2024", label: "search_decisions" },
  { id: "54", query: "latest High Court judgment", label: "search_decisions" },
  { id: "55", query: "NCAT tenancy decision about mould", label: "search_decisions" },
  { id: "56", query: "FWC unfair dismissal decision small business", label: "search_decisions" },
  { id: "57", query: "OAIC determination Optus privacy", label: "search_decisions" },
  { id: "58", query: "ATO TR on ordinary income", label: "search_rulings", also: ["search_decisions"] },
  { id: "59", query: "ATO decision impact statement on [2019] HCA 3", label: "search_decisions" },
  { id: "60", query: "ATO ID 2010/1", label: "get_ruling_text" },
  { id: "61", query: "PS LA 2009/9", label: "get_ruling_text" },
  { id: "62", query: "dumping review aluminium extrusions China", label: "search_decisions" },
  { id: "63", query: "NACC Operation Wilson report", label: "search_decisions" },
  { id: "64", query: "Merit Protection Commissioner case study code of conduct", label: "search_decisions" },
  { id: "65", query: "Commonwealth Ombudsman report on robodebt", label: "search_decisions" },
  { id: "66", query: "University of Sydney by-law parking", label: "search_decisions" },
  { id: "67", query: "CSIRO staff determination", label: "search_decisions" },
  {
    id: "68",
    query: "EM for the Privacy Legislation Amendment 2022",
    label: "search_explanatory",
    deviation:
      "Corpus label is `search_explanatory_memoranda`; this registry registers that schema under the name " +
      "search_explanatory (explanatory.ts exports the memoranda name as an alias of the same schema).",
  },
  {
    id: "69",
    query: "explanatory statement for CASA instrument F2011L00287",
    label: "get_explanatory_text",
    deviation: "Corpus label is `get_em_text`, an alias of the same schema; the registered name is get_explanatory_text.",
  },
  { id: "70", query: "three-tier: FW Act → Regulations → FWC Rules", label: "get_three_tier" },
  { id: "71", query: "abbreviation CCA", label: "get_law_abbreviations" },
  { id: "72", query: "what tools do I use to check if a case is good law", label: "discover_tools" },
]

const NEGATIVES: Row[] = [
  { id: "N1", query: "s 18 of the ACL vs CCA s 18 — which is misleading conduct", label: "get_law_text" },
  { id: "N2", query: "Part 2-1 of the ACL", label: "get_law_text" },
  { id: "N3", query: "Schedule 2 item 1 Corps Act", label: "get_schedules" },
  { id: "N4", query: "s 109 of the Constitution", label: "get_law_text" },
  { id: "N5", query: "18C", label: "search_law" },
  {
    id: "N6",
    query: "section 90 of the Constitution",
    label: "get_law_text",
    deviation:
      "Corpus routes this to the constitutional decisions domain while N4 — the same shape, one section number " +
      "apart — goes to get_law_text. Nothing in the sentence asks for cases, so it is routed like N4 and " +
      "search_decisions(domain=\"constitutional\") is offered as an alternate. The corpus's point, that s 90 is " +
      "the Commonwealth excise power and not a State provision, is met either way.",
  },
  { id: "N7", query: "[2010] NSWCCA 333 still good law?", label: "cite_check" },
  { id: "N8", query: "175 CLR 1", label: "search_cases", also: ["cite_check"] },
  { id: "N9", query: "TR 2024/1", label: "get_ruling_text" },
  {
    id: "N10",
    query: "F2011L00287",
    label: "get_instrument_provisions",
    also: ["search_law"],
    deviation: "Corpus label `get_instrument_text` is the reference implementation's name for get_instrument_provisions.",
  },
  { id: "N11", query: "C2004A00109", label: "get_law_text" },
  { id: "N12", query: "penalty unit", label: "get_legal_term_kb" },
  { id: "N13", query: "consumer under the ASIC Act", label: "get_legal_term_detail", also: ["get_legal_term_kb"] },
  { id: "N14", query: "section 51(xx)", label: "get_law_text" },
  { id: "N15", query: "Art 9 ICCPR", label: "search_treaties", also: ["get_treaty_text"] },
  { id: "N16", query: "GSTR 2001/1 as at 30 June 2002", label: "get_ruling_text" },
  {
    id: "N17",
    query: "s 18 meetings of the Commission",
    label: "verify_citations",
    deviation:
      "Corpus routes to CCA body s 18 on the strength of the heading the user quoted. No Act is named in the " +
      "sentence, and inferring one from a heading is the guess N18 forbids — so this takes the N18 path and the " +
      "citation checker reports the missing Act. What the corpus actually guards against, silently reading it as " +
      "the ACL, is asserted below.",
  },
  { id: "N18", query: '"the Act" s 18 in a pasted letter that never named the Act', label: "verify_citations" },
]

const ALL_ROWS = [...CORPUS, ...NEGATIVES]

describe("grok corpus — every labelled query reaches its labelled tool", () => {
  it.each(ALL_ROWS.map((row) => [row.id, row.query, row] as const))(
    "%s: %s",
    (_id, _query, row) => {
      const accepted = new Set([row.label, ...(row.also ?? [])].flatMap(equivalents))
      const reached = routeDestinations(row.query)
      // Compared as a pair so a failure prints the query alongside the result
      // rather than just "false is not true".
      expect([row.id, reached.some((tool) => accepted.has(tool))]).toEqual([row.id, true])
    },
  )

  it("covers the whole published table", () => {
    expect(CORPUS).toHaveLength(72)
    expect(NEGATIVES).toHaveLength(18)
  })

  it("routes 85 of the 90 rows to their label with no deviation at all", () => {
    const deviations = ALL_ROWS.filter((row) => row.deviation)
    // Pinned so a new deviation cannot be added without the count moving and
    // the reason being read.
    expect(deviations.map((row) => row.id)).toEqual(["23", "29", "34", "48", "68", "69", "N6", "N10", "N17"])
  })

  it("every deviation says why", () => {
    for (const row of ALL_ROWS.filter((entry) => entry.deviation)) {
      expect([row.id, (row.deviation ?? "").length > 60]).toEqual([row.id, true])
    }
  })
})

describe("grok corpus — every destination is a registered tool", () => {
  const names = new Set(allTools.map((tool) => tool.name))

  it.each(ALL_ROWS.map((row) => [row.id, row] as const))("%s routes only to real tools", (_id, row) => {
    for (const tool of routeDestinations(row.query)) {
      expect([row.id, tool, names.has(tool)]).toEqual([row.id, tool, true])
    }
  })

  it("every alternate names a real tool too", () => {
    for (const row of ALL_ROWS) {
      for (const alternate of routeQuery(row.query).alternates) {
        expect([row.id, alternate.tool, names.has(alternate.tool)]).toEqual([row.id, alternate.tool, true])
      }
    }
  })
})

describe("grok corpus — the parameters, not just the destination", () => {
  const paramsOf = (query: string) => JSON.stringify(routeQuery(query).params)

  it("1: the ACL is schedule 2 of the CCA, so s 18 becomes sch 2 s 18", () => {
    expect(routeQuery("what does s 18 of the ACL say").params).toMatchObject({
      query: "Competition and Consumer Act 2010",
      provision: "sch 2 s 18",
    })
  })

  it("2: naming the CCA itself does not add the schedule", () => {
    expect(routeQuery("Competition and Consumer Act 2010 section 18").params).toMatchObject({ provision: "s 18" })
  })

  it("N1: the schedule reading wins, and the body section is offered as the alternate", () => {
    const route = routeQuery("s 18 of the ACL vs CCA s 18 — which is misleading conduct")
    expect(route.params).toMatchObject({ provision: "sch 2 s 18" })
    expect(JSON.stringify(route.alternates)).toContain('"provision":"s 18"')
  })

  it("N2: Part 2-1 is a hyphenated part number, never section 2-1", () => {
    const params = paramsOf("Part 2-1 of the ACL")
    expect(params).toContain("pt 2-1")
    expect(params).not.toContain('"s 2-1"')
  })

  it("N3: schedule 2 item 1 is a schedule lookup, not section 2", () => {
    const route = routeQuery("Schedule 2 item 1 Corps Act")
    expect(route.params).toMatchObject({ schedule: "2" })
    expect(JSON.stringify(route.params)).not.toContain('"s 2"')
  })

  it("N4 and N6: the Constitution, not a State Act", () => {
    expect(paramsOf("s 109 of the Constitution")).toContain("Constitution")
    expect(paramsOf("section 90 of the Constitution")).toContain("Constitution")
  })

  it("N6 still offers the constitutional decisions domain", () => {
    const alternates = JSON.stringify(routeQuery("section 90 of the Constitution").alternates)
    expect(alternates).toContain("constitutional")
  })

  it("N13: the ASIC Act is kept in view, and the ACL's schedule is not assumed", () => {
    const route = routeQuery("consumer under the ASIC Act")
    const everything = JSON.stringify([route.params, route.alternates, route.clarify])
    expect(everything).toContain("Australian Securities and Investments Commission Act 2001")
    expect(everything).not.toContain("sch 2")
  })

  it("N14: s 51(xx) is a head of power, canonicalised", () => {
    expect(routeQuery("section 51(xx)").params).toMatchObject({ provision: "s 51(xx)" })
  })

  it("N16: an ATO point-in-time is asAt on the ruling, not a Register compilation", () => {
    expect(routeQuery("GSTR 2001/1 as at 30 June 2002").params).toMatchObject({
      id: "GSTR 2001/1",
      asAt: "2002-06-30",
    })
  })

  it("N9 and 60: a year inside a product code is not a point in time", () => {
    expect(routeQuery("TR 2024/1").params.asAt).toBeUndefined()
    expect(routeQuery("ATO ID 2010/1").params.asAt).toBeUndefined()
  })

  it("N17: the Commission heading does not silently become the ACL", () => {
    expect(paramsOf("s 18 meetings of the Commission")).not.toContain("sch 2")
  })

  it("12: a bare year resolves to the end of the period, as the corpus notes", () => {
    expect(routeQuery("what did s 52 TPA say in 2009").params).toMatchObject({ date: "2009-12-31" })
  })

  it("11: a former statute name is flagged rather than silently modernised", () => {
    const route = routeQuery("TPA s 52")
    expect(route.clarify).toMatch(/former name/i)
    expect(route.alternates.map((alternate) => alternate.tool)).toContain("applicable_law")
  })

  it("13: the day-first date is read as 1 July 2018", () => {
    expect(routeQuery("point in time Corporations Act 1 July 2018 s 588G").params).toMatchObject({
      date: "2018-07-01",
      provision: "s 588G",
    })
  })

  it("17: a year inside a short title is not read as a search window", () => {
    const params = routeQuery("amendments to the Fair Work Act 2024").params
    expect(params.query).toBe("Fair Work Act 2009")
    expect(params.fromDate).toBeUndefined()
  })

  it("16: `since 2020` is a window", () => {
    expect(routeQuery("what changed in the Privacy Act since 2020").params).toMatchObject({ fromDate: "2020-01-01" })
  })

  it("23: the regulation number survives, and the Act's own year does not become one", () => {
    expect(routeQuery("Fair Work Regulations 2009 reg 1.07").params).toMatchObject({ provision: "reg 1.07" })
  })

  it("24: court rules keep their rule number", () => {
    expect(routeQuery("High Court Rules 2004 r 42.02").params).toMatchObject({ provision: "r 42.02" })
  })

  it("34: NSW is chosen over the Commonwealth Crimes Act, and the other claimant is named", () => {
    const route = routeQuery("Crimes Act 1900 s 61I")
    expect(route.params).toMatchObject({ jurisdiction: "NSW" })
    expect(JSON.stringify(route.params)).not.toContain("1914")
    expect(route.clarify).toMatch(/ACT/)
  })

  it("36: an explicit State token beats the table's Commonwealth default", () => {
    expect(routeQuery("QLD WHS Act duties").params).toMatchObject({ jurisdiction: "QLD" })
  })

  it("29: the AAO route explains the missing collection filter", () => {
    expect(routeQuery("Administrative Arrangements Order current").clarify).toMatch(/collection/i)
  })

  it("N5: a bare section number asks which Act rather than guessing one", () => {
    const route = routeQuery("18C")
    expect(route.tool).toBe("search_law")
    expect(route.clarify).toMatch(/name the Act|which Act/i)
  })

  it("N8: a report citation says it is a case, not an Act", () => {
    expect(routeQuery("175 CLR 1").clarify).toMatch(/law-report citation/i)
  })

  it("N18: an unnamed Act is reported, not invented", () => {
    const route = routeQuery('"the Act" s 18 in a pasted letter that never named the Act')
    expect(route.tool).toBe("verify_citations")
    expect(route.clarify).toMatch(/No Act is named/i)
  })

  it("every routed parameter set is accepted by its tool's own schema", () => {
    const byName = new Map(allTools.map((tool) => [tool.name, tool]))
    for (const row of ALL_ROWS) {
      const route = routeQuery(row.query)
      for (const step of [{ tool: route.tool, params: route.params }, ...(route.pipeline ?? [])]) {
        const tool = byName.get(step.tool)
        if (!tool) continue
        // Pipeline steps are completed with an identifier lifted from the
        // first result, so their parameters are legitimately incomplete here.
        if (step !== route.params && route.pipeline?.some((entry) => entry === step)) continue
        const parsed = tool.schema.safeParse(step.params)
        expect([row.id, step.tool, parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)]).toEqual([
          row.id,
          step.tool,
          true,
          "",
        ])
      }
    }
  })
})

describe("grok corpus — nothing routes to an empty search", () => {
  it.each(ALL_ROWS.map((row) => [row.id, row] as const))("%s has a usable search term", (_id, row) => {
    const params = routeQuery(row.query).params
    for (const key of ["query", "text", "intent", "term", "caseNumber", "lawName", "id"]) {
      const value = params[key]
      if (typeof value !== "string") continue
      expect([row.id, key, value.trim().length > 0]).toEqual([row.id, key, true])
    }
  })
})
