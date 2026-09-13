import { describe, expect, it } from "vitest"
import { inspectAsideResult } from "./verify-aside.mjs"

const source = "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/full/2020/2020fcafc0130"
const citation = "[2020] FCAFC 130"
const message = (text, followup) => ({ result: { content: [{ type: "text", text }], ...(followup ? { structuredContent: { followup } } : {}) } })
const judgment = `=== TPG ${citation} ===\nCitation: ${citation}\nSource: ${source}\nRetrieved via: Aside\nReasons:\n1 The appeal is dismissed.`

describe("live Aside report validation (offline)", () => {
  it("does not open a browser on import", () => expect(typeof inspectAsideResult).toBe("function"))
  it("recognizes successful exact retrieval", () => expect(inspectAsideResult(message(judgment), { citation }).status).toBe("retrieved"))
  it("rejects wrong citation and error-page reasons", () => {
    expect(() => inspectAsideResult(message(judgment), { citation: "[2020] FCAFC 13" })).toThrow("Exact judgment identity")
    expect(() => inspectAsideResult(message(judgment.replace(/^===.*===/, "=== Page Not Found ===")))).toThrow("Error pages")
  })
  it("keeps blocked-source observations separate from retrieved judgments", () => {
    expect(inspectAsideResult(message("The source remains blocked.", { pending: true, gaps: [] })).status).toBe("unresolved")
    expect(() => inspectAsideResult(message("no case exists"))).toThrow("Unclassified")
  })
  it("requires an actionable source-linked gap for omitted reasons", () => {
    expect(() => inspectAsideResult(message(judgment + "\n[TRUNCATED]"))).toThrow("source-linked")
    expect(inspectAsideResult(message(judgment + "\n[TRUNCATED]", { pending: true, gaps: [{ kind: "truncated", target: { citation }, sourceUrls: [source] }] })).pending).toBe(true)
  })
  it("checks search scope and page number", () => {
    const text = "Retrieved via: Aside\nResult page: 2; displayed 1\n1. TPG [2020] FCAFC 130\n   https://www.austlii.edu.au/au/cases/cth/FCAFC/2020/130.html"
    expect(inspectAsideResult(message(text), { court: "FCAFC", jurisdiction: "Cth", page: 2 }).status).toBe("search_results")
    expect(() => inspectAsideResult(message(text), { court: "FCA" })).toThrow()
    expect(() => inspectAsideResult(message(text), { page: 1 })).toThrow()
  })
})
