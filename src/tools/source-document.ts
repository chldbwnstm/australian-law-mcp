/** Render a source document while preserving machine-readable missing-original gaps. */
import type { SourceDocument } from "../lib/sources/types.js"
import { renderDocument, type RenderDocumentOptions } from "../lib/sources/render.js"
import { followupEnvelope, makeGap, type ResearchGap } from "../lib/research-followup.js"
import type { LooseToolResponse } from "../lib/types.js"
import { compactBody } from "../lib/decision-compact.js"

export function sourceDocumentResponse(
  document: SourceDocument,
  options: RenderDocumentOptions & { originTool: string; documentId?: string; jurisdiction?: string },
): LooseToolResponse {
  const gaps: ResearchGap[] = []
  const links = document.documents?.map((entry) => entry.url).filter((url) => /^https?:\/\//i.test(url)) ?? []
  const bodyStatus = document.bodyStatus ?? (document.text.trim() ? "full_text" : links.length ? "binary_link_only" : "metadata_only")
  if (bodyStatus !== "full_text") {
    const restricted = links.some((url) => /(?:austlii|lawcite)/i.test(url))
    gaps.push(makeGap({
      kind: "document_body", originTool: options.originTool,
      target: { ...(document.citation ? { citation: document.citation } : {}), ...(options.documentId ? { documentId: options.documentId } : {}) },
      ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
      reason: `The source adapter classified this response as ${bodyStatus}; it is not the complete original body.`,
      sourceUrls: links.length ? links : [document.url], sourceAccess: restricted ? "requires_access" : "permitted",
      evidenceNeeded: ["The original document body", "An exact relevant passage with paragraph or printed-page locator"],
    }))
  }
  if (!options.full && compactBody(document.text, { full: false }).length < document.text.length) {
    gaps.push(makeGap({
      kind: "truncated", originTool: options.originTool,
      target: { ...(document.citation ? { citation: document.citation } : {}), ...(options.documentId ? { documentId: options.documentId } : {}) },
      ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
      reason: "The returned body was shortened from the middle by the decision renderer.", sourceUrls: [document.url],
      sourceAccess: "permitted", evidenceNeeded: ["The omitted paragraphs from the original decision body"],
    }))
  }
  return {
    content: [{ type: "text", text: renderDocument(document, options) }],
    ...(gaps.length ? { structuredContent: { followup: followupEnvelope(gaps, { pending: true }) } } : {}),
  }
}
