import { describe, expect, it } from "vitest"
import { headingTitle, matchCitationContent, normalizeLegalText } from "./citation-content-matcher.js"

describe("normalizeLegalText", () => {
  it("folds emphasis, smart quotes and dashes away", () => {
    expect(normalizeLegalText("*Misleading* or “deceptive”—conduct")).toBe("misleading or deceptive conduct")
  })

  it("removes zero-width characters and normalises odd spaces", () => {
    expect(normalizeLegalText("mis​leading conduct")).toBe("misleading conduct")
  })

  it("returns an empty string for empty input", () => {
    expect(normalizeLegalText("")).toBe("")
  })
})

describe("headingTitle", () => {
  it("drops the leading section number of a numbered navLabel", () => {
    expect(headingTitle("18  Meetings of Commission")).toBe("Meetings of Commission")
  })

  it("drops the structural word, number and dash of a worded navLabel", () => {
    expect(headingTitle("Schedule 2—The Australian Consumer Law")).toBe("Australian Consumer Law")
  })

  it("leaves a bare heading alone", () => {
    expect(headingTitle("Misleading or deceptive conduct")).toBe("Misleading or deceptive conduct")
  })

  it("keeps a lettered section number out of the title", () => {
    expect(headingTitle("10AA  Application of the Act")).toBe("Application of the Act")
  })
})

describe("matchCitationContent", () => {
  it("matches an identical heading exactly", () => {
    const result = matchCitationContent("misleading or deceptive conduct", "Misleading or deceptive conduct")
    expect(result.matched).toBe(true)
    expect(result.method).toBe("exact")
  })

  it("matches a short claim contained in the heading", () => {
    const result = matchCitationContent("meetings", "Meetings of Commission")
    expect(result.matched).toBe(true)
    expect(result.method).toBe("exact")
  })

  it("matches a paraphrase through the bigram layer", () => {
    const result = matchCitationContent("misleading conduct", "Misleading or deceptive conduct")
    expect(result.matched).toBe(true)
    expect(result.method).toBe("token-jaccard")
    expect(result.score).toBeGreaterThan(0.25)
  })

  it("REJECTS the flagship trap: misleading conduct vs the real CCA s 18 heading", () => {
    const result = matchCitationContent("misleading or deceptive conduct", "Meetings of Commission")
    expect(result.matched).toBe(false)
    expect(result.method).toBe("mismatch")
    expect(result.score).toBeLessThan(0.25)
  })

  it("rejects a neighbouring but different consumer-law concept", () => {
    expect(matchCitationContent("unconscionable conduct", "Meetings of Commission").matched).toBe(false)
  })

  it("never treats an empty side as agreement", () => {
    expect(matchCitationContent("", "Meetings of Commission").matched).toBe(false)
    expect(matchCitationContent("meetings", "").matched).toBe(false)
  })
})
