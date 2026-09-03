import { describe, expect, it } from "vitest"
import {
  KNOWN_SECTION_HEADERS,
  OMISSION_MARKER,
  compactBody,
  compactLongSections,
  stripRepeatedSummary,
} from "./decision-compact.js"

const paragraph = (n: number) => `[${n}] ${"The appellant submits that the primary judge erred. ".repeat(4)}`
const longBody = Array.from({ length: 60 }, (_, i) => paragraph(i + 1)).join("\n")

describe("compactBody", () => {
  it("returns short text unchanged", () => {
    expect(compactBody("short reasons")).toBe("short reasons")
  })

  it("returns the input verbatim when full=true", () => {
    expect(compactBody(longBody, { full: true })).toBe(longBody)
  })

  it("keeps the head and the tail and marks the gap", () => {
    const compacted = compactBody(longBody)
    expect(compacted.length).toBeLessThan(longBody.length)
    expect(compacted).toContain(OMISSION_MARKER)
    expect(compacted.startsWith("[1] ")).toBe(true)
    // The conclusion is the part a reader most needs, so the tail survives.
    expect(compacted.trimEnd().endsWith(longBody.trimEnd().slice(-40))).toBe(true)
  })

  it("states exactly how many characters were removed and how to get them", () => {
    const compacted = compactBody(longBody)
    const removed = Number(/omitted ([\d,]+) characters/.exec(compacted)?.[1]?.replace(/,/g, ""))
    expect(removed).toBeGreaterThan(0)
    expect(compacted).toContain("full=true")
    // The marker's number is the truth, not an estimate.
    const kept = compacted.split(OMISSION_MARKER)
    expect(kept).toHaveLength(2)
  })

  it("cuts at a paragraph boundary rather than mid-sentence", () => {
    const compacted = compactBody(longBody)
    const head = compacted.split("\n\n⋯")[0]
    expect(head.trimEnd().endsWith(".")).toBe(true)
  })

  it("leaves the text alone when the saving would be trivial", () => {
    const barelyLong = "x".repeat(1600 + 800 + 100)
    expect(compactBody(barelyLong)).toBe(barelyLong)
  })

  it("honours custom head/tail budgets", () => {
    const compacted = compactBody(longBody, { headSize: 200, tailSize: 100 })
    expect(compacted.length).toBeLessThan(compactBody(longBody).length)
  })
})

describe("compactLongSections", () => {
  it("shortens the body under the LAST known section header", () => {
    const rendered = `=== A case ===\nCitation: [2020] HCA 1\n\nBackground:\nshort\n\nReasons:\n${longBody}`
    const compacted = compactLongSections(rendered)
    expect(compacted).toContain("Background:\nshort")
    expect(compacted).toContain(OMISSION_MARKER)
    expect(compacted.length).toBeLessThan(rendered.length)
  })

  it("returns the input unchanged when there is no known header", () => {
    const rendered = `=== A case ===\n\nSomething else:\n${longBody}`
    expect(compactLongSections(rendered)).toBe(rendered)
  })

  it("never shortens twice — a nested gap marker would contradict itself", () => {
    const once = compactLongSections(`=== A ===\n\nReasons:\n${longBody}`)
    expect(compactLongSections(once)).toBe(once)
  })

  it("leaves short responses alone", () => {
    const short = "=== A ===\n\nReasons:\nbrief"
    expect(compactLongSections(short)).toBe(short)
  })

  it("knows the headers the renderers actually emit", () => {
    for (const heading of ["Reasons", "Text", "Ruling", "Determination", "Background"]) {
      expect(KNOWN_SECTION_HEADERS as readonly string[]).toContain(heading)
    }
  })
})

describe("stripRepeatedSummary", () => {
  const summary = "The appeal is allowed and the sentence imposed at first instance is set aside in its entirety."

  it("removes a summary the body repeats at the top", () => {
    const body = `${summary}\n\nThe facts are as follows. ${"More reasoning. ".repeat(20)}`
    const stripped = stripRepeatedSummary(body, [summary])
    expect(stripped.startsWith("The facts are as follows")).toBe(true)
  })

  it("leaves the body alone when the summary does not appear near the top", () => {
    const body = `${"Unrelated reasoning. ".repeat(40)}${summary}`
    expect(stripRepeatedSummary(body, [summary])).toBe(body)
  })

  it("ignores summaries that are too short to match safely", () => {
    const body = "Allowed. Then some reasoning follows here."
    expect(stripRepeatedSummary(body, ["Allowed."])).toBe(body)
  })

  it("tolerates undefined entries", () => {
    expect(stripRepeatedSummary("body", [undefined])).toBe("body")
  })
})
