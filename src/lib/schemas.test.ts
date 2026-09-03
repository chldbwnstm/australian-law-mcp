import { describe, it, expect } from "vitest"
import { MAX_RESPONSE_SIZE, truncateResponse, truncateSections } from "./schemas.js"

// Mimics a full judgment response: long prose whose sentences span several lines.
const SENTENCE =
  "Having examined the reasons for the judgment below in light of the relevant legal " +
  "principles and the record, the court below did not err in misapprehending the law. "

function longLegalProse(chars: number): string {
  let out = ""
  while (out.length < chars) out += SENTENCE
  return out.slice(0, chars)
}

describe("truncateResponse limit guarantee", () => {
  it("never exceeds maxSize even after truncation", () => {
    const out = truncateResponse(longLegalProse(60000))
    expect(out.length).toBeLessThanOrEqual(MAX_RESPONSE_SIZE)
  })

  it("respects an explicit maxSize too", () => {
    const out = truncateResponse(longLegalProse(5000), 1000)
    expect(out.length).toBeLessThanOrEqual(1000)
  })

  it("keeps truncateSections within the overall limit as well", () => {
    const text = ["▶ Section 1", longLegalProse(30000), "", "▶ Section 2", longLegalProse(30000)].join("\n")
    const out = truncateSections(text, 2000)
    expect(out.length).toBeLessThanOrEqual(2000)
  })

  it("returns input below the limit unchanged", () => {
    const text = "a short response"
    expect(truncateResponse(text)).toBe(text)
  })
})

describe("truncateResponse sentence-boundary guard", () => {
  // If the body before the notice ends mid-sentence or mid-line, legal
  // substance (the tail of a concurring or dissenting opinion) is lost inside a
  // sentence. The cut must retreat to the last completed boundary.
  const bodyOf = (out: string) => out.split("\n\n⚠️")[0]

  it("does not cut mid-sentence (retreats past the last terminator)", () => {
    const out = truncateResponse(longLegalProse(5000), 1000)
    const body = bodyOf(out)
    expect(body.trimEnd().endsWith("the law.")).toBe(true)
  })

  it("retreats to a line boundary when there is one", () => {
    const line = "Section 1 (Purpose) The object of this Act is to protect the rights of the public.\n"
    const text = line.repeat(200)
    const body = bodyOf(truncateResponse(text, 1000))
    expect(body.endsWith("public.")).toBe(true)
  })

  it("loses no more than the retreat cap (no excessive loss)", () => {
    const out = truncateResponse(longLegalProse(5000), 1000)
    const body = bodyOf(out)
    // Never discard more than the few hundred characters of the retreat cap
    expect(body.length).toBeGreaterThan(1000 - 500)
  })

  it("does not retreat in text with no boundary at all (extreme-run defence)", () => {
    const noBoundary = "x".repeat(5000)
    const body = bodyOf(truncateResponse(noBoundary, 1000))
    // With no boundary to retreat to, keep the hard cut — zero gratuitous loss
    expect(body.length).toBeGreaterThan(1000 - 60)
  })
})
