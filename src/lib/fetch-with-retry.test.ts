import { afterEach, describe, it, expect, vi } from "vitest"
import { fetchWithRetry, maskSensitiveUrl } from "./fetch-with-retry.js"

// An API key must be masked before any URL or error message leaves the process;
// a regression here leaks the credential.
describe("maskSensitiveUrl — API key masking", () => {
  it("masks an apikey parameter and preserves the others", () => {
    expect(
      maskSensitiveUrl("https://api.legislation.gov.au/lookup?apikey=mysecret&target=act&id=C2004A00818"),
    ).toBe("https://api.legislation.gov.au/lookup?apikey=***&target=act&id=C2004A00818")
  })
  it("masks the other common key parameter names too", () => {
    expect(maskSensitiveUrl("https://x/?oc=k")).toBe("https://x/?oc=***")
    expect(maskSensitiveUrl("https://x/?apiKey=abc&q=1")).toBe("https://x/?apiKey=***&q=1")
    expect(maskSensitiveUrl("https://x/?auth_key=abc")).toBe("https://x/?auth_key=***")
  })
  it("leaves a key-free URL untouched", () => {
    expect(maskSensitiveUrl("https://www.legislation.gov.au/search?query=Corporations%20Act")).toBe(
      "https://www.legislation.gov.au/search?query=Corporations%20Act",
    )
  })
  it("passes an empty string through safely", () => {
    expect(maskSensitiveUrl("")).toBe("")
  })
})

// Taking Retry-After at face value lets one upstream header set the wait
// arbitrarily (3600 → a one-hour sleep). Clamp it at 30s — the same place the
// tool timeout sits.
describe("getRetryDelay — the Retry-After ceiling", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("clamps an absurdly large Retry-After to 30 seconds", async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++
      return n === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "3600" } })
        : new Response("<ok/>", { status: 200 })
    }))

    const pending = fetchWithRetry("https://example.com/x", { retryDelay: 1 })
    // Advancing the clock to the clamp ceiling (30s) must already have fired the retry
    await vi.advanceTimersByTimeAsync(30_100)
    expect(n).toBe(2)
    await expect(pending).resolves.toMatchObject({ status: 200 })
  })
})
