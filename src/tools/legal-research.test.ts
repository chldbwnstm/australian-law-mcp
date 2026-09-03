import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] })

const chainFullResearch = vi.fn()
const chainLawSystem = vi.fn()
const chainActionBasis = vi.fn()
const chainDisputePrep = vi.fn()
const chainAmendmentTrack = vi.fn()
const chainStateLawCompare = vi.fn()
const chainProcedureDetail = vi.fn()
const chainDocumentReview = vi.fn()

vi.mock("./chains.js", () => ({
  MAX_CHAIN_QUERY: 2000,
  chainFullResearch: (...a: unknown[]) => chainFullResearch(...a),
  chainLawSystem: (...a: unknown[]) => chainLawSystem(...a),
  chainActionBasis: (...a: unknown[]) => chainActionBasis(...a),
  chainDisputePrep: (...a: unknown[]) => chainDisputePrep(...a),
  chainAmendmentTrack: (...a: unknown[]) => chainAmendmentTrack(...a),
  chainStateLawCompare: (...a: unknown[]) => chainStateLawCompare(...a),
  chainProcedureDetail: (...a: unknown[]) => chainProcedureDetail(...a),
  chainDocumentReview: (...a: unknown[]) => chainDocumentReview(...a),
}))

const { LegalResearchSchema, RESEARCH_TASKS, legalResearch, withNote } = await import("./legal-research.js")

const client = {} as AuApiClient
const parse = (raw: Record<string, unknown>) => LegalResearchSchema.parse(raw)
const run = (raw: Record<string, unknown>) => legalResearch(client, parse(raw))

beforeEach(() => {
  vi.clearAllMocks()
  for (const stub of [
    chainFullResearch, chainLawSystem, chainActionBasis, chainDisputePrep,
    chainAmendmentTrack, chainStateLawCompare, chainProcedureDetail, chainDocumentReview,
  ]) {
    stub.mockResolvedValue(ok("chain output"))
  }
})

describe("dispatch", () => {
  it("defaults to full_research when no task is given", async () => {
    await run({ query: "stood down without pay" })
    expect(chainFullResearch).toHaveBeenCalledWith(client, { query: "stood down without pay" })
  })

  it("reaches every one of the eight chains", async () => {
    const wiring: Array<[string, ReturnType<typeof vi.fn>]> = [
      ["full_research", chainFullResearch],
      ["law_system", chainLawSystem],
      ["action_basis", chainActionBasis],
      ["dispute_prep", chainDisputePrep],
      ["amendment_track", chainAmendmentTrack],
      ["state_law_compare", chainStateLawCompare],
      ["procedure_detail", chainProcedureDetail],
    ]
    for (const [task, stub] of wiring) {
      vi.clearAllMocks()
      stub.mockResolvedValue(ok("chain output"))
      await run({ task, query: "x" })
      expect(stub, task).toHaveBeenCalledTimes(1)
    }
    await run({ task: "document_review", text: "y".repeat(60) })
    expect(chainDocumentReview).toHaveBeenCalledTimes(1)
    // Nothing in the enum is unreachable.
    expect(RESEARCH_TASKS).toHaveLength(wiring.length + 1)
  })

  it("passes only the parameters that task actually takes", async () => {
    await run({ task: "law_system", query: "CCA", provisions: ["s 18"], domain: "tax" })
    expect(chainLawSystem).toHaveBeenCalledWith(client, { query: "CCA", provisions: ["s 18"] })

    await run({ task: "amendment_track", query: "CCA", provision: "s 45", toDate: "2024-01-01" })
    expect(chainAmendmentTrack).toHaveBeenCalledWith(client, {
      query: "CCA",
      provision: "s 45",
      toDate: "2024-01-01",
    })
  })
})

describe("tolerant task handling", () => {
  it("absorbs a subject word used in the task slot, and says it did", async () => {
    // The description names task and subject in one breath, so `task:"penalty"`
    // happens. Failing the call teaches the caller nothing; it retries the same
    // way. Correct it and announce the correction.
    const result = await run({ task: "penalty", query: "late lodgement" })
    expect(chainActionBasis).toHaveBeenCalled()
    expect(result.content[0].text).toContain('task="penalty"')
    expect(result.content[0].text).toContain('read as task="action_basis"')
  })

  it("falls back to full_research for an invented task name", async () => {
    const result = await run({ task: "whatever", query: "x" })
    expect(chainFullResearch).toHaveBeenCalled()
    expect(result.content[0].text).toContain("not one of the eight research patterns")
  })

  it("normalises spacing and case before absorbing", async () => {
    await run({ task: "State Law", query: "tenancy" })
    expect(chainStateLawCompare).toHaveBeenCalled()
  })

  it("never rewrites a task that was already valid", async () => {
    const result = await run({ task: "dispute_prep", query: "x" })
    expect(result.content[0].text).not.toContain("⚠")
  })
})

describe("required parameters", () => {
  it("asks for text, by name, when document_review has none", async () => {
    const result = await run({ task: "document_review" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("`text`")
    expect(chainDocumentReview).not.toHaveBeenCalled()
  })

  it("asks for query, by name, for every other task", async () => {
    const result = await run({ task: "law_system" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("`query`")
  })

  it("bounds the query the same way the chains do", () => {
    // Without it, an unbounded paste bypasses the chain schema and reaches the
    // criteria encoder and the title-phrase regex.
    expect(LegalResearchSchema.safeParse({ query: "x".repeat(3000) }).success).toBe(false)
  })
})

describe("the correction note", () => {
  it("rides on the first block rather than adding one", () => {
    // A chain response is often already at the character limit; a separate
    // block pushes the whole thing over it, and what gets cut should be the
    // tail of the body, not the warning.
    const merged = withNote("⚠ note", ok("body"))
    expect(merged.content).toHaveLength(1)
    expect(merged.content[0].text).toBe("⚠ note\nbody")
  })

  it("leaves a clean response untouched", () => {
    const response = ok("body")
    expect(withNote(undefined, response)).toBe(response)
  })

  it("keeps the warning when the body is at the limit", () => {
    const huge = ok("x".repeat(60_000))
    const merged = withNote("⚠ note", huge)
    expect(merged.content[0].text.startsWith("⚠ note")).toBe(true)
    expect(merged.content[0].text.length).toBeLessThanOrEqual(50_000)
  })
})
