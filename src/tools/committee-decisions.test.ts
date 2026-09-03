import { describe, expect, it } from "vitest"
import {
  competitionLinks,
  getCompetitionDecisionText,
  searchCompetitionDecisions,
} from "./committee-decisions.js"

const noNetworkClient = new Proxy({} as never, {
  get() {
    return () => {
      throw new Error("network access in a unit test")
    }
  },
})

describe("competitionLinks", () => {
  it("offers both blocked registers plus the Tribunal's AustLII series", () => {
    const links = competitionLinks("cartel")
    expect(links[0]).toContain("accc.gov.au/public-registers")
    expect(links[1]).toContain("competitiontribunal.gov.au/decisions")
    expect(links[2]).toContain("mask_path=au%2Fcases%2Fcth%2FACompT")
  })
})

describe("get_decision_text[competition]", () => {
  it("refuses honestly and points at the case-law tool", async () => {
    const result = await getCompetitionDecisionText(noNetworkClient, { id: "[2020] ACompT 1" })
    const text = result.content[0].text
    expect(result.isError).toBe(true)
    expect(text).toContain("[UPSTREAM_BLOCKED]")
    expect(text).toMatch(/refusal to request, not evidence the document is absent/i)
    expect(text).toContain('get_case_text(citation="[2020] ACompT 1")')
  })
})

describe("search_decisions[competition]", () => {
  it("leads with the blocked notice before falling back to case law", async () => {
    const result = await searchCompetitionDecisions(noNetworkClient, { query: "merger authorisation" })
    const text = result.content.map((entry) => entry.text).join("\n")
    const blockedAt = text.indexOf("[UPSTREAM_BLOCKED]")
    const fallbackAt = text.indexOf("Falling back to live case law")
    expect(blockedAt).toBeGreaterThanOrEqual(0)
    expect(fallbackAt).toBeGreaterThan(blockedAt)
    expect(text).toMatch(/These are court decisions, not the regulator's own register/)
  })
})
