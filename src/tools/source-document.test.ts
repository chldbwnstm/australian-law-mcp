import { describe, expect, it } from "vitest"
import { sourceDocumentResponse } from "./source-document.js"

describe("typed source-document follow-up", () => {
  it("emits an original-body gap for a PDF-backed summary", () => {
    const result = sourceDocumentResponse({ title: "Example v Example", citation: "[2020] HCA 1", url: "https://court.example/case", metadata: [], text: "Catchwords only", bodyStatus: "summary_only", documents: [{ label: "PDF", url: "https://court.example/Case.PDF" }] }, { originTool: "get_case_text", bodyHeading: "Reasons", full: false })
    expect(result.structuredContent?.followup.gaps).toEqual([expect.objectContaining({ kind: "document_body", sourceUrls: ["https://court.example/Case.PDF"] })])
  })

  it("does not infer a missing body merely because full HTML also links a PDF", () => {
    const result = sourceDocumentResponse({ title: "Example", url: "https://court.example/case", metadata: [], text: "Complete HTML reasons", bodyStatus: "full_text", documents: [{ label: "PDF", url: "https://court.example/case.pdf" }] }, { originTool: "get_case_text", full: false })
    expect(result.structuredContent).toBeUndefined()
  })
})
