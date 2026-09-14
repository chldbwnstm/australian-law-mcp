import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_EXECUTION_LIMITS, RequestExecutionBudget } from "../execution-limits.js"
import { requestContext } from "../session-state.js"
import {
  ASIDE_BEGIN_MARKER, ASIDE_END_MARKER, ASIDE_COMMAND_ENV, ASIDE_ENABLED_ENV,
  asidePageFailure, asideReplScript, assertAsideUrl, extractAsideEnvelope, extractAsidePayload,
  fetchPageViaAside, fetchViaAside, looksLikeBotChallenge, type AsideRunner,
} from "./aside-browser.js"

const target = "https://www.austlii.edu.au/cgi-bin/viewdoc/au/cases/cth/FCAFC/2020/130.html"
const html = "<html><title>Example [2020] FCAFC 130</title><body><p>REASONS FOR JUDGMENT</p><p>1. The appeal was dismissed.</p></body></html>"
const macHost = { platform: "darwin" as const, env: { [ASIDE_ENABLED_ENV]: "true", [ASIDE_COMMAND_ENV]: "/stub/aside" }, exists: () => true }
const windowsHost = { platform: "win32" as const, env: { [ASIDE_ENABLED_ENV]: "true", [ASIDE_COMMAND_ENV]: "C:\\stub\\aside.exe" }, exists: () => true }
const snapshot = (changes: Record<string, unknown> = {}) => ({ schemaVersion: 1, requestedUrl: target, url: target, html, ready: true, closed: true, ...changes })
const frame = (value: unknown) => `${ASIDE_BEGIN_MARKER}\n${JSON.stringify(value)}\n${ASIDE_END_MARKER}`
const runnerFor = (value: unknown): AsideRunner => async () => ({ stdout: frame(value), exitCode: 0 })
afterEach(() => vi.useRealTimers())

// The protocol is the same on both hosts Aside ships on; the suite says so by
// running under each simulated status rather than assuming it.
describe.each([["macOS", macHost], ["Windows", windowsHost]] as const)("Aside snapshot protocol on %s", (_name, host) => {
  it.each([
    "ordinary text", "한국어 ⚖️ café", "quotes \" ' and backslashes \\",
    `a\n${ASIDE_BEGIN_MARKER}\nb\n${ASIDE_END_MARKER}\nc`,
    "line one\r\nline two\twith tab", "\u2028\u2029", "a\u0000b",
  ])("round-trips document data without interpreting it as protocol: %j", async text => {
    const body = `<html><body>${text}</body></html>`
    const output = frame(snapshot({ html: body }))
    expect(extractAsidePayload(output)).toBe(body)
    expect(await fetchViaAside(target, { ...host, runner: runnerFor(snapshot({ html: body })) })).toBe(body)
  })

  it.each([
    "", "<html>Unframed document</html>", ASIDE_BEGIN_MARKER,
    `${ASIDE_BEGIN_MARKER}\n{}\n`, `${ASIDE_END_MARKER}\n{}\n${ASIDE_BEGIN_MARKER}`,
    `${ASIDE_BEGIN_MARKER}\nnot json\n${ASIDE_END_MARKER}`,
    `${frame(snapshot())}\n${frame(snapshot())}`,
    `${ASIDE_BEGIN_MARKER}\n${frame(snapshot())}`,
  ])("rejects incomplete or ambiguous framing: %j", output => {
    expect(extractAsideEnvelope(output)).toBeUndefined()
  })

  it.each([
    { schemaVersion: 2 }, { html: null }, { html: {} }, { url: 5 },
    { requestedUrl: null }, { ready: "true" }, { closed: undefined },
  ])("rejects malformed snapshot metadata: %j", async changes => {
    await expect(fetchViaAside(target, { ...host, runner: runnerFor(snapshot(changes)) })).rejects.toThrow(/complete page/)
  })

  it("discards CLI diagnostics and accepts CRLF framing", () => {
    const output = `Other title and diagnostics\r\n${frame(snapshot()).replace(/\n/g, "\r\n")}\r\n\u001b[2m[ok | 20ms]\u001b[0m`
    expect(extractAsidePayload(output)).toBe(html)
  })

  // The Windows CLI's opening line as measured 2026-09-14 ("✔︎ Opened a new
  // tab…"), the dim status trailer, CRLF fences, and a byte-order mark a
  // console layer could prepend — none of it is the document.
  it("accepts a byte-order mark, the Windows opening line, CRLF fences and the status trailer around the payload", () => {
    const framed = frame(snapshot()).replace(/\n/g, "\r\n")
    const withOpeningLine = `\uFEFF✔︎ Opened a new tab and set it active: tabs[0], page →  (about:blank)\r\n${framed}\r\n\u001b[2m[ok | 351ms]\u001b[0m\r\n`
    expect(extractAsidePayload(withOpeningLine)).toBe(html)
    expect(extractAsidePayload(`\uFEFF${framed}`)).toBe(html)
  })

  it("binds the snapshot to the requested URL", async () => {
    await expect(fetchPageViaAside(target, { ...host, runner: runnerFor(snapshot({ requestedUrl: target.replace("130", "131") })) })).rejects.toThrow(/complete page/)
  })

  it("retains the observed legal-source redirect URL", async () => {
    const finalUrl = target.replace("www.austlii", "classic.austlii")
    expect(await fetchPageViaAside(target, { ...host, runner: runnerFor(snapshot({ url: finalUrl })) })).toEqual({ html, url: finalUrl })
  })

  it.each(["https://example.org/inbox", "https://www.austlii.edu.au:444/a", "http://www.austlii.edu.au/a", "https://name:secret@www.austlii.edu.au/a"])("rejects unsafe final URLs: %s", async url => {
    await expect(fetchPageViaAside(target, { ...host, runner: runnerFor(snapshot({ url })) })).rejects.toThrow()
  })

  it("does not accept a DOM that was still loading", async () => {
    await expect(fetchViaAside(target, { ...host, runner: runnerFor(snapshot({ ready: false })) })).rejects.toThrow(/partial page was not accepted/)
  })

  it("reports unconfirmed tab cleanup", async () => {
    await expect(fetchViaAside(target, { ...host, runner: runnerFor(snapshot({ closed: false })) })).rejects.toMatchObject({ name: "AsideCleanupError" })
  })

  it("never accepts a complete payload from a failing CLI", async () => {
    const runner: AsideRunner = async () => ({ stdout: frame(snapshot()), exitCode: 3 })
    await expect(fetchViaAside(target, { ...host, runner })).rejects.toThrow(/status 3/)
  })

  it("charges an error page to the shared byte budget too", async () => {
    const body = "<html><title>404 Not Found</title><body>Missing document</body></html>"
    const budget = new RequestExecutionBudget(DEFAULT_EXECUTION_LIMITS)
    await expect(requestContext.run({ budget }, () => fetchViaAside(target, { ...host, runner: runnerFor(snapshot({ html: body })) }))).rejects.toThrow(/error page/)
    expect(budget.snapshot().upstreamBodyBytes).toBe(Buffer.byteLength(body))
  })
})

describe("Aside page classification", () => {
  // Recorded 2026-09-14 from https://www.austlii.edu.au/cgi-bin/sinosrch.cgi?method=auto&query=prepayment&mask_path=au/cases/cth/FCAFC
  // through the Windows Aside browser on a Korean-locale PC: Cloudflare's
  // Turnstile page with a Korean title and body. The English heading markers
  // do not match it; the markup tokens and the language-neutral "Ray ID" do.
  it("recognises a localised Cloudflare challenge page by its markup, not its language", () => {
    const korean = readFileSync(new URL("./__fixtures__/aside/austlii-challenge-ko.html", import.meta.url), "utf8")
    expect(korean).toContain("잠시만 기다리십시오")
    expect(looksLikeBotChallenge(korean)).toBe(true)
    expect(asidePageFailure(korean)).toContain("bot-verification")
    // and by the markup alone, when even the noscript line and the Ray ID are gone
    const markupOnly = korean.replace(/Enable JavaScript and cookies to continue/g, "").replace(/Ray ID/g, "")
    expect(looksLikeBotChallenge(markupOnly)).toBe(true)
    // The same page's language does not turn a judgment into a challenge.
    expect(looksLikeBotChallenge(html.replace("REASONS FOR JUDGMENT", "잠시만 기다리십시오… REASONS FOR JUDGMENT"))).toBe(false)
    // Nor does the markup, if the publisher ever puts a widget on a real
    // judgment page: the reasons guard is checked first.
    expect(looksLikeBotChallenge(html.replace("</body>", "<div class='cf-chl-widget' data-_cf_chl_opt='1'></div></body>"))).toBe(false)
  })

  it.each(["Page Not Found", "403 Forbidden", "503 Service unavailable", "404 – Document Not Found", "Error 500", "Access Denied", "Bad Gateway", "Gateway Timeout"])("rejects an error heading regardless of a long menu: %s", heading => {
    expect(asidePageFailure(`<title>Publisher</title><h1>${heading}</h1><nav>${"Menu ".repeat(2000)}</nav>`)).toContain("error page")
  })

  it.each(["Just a moment...", "Checking your browser", "Ray ID: example", "Enable JavaScript and cookies to continue", "cf_chl_"])("keeps challenge language quoted in a judgment: %s", quote => {
    const document = html.replace("</body>", `<blockquote>The website said: ${quote}</blockquote></body>`)
    expect(looksLikeBotChallenge(document)).toBe(false)
    expect(asidePageFailure(document)).toBeUndefined()
  })

  it.each([":444", ":80", ":65535"])("refuses a non-publisher port %s before any navigation", port => {
    expect(() => assertAsideUrl(`https://www.austlii.edu.au${port}/`)).toThrow(/port/)
  })
})

describe("the actual generated REPL program", () => {
  async function execute(pages: string[], options: { finalUrl?: string; gotoError?: boolean; closeError?: boolean } = {}) {
    const logged: string[] = []
    let reads = 0
    const page = {
      goto: vi.fn(async () => { if (options.gotoError) throw new Error("navigation failed") }),
      waitForLoadState: vi.fn(async () => {}),
      url: () => options.finalUrl ?? target,
      content: vi.fn(async () => pages[Math.min(reads++, pages.length - 1)]),
      close: vi.fn(async () => { if (options.closeError) throw new Error("close failed") }),
    }
    const openTab = vi.fn(async () => page)
    const evaluate = new Function("openTab", "console", `return (async () => { ${asideReplScript(target)} })()`)
    const work = evaluate(openTab, { log: (line: string) => logged.push(line) }) as Promise<void>
    return { page, openTab, logged, work }
  }

  it("owns one blank tab, loads the requested URL, then closes only that tab", async () => {
    const run = await execute([html])
    await run.work
    expect(run.openTab).toHaveBeenCalledExactlyOnceWith("about:blank")
    expect(run.page.goto).toHaveBeenCalledWith(target, expect.objectContaining({ waitUntil: "domcontentloaded" }))
    expect(run.page.close).toHaveBeenCalledTimes(1)
    expect(extractAsideEnvelope(run.logged.join("\n"))).toMatchObject({ ready: true, closed: true, html })
  })

  it("waits through a challenge and an incomplete head before taking the document", async () => {
    vi.useFakeTimers()
    const run = await execute(["<title>Just a moment...</title><body>Checking your browser</body>", "<html><head><title>Result</title></head></html>", html])
    await vi.runAllTimersAsync()
    await run.work
    expect(run.page.content).toHaveBeenCalledTimes(3)
    expect(extractAsideEnvelope(run.logged.join("\n"))).toMatchObject({ ready: true, html })
  })

  it("bounds a challenge which never clears and still closes its tab", async () => {
    vi.useFakeTimers()
    const run = await execute(["<title>Just a moment...</title><body>Checking your browser</body>"])
    await vi.runAllTimersAsync()
    await run.work
    expect(run.page.content.mock.calls.length).toBeLessThanOrEqual(17)
    expect(run.page.close).toHaveBeenCalledTimes(1)
    expect(extractAsideEnvelope(run.logged.join("\n"))).toMatchObject({ ready: false, closed: true })
  })

  it("refuses an external redirect before reading its body", async () => {
    const run = await execute([html], { finalUrl: "https://example.org/inbox" })
    await expect(run.work).rejects.toThrow(/outside/)
    expect(run.page.content).not.toHaveBeenCalled()
    expect(run.page.close).toHaveBeenCalledTimes(1)
    expect(run.logged).toHaveLength(0)
  })

  it("closes its own tab if navigation fails", async () => {
    const run = await execute([html], { gotoError: true })
    await expect(run.work).rejects.toThrow(/navigation failed/)
    expect(run.page.close).toHaveBeenCalledTimes(1)
  })

  it("does not claim cleanup succeeded when close throws", async () => {
    const run = await execute([html], { closeError: true })
    await run.work
    expect(extractAsideEnvelope(run.logged.join("\n"))).toMatchObject({ closed: false })
  })
})
