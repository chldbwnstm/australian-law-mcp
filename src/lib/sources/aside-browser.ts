/**
 * Aside browser bridge — the opt-in way this server finishes a source it is
 * refused directly.
 *
 * Eight legal sources are Cloudflare/WAF-gated against server-side clients and
 * are rows marked `blocked` in `upstream-hosts.ts` (Federal Court judgments,
 * AustLII, LawCite, the NSW and SA registers, ACCC, the Competition Tribunal,
 * the Commonwealth Ombudsman). A real local browser walks through those gates
 * because it is a real browser. Aside is one, driven from the command line:
 *
 *     aside repl "const page = await openTab('https://…'); console.log(await page.content())"
 *
 * That is the whole mechanism. `repl` rather than `exec` on purpose: it is
 * deterministic, there is no agent loop between the URL and the page, and this
 * server stays a process that spawns a child rather than an MCP client of
 * another server.
 *
 * ## Containment
 *
 * The browser this spawns holds the user's logged-in sessions — that is why it
 * gets past the gates, and it is the whole risk. A URL handed to
 * `fetchViaAside` can have come from a tool argument, i.e. from text a model
 * read on some page. So the URL is not a request, it is a claim to be checked:
 *
 *  - https only, no embedded credentials, no unbounded length;
 *  - the host must be on `BROWSER_FALLBACK_DOMAINS`, which is derived from the
 *    blocked rows of the host table and cannot be widened by a caller;
 *  - the snippet is built with `JSON.stringify`, and the child is spawned with
 *    `shell: false`, so the URL crosses the argv and JS-evaluator boundaries as
 *    data both times;
 *  - only `page.content()` is ever evaluated. No cookie jar, no storage, no
 *    other tab. The child's stderr is routed to /dev/null and never appears in
 *    a return value or an error message;
 *  - the call is charged to the request's execution budget at
 *    `ASIDE_REQUEST_COST` upstream attempts, before the child is spawned, so a
 *    fan-out cannot open browser tabs for free.
 *
 * Off unless `AU_LAW_ASIDE` is set (`1`, `true`, `yes` or `on`). `asideStatus()`
 * reports *why* it is off, so a tool can say so instead of silently skipping the
 * fallback.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

import { ErrorCodes, LawApiError, UpstreamBlockedError } from "../errors.js"
import { DEFAULT_EXECUTION_LIMITS, ExecutionLimitError } from "../execution-limits.js"
import { maskSensitiveUrl } from "../fetch-with-retry.js"
import {
  combineAbortSignals,
  getRequestSignal,
  requestCancelledError,
  requestContext,
} from "../session-state.js"
import { BROWSER_FALLBACK_DOMAINS, isBrowserFallbackHost } from "../upstream-hosts.js"
import { blockTextOf } from "./html.js"

/** Opt-in switch. Off unless set to one of `ENABLED_VALUES`. */
export const ASIDE_ENABLED_ENV = "AU_LAW_ASIDE"

/** Absolute path to the Aside CLI. Unset means "probe the usual places". */
export const ASIDE_COMMAND_ENV = "AU_LAW_ASIDE_COMMAND"

/**
 * Aside's own `repl` ceiling is 120s. Ours has to fire first: a timeout we
 * enforce is a killed child and a labelled error, while one Aside enforces is
 * a child this server is still waiting on.
 */
export const ASIDE_MAX_TIMEOUT_MS = 110_000
export const ASIDE_DEFAULT_TIMEOUT_MS = 90_000
const ASIDE_MIN_TIMEOUT_MS = 1_000

/**
 * What one Aside call costs against `maxUpstreamRequests`.
 *
 * An HTTP GET to a healthy upstream is ~1s of someone else's CPU; this is a
 * browser launch, a gate challenge and a full page render on the user's own
 * machine, up to 90s of it. Charging it as one attempt would let a chain open
 * 48 tabs. At 8, the 48-attempt default allows six browser calls in one
 * request, which is more than any documented chain needs and far short of a
 * fan-out that takes over the desktop.
 */
export const ASIDE_REQUEST_COST = 8

/** Same ceiling `research-followup.ts` puts on a source URL. */
export const ASIDE_MAX_URL_LENGTH = 4_000

/** The install path Aside ships to on macOS. Note the spaces in the .app name. */
export function defaultAsideCommandPath(home: string = homedir()): string {
  return join(home, ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside")
}

export interface AsideStatus {
  /** True only when the fallback would actually run: opted in *and* an executable found. */
  enabled: boolean
  /** Absolute path that would be spawned, when one was found. */
  command?: string
  /** Why it would not run. Present whenever `enabled` is false. */
  reason?: string
}

/** Seams. Defaults are the real environment, filesystem and child process. */
export interface AsideEnvironment {
  env?: NodeJS.ProcessEnv
  /** Filesystem probe. Injected so a test can describe a host without an Aside install. */
  exists?: (path: string) => boolean
  /** Home directory used for the standard install path. */
  home?: string
}

export interface AsideRunOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Hard cap on captured stdout; over it the child is killed. */
  maxOutputBytes: number
}

/**
 * Outcome of one child run.
 *
 * There is deliberately no `stderr` field. The bridge has no use for the
 * child's diagnostics, and a shape without them cannot leak them into an error
 * message or a tool response (`automation/process.ts` takes the same line:
 * command output can contain secrets).
 */
export interface AsideRunResult {
  stdout: string
  exitCode: number | null
  timedOut?: boolean
  /** Output passed `maxOutputBytes` and the child was stopped. */
  truncated?: boolean
  /** The executable could not be started at all. */
  failedToStart?: boolean
}

export type AsideRunner = (
  command: string,
  args: readonly string[],
  options: AsideRunOptions,
) => Promise<AsideRunResult>

export interface FetchViaAsideOptions extends AsideEnvironment {
  /** Clamped into [1s, `ASIDE_MAX_TIMEOUT_MS`]; defaults to `ASIDE_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Item-scoped cancellation; combined with the request signal. */
  signal?: AbortSignal
  /** Child-process seam. Tests drive a stub; nothing in the suite spawns the real CLI. */
  runner?: AsideRunner
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * The spellings a real config surface produces for "on".
 *
 * This deliberately accepts more than `1`. The MCPB runtime substitutes a
 * `boolean` user setting as the **string** `"true"`, so a manifest switch and a
 * check for `"1"` would leave a Claude Desktop user toggling a control that does
 * nothing — the one host this fallback was built for. Hand-set variables are the
 * same story: a person typing it into a client config writes `true` at least as
 * often as `1`. Anything not listed here, `"false"` and `"0"` included, is off.
 */
const ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"])

function isEnabledValue(raw: string | undefined): boolean {
  return ENABLED_VALUES.has((raw ?? "").trim().toLowerCase())
}

/**
 * Is the fallback available, and if not, why not?
 *
 * "Not enabled" and "enabled but the CLI is not where we looked" are different
 * facts with different fixes, and both are different from "it ran and found
 * nothing". A tool that cannot tell them apart can only say nothing happened.
 */
export function asideStatus(options: AsideEnvironment = {}): AsideStatus {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync

  if (!isEnabledValue(env[ASIDE_ENABLED_ENV])) {
    return {
      enabled: false,
      reason:
        `The Aside browser fallback is off: ${ASIDE_ENABLED_ENV} is not set. ` +
        "Turn it on in the extension's settings (or set the variable in the MCP client config) " +
        "to let this server finish blocked sources in your local browser.",
    }
  }

  const configured = (env[ASIDE_COMMAND_ENV] ?? "").trim()
  if (configured) {
    if (!isAbsolute(configured)) {
      return {
        enabled: false,
        reason: `${ASIDE_COMMAND_ENV} must be an absolute path to the Aside CLI; it is set to ${JSON.stringify(configured)}.`,
      }
    }
    if (!exists(configured)) {
      return {
        enabled: false,
        reason: `${ASIDE_COMMAND_ENV} points at ${configured}, which does not exist. Use the path shown in Aside's Developer settings.`,
      }
    }
    return { enabled: true, command: configured }
  }

  const standard = defaultAsideCommandPath(options.home)
  if (exists(standard)) return { enabled: true, command: standard }

  const onPath = findOnPath("aside", env, exists)
  if (onPath) return { enabled: true, command: onPath }

  return {
    enabled: false,
    reason:
      `${ASIDE_ENABLED_ENV} is on but the Aside CLI was not found at ${standard} or anywhere on PATH. ` +
      `Install Aside, or set ${ASIDE_COMMAND_ENV} to the absolute path in its Developer settings.`,
  }
}

function refuse(message: string, suggestions: string[]): LawApiError {
  return new LawApiError(`Aside browser fallback refused ${message}`, ErrorCodes.INVALID_PARAM, suggestions)
}

function allowedDomainList(): string {
  return [...BROWSER_FALLBACK_DOMAINS].sort().join(", ")
}

/**
 * Check a URL against the containment rules and return its canonical form.
 *
 * The **canonical** form is what gets browsed: validating the caller's string
 * and then navigating to it separately would let the two disagree (`\` becomes
 * `/`, a host uppercases, stray newlines are stripped). One parse, one value.
 */
export function assertAsideUrl(url: string): string {
  const value = typeof url === "string" ? url.trim() : ""
  if (!value) throw refuse("an empty URL.", ["Pass the source URL from the blocked-source error."])
  if (value.length > ASIDE_MAX_URL_LENGTH) {
    throw refuse(`a URL of ${value.length} characters (the limit is ${ASIDE_MAX_URL_LENGTH}).`, [
      "Deep-link to the record rather than passing a whole search session URL.",
    ])
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw refuse("a value that is not a URL.", ["Pass an absolute https:// URL to an Australian legal source."])
  }

  if (parsed.protocol !== "https:") {
    throw refuse(`the ${parsed.protocol}// scheme for ${parsed.hostname}; only https is browsed.`, [
      "Use the https:// form of the same link.",
    ])
  }
  // Never carried into a browser that already has the user's sessions, and
  // never echoed back: the message names neither the user nor the password.
  if (parsed.username || parsed.password) {
    throw refuse(`a URL with embedded credentials for ${parsed.hostname}.`, [
      "Pass the plain https:// link with no user:password@ part.",
    ])
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "")
  if (!isBrowserFallbackHost(hostname)) {
    // THIS IS THE LOAD-BEARING RULE OF THE MODULE. The browser being driven is
    // signed in to the user's accounts, and this URL may have arrived in a tool
    // argument the model copied out of a web page. Without the allowlist, one
    // line of text on an untrusted page turns this server into a request to
    // open any authenticated site on the user's machine and hand the HTML back.
    throw refuse(
      `${hostname}: it is not an Australian legal source this server is blocked from. ` +
        "The browser fallback exists to finish the sources in the host table, nothing else.",
      [
        `Allowed domains (and their subdomains): ${allowedDomainList()}.`,
        "Sources this server can fetch itself are fetched itself — the fallback is not a general web browser.",
      ],
    )
  }

  return parsed.href
}

/**
 * The snippet evaluated inside Aside.
 *
 * `JSON.stringify` is not cosmetic here. The URL survives WHATWG
 * normalisation with `'` intact in a fragment, so the obvious
 * `openTab('${url}')` lets `…#'+something()+'` close the literal and run its
 * own code inside the user's browser. Quoting it as a JSON literal makes the
 * URL data at the JS boundary, and `shell: false` on the spawn makes it data
 * at the argv boundary.
 *
 * It reads exactly one thing, the rendered page. Not cookies, not storage, not
 * another tab.
 */
/**
 * Markers that fence the page off from the CLI's own chatter.
 *
 * Measured against the real CLI (2026-09-12), `aside repl` puts everything on
 * stdout — the page, and around it its own reporting:
 *
 *     🔭 Opened a new tab and set it active: tabs[0], page → <title> (<url>)
 *     <the page>
 *     \x1b[2m[ok | 2522ms]\x1b[0m
 *
 * Both would otherwise be returned as part of the document, and the opening
 * line is not a fixed string — it carries the page's own title and URL, so it
 * cannot be recognised by shape. Fencing the payload is the only version of
 * this that does not depend on reverse-engineering output the CLI is free to
 * change: the markers are ours, and text outside them is discarded whatever it
 * turns out to say.
 */
export const ASIDE_BEGIN_MARKER = "<<<AU-LAW-PAGE-BEGIN>>>"
export const ASIDE_END_MARKER = "<<<AU-LAW-PAGE-END>>>"

/**
 * Text that means "this is the gate, not the document".
 *
 * A browser walks through these gates most of the time, which is the whole
 * reason for this bridge — but not always: an outside tester driving Aside at
 * AustLII got the interstitial twice, with Ray IDs, where the same URL fetched
 * here returned the judgment. Whatever decides that (session age, reputation,
 * how recently the profile last passed) is Cloudflare's business, so the page
 * that comes back has to be checked rather than assumed.
 *
 * Returning an interstitial as though it were the reasons would be the exact
 * failure this project exists to prevent, and a worse version of it: the caller
 * gets prose that looks like a retrieved page, so nothing downstream flags it.
 */
const CHALLENGE_MARKERS: readonly RegExp[] = [
  /performing\s+security\s+verification/i,
  /checking\s+(?:if\s+the\s+site\s+connection\s+is\s+secure|your\s+browser)/i,
  /just\s+a\s+moment\s*(?:\.{3}|…)/i,
  /cf-browser-verification|cf_chl_|__cf_chl|cf-challenge/i,
  /attention\s+required!?\s*\|\s*cloudflare/i,
  /enable\s+javascript\s+and\s+cookies\s+to\s+continue/i,
  /\bray\s*id\b/i,
]

export function looksLikeBotChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((pattern) => pattern.test(html))
}

/** Classify page-level failures, without matching error text quoted in reasons. */
export function asidePageFailure(html: string): string | undefined {
  if (looksLikeBotChallenge(html)) return "a bot-verification page instead of the document"
  const errorHeading = /^(?:(?:http(?: error)?|error)\s*[:–—-]?\s*)?(?:403|404|410|500|502|503|504)\b|^(?:(?:page|document|resource|file)\s+not\s+found|not\s+found|access\s+denied|forbidden|service\s+unavailable|internal\s+server\s+error|bad\s+gateway|gateway\s+timeout)(?:$|[\s:|–—-])/i
  for (const match of html.matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    if (errorHeading.test(blockTextOf(match[2]).trim())) return "a publisher error page instead of the requested document"
  }
  // Some browser payloads contain plain page text without title/h1 markup.
  if (errorHeading.test(blockTextOf(html).trim())) return "a publisher error page instead of the requested document"
  return undefined
}

/**
 * How long the page is given to get past a gate before it is read.
 *
 * A Cloudflare interstitial replaces itself once its script finishes, so the
 * difference between an interstitial and the judgment is often a few seconds of
 * patience. Polling inside the snippet spends them in the browser, where the
 * wait actually helps, rather than in a retry that opens a second tab.
 */
const CHALLENGE_WAIT_MS = 12_000
const CHALLENGE_POLL_MS = 750

export function asideReplScript(url: string): string {
  const markers = CHALLENGE_MARKERS.map((pattern) => pattern.source)
  return (
    `const page = await openTab(${JSON.stringify(url)}); ` +
    `const gate = ${JSON.stringify(markers)}.map(s => new RegExp(s, "i")); ` +
    `let html = await page.content(); ` +
    `const until = Date.now() + ${CHALLENGE_WAIT_MS}; ` +
    `while (gate.some(r => r.test(html)) && Date.now() < until) { ` +
    `await new Promise(r => setTimeout(r, ${CHALLENGE_POLL_MS})); ` +
    `html = await page.content(); } ` +
    `console.log(${JSON.stringify(ASIDE_BEGIN_MARKER)}); ` +
    `console.log(html); ` +
    `console.log(${JSON.stringify(ASIDE_END_MARKER)})`
  )
}

/**
 * The page, or undefined when the run produced no fenced payload.
 *
 * A missing fence is never treated as "the whole of stdout is the page": that
 * is how the CLI's status line ends up inside a judgment.
 */
export function extractAsidePayload(stdout: string): string | undefined {
  const start = stdout.indexOf(ASIDE_BEGIN_MARKER)
  if (start === -1) return undefined
  const from = start + ASIDE_BEGIN_MARKER.length
  const end = stdout.indexOf(ASIDE_END_MARKER, from)
  if (end === -1) return undefined
  return stdout.slice(from, end).trim()
}

/**
 * Variables the child is allowed to see.
 *
 * The CLI needs enough of a session to find the user's Aside install; it has
 * no business reading this server's own configuration (upstream credentials a
 * future keyed source would carry, the `AU_LAW_ASIDE*` switches themselves, or
 * whatever else the desktop client put in the server's environment).
 */
const CHILD_ENV_KEYS = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING",
] as const

export function asideChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) child[key] = value
  }
  return child
}

export function clampAsideTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return ASIDE_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.floor(timeoutMs), ASIDE_MIN_TIMEOUT_MS), ASIDE_MAX_TIMEOUT_MS)
}

/** The real child process. Replaced wholesale in tests — the suite never spawns Aside. */
const spawnAsideRunner: AsideRunner = (command, args, options) =>
  new Promise<AsideRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(requestCancelledError(options.signal.reason))
      return
    }

    const child = spawn(command, [...args], {
      // The snippet is one argv element and no shell parses it.
      shell: false,
      // stderr goes nowhere by construction: diagnostics from a browser session
      // are exactly the kind of output that must not reach a tool response.
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      // A browser CLI starts children of its own; kill the group, not just the
      // parent, or a timeout leaves the work running.
      detached: process.platform !== "win32",
      env: asideChildEnv(),
    })

    const chunks: Buffer[] = []
    let bytes = 0
    let timedOut = false
    let truncated = false
    let failedToStart = false
    let cancelled: Error | undefined
    let hardKill: ReturnType<typeof setTimeout> | undefined

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        /* already gone */
      }
    }
    const stop = () => {
      kill("SIGTERM")
      if (!hardKill) hardKill = setTimeout(() => kill("SIGKILL"), 500)
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)

    const onAbort = () => {
      cancelled = requestCancelledError(options.signal?.reason)
      stop()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout?.on("data", (data: Buffer) => {
      bytes += data.byteLength
      if (bytes > options.maxOutputBytes) {
        truncated = true
        stop()
        return
      }
      chunks.push(data)
    })

    child.on("error", () => {
      failedToStart = true
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      options.signal?.removeEventListener("abort", onAbort)
      if (cancelled) {
        reject(cancelled)
        return
      }
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
        timedOut,
        truncated,
        failedToStart,
      })
    })
  })

/**
 * Browse one blocked legal source in the user's local Aside browser and return
 * the page HTML.
 *
 * Throws, never returns a placeholder: a refused host, a fallback that is off,
 * a CLI that is missing, a timeout and an empty page are five different facts
 * and a caller has to be able to report the right one.
 */
export async function fetchViaAside(url: string, opts: FetchViaAsideOptions = {}): Promise<string> {
  // Containment first: before the environment is read, before the budget is
  // charged, before anything is spawned.
  const target = assertAsideUrl(url)

  const status = asideStatus(opts)
  if (!status.enabled || !status.command) {
    throw new LawApiError(status.reason ?? "The Aside browser fallback is unavailable.", ErrorCodes.API_ERROR, [
      "⚠️ The blocked source was not browsed, so this says nothing about whether the record exists.",
      `Open the link yourself, or enable the fallback (${ASIDE_ENABLED_ENV}=true).`,
    ])
  }

  const signal = combineAbortSignals(opts.signal, getRequestSignal())
  if (signal?.aborted) throw requestCancelledError(signal.reason)

  const timeoutMs = clampAsideTimeout(opts.timeoutMs)
  const budget = requestContext.getStore()?.budget
  const maxOutputBytes = budget?.limits.maxUpstreamBodyBytes ?? DEFAULT_EXECUTION_LIMITS.maxUpstreamBodyBytes

  // Charged per call and *before* the spawn, the way fetch-with-retry charges
  // per attempt before the fetch: an exhausted budget must stop a browser from
  // opening, not be discovered once the page is already on screen.
  for (let charge = 0; charge < ASIDE_REQUEST_COST; charge += 1) {
    budget?.consumeUpstreamRequest()
  }

  const run = opts.runner ?? spawnAsideRunner
  const result = await run(status.command, ["repl", asideReplScript(target)], {
    timeoutMs,
    signal,
    maxOutputBytes,
  })

  const shown = maskSensitiveUrl(target)
  if (result.failedToStart) {
    throw new LawApiError(
      `The Aside CLI at ${status.command} could not be started.`,
      ErrorCodes.API_ERROR,
      [`Check the path in ${ASIDE_COMMAND_ENV}, and that Aside is installed and runnable.`],
    )
  }
  if (result.timedOut) {
    throw new LawApiError(
      `Aside did not finish loading ${shown} within ${timeoutMs}ms.`,
      ErrorCodes.TIMEOUT,
      [
        "The page may be showing a challenge or a login. Open it in Aside yourself and retry.",
        "⚠️ A timeout is not evidence the record is absent.",
      ],
    )
  }
  if (result.truncated) {
    throw new ExecutionLimitError(
      `Aside returned more than the per-response limit of ${maxOutputBytes} bytes for ${shown} ` +
        "(MCP_MAX_UPSTREAM_BODY_BYTES).",
    )
  }
  if (result.exitCode !== 0) {
    // The exit code, not the child's output: stdout/stderr from a signed-in
    // browser session is never quoted back into an error.
    throw new LawApiError(
      `Aside could not browse ${shown} (the CLI exited with ${result.exitCode === null ? "no status" : `status ${result.exitCode}`}).`,
      ErrorCodes.API_ERROR,
      [
        "Check that Aside is running and signed in, then retry.",
        "⚠️ A failed browser call is not evidence the record is absent.",
      ],
    )
  }

  const html = extractAsidePayload(result.stdout)
  if (html === undefined) {
    // Reached when the fence is absent: the run was cut short, or the CLI
    // changed what it prints. Returning stdout anyway would hand back its
    // status line as though it were the document.
    throw new LawApiError(
      `Aside did not return a complete page for ${shown}.`,
      ErrorCodes.PARSE_ERROR,
      [
        "The browser session ended before the page was handed back.",
        "⚠️ This is not evidence the record is absent — open the link to check.",
      ],
    )
  }
  if (!html) {
    throw new LawApiError(
      `Aside returned an empty page for ${shown}.`,
      ErrorCodes.UPSTREAM_NO_DATA,
      [
        "⚠️ An empty page is not evidence the record is absent — open the link to check.",
      ],
    )
  }
  const pageFailure = asidePageFailure(html)
  if (pageFailure) {
    // The snippet already waited this out for as long as it is worth waiting.
    // Still a gate, so the browser did not get through this time — which is a
    // different fact from the record being absent, and from the page being read.
    throw new UpstreamBlockedError(
      "the browser fallback",
      `the publisher served ${pageFailure} at ${shown}; the requested source was not retrieved`,
      [target],
    )
  }

  const size = Buffer.byteLength(html, "utf8")
  budget?.ensureResponseBodySize(size)
  budget?.consumeUpstreamBody(size)
  return html
}
