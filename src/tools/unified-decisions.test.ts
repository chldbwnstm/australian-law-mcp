import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"

// The constitutional handler renders High Court reasons through `renderDocument`
// without threading `full`, which is the case the note below exists for. Its
// output is stubbed so the note can be tested without a network fixture; the
// schema and the search half of the module stay real.
vi.mock("./constitutional-decisions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constitutional-decisions.js")>()
  return {
    ...actual,
    getConstitutionalDecisionText: async () => ({
      content: [
        {
          type: "text",
          text:
            "=== Fake v The Queen ===\nSource: https://www.hcourt.gov.au/cases-and-judgments/x\n\nReasons:\n" +
            "[1] The appellant contends…\n\n⋯ omitted 4,000 characters (call again with full=true for the " +
            "complete text) ⋯\n\n[97] Appeal dismissed.",
        },
      ],
    }),
  }
})

const {
  DECISION_DOMAINS,
  DOMAIN_LABELS,
  GetDecisionTextSchema,
  SEARCH_SCHEMAS,
  SELF_COMPACTING,
  SearchDecisionsSchema,
  getDecisionText,
  searchDecisions,
} = await import("./unified-decisions.js")

const ARCHITECTURE = readFileSync(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf-8")

/** No network: any handler that actually reaches an upstream fails the test. */
const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("the domain enum matches docs/ARCHITECTURE.md exactly", () => {
  // Scope to the "18 decision domains" table; the upstream-hosts table above it
  // has the same three-column shape.
  const section = ARCHITECTURE.slice(ARCHITECTURE.indexOf("## 18 decision domains")).split("\n## ")[0]
  const documented = [...section.matchAll(/^\| `([a-z_]+)` \| .* \| .* \|$/gm)].map((match) => match[1])

  it("finds the 18 domains in the architecture table", () => {
    expect(documented).toHaveLength(18)
  })

  it("exposes exactly those 18, in the same order", () => {
    expect([...DECISION_DOMAINS]).toEqual(documented)
  })

  it("labels every one of them", () => {
    for (const domain of DECISION_DOMAINS) {
      expect(DOMAIN_LABELS[domain]).toBeTruthy()
    }
  })
})

describe("unknown domains", () => {
  it("names the bad value instead of dispatching", async () => {
    const result = await searchDecisions(noNetworkClient, { domain: "nope" as never })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Unknown decision domain: nope")
  })
})

describe("options passthrough — reserved-key guard", () => {
  it("drops an option that would overwrite the tool's own id", async () => {
    // Without the guard, options.id silently redirects the fetch to another
    // document than the one the caller named.
    const result = await getDecisionText(noNetworkClient, {
      domain: "state_law",
      id: "act-1899-009",
      options: { id: "act-9999-999", jurisdiction: "QLD" },
    })
    const text = result.content.map((entry) => entry.text).join("\n")
    expect(text).toContain("options.id")
    expect(text).toContain("ignored")
    expect(text).not.toContain("act-9999-999")
  })

  it("drops reserved search keys too", async () => {
    const result = await searchDecisions(noNetworkClient, {
      domain: "competition",
      query: "cartel",
      options: { query: "something else", limit: 99 },
    })
    const text = result.content.map((entry) => entry.text).join("\n")
    expect(text).toMatch(/options\.query, options\.limit .* ignored/)
    expect(text).not.toContain("something else")
  })

  it("passes a non-reserved option through", async () => {
    // `jurisdiction` is domain-specific and must survive; without it the
    // state_law guard below would not be satisfied.
    const result = await getDecisionText(noNetworkClient, {
      domain: "state_law",
      id: "x",
      options: { jurisdiction: "NSW" },
    })
    const text = result.content.map((entry) => entry.text).join("\n")
    // NSW is a blocked register, which proves the jurisdiction reached the handler.
    expect(text).toContain("[UPSTREAM_BLOCKED]")
  })
})

describe("jurisdiction guard", () => {
  it("refuses a state_law SEARCH without a jurisdiction rather than crashing inside the register client", async () => {
    // Without the guard this reached normaliseJurisdiction(undefined) and came
    // back "[EXTERNAL_API_ERROR] Cannot read properties of undefined" — an
    // outage report for a malformed call, which invites the same call again.
    const result = await searchDecisions(noNetworkClient, { domain: "state_law", query: "tenancy" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).not.toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain('options={"jurisdiction":"QLD"}')
    expect(text).toMatch(/nothing here says whether such a law exists/i)
  })

  it("does not impose that guard on a university_rules search", async () => {
    // Its handler searches every reachable register at once when no
    // jurisdiction is named, so requiring one would remove a working call.
    const result = await searchDecisions(noNetworkClient, { domain: "university_rules", query: "University of Sydney" })
    expect(result.content.map((entry) => entry.text).join("\n")).not.toContain("needs a jurisdiction")
  })

  it("refuses a state_law fetch without a jurisdiction rather than guessing one", async () => {
    const result = await getDecisionText(noNetworkClient, { domain: "state_law", id: "act-1899-009" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toMatch(/needs a jurisdiction/)
    expect(text).toMatch(/the id alone does not say which register/)
  })

  it("applies the same guard to university_rules", async () => {
    const result = await getDecisionText(noNetworkClient, { domain: "university_rules", id: "x" })
    expect(result.isError).toBe(true)
  })
})

describe("validating a dispatch against the domain that will run it", () => {
  it("reports a missing required parameter as a parameter problem, not an upstream failure", async () => {
    // search_decisions carries three parameters; the domain behind it has its
    // own schema. Dispatching unvalidated turned a missing `query` into a
    // TypeError inside the source module, labelled as an external API error.
    const result = await searchDecisions(noNetworkClient, { domain: "cases" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[INVALID_PARAMETER]")
    expect(text).toContain("query")
    expect(text).not.toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain("No source was queried")
  })

  it("names the domain whose schema rejected the call", async () => {
    const result = await searchDecisions(noNetworkClient, { domain: "tax_tribunal" })
    expect(result.content[0].text).toContain('search_decisions(domain="tax_tribunal")')
  })

  it("lets a well-formed dispatch through untouched", async () => {
    // `query` satisfies SearchCompetitionSchema, so the handler still runs and
    // the domain's own blocked notice comes back.
    const result = await searchDecisions(noNetworkClient, { domain: "competition", query: "cartel" })
    expect(result.content[0].text).toContain("[UPSTREAM_BLOCKED]")
  })
})

describe("compaction routing", () => {
  it("marks the domains whose handlers shorten their own body", () => {
    for (const domain of ["cases", "state_law", "tax_rulings", "admin_appeals"] as const) {
      expect(SELF_COMPACTING.has(domain)).toBe(true)
    }
  })

  it("marks the three domains whose handlers now take `full` themselves", () => {
    // They hand over a real body (an FWC decision, a NACC index entry, an MPC
    // case study), so `full=true` is honoured in the handler and this file must
    // not compact the result a second time.
    for (const domain of ["workplace", "integrity", "public_service"] as const) {
      expect(SELF_COMPACTING.has(domain)).toBe(true)
    }
  })

  it("does not double-shorten the link-only domains", () => {
    // These return metadata and links, so there is no body to compact twice.
    for (const domain of ["treaties", "privacy", "gazettes"] as const) {
      expect(SELF_COMPACTING.has(domain)).toBe(false)
    }
  })
})

describe("what the schema advertises is what the code does", () => {
  const shapeOf = (domain: (typeof DECISION_DOMAINS)[number]) =>
    (SEARCH_SCHEMAS[domain] as unknown as z.ZodObject<Record<string, unknown>>).shape

  it("names exactly the domains whose search ignores `limit`", () => {
    // The parameter is advertised for all eighteen; the two whose sources hand
    // over a fixed page cannot honour it, and the description says which.
    const ignoring = DECISION_DOMAINS.filter((domain) => !("limit" in shapeOf(domain)))
    expect([...ignoring].sort()).toEqual(["constitutional", "treaties"])
    const described = SearchDecisionsSchema.shape.limit.description ?? ""
    for (const domain of ignoring) expect(described).toContain(domain)
  })

  it("does not promise a verbatim body for the domain that cannot return one", () => {
    const described = GetDecisionTextSchema.shape.full.description ?? ""
    expect(described).toContain("constitutional")
    expect(described).toMatch(/except constitutional/)
  })
})

describe("full=true on a domain whose handler cannot act on it", () => {
  it("says so once instead of leaving the caller to loop on the marker", async () => {
    // The omission marker is generic: "call again with full=true". For a domain
    // that ignores the flag, following it makes the identical call forever.
    const result = await getDecisionText(noNetworkClient, { domain: "constitutional", id: "x", full: true })
    const text = result.content.map((entry) => entry.text).join("\n")
    expect(text).toContain('domain "constitutional" does not honour full=true')
    expect(text).toContain("Source URL")
  })

  it("adds no such note when full was not asked for", async () => {
    const result = await getDecisionText(noNetworkClient, { domain: "constitutional", id: "x" })
    expect(result.content.map((entry) => entry.text).join("\n")).not.toContain("does not honour full=true")
  })
})

describe("competition falls back rather than returning nothing", () => {
  it("leads with [UPSTREAM_BLOCKED] and the registers' links", async () => {
    const result = await searchDecisions(noNetworkClient, { domain: "competition", query: "cartel" })
    const text = result.content.map((entry) => entry.text).join("\n")
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toContain("accc.gov.au/public-registers")
    expect(text).toContain("competitiontribunal.gov.au/decisions")
    expect(text).toMatch(/never queried/i)
  })
})
