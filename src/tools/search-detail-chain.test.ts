import { describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"
import { SEARCH_DETAIL_CHAINS } from "../lib/tool-chain-config.js"
import { V3_EXPOSED } from "../lib/tool-profiles.js"

const getCaseText = vi.fn()
const getLawText = vi.fn()

vi.mock("./precedents.js", () => ({ getCaseText: (...args: unknown[]) => getCaseText(...args) }))
vi.mock("./law-text.js", () => ({ getLawText: (...args: unknown[]) => getLawText(...args) }))

const { extractDetailIds, fetchSearchDetailChain } = await import("./search-detail-chain.js")

const CASES = `Case law — "misleading conduct"
2 results returned

1. Smith v Jones [2020] NSWSC 41
   id: nsw:aaa  ·  source: nswCaselaw
2. Brown v Green [2021] QSC 7
   id: qld:bbb  ·  source: qldJudgments
3. Third v Fourth [2022] HCA 1
   id: hca:ccc  ·  source: hcourt
`

const client = {} as AuApiClient

describe("the chain table itself", () => {
  it("names a detail tool and an id parameter for every entry", () => {
    for (const [searchTool, chain] of Object.entries(SEARCH_DETAIL_CHAINS)) {
      expect(chain.detailTool, searchTool).toMatch(/^get_/)
      expect(chain.detailParam, searchTool).toBeTruthy()
      expect(chain.idRegex.source, searchTool).toBeTruthy()
    }
  })

  it("leaves out the detail tools that need more than an id", () => {
    // get_decision_text needs `domain`, get_state_law_text needs `jurisdiction`.
    // Listing them with a single param would fetch the wrong record rather than
    // skip a step — a worse failure than not chaining at all.
    expect(SEARCH_DETAIL_CHAINS.search_decisions).toBeUndefined()
    expect(SEARCH_DETAIL_CHAINS.search_state_law).toBeUndefined()
    expect(SEARCH_DETAIL_CHAINS.search_treaties).toBeUndefined()
  })

  it("keeps the search tools it does list out of the advertised set", () => {
    // Not a rule about chaining — a sanity check that the table is describing
    // the two-hop tools rather than duplicating the ten exposed ones.
    expect(V3_EXPOSED.has("search_cases")).toBe(false)
  })
})

describe("search → detail", () => {
  it("expands two judgments but only one of anything else", () => {
    // One authority reads as if it settles the point; two do not.
    expect(extractDetailIds("search_cases", CASES)).toEqual(["nsw:aaa", "qld:bbb"])
    expect(extractDetailIds("search_rulings", CASES)).toEqual(["nsw:aaa"])
  })

  it("passes full=false only to tools whose schema has it", async () => {
    getCaseText.mockResolvedValue({ content: [{ type: "text", text: "reasons" }] })
    await fetchSearchDetailChain(client, "search_cases", { text: CASES, isError: false }, { limit: 1 })
    expect(getCaseText).toHaveBeenCalledWith(client, { id: "nsw:aaa", full: false })

    getLawText.mockResolvedValue({ content: [{ type: "text", text: "s 18" }] })
    await fetchSearchDetailChain(
      client,
      "search_law",
      { text: "1. CCA\n   id: C2004A00109 | Act | InForce", isError: false },
    )
    // get_law_text has no `full`; Zod would drop it silently, so it is not sent.
    expect(getLawText).toHaveBeenCalledWith(client, { registerId: "C2004A00109" })
  })

  it("never follows a failed search", async () => {
    getCaseText.mockClear()
    const result = await fetchSearchDetailChain(client, "search_cases", { text: CASES, isError: true })
    expect(result).toBeNull()
    expect(getCaseText).not.toHaveBeenCalled()
  })

  it("reports a per-record failure without discarding the record that worked", async () => {
    getCaseText.mockReset()
    getCaseText
      .mockResolvedValueOnce({ content: [{ type: "text", text: "full reasons" }] })
      .mockRejectedValueOnce(new Error("upstream refused"))

    const result = await fetchSearchDetailChain(client, "search_cases", { text: CASES, isError: false })
    expect(result?.text).toContain("[nsw:aaa]")
    expect(result?.text).toContain("full reasons")
    expect(result?.text).toContain("upstream refused")
    // One of two failed — a partial fetch is still information.
    expect(result?.isError).toBe(false)
  })

  it("is an error only when every record failed", async () => {
    getCaseText.mockReset()
    getCaseText.mockRejectedValue(new Error("upstream refused"))
    const result = await fetchSearchDetailChain(client, "search_cases", { text: CASES, isError: false })
    expect(result?.isError).toBe(true)
  })

  it("returns null rather than an empty block when the search found nothing", async () => {
    const empty = "Case law — \"zzz\"\n0 results returned\n\nNo rows came back from this source."
    expect(await fetchSearchDetailChain(client, "search_cases", { text: empty, isError: false })).toBeNull()
  })
})
