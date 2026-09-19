import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AuApiClient } from "./api-client.js"
import { DEFAULT_EXECUTION_LIMITS, RequestExecutionBudget } from "./execution-limits.js"
import { jevEnabled, rankCasesWithJev } from "./jev.js"
import { runWithRequestContext } from "./session-state.js"

const hits = [
  { title: "First result", id: "first", url: "https://example.test/first", snippet: "A source snippet" },
  { title: "Second result", id: "second", url: "https://example.test/second", extra: [["unrelated", "not sent"]] },
]
const reply = (scores = [0.2, 0.8]) => ({ model: "test-model", answers: Object.fromEntries(scores.map((noul, i) => [`case_${i}`, { type: "noul", noul }])) })
const client = new AuApiClient()

beforeEach(() => {
  vi.stubEnv("AU_LAW_JEV", "true")
  vi.stubEnv("TYPESAFE_API_KEY", "test-secret-key")
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("Jev opt-in and input boundaries", () => {
  it.each([undefined, "", "false", "0", "off", "garbage", "${user_config.jev_enabled}"])("never calls with switch %s, even if a key is saved", async flag => {
    vi.stubEnv("AU_LAW_JEV", flag)
    const fetch = vi.spyOn(client, "fetchJson")
    expect(jevEnabled()).toBe(false)
    expect(await rankCasesWithJev(client, "negligence", hits)).toEqual({ hits })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(["true", "1", " YES ", "on"])("accepts enabled value %s", value => {
    expect(jevEnabled({ AU_LAW_JEV: value })).toBe(true)
  })
  it.each([undefined, "", "  ", "${user_config.typesafe_api_key}", "key\ninjected"])("keeps search results with missing or unusable key %s", async key => {
    vi.stubEnv("TYPESAFE_API_KEY", key)
    const fetch = vi.spyOn(client, "fetchJson")
    const result = await rankCasesWithJev(client, "negligence", hits)
    expect(result.hits).toBe(hits)
    expect(result.note).toContain("enter a TypeSafe API key")
    expect(fetch).not.toHaveBeenCalled()
  })
  it("does no paid work for zero or one result, or an oversized query/page", async () => {
    const fetch = vi.spyOn(client, "fetchJson")
    for (const page of [[], hits.slice(0, 1), Array.from({ length: 51 }, () => hits[0])]) {
      expect((await rankCasesWithJev(client, "negligence", page)).hits).toBe(page)
    }
    expect((await rankCasesWithJev(client, "q".repeat(4001), hits)).hits).toBe(hits)
    const longPage = Array.from({ length: 50 }, () => ({ title: "法".repeat(1000) }))
    expect((await rankCasesWithJev(client, "query", longPage)).hits).toBe(longPage)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("Jev evaluation", () => {
  it("reorders existing records only and sends bounded metadata with the key in a header", async () => {
    const fetch = vi.spyOn(client, "fetchJson").mockResolvedValue(reply())
    const result = await rankCasesWithJev(client, "negligence", hits)
    expect(result.hits).toEqual([hits[1], hits[0]])
    expect(result.hits[0]).toBe(hits[1])
    expect(hits[0].id).toBe("first")
    expect(result.note).toContain("does not verify")
    const [host, path, opts] = fetch.mock.calls[0]
    expect([host, path]).toEqual(["typesafe", "systemone"])
    expect(opts).toMatchObject({ method: "POST", retries: 0, redirect: "error", headers: { authorization: "Bearer test-secret-key" } })
    expect(opts?.apiKey).toBeUndefined()
    const body = JSON.parse(String(opts?.body))
    expect(body.state.query).toBe("negligence")
    expect(body.state.candidates[0]).toMatchObject({ candidateId: "case_0", title: "First result" })
    expect(body.questions.case_0.instructions).toContain("case_0")
    expect(JSON.stringify(body)).not.toMatch(/test-secret-key|https:\/\/example|not sent/)
  })
  it("preserves source order for ties", async () => {
    vi.spyOn(client, "fetchJson").mockResolvedValue(reply([0.5, 0.5]))
    expect((await rankCasesWithJev(client, "query", hits)).hits).toEqual(hits)
  })
  it("bounds long metadata and reads a changed key without retaining it", async () => {
    const fetch = vi.spyOn(client, "fetchJson").mockResolvedValue(reply())
    await rankCasesWithJev(client, "query", [{ ...hits[0], snippet: "x".repeat(2000) }, hits[1]])
    expect(JSON.parse(String(fetch.mock.calls[0][2]?.body)).state.candidates[0].snippet).toHaveLength(1000)
    vi.stubEnv("TYPESAFE_API_KEY", "replacement-key")
    await rankCasesWithJev(client, "query", hits)
    expect(fetch.mock.calls[1][2]?.headers?.authorization).toBe("Bearer replacement-key")
  })
  it.each([
    {}, { ...reply(), answers: { case_0: { type: "noul", noul: 0.5 } } },
    reply([NaN, 0.4]), reply([-1, 0.4]), reply([1.1, 0.4]), reply([0.2, 0.4, 0.6]),
    { ...reply(), answers: { case_0: { type: "score", noul: 0.4 }, case_1: { type: "noul", noul: 0.6 } } },
  ])("retains results for malformed or incomplete evaluation %#", async response => {
    vi.spyOn(client, "fetchJson").mockResolvedValue(response)
    const result = await rankCasesWithJev(client, "query", hits)
    expect(result.hits).toBe(hits)
    expect(result.note).toContain("unavailable")
  })
  it("does not expose provider error details or the API key", async () => {
    vi.spyOn(client, "fetchJson").mockRejectedValue(new Error("test-secret-key provider-debug"))
    const result = await rankCasesWithJev(client, "query", hits)
    expect(JSON.stringify(result)).not.toMatch(/test-secret-key|provider-debug/)
    expect(result.hits).toBe(hits)
  })
})

describe("shared transport and cancellation", () => {
  it.each([401, 403, 429, 503, 302])("keeps source results after HTTP %i without retries", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response("provider error", { status }))
    vi.stubGlobal("fetch", fetch)
    const result = await rankCasesWithJev(new AuApiClient(), "query", hits)
    expect(result.hits).toBe(hits)
    expect(result.note).toContain("unavailable")
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone")
    expect(fetch.mock.calls[0][1].redirect).toBe("error")
  })
  it("charges the existing request budget and reads the body through its limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(reply())))
    const budget = new RequestExecutionBudget(DEFAULT_EXECUTION_LIMITS)
    await runWithRequestContext({ budget }, () => rankCasesWithJev(new AuApiClient(), "query", hits))
    expect(budget.snapshot().upstreamRequests).toBe(1)
    expect(budget.snapshot().upstreamBodyBytes).toBeGreaterThan(0)
  })
  it("does not turn caller cancellation into a successful fallback", async () => {
    const controller = new AbortController()
    vi.spyOn(client, "fetchJson").mockImplementation(async () => { controller.abort(new Error("cancelled by caller")); throw new Error("provider failure") })
    await expect(runWithRequestContext({ signal: controller.signal }, () => rankCasesWithJev(client, "query", hits))).rejects.toThrow("cancelled by caller")
  })
  it("falls back when the optional deadline interrupts a stalled response body", async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
    let cancelBody = false
    vi.stubGlobal("fetch", vi.fn(async () => {
      setTimeout(() => deadline.abort(new Error("evaluation timeout")), 10)
      return new Response(new ReadableStream({ cancel() { cancelBody = true } }))
    }))
    const result = await rankCasesWithJev(new AuApiClient(), "query", hits)
    expect(result.hits).toBe(hits)
    expect(result.note).toContain("unavailable")
    expect(cancelBody).toBe(true)
  })
})
