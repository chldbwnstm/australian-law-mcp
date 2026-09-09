/**
 * Fetch with retry and timeout
 * - Exponential backoff for 429, 503, 504
 * - AbortController for timeout
 */

import { ExecutionLimitError } from "./execution-limits.js"
import { classifyOkBody, MISS_CONFIRM_DELAY_MS, UpstreamRecordMissingError } from "./upstream-miss.js"
import { combineAbortSignals, getRequestSignal, requestCancelledError, requestContext, throwIfRequestCancelled } from "./session-state.js"

/**
 * Mask sensitive values (API keys) in a URL before it reaches an error message
 * or a log. Current Australian sources are keyless, but the masking stays on
 * the shared path: any future keyed source must not be able to leak its
 * credential just by appearing in an error string.
 */
export function maskSensitiveUrl(url: string): string {
  if (!url) return url
  return url.replace(/([?&](?:oc|apikey|api_key|authkey|auth_key|key)=)[^&]+/gi, "$1***")
}

export interface FetchWithRetryOptions extends RequestInit {
  /** Reserve a host slot for every attempt, including retries, before starting its timeout. */
  beforeAttempt?: (signal?: AbortSignal) => Promise<void>
  /** Request timeout in ms (default: 30000) */
  timeout?: number
  /** Max retry attempts (default: 3) */
  retries?: number
  /** Base delay for exponential backoff in ms (default: 300 — see DEFAULT_RETRY_DELAY) */
  retryDelay?: number
  /** HTTP status codes to retry on (default: [429, 503, 504]) */
  retryOn?: number[]
  /**
   * True for requests whose normal response *is* HTML (an endpoint that serves
   * a rendered history list, say). The default (false) reads "200 but HTML" as
   * a maintenance page and retries, which on an HTML-native endpoint burns
   * every retry and multiplies the request count on each call. Even when true,
   * an empty body is still retried as a transient failure.
   */
  allowHtmlBody?: boolean
  /**
   * True for single-record lookups where **a miss arrives as an empty body or
   * a notice page**. Climbing the whole retry ladder there returns the same
   * answer every time, so after one confirmation retry the miss is surfaced as
   * `UpstreamRecordMissingError`. Do not enable it for search endpoints, whose
   * misses arrive in a normal envelope — an empty body there is a real
   * transient failure and the existing ladder is the defence.
   */
  singleRecordLookup?: boolean
}

const DEFAULT_TIMEOUT = 30000
const DEFAULT_RETRIES = 3
/**
 * Exponential-backoff base. Upstream round trips run well under a second, and
 * a 1,000ms base would wait 1/2/4 seconds — six to eight times the round trip.
 * At 300ms the wall clock to the final attempt is ~4.6s, still covering the
 * "recovers within seconds" burst-failure window, without the waiting
 * dominating the work. Retry count and retryOn are unchanged.
 */
const DEFAULT_RETRY_DELAY = 300
const DEFAULT_RETRY_ON = [429, 503, 504]

// Several public legal-data sites classify Node's default UA (undici) as a bot
// and refuse the request, so calls go out with an ordinary browser UA.
// Override with the LAW_USER_AGENT environment variable.
const DEFAULT_USER_AGENT =
  process.env.LAW_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// Some upstreams reject requests without a Referer even when everything else
// checks out. There is no default: it is only sent when LAW_REFERER is set,
// so no header is injected into a host that never asked for one.
const CONFIGURED_REFERER = process.env.LAW_REFERER

/**
 * Fetch with automatic retry and timeout
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
    retryOn = DEFAULT_RETRY_ON,
    allowHtmlBody = false,
    singleRecordLookup = false,
    signal: callerSignal,
    beforeAttempt,
    ...fetchOptions
  } = options
  const externalSignal = callerSignal ?? undefined

  let lastError: Error | null = null
  // For confirming a single-record miss: whether an empty/HTML body has been
  // observed at all (independent of the attempt number).
  let sawBadBody = false

  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfRequestCancelled()
    const waitingSignal = combineAbortSignals(externalSignal, getRequestSignal())
    if (waitingSignal?.aborted) throw requestCancelledError(waitingSignal.reason)
    // Waiting for a host slot is neither a network failure nor upstream work:
    // do not retry a rejected gate or charge it to the request allowance.
    await beforeAttempt?.(waitingSignal)
    if (waitingSignal?.aborted) throw requestCancelledError(waitingSignal.reason)
    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    const signal = combineAbortSignals(controller.signal, externalSignal, getRequestSignal())

    const headers = new Headers(fetchOptions.headers)
    if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT)
    if (!headers.has("referer") && CONFIGURED_REFERER) headers.set("referer", CONFIGURED_REFERER)

    try {
      // This is intentionally charged per *attempt*: retry work must not turn
      // one tool call into unbounded upstream activity.
      requestContext.getStore()?.budget?.consumeUpstreamRequest()
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal,
      })

      clearTimeout(timeoutId)

      // Success or non-retryable error
      if (response.ok || !retryOn.includes(response.status)) {
        // A 200 with an empty body or an HTML page is not passed through — the
        // parser would blow up on "missing root element". On search paths this
        // reads as maintenance/overload and is retried; on single-record
        // lookups the `singleRecordLookup` branch below confirms it once and
        // then declares a miss.
        if (response.ok && attempt < retries) {
          const bad = await classifyOkBody(response, externalSignal)
          if (bad === "empty" || (bad === "html" && !allowHtmlBody)) {
            await response.body?.cancel().catch(() => {})
            // On a single-record lookup this body usually means "no such
            // record". The body alone cannot separate a miss from a transient
            // failure, so ask once more briefly; if the answer is the same,
            // stop climbing the ladder and surface the miss (never return an
            // empty result as success). The test is not the attempt number but
            // "has a bad body already been seen" — the first empty body after
            // a 503 or a network error (one observation) must not be confirmed
            // as a miss.
            if (singleRecordLookup && sawBadBody) {
              throw new UpstreamRecordMissingError(maskSensitiveUrl(url), bad)
            }
            sawBadBody = true
            lastError = new Error(
              `Malformed upstream response (${bad === "empty" ? "empty body" : "HTML page"}) - ${maskSensitiveUrl(url)}`
            )
            await sleep(
              singleRecordLookup ? MISS_CONFIRM_DELAY_MS : getRetryDelay(response, retryDelay, attempt),
              combineAbortSignals(externalSignal, getRequestSignal()),
            )
            continue
          }
        }
        return response
      }

      // Retryable error - check if we have retries left
      if (attempt < retries) {
        const delay = getRetryDelay(response, retryDelay, attempt)
        // This response will never be returned to a caller. Dispose its body
        // before backoff so the connection can be reused, and let either MCP
        // item cancellation or HTTP disconnect interrupt the wait.
        await response.body?.cancel().catch(() => {})
        await sleep(delay, combineAbortSignals(externalSignal, getRequestSignal()))
        continue
      }

      // No retries left
      return response
    } catch (error) {
      clearTimeout(timeoutId)

      if (getRequestSignal()?.aborted || externalSignal?.aborted) {
        throw requestCancelledError(getRequestSignal()?.reason ?? externalSignal?.reason)
      }
      if (error instanceof ExecutionLimitError) throw error
      // A miss already confirmed by the re-check — do not mistake it for a
      // network error and reopen the retry ladder.
      if (error instanceof UpstreamRecordMissingError) throw error

      // Timeout or network error — build the error with the key stripped
      if (error instanceof Error) {
        if (error.name === "AbortError" && timedOut) {
          lastError = new Error(`Request timeout after ${timeout}ms for ${maskSensitiveUrl(url)}`)
        } else {
          // fetch's own error messages can embed the URL as well
          const masked = maskSensitiveUrl(error.message)
          lastError = masked !== error.message ? new Error(masked) : error
        }
      }

      // Retry on network errors
      if (attempt < retries) {
        const delay = getRetryDelay(null, retryDelay, attempt)
        await sleep(delay, combineAbortSignals(externalSignal, getRequestSignal()))
        continue
      }
    }
  }

  throw lastError || new Error("Request failed after retries")
}

/**
 * Defensive ceiling on Retry-After. Taking the header at face value lets one
 * upstream response set an arbitrary wait (3600 → a one-hour sleep). The cap
 * sits well above an upstream round trip and at the same place as the tool
 * timeout (DEFAULT_TIMEOUT, 30 seconds).
 */
const MAX_RETRY_AFTER_MS = 30_000

/** Prefer the Retry-After header (clamped), otherwise exponential backoff + jitter. */
function getRetryDelay(response: Response | null, retryDelay: number, attempt: number): number {
  if (response) {
    const retryAfter = response.headers.get("Retry-After")
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
      }
    }
  }
  const baseDelay = retryDelay * Math.pow(2, attempt)
  return baseDelay + Math.random() * baseDelay * 0.5
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(requestCancelledError(signal.reason))

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeoutId)
      signal.removeEventListener("abort", onAbort)
      reject(requestCancelledError(signal.reason))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
