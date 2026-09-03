import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DECISION_DOMAINS, DOMAIN_LABELS, SELF_COMPACTING, getDecisionText, searchDecisions } from "./unified-decisions.js"

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

describe("compaction routing", () => {
  it("marks the domains whose handlers shorten their own body", () => {
    for (const domain of ["cases", "state_law", "tax_rulings", "admin_appeals"] as const) {
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
