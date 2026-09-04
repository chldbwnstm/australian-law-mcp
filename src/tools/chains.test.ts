/**
 * Chain behaviour, with every upstream tool mocked.
 *
 * What is under test is the chain's own contract — which branches run, what a
 * failed branch turns into, whether a partial answer is still an answer — not
 * the tools it calls. Those have their own suites, and letting them run here
 * would make a chain test fail for reasons that have nothing to do with chains.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuApiClient } from "../lib/api-client.js"

const ok = (text: string) => ({ content: [{ type: "text", text }] })
const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true })

const resolveChainBaseLaw = vi.fn()
const getThreeTier = vi.fn()
const getBatchProvisions = vi.fn()
const getSchedules = vi.fn()
const searchCases = vi.fn()
const searchRulings = vi.fn()
const searchAdminAppeals = vi.fn()
const searchWorkplaceDecisions = vi.fn()
const searchTaxTribunalDecisions = vi.fn()
const compareOldNew = vi.fn()
const getProvisionHistory = vi.fn()
const getStateEquivalents = vi.fn()
const getEnabledInstruments = vi.fn()
const searchStateLaw = vi.fn()
const searchAiLaw = vi.fn()
const getLawText = vi.fn()
const analyzeDocument = vi.fn()
const fetchSearchDetailChain = vi.fn()

vi.mock("./chain-law-lookup.js", () => ({
  resolveChainBaseLaw: (...a: unknown[]) => resolveChainBaseLaw(...a),
}))
vi.mock("./three-tier.js", () => ({ getThreeTier: (...a: unknown[]) => getThreeTier(...a) }))
vi.mock("./batch-provisions.js", () => ({ getBatchProvisions: (...a: unknown[]) => getBatchProvisions(...a) }))
vi.mock("./schedules.js", () => ({ getSchedules: (...a: unknown[]) => getSchedules(...a) }))
vi.mock("./precedents.js", () => ({ searchCases: (...a: unknown[]) => searchCases(...a) }))
vi.mock("./rulings.js", () => ({ searchRulings: (...a: unknown[]) => searchRulings(...a) }))
vi.mock("./admin-appeals.js", () => ({ searchAdminAppeals: (...a: unknown[]) => searchAdminAppeals(...a) }))
vi.mock("./committee-decisions.js", () => ({
  searchWorkplaceDecisions: (...a: unknown[]) => searchWorkplaceDecisions(...a),
  searchPrivacyDecisions: vi.fn(),
  searchCompetitionDecisions: vi.fn(),
  searchIntegrityDecisions: vi.fn(),
  searchPublicServiceDecisions: vi.fn(),
}))
vi.mock("./tax-tribunal-decisions.js", () => ({
  searchTaxTribunalDecisions: (...a: unknown[]) => searchTaxTribunalDecisions(...a),
}))
vi.mock("./comparison.js", () => ({ compareOldNew: (...a: unknown[]) => compareOldNew(...a) }))
vi.mock("./provision-history.js", () => ({ getProvisionHistory: (...a: unknown[]) => getProvisionHistory(...a) }))
vi.mock("./law-linkage.js", () => ({
  getStateEquivalents: (...a: unknown[]) => getStateEquivalents(...a),
  getEnabledInstruments: (...a: unknown[]) => getEnabledInstruments(...a),
}))
vi.mock("./state-law.js", () => ({ searchStateLaw: (...a: unknown[]) => searchStateLaw(...a) }))
vi.mock("./ai-search.js", () => ({ searchAiLaw: (...a: unknown[]) => searchAiLaw(...a) }))
vi.mock("./law-text.js", () => ({ getLawText: (...a: unknown[]) => getLawText(...a) }))
vi.mock("./document-analysis.js", () => ({ analyzeDocument: (...a: unknown[]) => analyzeDocument(...a) }))
vi.mock("./search-detail-chain.js", () => ({
  fetchSearchDetailChain: (...a: unknown[]) => fetchSearchDetailChain(...a),
}))

const {
  chainActionBasis,
  chainAmendmentTrack,
  chainDisputePrep,
  chainDocumentReview,
  chainFullResearch,
  chainLawSystem,
  chainProcedureDetail,
  chainStateLawCompare,
  detectDisputeDomain,
  detectExpansions,
  extractSearchHints,
} = await import("./chains.js")

const client = {} as AuApiClient
const CCA = { registerId: "C2004A00109", name: "Competition and Consumer Act 2010", collection: "Act", status: "InForce" }

beforeEach(() => {
  vi.clearAllMocks()
  resolveChainBaseLaw.mockResolvedValue({ laws: [CCA], searchedWith: "CCA", attempts: ["CCA"] })
  for (const stub of [
    getThreeTier, getBatchProvisions, getSchedules, searchCases, searchRulings, searchAdminAppeals,
    searchWorkplaceDecisions, searchTaxTribunalDecisions, compareOldNew, getProvisionHistory,
    getStateEquivalents, getEnabledInstruments, searchStateLaw, searchAiLaw, getLawText,
  ]) {
    stub.mockResolvedValue(ok("stub result"))
  }
  fetchSearchDetailChain.mockResolvedValue(null)
})

describe("reading the question", () => {
  it("routes a dispute to the body that actually hears it", () => {
    expect(detectDisputeDomain("unfair dismissal small business")).toBe("workplace")
    expect(detectDisputeDomain("objection to an amended assessment")).toBe("tax")
    expect(detectDisputeDomain("data breach notification")).toBe("privacy")
    expect(detectDisputeDomain("boundary fence")).toBe("general")
  })

  it("does not read 'act' out of 'contract' or 'transaction'", () => {
    // The commonest word in the vocabulary; a substring test makes it match
    // almost every legal question ever asked.
    expect(detectExpansions("contract variation")).not.toContain("cases")
    expect(detectDisputeDomain("transaction")).toBe("general")
  })

  it("hears fees, forms and tables as a request for schedules", () => {
    expect(detectExpansions("what is the application fee")).toContain("schedule_fee")
    expect(detectExpansions("which approved form do I lodge")).toContain("schedule_form")
    expect(detectExpansions("penalty units for a breach")).toContain("schedule_fee")
  })
})

describe("chain_law_system", () => {
  it("stops with the search terms named when no law matched", async () => {
    resolveChainBaseLaw.mockResolvedValue({ laws: [], attempts: ["bond rules", "bond rules (full text)"] })
    const result = await chainLawSystem(client, { query: "bond rules" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toContain("[NOT_FOUND]")
    // A caller told nothing about what was tried cannot rephrase.
    expect(text).toContain('"bond rules"')
    expect(text).toContain("Do not invent an Act")
    // The federal/state split is the likeliest cause and has to be named.
    expect(text).toContain("search_state_law")
  })

  it("reports an unreachable Register as an upstream failure, never as absence", async () => {
    // Every rung threw, so nothing was searched. `[NOT_FOUND]` here would say
    // there is no such Commonwealth law on the strength of an outage.
    resolveChainBaseLaw.mockResolvedValue({
      laws: [],
      attempts: ["Fair Work Act", "Fair Work Act (full text)"],
      failures: [
        { term: "Fair Work Act", message: "frlApi upstream server error (503)" },
        { term: "Fair Work Act (full text)", message: "frlApi request timed out" },
      ],
    })
    const result = await chainLawSystem(client, { query: "Fair Work Act" })
    expect(result.isError).toBe(true)
    const text = result.content[0].text

    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(text).not.toContain("[NOT_FOUND]")
    expect(text).toContain("NOT a finding that no such law exists")
    // The failed rungs are named, so the caller can see it was transport.
    expect(text).toContain('"Fair Work Act": frlApi upstream server error (503)')
    expect(text).toContain("frlApi request timed out")
  })

  it("fetches only the provisions that were asked for", async () => {
    await chainLawSystem(client, { query: "CCA" })
    expect(getBatchProvisions).not.toHaveBeenCalled()

    await chainLawSystem(client, { query: "CCA", provisions: ["s 18"] })
    expect(getBatchProvisions).toHaveBeenCalledWith(client, {
      registerId: "C2004A00109",
      provisions: ["s 18"],
    })
  })

  it("pulls schedules when the question is about fees, and not otherwise", async () => {
    await chainLawSystem(client, { query: "CCA structure" })
    expect(getSchedules).not.toHaveBeenCalled()
    await chainLawSystem(client, { query: "CCA registration fee" })
    expect(getSchedules).toHaveBeenCalled()
  })

  it("marks a failed branch instead of dropping it", async () => {
    getThreeTier.mockResolvedValue(fail("[UPSTREAM_NO_DATA] the Register did not answer"))
    const text = (await chainLawSystem(client, { query: "CCA" })).content[0].text
    expect(text).toContain("[NOT RETRIEVED]")
    expect(text).toContain("Do not infer, guess or generate its contents")
    expect(text).toContain("UPSTREAM_NO_DATA")
  })
})

describe("chain_action_basis", () => {
  it("runs all four branches and keeps the output order", async () => {
    searchRulings.mockResolvedValue(ok("TR 2024/1"))
    searchCases.mockResolvedValue(ok("Smith v Jones"))
    searchAdminAppeals.mockResolvedValue(ok("ART decision"))
    const text = (await chainActionBasis(client, { query: "infringement notice" })).content[0].text

    expect(getThreeTier).toHaveBeenCalled()
    expect(searchRulings).toHaveBeenCalled()
    expect(searchCases).toHaveBeenCalled()
    expect(searchAdminAppeals).toHaveBeenCalled()
    expect(text.indexOf("Rulings and interpretations")).toBeLessThan(text.indexOf("Case law"))
    expect(text.indexOf("Case law")).toBeLessThan(text.indexOf("Tribunal review decisions"))
  })

  it("survives one dead branch with the rest intact", async () => {
    searchRulings.mockRejectedValue(new Error("ATO form timed out"))
    searchCases.mockResolvedValue(ok("Smith v Jones [2020] HCA 1"))
    const result = await chainActionBasis(client, { query: "infringement notice" })
    expect(result.isError).toBeFalsy()
    const text = result.content[0].text
    expect(text).toContain("ATO form timed out")
    expect(text).toContain("Smith v Jones")
  })

  it("searches cases by the Act's name, not the raw question", async () => {
    // Court search engines match party names and catchwords, not sentences;
    // handing them "can the regulator issue an infringement notice" returns
    // nothing and the chain reports a gap that is really a bad query.
    await chainActionBasis(client, { query: "can the regulator issue an infringement notice" })
    expect(searchCases).toHaveBeenCalledWith(client, { query: CCA.name, limit: 5 })
  })
})

describe("chain_dispute_prep", () => {
  it("adds the specialist forum the question implies", async () => {
    await chainDisputePrep(client, { query: "unfair dismissal small business" })
    expect(searchWorkplaceDecisions).toHaveBeenCalled()
    expect(searchTaxTribunalDecisions).not.toHaveBeenCalled()
  })

  it("says so when there is no specialist forum, rather than showing nothing", async () => {
    const text = (await chainDisputePrep(client, { query: "boundary fence" })).content[0].text
    expect(text).toContain("No specialist forum was detected")
  })

  it("always tells the caller the authorities are unchecked", async () => {
    // A judgment can be overruled, or its statutory basis repealed, with
    // nothing in the search result saying so.
    const text = (await chainDisputePrep(client, { query: "unfair dismissal" })).content[0].text
    expect(text).toContain("cite_check")
  })
})

describe("chain_amendment_track", () => {
  it("traces the provision history only when a provision was named", async () => {
    await chainAmendmentTrack(client, { query: "CCA" })
    expect(getProvisionHistory).not.toHaveBeenCalled()
    const text = (await chainAmendmentTrack(client, { query: "CCA" })).content[0].text
    expect(text).toContain("Pass `provision`")

    await chainAmendmentTrack(client, { query: "CCA", provision: "s 45" })
    expect(getProvisionHistory).toHaveBeenCalledWith(client, { registerId: "C2004A00109", provision: "s 45" })
  })

  it("passes the dates through to the comparison", async () => {
    await chainAmendmentTrack(client, { query: "CCA", fromDate: "2019-01-01", toDate: "2024-01-01" })
    expect(compareOldNew).toHaveBeenCalledWith(client, {
      registerId: "C2004A00109",
      fromDate: "2019-01-01",
      toDate: "2024-01-01",
    })
  })
})

describe("chain_state_law_compare", () => {
  it("carries on when there is no Commonwealth Act, and says why", async () => {
    resolveChainBaseLaw.mockResolvedValue({ laws: [], attempts: ["residential tenancy"] })
    const result = await chainStateLawCompare(client, { query: "residential tenancy" })
    // No federal Act is the *correct* answer for tenancy, not a failure.
    expect(result.isError).toBeFalsy()
    const text = result.content[0].text
    expect(text).toContain("that is the correct")
    expect(getStateEquivalents).toHaveBeenCalled()
  })

  it("does not call an unreachable Register 'the correct answer' for the federal side", async () => {
    resolveChainBaseLaw.mockResolvedValue({
      laws: [],
      attempts: ["residential tenancy"],
      failures: [{ term: "residential tenancy", message: "frlApi upstream server error (503)" }],
    })
    const result = await chainStateLawCompare(client, { query: "residential tenancy" })
    const text = result.content[0].text

    // "That is the correct answer rather than a failure: they are state law"
    // is a federal/state conclusion, and an outage establishes no such thing.
    expect(text).not.toContain("that is the correct")
    expect(text).toContain("[EXTERNAL_API_ERROR]")
    expect(text).toContain("NOT because none exists")
    // The state half is real data and still runs — a marked gap, not a dead chain.
    expect(getStateEquivalents).toHaveBeenCalled()
    expect(searchStateLaw).toHaveBeenCalledTimes(2)
  })

  it("searches at most two registers, because each is a different slow site", async () => {
    await chainStateLawCompare(client, { query: "work health and safety" })
    expect(searchStateLaw).toHaveBeenCalledTimes(2)
  })

  it("explains applied vs uniform vs comparable, and names the two blocked registers", async () => {
    const text = (await chainStateLawCompare(client, { query: "ACL" })).content[0].text
    expect(text).toContain("'Applied'")
    expect(text).toContain("'uniform'")
    expect(text).toContain("NSW and SA are link-only")
    expect(text).toContain("not evidence that they have no counterpart")
  })
})

describe("chain_full_research", () => {
  it("shows the full-text search even when no single Act could be picked", async () => {
    resolveChainBaseLaw.mockResolvedValue({ laws: [], attempts: ["x"] })
    searchAiLaw.mockResolvedValue(ok("Fair Work Act 2009 [C2009A00028]"))
    const result = await chainFullResearch(client, { query: "stood down without pay" })
    expect(result.isError).toBeFalsy()
    const text = result.content[0].text
    expect(text).toContain("Fair Work Act 2009")
    expect(text).toContain("No single Act was identified")
    expect(getLawText).not.toHaveBeenCalled()
  })

  it("fetches the Act's structure when one was picked", async () => {
    await chainFullResearch(client, { query: "misleading conduct" })
    expect(getLawText).toHaveBeenCalledWith(client, { registerId: "C2004A00109", maxChars: 8000 })
  })
})

describe("chain_procedure_detail", () => {
  it("opens the instrument's schedules, which is where the fees actually are", async () => {
    getEnabledInstruments.mockResolvedValue(ok("1. Competition and Consumer Regulations 2010\n   id: F2010L02522 | InForce"))
    await chainProcedureDetail(client, { query: "registering a business name" })
    expect(getSchedules).toHaveBeenCalledWith(client, { registerId: "C2004A00109" })
    expect(getSchedules).toHaveBeenCalledWith(client, { registerId: "F2010L02522" })
  })

  it("says there is no second level rather than leaving a hole", async () => {
    getEnabledInstruments.mockResolvedValue(ok("No instruments are made under this Act."))
    const text = (await chainProcedureDetail(client, { query: "lodging a notice" })).content[0].text
    expect(text).toContain("no second level of")
  })

  it("warns that a printed amount may not be the amount payable", async () => {
    // Commonwealth amounts are penalty units or annually indexed; the figure in
    // the schedule is routinely not today's figure.
    const text = (await chainProcedureDetail(client, { query: "application fee" })).content[0].text
    expect(text).toContain("penalty units")
    expect(text).toContain("may not be the amount")
  })
})

describe("chain_document_review", () => {
  const TRIAGE = `=== Document risk triage ===

--- Signals ---
[HIGH] Unilateral variation right
  Next: check it
  Read: Australian Consumer Law s 23; unfair contract terms

--- Suggested follow-up searches ---
  - unfair contract terms standard form
  - unilateral variation clause
`

  it("reads follow-up searches out of the triage", () => {
    // Document order, which puts the per-signal `Read:` references ahead of
    // the generic per-document-type suggestions — only the first three are
    // searched, so the specific ones have to come first.
    expect(extractSearchHints(TRIAGE)).toEqual([
      "Australian Consumer Law s 23",
      "unfair contract terms",
      "unfair contract terms standard form",
      "unilateral variation clause",
    ])
  })

  it("fails as a whole when the triage failed — there is nothing to search for", async () => {
    analyzeDocument.mockResolvedValue(fail("[INVALID_PARAMETER] Text too short"))
    const result = await chainDocumentReview(client, { text: "x".repeat(50), maxClauses: 30 })
    expect(result.isError).toBe(true)
    expect(searchAiLaw).not.toHaveBeenCalled()
  })

  it("runs at most three follow-up searches per family", async () => {
    analyzeDocument.mockResolvedValue(ok(TRIAGE))
    await chainDocumentReview(client, { text: "x".repeat(200), maxClauses: 30 })
    expect(searchAiLaw).toHaveBeenCalledTimes(3)
    expect(searchCases).toHaveBeenCalledTimes(3)
  })

  it("says a quiet triage is not a clearance", async () => {
    analyzeDocument.mockResolvedValue(ok("=== Document risk triage ===\n\nNo rule in the bundled set matched."))
    const text = (await chainDocumentReview(client, { text: "x".repeat(200), maxClauses: 30 })).content[0].text
    expect(text).toContain("not a clearance")
  })

  it("warns that the governing jurisdiction changes the answer", async () => {
    analyzeDocument.mockResolvedValue(ok(TRIAGE))
    const text = (await chainDocumentReview(client, { text: "x".repeat(200), maxClauses: 30 })).content[0].text
    expect(text).toContain("state Act that was never searched")
  })
})
