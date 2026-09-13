import { describe, expect, it } from "vitest"
import { sourceDocumentResponse } from "./source-document.js"
import { boundToolResponse } from "../lib/research-followup.js"

describe("typed source-document follow-up", () => {
  it("emits an original-body gap for a PDF-backed summary", () => {
    const result = sourceDocumentResponse({ title: "Example v Example", citation: "[2020] HCA 1", url: "https://court.example/case", metadata: [], text: "Catchwords only", bodyStatus: "summary_only", documents: [{ label: "PDF", url: "https://court.example/Case.PDF" }] }, { originTool: "get_case_text", bodyHeading: "Reasons", full: false })
    expect(result.structuredContent?.followup.gaps).toEqual([expect.objectContaining({ kind: "document_body", sourceUrls: ["https://court.example/Case.PDF"] })])
  })

  it("does not infer a missing body merely because full HTML also links a PDF", () => {
    const result = sourceDocumentResponse({ title: "Example", url: "https://court.example/case", metadata: [], text: "Complete HTML reasons", bodyStatus: "full_text", documents: [{ label: "PDF", url: "https://court.example/case.pdf" }] }, { originTool: "get_case_text", full: false })
    expect(result.structuredContent).toBeUndefined()
  })

  it.each(["Ordinary text. ".repeat(5000), '"\\\n'.repeat(12_000)])("preserves a source-linked gap when full=true exceeds rendering or serialized limits", (text) => {
    const response = sourceDocumentResponse({ title: "TPG", citation: "[2020] FCAFC 130", url: "https://www.austlii.edu.au/au/cases/cth/FCAFC/2020/130.html", metadata: [], text }, { originTool: "get_case_text", full: true })
    const bounded = boundToolResponse(response, "get_case_text", 50_000)
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(50_000)
    expect(bounded.structuredContent?.followup.pending).toBe(true)
    expect(bounded.structuredContent?.followup.gaps).toEqual([expect.objectContaining({ kind: "truncated", target: { citation: "[2020] FCAFC 130" }, sourceUrls: ["https://www.austlii.edu.au/au/cases/cth/FCAFC/2020/130.html"] })])
  })
})
