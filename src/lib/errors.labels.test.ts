import { describe, expect, it } from "vitest"
import { ErrorCodes, formatToolError } from "./errors.js"
import { UpstreamRecordMissingError } from "./upstream-miss.js"

// The module knows the miss shape as three values, but the surface used to
// flatten it to two causes. An access-notice page is a cause retrying never
// fixes, so advising only "retry shortly" leaves the user waiting on a state
// that never improves.
describe("UPSTREAM_NO_DATA — the notice page's third cause", () => {
  it("names only two causes for an empty body", () => {
    const text = formatToolError(new UpstreamRecordMissingError("https://x/?apikey=***", "empty")).content[0].text
    expect(text).toContain(`[${ErrorCodes.UPSTREAM_NO_DATA}]`)
    expect(text).toContain("one of two")
    expect(text).not.toContain("API key is not registered")
  })

  it("names the unregistered API key as a third cause for a notice page", () => {
    const text = formatToolError(new UpstreamRecordMissingError("https://x/?apikey=***", "html")).content[0].text
    expect(text).toContain("one of three")
    expect(text).toContain("API key is not registered/approved for this endpoint")
    expect(text).toContain("upstream provider")
    // The fact that retrying will not help has to stand alongside it
    expect(text).toContain("will not be fixed by retrying")
  })

  it("never asserts absence either way (regression)", () => {
    for (const kind of ["empty", "html"] as const) {
      const text = formatToolError(new UpstreamRecordMissingError("https://x/?apikey=***", kind)).content[0].text
      expect(text).toContain("did not return the requested record")
      expect(text).not.toContain("does not exist")
      expect(text).toContain("does not prove")
    }
  })
})

// Bracket labels are a contract with machine readers, so they are never built
// outside the constant.
describe("ErrorCodes — schedule body not extracted", () => {
  it("exposes ANNEX_BODY_UNAVAILABLE as a constant", () => {
    expect(ErrorCodes.ANNEX_BODY_UNAVAILABLE).toBe("ANNEX_BODY_UNAVAILABLE")
  })
})
