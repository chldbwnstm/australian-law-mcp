/**
 * Aside browser bridge — the opt-in way this server finishes a source it is
 * refused directly.
 *
 * Eight legal sources are Cloudflare/WAF-gated against server-side clients and
 * are rows marked `blocked` in `upstream-hosts.ts` (Federal Court judgments,
 * AustLII, LawCite, the NSW and SA registers, ACCC, the Competition Tribunal,
 * the Commonwealth Ombudsman). Aside can sometimes retrieve a source through
 * the user's local browser session, driven from the command line:
 *
 *     aside repl --host local "…"
 *
 * That is the whole mechanism. `repl` rather than `exec` on purpose: it is
 * deterministic, there is no agent loop between the URL and the page, and this
 * server stays a process that spawns a child rather than an MCP client of
 * another server.
 *
 * ## Containment
 *
 * The browser holds the user's sessions. A URL handed to
 * `fetchViaAside` can have come from a tool argument, i.e. from text a model
 * read on some page. So the URL is not a request, it is a claim to be checked:
 *
 *  - https on its standard port, no embedded credentials, no unbounded length;
 *  - the host must be on `BROWSER_FALLBACK_DOMAINS`, which is derived from the
 *    blocked rows of the host table and cannot be widened by a caller;
 *  - the snippet is built with `JSON.stringify`, and the child is spawned with
 *    `shell: false`, so the URL crosses the argv and JS-evaluator boundaries as
 *    data both times;
 *  - navigation, readiness checks and content reads use one owned tab, closed
 *    in a finally block. No cookie jar, storage or unrelated tab is inspected.
 *    The child's stderr is discarded and never appears in
 *    a return value or an error message;
 *  - the call is charged to the request's execution budget at
 *    `ASIDE_REQUEST_COST` upstream attempts, before the child is spawned, so a
 *    fan-out cannot open browser tabs for free. This process serializes calls,
 *    bounds its queue and includes queue time in each call's deadline.
 *
 * Off unless `AU_LAW_ASIDE` is set (`1`, `true`, `yes` or `on`). `asideStatus()`
 * reports *why* it is off, so a tool can say so instead of silently skipping the
 * fallback.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { posix as posixPath, win32 as win32Path } from "node:path"

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
import { runAsideCommand, serialAsideRun } from "./aside-process.js"
export { asideChildEnv } from "./aside-process.js"

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
/** JSON quotes/newlines and fixed metadata are bounded separately from the HTML body. */
export const ASIDE_OUTPUT_ALLOWANCE_BYTES = 4096

/**
 * Path arithmetic for the host being *described*, never the machine running
 * the suite: a simulated Mac is probed with POSIX rules on a Windows CI
 * runner, and a simulated Windows PC with Windows rules on a Mac.
 */
function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32Path : posixPath
}

/**
 * Is this a path a config may carry as the CLI? Absolute in the host's own
 * form: on Windows a drive-letter or UNC path — `path.win32.isAbsolute` also
 * accepts a drive-less `\foo`, which resolves against whatever the current
 * drive happens to be. Shared with the installer (`followup-setup.ts`); the
 * companion helper carries a copy held in lock-step by a test.
 */
export function isAbsoluteCommandPath(candidate: string, platform: NodeJS.Platform): boolean {
  return pathFor(platform).isAbsolute(candidate) && (platform !== "win32" || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate))
}

/**
 * The install path Aside ships to.
 *
 * macOS: `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside` — note the spaces
 * in the .app name. Windows (measured against `install.ps1`, 2026-09-14): the
 * installer places `versions\<v>\aside.exe` under `%LOCALAPPDATA%\Aside\CLI`,
 * or under `ASIDE_CLI_INSTALL_DIR` when that is set, and keeps a `current`
 * junction at the active version — so `current\aside.exe` is the stable path,
 * and the directory the installer appends to the user's PATH.
 */
export function defaultAsideCommandPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    // A relative value in either variable would make the "standard" path
    // depend on the working directory; such a value is treated as unset.
    const absolute = (value: string | undefined) => { const trimmed = (value ?? "").trim(); return isAbsoluteCommandPath(trimmed, "win32") ? trimmed : "" }
    const installDir = absolute(env.ASIDE_CLI_INSTALL_DIR)
    const localAppData = absolute(env.LOCALAPPDATA) || win32Path.join(home, "AppData", "Local")
    return win32Path.join(installDir || win32Path.join(localAppData, "Aside", "CLI"), "current", "aside.exe")
  }
  return posixPath.join(home, ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside")
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
  /**
   * Host platform. `darwin` and `win32` can run the fallback — Aside ships a
   * browser and a CLI for both (Windows x64 from 1.0.914.1). Everything else,
   * Linux and WSL (which reports `linux`) included, is refused by
   * `asideStatus`: there is no local Aside browser there to drive.
   */
  platform?: NodeJS.Platform
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

/**
 * Look for the CLI on PATH the way the host's own shell would.
 *
 * Windows entries are `;`-separated and may be quoted, and the executable is
 * `aside.exe`. Only a real `.exe` is accepted there: Node refuses to spawn a
 * `.cmd`/`.bat` shim without a shell (the CVE-2024-27980 fix), and this
 * bridge never uses one — so a shim would be found and then fail to start,
 * which is worse than being reported as not found.
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean, platform: NodeJS.Platform): string | undefined {
  const paths = pathFor(platform)
  const pathValue = (platform === "win32" ? env.PATH ?? env.Path : env.PATH) ?? ""
  for (const entry of pathValue.split(paths.delimiter)) {
    const directory = platform === "win32" ? entry.trim().replace(/^"(.*)"$/, "$1") : entry
    // A relative entry (`.`, `bin`) would make the command this server spawns
    // depend on whatever directory a desktop app started it in.
    if (!directory || !paths.isAbsolute(directory)) continue
    const candidate = paths.join(directory, platform === "win32" ? `${name}.exe` : name)
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

  const platform = options.platform ?? process.platform
  if (platform !== "darwin" && platform !== "win32") {
    return {
      enabled: false,
      reason:
        `The Aside browser fallback runs on macOS and Windows only; it is unavailable on this platform (${platform}). ` +
        "Aside ships no browser for it, so there is nothing local to drive.",
    }
  }
  // A user pastes the path with the quotes Explorer's "Copy as path" adds, or
  // that a shell showed them; on either platform a CLI path is never itself quoted.
  const configured = (env[ASIDE_COMMAND_ENV] ?? "").trim().replace(/^"(.*)"$/, "$1").trim()
  if (configured) {
    if (!isAbsoluteCommandPath(configured, platform)) {
      return {
        enabled: false,
        reason:
          `${ASIDE_COMMAND_ENV} must be an absolute path to the Aside CLI; it is set to ${JSON.stringify(configured)}.` +
          (platform === "win32"
            ? " On Windows that is a drive-letter path such as C:\\Users\\you\\AppData\\Local\\Aside\\CLI\\current\\aside.exe; %LOCALAPPDATA% and ~ are not expanded."
            : ""),
      }
    }
    // Node refuses to spawn a .cmd/.bat without a shell, and this bridge never
    // uses one: a wrapper would be found and then fail to start, which is a
    // worse answer than being told now.
    if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(configured)) {
      return {
        enabled: false,
        reason:
          `${ASIDE_COMMAND_ENV} points at ${configured}, a script wrapper; give the path of aside.exe itself ` +
          "(normally %LOCALAPPDATA%\\Aside\\CLI\\current\\aside.exe). A .cmd, .bat or .ps1 wrapper cannot be started without a shell.",
      }
    }
    if (!exists(configured)) {
      return {
        enabled: false,
        reason:
          `${ASIDE_COMMAND_ENV} points at ${configured}, which does not exist. ` +
          (platform === "win32"
            ? `The Windows CLI installs to ${defaultAsideCommandPath(options.home, platform, env)}; leave ${ASIDE_COMMAND_ENV} blank to let this server look there.`
            : "Use the path shown in Aside's Developer settings."),
      }
    }
    return { enabled: true, command: configured }
  }

  const standard = defaultAsideCommandPath(options.home, platform, env)
  if (exists(standard)) return { enabled: true, command: standard }

  const onPath = findOnPath("aside", env, exists, platform)
  if (onPath) return { enabled: true, command: onPath }

  return {
    enabled: false,
    reason:
      `${ASIDE_ENABLED_ENV} is on but the Aside CLI was not found at ${standard} or anywhere on PATH. ` +
      (platform === "win32"
        ? "Install the Aside CLI for Windows x64 (download https://releases.aside.com/install.ps1 and run it as a file), " +
          `restart the app that started this server so it sees the updated PATH, or set ${ASIDE_COMMAND_ENV} to the absolute path of aside.exe.`
        : `Install Aside, or set ${ASIDE_COMMAND_ENV} to the absolute path in its Developer settings.`),
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
  if (parsed.port && parsed.port !== "443") {
    throw refuse("a nonstandard HTTPS port.", ["Use the publisher's standard HTTPS address."])
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
 *     <our start marker>
 *     <one JSON line containing the HTML and navigation/cleanup metadata>
 *     <our end marker>
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
 * A browser can pass a gate that refused a server, but not always: a tester driving Aside at
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

export function looksLikeBotChallenge(html: string, patterns: readonly RegExp[] = CHALLENGE_MARKERS): boolean {
  // Pure and self-contained: the exact same function runs inside the browser.
  const readable = (value: string) => value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim()
  const headings = [...html.matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(match => readable(match[2]))
  if (headings.some(heading => patterns.some(pattern => pattern.test(heading)))) return true
  if (/<(?:div|form|iframe)\b[^>]*\bid\s*=\s*["'](?:cf-browser-verification|cf-challenge|challenge-form)\b/i.test(html)) return true
  const text = readable(html)
  // A judgment may quote these phrases or exhibit the site's JavaScript.
  if (/\bREASONS\s+FOR\s+(?:JUDGMENT|DECISION)\b/i.test(text)) return false
  // Cloudflare localises the page — a Korean Windows profile is served
  // "잠시만 기다리십시오…" (recorded 2026-09-14, austlii-challenge-ko.html) — but
  // the challenge orchestration tokens in its markup are the same in every
  // language. Checked after the reasons guard, so a judgment page that happens
  // to embed a Turnstile widget is still a judgment.
  if (/\b_cf_chl_opt\b|\bcf-chl-widget\b/.test(html)) return true
  return text.length < 2000 && patterns.some(pattern => pattern.test(text))
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

export interface AsidePage {
  html: string
  url: string
}

interface AsideEnvelope extends AsidePage {
  schemaVersion: 1
  requestedUrl: string
  ready: boolean
  closed: boolean
}

/** One owned tab, a completed DOM load, and a JSON envelope that cannot collide with page text. */
export function asideReplScript(url: string): string {
  const target = assertAsideUrl(url)
  const markers = CHALLENGE_MARKERS.map(pattern => pattern.source)
  return `
    const target = ${JSON.stringify(target)};
    const allowed = ${JSON.stringify([...BROWSER_FALLBACK_DOMAINS])};
    const checkedUrl = value => {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase().replace(/\\.$/, "");
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !allowed.some(d => host === d || host.endsWith("." + d))) {
        throw new Error("The page redirected outside the permitted legal sources; its body was not accepted.");
      }
      return parsed.href;
    };
    const page = await openTab("about:blank");
    let snapshot;
    let closed = false;
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 });
      const gate = ${JSON.stringify(markers)}.map(s => new RegExp(s, "i"));
      const challenge = ${looksLikeBotChallenge.toString()};
      const until = Date.now() + ${CHALLENGE_WAIT_MS};
      do {
        let loaded = false;
        try { await page.waitForLoadState("domcontentloaded", { timeout: 2000 }); loaded = true; } catch {}
        const before = checkedUrl(await page.url());
        const html = await page.content();
        const after = checkedUrl(await page.url());
        const ready = loaded && before === after && /<body\\b/i.test(html) && !challenge(html, gate);
        snapshot = { schemaVersion: 1, requestedUrl: target, url: after, html, ready };
        if (ready) break;
        await new Promise(r => setTimeout(r, ${CHALLENGE_POLL_MS}));
      } while (Date.now() < until);
    } finally {
      try { await page.close(); closed = true; } catch {}
    }
    if (!snapshot) throw new Error("The browser did not return a page snapshot.");
    console.log(${JSON.stringify(ASIDE_BEGIN_MARKER)});
    console.log(JSON.stringify({ ...snapshot, closed }));
    console.log(${JSON.stringify(ASIDE_END_MARKER)});
  `
}

/** Fences occupy their own lines; embedded marker text inside JSON is ordinary page data. */
export function extractAsideEnvelope(stdout: string): AsideEnvelope | undefined {
  // A byte-order mark would glue itself to the fence if the CLI ever printed
  // the fence first; CRLF is already tolerated by the split.
  const lines = stdout.replace(/^\uFEFF/, "").split(/\r?\n/)
  const starts = lines.flatMap((line, index) => line === ASIDE_BEGIN_MARKER ? [index] : [])
  const ends = lines.flatMap((line, index) => line === ASIDE_END_MARKER ? [index] : [])
  if (starts.length !== 1 || ends.length !== 1 || ends[0] !== starts[0] + 2) return undefined
  try {
    const value: unknown = JSON.parse(lines[starts[0] + 1])
    if (!value || typeof value !== "object") return undefined
    const page = value as Partial<AsideEnvelope>
    if (page.schemaVersion !== 1 || typeof page.requestedUrl !== "string" || typeof page.url !== "string" || typeof page.html !== "string" || typeof page.ready !== "boolean" || typeof page.closed !== "boolean") return undefined
    return page as AsideEnvelope
  } catch { return undefined }
}

/** Compatibility helper: return only the HTML from a complete, unambiguous envelope. */
export function extractAsidePayload(stdout: string): string | undefined {
  return extractAsideEnvelope(stdout)?.html
}

export function clampAsideTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return ASIDE_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.floor(timeoutMs), ASIDE_MIN_TIMEOUT_MS), ASIDE_MAX_TIMEOUT_MS)
}

/**
 * Browse one blocked legal source in the user's local Aside browser and return
 * the page HTML.
 *
 * Throws, never returns a placeholder: a refused host, a fallback that is off,
 * a CLI that is missing, a timeout and an empty page are five different facts
 * and a caller has to be able to report the right one.
 */
export async function fetchPageViaAside(url: string, opts: FetchViaAsideOptions = {}): Promise<AsidePage> {
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

  const run = opts.runner ?? runAsideCommand
  const result = await serialAsideRun(async remainingMs => {
    if (signal?.aborted) throw requestCancelledError(signal.reason)
    for (let charge = 0; charge < ASIDE_REQUEST_COST; charge += 1) budget?.consumeUpstreamRequest()
    return run(status.command!, ["repl", "--host", "local", asideReplScript(target)], {
      timeoutMs: remainingMs, signal, maxOutputBytes: maxOutputBytes * 2 + ASIDE_OUTPUT_ALLOWANCE_BYTES,
    })
  }, { signal, timeoutMs })
  if (signal?.aborted) throw requestCancelledError(signal.reason)

  const snapshot = extractAsideEnvelope(result.stdout)
  const size = Buffer.byteLength(snapshot?.html ?? result.stdout, "utf8")
  if (size > maxOutputBytes) throw new ExecutionLimitError(`Aside returned more than the per-response limit of ${maxOutputBytes} bytes.`)
  budget?.ensureResponseBodySize(size)
  budget?.consumeUpstreamBody(size)

  const shown = maskSensitiveUrl(target)
  if (result.failedToStart) {
    throw new LawApiError(
      `The Aside CLI at ${status.command} could not be started.`,
      ErrorCodes.API_ERROR,
      [
        `Check the path in ${ASIDE_COMMAND_ENV}, and that Aside is installed and runnable.`,
        ...((opts.platform ?? process.platform) === "win32"
          ? [
              "On Windows the command must be aside.exe itself (normally %LOCALAPPDATA%\\Aside\\CLI\\current\\aside.exe): " +
                "a .cmd wrapper cannot be started without a shell, and a dangling \"current\" junction after a CLI update looks the same — re-run install.ps1.",
            ]
          : []),
      ],
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

  if (!snapshot || snapshot.requestedUrl !== target) {
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
  assertAsideUrl(snapshot.url)
  if (!snapshot.closed) {
    const error = new LawApiError("Aside could not confirm that its research tab was closed. Inspect that tab before retrying.", ErrorCodes.API_ERROR)
    error.name = "AsideCleanupError"
    throw error
  }
  const html = snapshot.html.trim()
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
      true,
    )
  }

  if (!snapshot.ready) {
    throw new LawApiError(`Aside did not finish loading the document at ${shown}. The partial page was not accepted.`, ErrorCodes.TIMEOUT)
  }
  return { html, url: snapshot.url }
}

/** HTML-only compatibility entry point; source adapters should retain the observed final URL. */
export async function fetchViaAside(url: string, opts: FetchViaAsideOptions = {}): Promise<string> {
  return (await fetchPageViaAside(url, opts)).html
}
