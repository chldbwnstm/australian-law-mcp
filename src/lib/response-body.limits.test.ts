import { afterAll, beforeAll, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { fetchWithRetry } from "./fetch-with-retry.js"
import { readResponseText } from "./response-body.js"
import { requestContext } from "./session-state.js"
import { DEFAULT_EXECUTION_LIMITS, RequestExecutionBudget } from "./execution-limits.js"

// A body over the budget (2 MiB by default) used to make a tool call **hang for
// 300 seconds instead of erroring**. Cause: `response.clone()` builds a tee, and
// cancelling one branch leaves that cancel promise unsettled until the other
// branch is cancelled too — and the cleanup code awaited it. Every case runs
// against a local mock server so no upstream is touched.

const OVER = Buffer.from(`<?xml version="1.0"?><Law>${"x".repeat(2_400_000)}</Law>`, "utf8") // ~2.4 MB > 2 MiB
const UNDER = Buffer.from(`<?xml version="1.0"?><Law>${"x".repeat(1_800_000)}</Law>`, "utf8") // ~1.8 MB < 2 MiB
const WS_THEN_JSON = Buffer.from(" ".repeat(4096) + `{"Law":"ok"}`, "utf8")

let base = ""
let server: http.Server
let hits = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++
    const kind = new URL(req.url ?? "/", "http://x").searchParams.get("k")
    const body = kind === "under" ? UNDER : kind === "ws" ? WS_THEN_JSON : OVER
    const headers: Record<string, string> = { "content-type": "text/xml;charset=UTF-8" }
    if (kind === "chunked") {
      res.writeHead(200, headers)
      for (let i = 0; i < body.length; i += 65536) res.write(body.subarray(i, i + 65536))
      res.end()
      return
    }
    res.writeHead(200, { ...headers, "content-length": String(body.length) })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

function withBudget<T>(work: () => Promise<T>): { run: Promise<T>; budget: RequestExecutionBudget } {
  const budget = new RequestExecutionBudget(DEFAULT_EXECUTION_LIMITS)
  return { budget, run: requestContext.run({ budget }, work) }
}

const read = (url: string) => async () => readResponseText(await fetchWithRetry(url))

describe("upstream body budget — over the limit is an error, not a hang", () => {
  it("ends immediately with an error carrying the observed size and the limit when Content-Length is over", async () => {
    const { run } = withBudget(read(`${base}?k=over`))
    await expect(run).rejects.toThrow(
      new RegExp(`${OVER.length}.*${DEFAULT_EXECUTION_LIMITS.maxUpstreamBodyBytes}`),
    )
  }, 6000)

  it("ends immediately on reaching the limit even without Content-Length (chunked)", async () => {
    const { run } = withBudget(read(`${base}?k=chunked`))
    await expect(run).rejects.toThrow(/MCP_MAX_UPSTREAM_BODY_BYTES/)
  }, 6000)
})

describe("large responses under the limit — no false positive, no double billing", () => {
  it("passes a 1.8MB full text through and bills the budget once", async () => {
    const { run, budget } = withBudget(read(`${base}?k=under`))
    await expect(run).resolves.toContain("<Law>")
    // Back when the peek cloned and read the whole body, the same bytes were billed twice.
    expect(budget.snapshot().upstreamBodyBytes).toBe(UNDER.length)
  }, 6000)

  it("does not misread a whitespace-only prefix as an empty body (probe boundary)", async () => {
    hits = 0
    const { run } = withBudget(read(`${base}?k=ws`))
    await expect(run).resolves.toContain(`{"Law":"ok"}`)
    expect(hits).toBe(1)                       // a false "empty body" reading would add a retry
  }, 6000)
})
