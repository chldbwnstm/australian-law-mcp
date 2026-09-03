import { describe, expect, it } from "vitest"
import { interleave, renderDocument, renderSearch } from "./render.js"
import type { SourceHit, SourceSearchResult } from "./types.js"

const hit = (over: Partial<SourceHit> = {}): SourceHit => ({
  source: "NSW Caselaw",
  title: "Dela Cruz v R",
  citation: "[2010] NSWCCA 333",
  id: "549fff1d3004262463c85662",
  url: "https://www.caselaw.nsw.gov.au/decision/549fff1d3004262463c85662",
  ...over,
})

describe("renderSearch", () => {
  it("prints the identifier the follow-up call needs, labelled `id:`", () => {
    const text = renderSearch({ hits: [hit()], total: 1, sourceUrl: "u" }, { heading: "Cases" })
    expect(text).toContain("id: 549fff1d3004262463c85662")
    expect(text).toContain("1. Dela Cruz v R [2010] NSWCCA 333")
  })

  it("prints an exact count when the upstream's total is trustworthy", () => {
    const text = renderSearch({ hits: [hit()], total: 4, sourceUrl: "u" }, { heading: "Cases" })
    expect(text).toContain("1 of 4 results")
  })

  it("refuses to quote an unreliable total as the answer", () => {
    const result: SourceSearchResult = {
      hits: [hit()],
      total: 186201,
      totalIsUnreliable: true,
      totalNote: "facet total",
      sourceUrl: "u",
    }
    const text = renderSearch(result, { heading: "FWC" })
    expect(text).toContain("1 result returned (upstream reports 186,201")
    expect(text).not.toMatch(/^186,201 results/m)
    expect(text).toContain("note: facet total")
  })

  it("tells the caller that an empty result is not proof of absence", () => {
    const text = renderSearch({ hits: [], sourceUrl: "https://x" }, { heading: "Cases", query: "zzz" })
    expect(text).toMatch(/not proof of absence/i)
    expect(text).toMatch(/do not tell the user the decision does not exist/i)
    expect(text).toContain("https://x")
  })

  it("shows the source label only when several sources are merged", () => {
    const merged = renderSearch({ hits: [hit()], sourceUrl: "u" }, { heading: "h", showSource: true })
    const single = renderSearch({ hits: [hit()], sourceUrl: "u" }, { heading: "h" })
    expect(merged).toContain("source: NSW Caselaw")
    expect(single).not.toContain("source: NSW Caselaw")
  })

  it("prints the caller's notes and follow-up call", () => {
    const text = renderSearch(
      { hits: [hit()], sourceUrl: "u" },
      { heading: "h", notes: ["ART is blocked"], followUp: 'get_case_text(id="…")' },
    )
    expect(text).toContain("note: ART is blocked")
    expect(text).toContain('Full text: get_case_text(id="…")')
  })
})

describe("renderDocument", () => {
  const document = {
    title: "Dela Cruz v R",
    citation: "[2010] NSWCCA 333",
    url: "https://x",
    metadata: [["CITATION", "Dela Cruz v R [2010] NSWCCA 333"]] as Array<[string, string]>,
    text: "reasons here",
    documents: [{ label: "PDF", url: "https://x/export.pdf" }],
    note: "the PDF is authorised",
  }

  it("prints title, citation, source, metadata, documents and the note", () => {
    const text = renderDocument(document)
    expect(text).toContain("=== Dela Cruz v R ===")
    expect(text).toContain("Citation: [2010] NSWCCA 333")
    expect(text).toContain("CITATION: Dela Cruz v R [2010] NSWCCA 333")
    expect(text).toContain("  - PDF: https://x/export.pdf")
    expect(text).toContain("Note: the PDF is authorised")
  })

  it("uses the caller's body heading so compactLongSections can find it later", () => {
    expect(renderDocument(document, { bodyHeading: "Reasons" })).toContain("Reasons:\nreasons here")
  })

  it("shortens a long body unless full=true", () => {
    const long = { ...document, text: "para. ".repeat(2000) }
    expect(renderDocument(long)).toContain("⋯ omitted")
    expect(renderDocument(long, { full: true })).not.toContain("⋯ omitted")
  })

  it("omits the body section entirely when there is no text", () => {
    const text = renderDocument({ ...document, text: "" }, { bodyHeading: "Reasons" })
    expect(text).not.toContain("Reasons:")
  })
})

describe("interleave", () => {
  it("alternates between sources so an early reader sees more than one view", () => {
    const a: SourceSearchResult = { hits: [hit({ id: "a1" }), hit({ id: "a2" })], sourceUrl: "u" }
    const b: SourceSearchResult = { hits: [hit({ id: "b1" })], sourceUrl: "u" }
    expect(interleave([a, b]).map((entry) => entry.id)).toEqual(["a1", "b1", "a2"])
  })

  it("handles an empty source list", () => {
    expect(interleave([])).toEqual([])
  })
})
