import { describe, expect, it } from "vitest"
import { containsHtmlMarkup, isBlankBody, isHtmlPage } from "./body-shape.js"
import { detectBadBody } from "./upstream-miss.js"

// Three call sites used to answer the same question with different predicates:
// anchored + case-insensitive in the retry layer, unanchored + case-sensitive
// in the API client.
describe("isHtmlPage — is the response an entire web page", () => {
  it("ignores case (a lowercase doctype is a maintenance page too)", () => {
    expect(isHtmlPage("<!DOCTYPE html><html><body>maintenance</body></html>")).toBe(true)
    expect(isHtmlPage("<!doctype html><html><body>maintenance</body></html>")).toBe(true)
    expect(isHtmlPage("<HTML><body>x</body></HTML>")).toBe(true)
  })

  it("ignores leading whitespace", () => {
    expect(isHtmlPage("\n\n  <!DOCTYPE html><html></html>")).toBe(true)
  })

  it("does not treat an <html fragment inside a normal XML/JSON body as a maintenance page", () => {
    expect(isHtmlPage(`<?xml version="1.0"?><Law><![CDATA[<html>table</html>]]></Law>`)).toBe(false)
    expect(isHtmlPage(`{"Law":"<html>form</html>"}`)).toBe(false)
  })
})

describe("isBlankBody", () => {
  it("catches an empty string and a whitespace-only body", () => {
    expect(isBlankBody("")).toBe(true)
    expect(isBlankBody("   \n\t ")).toBe(true)
    expect(isBlankBody("{}")).toBe(false)
  })
})

describe("containsHtmlMarkup — a content judgement (a different question)", () => {
  it("catches a fragment wherever it sits", () => {
    expect(containsHtmlMarkup("form body <body>table</body> end")).toBe(true)
    expect(containsHtmlMarkup("a plain-text editor blob")).toBe(false)
  })
})

describe("detectBadBody — takes its predicates from body-shape alone", () => {
  it("never disagrees with isBlankBody/isHtmlPage", () => {
    const samples = [
      "",
      "   ",
      "<!doctype html><html></html>",
      "<!DOCTYPE html><html></html>",
      `<?xml version="1.0"?><Law>ok</Law>`,
      `{"Law":"ok"}`,
    ]
    for (const s of samples) {
      const expected = isBlankBody(s) ? "empty" : isHtmlPage(s) ? "html" : null
      expect(detectBadBody(s)).toBe(expected)
    }
  })
})
