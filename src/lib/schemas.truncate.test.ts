import { describe, expect, it } from "vitest"
import { truncateResponse, truncateSections } from "./schemas.js"
import { cutAtSafeBoundary, extractSummary } from "./truncate-text.js"

// The contract the top-level cut established ("subtract the notice length from
// the budget first" · "never hard-cut") was not carried through on two paths.

describe("truncateResponse(summary) — boundary cut instead of a hard cut", () => {
  // extractSummary collects with a `maxSize - 100` budget and appends the tail.
  // The last line collected has to be long enough to blow the budget for the
  // overflow path to be taken — hence the long body lines.
  const text = Array.from({ length: 20 }, (_, i) =>
    `▶ Section ${i}\n${"a".repeat(300)}\n${"b".repeat(300)}`).join("\n")
  const max = 500

  it("cuts the summary overflow at a boundary (not a hard slice)", () => {
    const extracted = extractSummary(text, max)
    expect(extracted.length).toBeGreaterThan(max)   // this input really does take the overflow path

    const out = truncateResponse(text, { maxLength: max, summary: true })
    expect(out).not.toBe(extracted.slice(0, max))
    expect(out.length).toBeLessThanOrEqual(max)
  })

  // If the re-cut trims from the end of the document, the `📋 Summary mode`
  // tail is the first thing to go — and the truncation becomes unmarked. The
  // tail length has to be reserved in the budget.
  it("keeps the summary-mode tail after the re-cut (no unmarked truncation)", () => {
    const out = truncateResponse(text, { maxLength: max, summary: true })
    expect(out.length).toBeLessThanOrEqual(max)
    expect(out).toMatch(/📋 Summary mode: key content extracted from [\d,]+ characters \([\d,]+ characters kept\)$/)
  })

  it("leaves input under the limit alone (regression)", () => {
    expect(truncateResponse("a short response", { maxLength: 1000, summary: true })).toBe("a short response")
  })
})

describe("hard-cut surrogate-pair protection", () => {
  // `𠮷` (U+20BB7) is two UTF-16 units. A hard cut through the pair breaks
  // isWellFormed() and JSON serialisation ships it as U+FFFD.
  it("does not split an astral character in cutAtSafeBoundary's no-boundary fallback", () => {
    const text = "a".repeat(499) + "𠮷" + "b".repeat(600)  // no boundary (no line break, no terminator)
    const out = cutAtSafeBoundary(text, 500)                // unit 500 is the high surrogate
    expect(out.isWellFormed()).toBe(true)
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it("keeps the tiny-budget path (smaller than the notice) safe too", () => {
    const text = "a".repeat(19) + "𠮷" + "b".repeat(100)
    const out = truncateResponse(text, 20)                  // no budget left for the notice → slice fallback
    expect(out.isWellFormed()).toBe(true)
  })

  it("keeps truncateSections' final re-cut fallback safe", () => {
    const head = "▶ Title\n"
    const body = "a".repeat(19 - head.length) + "𠮷" + "b".repeat(30)
    const out = truncateSections(head + body, 20, 300)       // overall limit 20 < the notice length
    expect(out.isWellFormed()).toBe(true)
  })

  it("keeps an all-astral input intact at every budget", () => {
    const text = "𠮷".repeat(60)
    for (let maxSize = 15; maxSize <= 60; maxSize++) {
      expect(truncateResponse(text, maxSize).isWellFormed(), `maxSize=${maxSize}`).toBe(true)
      expect(cutAtSafeBoundary(text, maxSize).isWellFormed(), `budget=${maxSize}`).toBe(true)
    }
  })
})

describe("truncateSections — the per-section notice also fits the budget", () => {
  // A line boundary is needed for cutAtSafeBoundary to fill close to the
  // budget — one unbroken block would be cut far earlier and the notice would
  // never push it over the limit.
  const section = (i: number) =>
    `▶ Section ${i}\n` + Array.from({ length: 60 }, () => "x".repeat(50)).join("\n")

  it("never exceeds perSection by the notice length", () => {
    const perSection = 300
    const out = truncateSections([0, 1, 2, 3].map(section).join("\n\n"), 5_000, perSection)

    const parts = out.split(/\n\n(?=▶\s)/)
    expect(parts.length).toBe(4)
    for (const p of parts) {
      expect(p).toContain("this section shortened from")   // confirm the cut path was taken
      expect(p.length).toBeLessThanOrEqual(perSection)
    }
  })

  it("still honours the overall limit (regression)", () => {
    const out = truncateSections([0, 1, 2, 3, 4, 5].map(section).join("\n\n"), 2_000)
    expect(out.length).toBeLessThanOrEqual(2_000)
  })
})
