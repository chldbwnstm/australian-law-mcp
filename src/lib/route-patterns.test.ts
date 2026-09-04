/**
 * The routing table's own invariants, and the `yieldsTo` mechanism.
 *
 * The corpus test in `query-router.corpus.test.ts` asserts destinations. This
 * one asserts the properties that make those destinations survive editing: a
 * guard that names a real pattern, a guard that evaluates the receiver rather
 * than a copy of its words, and regex shapes that cannot be made to hang.
 */

import { describe, expect, it } from "vitest"
import { patternNames, sortedRoutePatterns, yieldsToOther, type Pattern } from "./route-patterns.js"
import { routeQuery, routeDestinations } from "./query-router.js"
import { ROUTABLE_SCENARIO_RULES, SCENARIO_HOST_CHAINS, TASK_TO_CHAIN } from "./scenario-rules.js"
import { allTools } from "../tool-registry.js"

const byName = (name: string): Pattern => {
  const found = sortedRoutePatterns.find((pattern) => pattern.name === name)
  if (!found) throw new Error(`no pattern named ${name}`)
  return found
}

describe("table integrity", () => {
  it("every yieldsTo target exists", () => {
    const names = new Set(patternNames())
    for (const pattern of sortedRoutePatterns) {
      for (const target of pattern.yieldsTo ?? []) {
        expect([pattern.name, target, names.has(target)]).toEqual([pattern.name, target, true])
      }
    }
  })

  it("is sorted by priority, with declaration order kept inside a band", () => {
    const priorities = sortedRoutePatterns.map((pattern) => pattern.priority)
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  })

  it("every destination is a registered tool", () => {
    const names = new Set(allTools.map((tool) => tool.name))
    for (const pattern of sortedRoutePatterns) {
      expect([pattern.name, pattern.tool, names.has(pattern.tool)]).toEqual([pattern.name, pattern.tool, true])
    }
  })

  it("every scenario chain and task is real", () => {
    const names = new Set(allTools.map((tool) => tool.name))
    for (const chain of SCENARIO_HOST_CHAINS) {
      expect([chain, names.has(chain)]).toEqual([chain, true])
    }
    for (const rule of ROUTABLE_SCENARIO_RULES) {
      expect([rule.scenario, TASK_TO_CHAIN[rule.task]]).toBeTruthy()
    }
  })

  it("pattern names are unique except where a scenario is declared twice", () => {
    const counts = new Map<string, number>()
    for (const pattern of sortedRoutePatterns) {
      counts.set(pattern.name, (counts.get(pattern.name) ?? 0) + 1)
    }
    for (const [name, count] of counts) {
      // A repeat is legal — the guard resolver holds a list per name for
      // exactly that reason — but it should be a scenario, not a hand-written
      // rule silently shadowing another.
      if (count > 1) expect([name, name.startsWith("scenario_")]).toEqual([name, true])
    }
  })

  it("every routable scenario became a pattern", () => {
    const names = new Set(patternNames())
    for (const rule of ROUTABLE_SCENARIO_RULES) {
      expect([rule.scenario, names.has(`scenario_${rule.scenario}`)]).toEqual([rule.scenario, true])
    }
  })
})

describe("regex safety — the shapes that turn a scanner into a hang", () => {
  const sources = sortedRoutePatterns.flatMap((pattern) =>
    pattern.patterns.map((regex) => [pattern.name, regex.source] as const),
  )

  it("no pattern begins with a lazy wildcard capture", () => {
    for (const [name, source] of sources) {
      expect([name, /^\((?:\.[+*]\?)\)/.test(source)]).toEqual([name, false])
    }
  })

  it("no unbounded any-character repeat", () => {
    for (const [name, source] of sources) {
      // `.*`, `.+`, `[^]*`, `[^]+` — the repeats that can nest inside another
      // and go quadratic. Bounded `[^]{0,N}?` gaps are the sanctioned form.
      expect([name, source, /(?<!\\)\.[*+]|\[\^\][*+]/.test(source)]).toEqual([name, source, false])
    }
  })

  it("routes adversarial input in bounded time", () => {
    // Long runs of the characters the provision and citation grammars care
    // about: digits, `s`, brackets, spaces.
    const nasty = [
      `s ${"1".repeat(400)}`,
      `${"s ".repeat(300)}18`,
      `[${"2020".repeat(120)}] HCA ${"3".repeat(200)}`,
      `${"Competition and Consumer Act ".repeat(60)}s 18`,
      `${"(".repeat(300)}s 18${")".repeat(300)}`,
      "a".repeat(4000),
    ]
    for (const query of nasty) {
      const started = Date.now()
      expect(routeQuery(query).tool).toBeTruthy()
      expect([query.slice(0, 20), Date.now() - started < 2000]).toEqual([query.slice(0, 20), true])
    }
  })
})

describe("yieldsTo — a trailing intent is not swallowed", () => {
  const cases: Array<[string, string, string]> = [
    ["a bare provision stays a provision lookup", "CCA s 46", "get_law_text"],
    ["`cases` turns it into a citation graph", "CCA s 46 cases", "impact_map"],
    ["`history of` turns it into an amendment trail", "history of CCA s 46", "get_provision_history"],
    ["a verification request wins over the lookup", "verify these citations: s 18 CCA", "verify_citations"],
    ["a schedule word wins over the section reading", "Corps Act sch 2 forms", "get_schedules"],
    ["a date turns it into a point-in-time question", "Privacy Act s 13 as at 1 December 2022", "applicable_law"],
    ["`compare old and new` wins", "compare old and new s 18 ACL", "compare_old_new"],
    ["a citator question wins over the citation lookup", "[2010] NSWCCA 333 still good law?", "cite_check"],
  ]

  it.each(cases)("%s", (_label, query, expected) => {
    expect(routeDestinations(query)).toContain(expected)
  })

  it("a bare Act name yields to the scenario that actually wants it", () => {
    expect(routeQuery("FW Act").tool).toBe("search_law")
    expect(routeQuery("law system around the EPBC Act").params).toMatchObject({ task: "law_system" })
    expect(routeQuery("review this employment contract for FW Act risks").params).toMatchObject({
      task: "document_review",
    })
  })

  it("a tribunal name yields to a question about how to lodge", () => {
    // `ART` is a tribunal alias, so the admin-appeals domain matches; the
    // guard evaluates the procedure scenario's own triggers, not a copy.
    expect(routeQuery("NCAT tenancy decision about mould").params).toMatchObject({ domain: "admin_appeals" })
    expect(routeQuery("how do I apply to the ART for a tax review").params).toMatchObject({
      task: "procedure_detail",
    })
  })

  it("the guard checks whether the receiver would really take the query", () => {
    // `impact_map` matches the word "cases" but skips without an Act and a
    // provision, so the provision pattern must NOT yield to it here.
    const provision = byName("specific_provision")
    expect(yieldsToOther(provision, "CCA s 46 cases")).toBe(true)
    expect(yieldsToOther(provision, "Fair Work Act s 387")).toBe(false)
    // The word is present, but with no provision to graph the receiver skips.
    expect(yieldsToOther(provision, "latest High Court judgment cases")).toBe(false)
  })

  it("yielding to a pattern that would fall back does not happen", () => {
    // `schedules` matches on the word "forms" but skips with no Act and no
    // schedule number; the provision lookup keeps the query.
    const provision = byName("specific_provision")
    expect(yieldsToOther(provision, "Fair Work Act s 65 forms")).toBe(true)
    expect(yieldsToOther(provision, "s 65 forms")).toBe(false)
  })

  it("a pattern with no guard never yields", () => {
    for (const pattern of sortedRoutePatterns) {
      if (pattern.yieldsTo) continue
      expect([pattern.name, yieldsToOther(pattern, "anything at all s 18 cases as at 2020")]).toEqual([
        pattern.name,
        false,
      ])
    }
  })
})

describe("the fallback", () => {
  it("an unrecognised question still gets a real answer", () => {
    const route = routeQuery("what happens if my neighbour's tree falls on my shed")
    expect(route.tool).toBe("legal_research")
    expect(route.params).toMatchObject({ task: "full_research" })
  })

  it("and points at discover_tools for a caller who wanted something specific", () => {
    const route = routeQuery("what happens if my neighbour's tree falls on my shed")
    expect(route.matchedPattern).toBeUndefined()
    expect(route.alternates.map((alternate) => alternate.tool)).toContain("discover_tools")
  })

  it("a short lower-case phrase is a concept lookup before it is a fallback", () => {
    // The last rule before the fallback. It is gated hard — no digits, no
    // proper nouns, no interrogatives — because everything above it has
    // already had its chance at the query.
    expect(routeQuery("unconscionable conduct").tool).toBe("get_legal_term_kb")
    expect(routeQuery("wibble 42 frobnicate").tool).toBe("legal_research")
  })

  it("an empty query asks for the map rather than searching for nothing", () => {
    const route = routeQuery("   ")
    expect(route.tool).toBe("discover_tools")
    expect(route.clarify).toBeTruthy()
  })
})

describe("scenario labelling", () => {
  it("a research route carries the scenario that chose it", () => {
    expect(routeQuery("unfair dismissal after 5 months casual").scenario).toBe("eligibility")
    expect(routeQuery("how do I apply to the ART for a tax review").scenario).toBe("procedure")
  })

  it("the labelling vocabulary is wider than the routing vocabulary", () => {
    // "what changed" labels a time-travel comparison but must not route as
    // one — routing on it would take an amendment window and turn it into a
    // two-version diff with only one version named.
    const route = routeQuery("what changed in the Privacy Act since 2020")
    expect(route.params).toMatchObject({ task: "amendment_track" })
    expect(route.scenario).toBe("time_travel")
  })

  it("a bare penalty word does not route to a penalty analysis", () => {
    // The reference implementation's lesson: routing on the labelling word
    // drags every "<subject> penalty <state>" research question into an
    // action-basis chain and loses the cases and the procedure.
    expect(routeQuery("drink driving penalty NSW").params).toMatchObject({ task: "full_research" })
    expect(routeQuery("what is the maximum penalty for misleading conduct").params).toMatchObject({
      task: "action_basis",
    })
  })

  it("`penalty unit` is a defined term, not a question about how big a fine is", () => {
    expect(routeQuery("penalty unit").tool).toBe("get_legal_term_kb")
  })
})

describe("explainRoute", () => {
  it("names the rule that won, so a surprising route can be traced", async () => {
    const { explainRoute } = await import("./query-router.js")
    const text = explainRoute("what does s 18 of the ACL say")
    expect(text).toContain("specific_provision")
    expect(text).toContain("sch 2 s 18")
  })
})
