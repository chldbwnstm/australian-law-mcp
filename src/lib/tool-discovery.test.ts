import { describe, expect, it } from "vitest"
import { MAX_SECTIONS, browsableCategories, matchesAlias, selectSections, suggestCategories } from "./tool-discovery.js"
import { TOOL_ALIASES, TOOL_CATEGORIES, V3_EXPOSED, describeCallPath } from "./tool-profiles.js"

/** Stand-in registry: every tool named anywhere in the taxonomy exists. */
const NAMES = new Set(Object.values(TOOL_CATEGORIES).flat())
const lookup = (name: string) => (NAMES.has(name) ? { description: `${name} does a thing` } : undefined)

describe("the taxonomy's own invariants", () => {
  it("keys every alias group to a real category", () => {
    // An alias resolving to a category that does not exist is a silent nil
    // result — indistinguishable, to the caller, from "there is no such tool".
    for (const key of Object.keys(TOOL_ALIASES)) {
      expect(TOOL_CATEGORIES[key], `alias group "${key}"`).toBeDefined()
    }
  })

  it("lists no empty category", () => {
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
      expect(tools.length, category).toBeGreaterThan(0)
    }
  })

  it("puts every advertised tool somewhere findable", () => {
    // discover_tools/execute_tool are the lookup itself and need no entry.
    const meta = new Set(["discover_tools", "execute_tool"])
    for (const name of V3_EXPOSED) {
      if (meta.has(name)) continue
      expect(NAMES.has(name), `${name} is advertised but in no category`).toBe(true)
    }
  })
})

describe("English word boundaries", () => {
  it("does not let 'act' match contract, transaction or practice", () => {
    // The reference matches Korean, which has no spaces, so it allows bare
    // substring hits in both directions. In English that turns the single
    // commonest legal word into a match for almost everything.
    expect(matchesAlias("contract review", "act")).toBe(false)
    expect(matchesAlias("transaction", "act")).toBe(false)
    expect(matchesAlias("what does the act say", "act")).toBe(true)
  })

  it("matches multi-word aliases and ones ending in punctuation-free tokens", () => {
    expect(matchesAlias("high court authority", "high court")).toBe(true)
    expect(matchesAlias("public interest disclosure scheme", "public interest disclosure")).toBe(true)
  })
})

describe("selecting sections", () => {
  it("finds the tribunal tools from a practitioner's word", () => {
    const { sections } = selectSections("ncat", lookup)
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.flatMap((section) => section.tools)).toContain("search_admin_appeals")
  })

  it("routes Australian shorthand to the right family", () => {
    const cases: Array<[string, string]> = [
      ["ato", "search_rulings"],
      ["explanatory memorandum", "search_explanatory"],
      ["point in time", "get_historical_law"],
      ["aglc", "legal_analysis"],
      ["qld", "search_state_law"],
      ["penalty units", "get_schedules"],
    ]
    for (const [intent, expected] of cases) {
      const tools = selectSections(intent, lookup).sections.flatMap((section) => section.tools)
      expect(tools, intent).toContain(expected)
    }
  })

  it("lists a tool once, in its strongest section", () => {
    // legal_research and legal_analysis belong to several categories; left
    // alone they fill an answer with four copies of themselves.
    const { sections } = selectSections("research", lookup)
    const all = sections.flatMap((section) => section.tools)
    expect(new Set(all).size).toBe(all.length)
  })

  it("caps the sections and reports how many were dropped", () => {
    const { sections, omitted } = selectSections("law", lookup)
    expect(sections.length).toBeLessThanOrEqual(MAX_SECTIONS)
    expect(omitted).toBeGreaterThanOrEqual(0)
  })

  it("returns nothing for vocabulary it does not know", () => {
    expect(selectSections("zzzqqq", lookup).sections).toEqual([])
  })
})

describe("when nothing matched", () => {
  it("rescues a misspelling", () => {
    expect(suggestCategories("legislaton")).toContain("legislation")
    expect(suggestCategories("tribunal")).toContain("tribunals")
  })

  it("invents nothing for genuinely unknown words", () => {
    // A confident, irrelevant suggestion is worse than none.
    expect(suggestCategories("photosynthesis")).toEqual([])
  })

  it("offers starting points that are themselves one-hop", () => {
    const anchors = browsableCategories()
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) {
      expect(TOOL_CATEGORIES[anchor].some((name) => V3_EXPOSED.has(name)), anchor).toBe(true)
    }
  })
})

describe("the closing advice", () => {
  it("never tells a caller to proxy a tool it can already call", () => {
    expect(describeCallPath(new Set(["search_law"]))).toContain("call directly")
    expect(describeCallPath(new Set(["search_law"]))).not.toContain("execute_tool")
  })

  it("splits the advice when the answer mixes both kinds", () => {
    const advice = describeCallPath(new Set(["search_law", "search_treaties"]))
    expect(advice).toContain("call directly")
    expect(advice).toContain("execute_tool")
  })

  it("falls back to the proxy when nothing returned is advertised", () => {
    expect(describeCallPath(new Set(["search_treaties"]))).toContain("execute_tool")
  })
})
