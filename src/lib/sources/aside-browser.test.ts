import { describe, expect, it } from "vitest"

import { LawApiError } from "../errors.js"
import { DEFAULT_EXECUTION_LIMITS, ExecutionLimitError, RequestExecutionBudget } from "../execution-limits.js"
import { requestContext } from "../session-state.js"
import { BROWSER_FALLBACK_DOMAINS } from "../upstream-hosts.js"
import {
  ASIDE_COMMAND_ENV,
  ASIDE_DEFAULT_TIMEOUT_MS,
  ASIDE_ENABLED_ENV,
  ASIDE_MAX_TIMEOUT_MS,
  ASIDE_MAX_URL_LENGTH,
  ASIDE_REQUEST_COST,
  asideChildEnv,
  asideReplScript,
  asideStatus,
  assertAsideUrl,
  clampAsideTimeout,
  defaultAsideCommandPath,
  fetchViaAside,
  type AsideRunOptions,
  type AsideRunResult,
  type AsideRunner,
} from "./aside-browser.js"

const FED_COURT = "https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/single/2025/2025fca0001"
const ASIDE_PATH = "/Applications/Aside.app/Contents/MacOS/aside"

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv

/** Host with the fallback switched on and the CLI at a known absolute path. */
const enabledHost = {
  env: env({ [ASIDE_ENABLED_ENV]: "1", [ASIDE_COMMAND_ENV]: ASIDE_PATH }),
  exists: (path: string) => path === ASIDE_PATH,
}

interface RunnerCall {
  command: string
  args: readonly string[]
  options: AsideRunOptions
}

/** Records every spawn that *would* have happened and answers with a canned result. */
function stubRunner(result: Partial<AsideRunResult> = {}): { runner: AsideRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: AsideRunner = async (command, args, options) => {
    calls.push({ command, args, options })
    return { stdout: "<html><body>judgment</body></html>", exitCode: 0, ...result }
  }
  return { runner, calls }
}

describe("asideStatus", () => {
  it("is off, with a reason, when the opt-in variable is unset", () => {
    const status = asideStatus({ env: env({}), exists: () => true })
    expect(status.enabled).toBe(false)
    expect(status.command).toBeUndefined()
    expect(status.reason).toContain(ASIDE_ENABLED_ENV)
  })

  // The switch a Claude Desktop user actually touches is a manifest `boolean`,
  // and the MCPB runtime substitutes that as the string "true". An opt-in that
  // accepted only "1" would leave that user toggling a control that does
  // nothing — in the one host this whole fallback exists for. So the spellings a
  // real config surface produces are all on, and the off list stays explicit.
  it("accepts the spellings a config surface produces, and nothing else", () => {
    for (const value of ["1", " 1 ", "true", "TRUE", " True ", "yes", "on"]) {
      expect(asideStatus({ env: env({ [ASIDE_ENABLED_ENV]: value }), exists: () => true }).enabled).toBe(true)
    }
    for (const value of ["0", "false", "False", "off", "no", "", " ", "maybe"]) {
      expect(asideStatus({ env: env({ [ASIDE_ENABLED_ENV]: value }), exists: () => true }).enabled).toBe(false)
    }
  })

  it("uses the configured absolute command when it exists", () => {
    expect(asideStatus(enabledHost)).toEqual({ enabled: true, command: ASIDE_PATH })
  })

  it("names the configured path when it is missing, instead of silently probing on", () => {
    const status = asideStatus({
      env: env({ [ASIDE_ENABLED_ENV]: "1", [ASIDE_COMMAND_ENV]: "/nope/aside" }),
      exists: () => false,
    })
    expect(status.enabled).toBe(false)
    expect(status.reason).toContain("/nope/aside")
  })

  it("refuses a relative configured command", () => {
    const status = asideStatus({
      env: env({ [ASIDE_ENABLED_ENV]: "1", [ASIDE_COMMAND_ENV]: "aside" }),
      exists: () => true,
    })
    expect(status.enabled).toBe(false)
    expect(status.reason).toContain("absolute")
  })

  it("probes the standard install path before PATH", () => {
    const standard = defaultAsideCommandPath("/Users/tester")
    expect(standard).toBe("/Users/tester/.aside/cli/Aside CLI.app/Contents/MacOS/aside")
    const status = asideStatus({
      env: env({ [ASIDE_ENABLED_ENV]: "1", PATH: "/usr/local/bin" }),
      home: "/Users/tester",
      exists: (path) => path === standard || path === "/usr/local/bin/aside",
    })
    expect(status).toEqual({ enabled: true, command: standard })
  })

  it("falls back to PATH when the standard path is empty", () => {
    const status = asideStatus({
      env: env({ [ASIDE_ENABLED_ENV]: "1", PATH: "/empty:/usr/local/bin" }),
      home: "/Users/tester",
      exists: (path) => path === "/usr/local/bin/aside",
    })
    expect(status).toEqual({ enabled: true, command: "/usr/local/bin/aside" })
  })

  it("explains an opted-in host with no Aside installed", () => {
    const status = asideStatus({
      env: env({ [ASIDE_ENABLED_ENV]: "1", PATH: "/usr/bin" }),
      home: "/Users/tester",
      exists: () => false,
    })
    expect(status.enabled).toBe(false)
    expect(status.reason).toContain("/Users/tester/.aside/cli/Aside CLI.app/Contents/MacOS/aside")
    expect(status.reason).toContain(ASIDE_COMMAND_ENV)
  })
})

describe("containment", () => {
  /**
   * LOAD-BEARING. Aside is the user's real browser with the user's real
   * sessions — that is exactly why it gets past the Cloudflare gates, and
   * exactly why the URL cannot be trusted. `url` reaches this module from a
   * tool argument, i.e. from text a model may have read on some page, so
   * "fetch this for me" must not be able to become "open my mail and hand the
   * HTML back". Without the allowlist this call succeeds and returns a signed-
   * in inbox. If this test is ever relaxed to make some other host reachable,
   * that is the thing being given away.
   */
  it("refuses a non-legal host and never spawns the browser", async () => {
    const { runner, calls } = stubRunner()
    await expect(fetchViaAside("https://mail.google.com/mail/u/0/", { ...enabledHost, runner }))
      .rejects.toThrow(/mail\.google\.com/)
    expect(calls).toEqual([])
  })

  it("refuses every host outside the table, naming the host each time", async () => {
    const { runner, calls } = stubRunner()
    for (const url of [
      "https://mail.google.com/",
      "https://evil.example.com/austlii.edu.au",
      "https://accc.gov.au.attacker.example/x",
      "https://notaccc.gov.au/x",
      "https://www.legislation.gov.au/C2004A00109",
      "https://localhost/x",
    ]) {
      const hostname = new URL(url).hostname
      await expect(fetchViaAside(url, { ...enabledHost, runner })).rejects.toThrow(hostname)
    }
    expect(calls).toEqual([])
  })

  it("accepts each blocked source, in bare, www and subdomain form", () => {
    for (const domain of BROWSER_FALLBACK_DOMAINS) {
      expect(assertAsideUrl(`https://${domain}/x`)).toBe(`https://${domain}/x`)
      expect(assertAsideUrl(`https://www.${domain}/x`)).toBe(`https://www.${domain}/x`)
      expect(assertAsideUrl(`https://search.${domain}/x`)).toBe(`https://search.${domain}/x`)
    }
  })

  it("refuses anything that is not https, including file: and http:", () => {
    expect(() => assertAsideUrl("http://www.accc.gov.au/x")).toThrow(/http:/)
    expect(() => assertAsideUrl("file:///etc/passwd")).toThrow(LawApiError)
    expect(() => assertAsideUrl("javascript:alert(1)")).toThrow(LawApiError)
    expect(() => assertAsideUrl("data:text/html,<b>x</b>")).toThrow(LawApiError)
  })

  it("refuses embedded credentials without echoing them", () => {
    let thrown: unknown
    try {
      assertAsideUrl("https://user:hunter2@www.accc.gov.au/x")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LawApiError)
    expect((thrown as Error).message).toContain("www.accc.gov.au")
    expect((thrown as Error).message).not.toContain("hunter2")
  })

  it("refuses an empty, non-URL or oversized value", () => {
    expect(() => assertAsideUrl("")).toThrow(LawApiError)
    expect(() => assertAsideUrl("   ")).toThrow(LawApiError)
    expect(() => assertAsideUrl("www.austlii.edu.au")).toThrow(LawApiError)
    expect(() => assertAsideUrl(`https://www.austlii.edu.au/${"a".repeat(ASIDE_MAX_URL_LENGTH)}`)).toThrow(/limit/)
  })

  it("browses the canonical URL it validated, not the caller's string", () => {
    expect(assertAsideUrl(" https://WWW.ACCC.GOV.AU/A\\b ")).toBe("https://www.accc.gov.au/A/b")
    expect(assertAsideUrl("https://www.accc.gov.au./x")).toBe("https://www.accc.gov.au./x")
  })
})

describe("the repl snippet", () => {
  it("quotes the URL as a JSON literal", () => {
    expect(asideReplScript("https://www.accc.gov.au/x")).toBe(
      'const page = await openTab("https://www.accc.gov.au/x"); console.log(await page.content())',
    )
  })

  /**
   * The escaping is the test, not the shape of the string. `'` survives URL
   * normalisation inside a fragment, so `openTab('${url}')` — the obvious form,
   * and the form in Aside's own example — lets a URL close the literal and run
   * its own code in the user's signed-in browser. Evaluating the snippet with a
   * fake `openTab` proves it is valid JS *and* that nothing but the navigation
   * ran: with string concatenation instead of JSON.stringify, `broke` is true.
   */
  it("cannot be broken out of by a URL that closes a quote", async () => {
    const hostile = assertAsideUrl(
      "https://www.austlii.edu.au/cases/x#'+(globalThis.__asideEscapeProbe=true)+'",
    )
    expect(hostile).toContain("'+(globalThis.__asideEscapeProbe=true)+'")

    const logged: string[] = []
    const evaluate = new Function(
      "openTab",
      "console",
      `return (async () => { ${asideReplScript(hostile)} })()`,
    ) as (
      openTab: (url: string) => Promise<{ content: () => Promise<string> }>,
      console: { log: (line: string) => void },
    ) => Promise<void>

    await evaluate(
      async (url: string) => ({ content: async () => `<html>${url}</html>` }),
      { log: (line) => logged.push(line) },
    )

    const broke = (globalThis as Record<string, unknown>).__asideEscapeProbe === true
    delete (globalThis as Record<string, unknown>).__asideEscapeProbe
    expect(broke).toBe(false)
    expect(logged).toEqual([`<html>${hostile}</html>`])
  })

  it("reads the page and nothing else", () => {
    const script = asideReplScript(FED_COURT)
    expect(script).toContain("page.content()")
    expect(script).not.toMatch(/cookie|storage|localStorage|document\.cookie/i)
  })
})

describe("fetchViaAside", () => {
  it("returns the page HTML from the CLI's stdout", async () => {
    const { runner, calls } = stubRunner({ stdout: "  <html>fca</html>\n" })
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner })).resolves.toBe("<html>fca</html>")
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe(ASIDE_PATH)
    expect(calls[0].args).toEqual(["repl", asideReplScript(FED_COURT)])
  })

  it("does not run, and says why, when the fallback is off", async () => {
    const { runner, calls } = stubRunner()
    await expect(fetchViaAside(FED_COURT, { env: env({}), exists: () => true, runner }))
      .rejects.toThrow(new RegExp(ASIDE_ENABLED_ENV))
    expect(calls).toEqual([])
  })

  it("does not run, and says why, when the CLI is missing", async () => {
    const { runner, calls } = stubRunner()
    await expect(
      fetchViaAside(FED_COURT, {
        env: env({ [ASIDE_ENABLED_ENV]: "1", PATH: "/usr/bin" }),
        home: "/Users/tester",
        exists: () => false,
        runner,
      }),
    ).rejects.toThrow(new RegExp(ASIDE_COMMAND_ENV))
    expect(calls).toEqual([])
  })

  it("keeps its own timeout under Aside's 120s ceiling", async () => {
    const { runner, calls } = stubRunner()
    await fetchViaAside(FED_COURT, { ...enabledHost, runner })
    expect(calls[0].options.timeoutMs).toBe(ASIDE_DEFAULT_TIMEOUT_MS)

    await fetchViaAside(FED_COURT, { ...enabledHost, runner, timeoutMs: 500_000 })
    expect(calls[1].options.timeoutMs).toBe(ASIDE_MAX_TIMEOUT_MS)
    expect(calls[1].options.timeoutMs).toBeLessThan(120_000)

    expect(clampAsideTimeout(undefined)).toBe(ASIDE_DEFAULT_TIMEOUT_MS)
    expect(clampAsideTimeout(Number.NaN)).toBe(ASIDE_DEFAULT_TIMEOUT_MS)
    expect(clampAsideTimeout(5)).toBe(1_000)
    expect(clampAsideTimeout(30_000)).toBe(30_000)
  })

  it("reports a timeout as a timeout, not as an absent record", async () => {
    const { runner } = stubRunner({ stdout: "", exitCode: null, timedOut: true })
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner })).rejects.toThrow(/did not finish loading/)
  })

  it("reports a CLI failure without quoting the browser's output", async () => {
    const { runner } = stubRunner({ stdout: "session=SECRET-COOKIE-VALUE", exitCode: 3 })
    let thrown: unknown
    try {
      await fetchViaAside(FED_COURT, { ...enabledHost, runner })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain("status 3")
    expect((thrown as Error).message).not.toContain("SECRET-COOKIE-VALUE")
  })

  it("reports a CLI that will not start", async () => {
    const { runner } = stubRunner({ stdout: "", exitCode: null, failedToStart: true })
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner })).rejects.toThrow(/could not be started/)
  })

  it("refuses to pass off an empty page as a result", async () => {
    const { runner } = stubRunner({ stdout: "   \n  " })
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner })).rejects.toThrow(/empty page/)
  })

  it("rejects when the caller's signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { runner, calls } = stubRunner()
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner, signal: controller.signal })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe("execution budget", () => {
  it("charges one browser call as several upstream attempts", async () => {
    const budget = new RequestExecutionBudget(DEFAULT_EXECUTION_LIMITS)
    const { runner } = stubRunner()
    await requestContext.run({ budget }, () => fetchViaAside(FED_COURT, { ...enabledHost, runner }))
    expect(ASIDE_REQUEST_COST).toBeGreaterThan(1)
    expect(budget.snapshot().upstreamRequests).toBe(ASIDE_REQUEST_COST)
  })

  it("charges the page against the request's body budget", async () => {
    const budget = new RequestExecutionBudget(DEFAULT_EXECUTION_LIMITS)
    const { runner } = stubRunner({ stdout: "<html>fca</html>" })
    await requestContext.run({ budget }, () => fetchViaAside(FED_COURT, { ...enabledHost, runner }))
    expect(budget.snapshot().upstreamBodyBytes).toBe(Buffer.byteLength("<html>fca</html>", "utf8"))
  })

  it("stops an exhausted budget before the browser opens, not after", async () => {
    const budget = new RequestExecutionBudget({ ...DEFAULT_EXECUTION_LIMITS, maxUpstreamRequests: ASIDE_REQUEST_COST - 1 })
    const { runner, calls } = stubRunner()
    await expect(
      requestContext.run({ budget }, () => fetchViaAside(FED_COURT, { ...enabledHost, runner })),
    ).rejects.toThrow(ExecutionLimitError)
    expect(calls).toEqual([])
  })

  it("caps the captured page at the per-response byte limit", async () => {
    const budget = new RequestExecutionBudget({ ...DEFAULT_EXECUTION_LIMITS, maxUpstreamBodyBytes: 4_096 })
    const { runner, calls } = stubRunner({ truncated: true })
    await expect(
      requestContext.run({ budget }, () => fetchViaAside(FED_COURT, { ...enabledHost, runner })),
    ).rejects.toThrow(ExecutionLimitError)
    expect(calls[0].options.maxOutputBytes).toBe(4_096)
  })

  it("still runs outside a request context, charging nothing", async () => {
    const { runner, calls } = stubRunner()
    await expect(fetchViaAside(FED_COURT, { ...enabledHost, runner })).resolves.toContain("judgment")
    expect(calls[0].options.maxOutputBytes).toBe(DEFAULT_EXECUTION_LIMITS.maxUpstreamBodyBytes)
  })
})

describe("the child's environment", () => {
  it("passes only what a browser CLI needs, never this server's own configuration", () => {
    const child = asideChildEnv(
      env({
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        LANG: "en_AU.UTF-8",
        [ASIDE_ENABLED_ENV]: "1",
        [ASIDE_COMMAND_ENV]: ASIDE_PATH,
        LAW_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    )
    expect(child).toEqual({ HOME: "/Users/tester", PATH: "/usr/bin", LANG: "en_AU.UTF-8" })
  })
})
