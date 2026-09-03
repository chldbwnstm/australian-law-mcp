/**
 * Request quota gate — token bucket + rolling daily cap.
 *
 * A fixed window blocks the remaining tens of seconds outright whenever
 * requests bunch up early in the window. MCP is especially exposed to that
 * pattern because calling several tools within one conversation turn is normal.
 * A token bucket refills continuously, so a few seconds after exhaustion
 * requests pass again — the same average throughput produces far fewer 429s.
 *
 * `now` is injected so the whole module is testable without timers.
 */

export interface Verdict {
  ok: boolean
  /** Seconds to advise the client to wait when denied (0 when allowed) */
  retryAfterSec: number
}

const OK: Verdict = { ok: true, retryAfterSec: 0 }

export interface TokenBucket {
  take(n: number, now?: number): Verdict
}

/**
 * @param ratePerMin refill per minute. 0 or less denies everything (a signal that the feature is off)
 * @param burst bucket capacity. Defaults to one minute's worth — the average is unchanged and only bursts are absorbed
 */
export function createTokenBucket(ratePerMin: number, burst = ratePerMin): TokenBucket {
  let tokens = burst
  let last = 0

  return {
    take(n: number, now = Date.now()): Verdict {
      if (ratePerMin <= 0) return { ok: false, retryAfterSec: 60 }
      if (last === 0) last = now
      tokens = Math.min(burst, tokens + ((now - last) / 60_000) * ratePerMin)
      last = now

      if (tokens >= n) {
        tokens -= n
        return OK
      }
      // Time for the shortfall to refill. A request larger than the bucket can
      // never be served, so that case is also denied with a finite advised wait.
      const deficit = Math.min(n, burst) - tokens
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((deficit / ratePerMin) * 60)) }
    },
  }
}

export interface DailyCap {
  take(n: number, now?: number): Verdict
  used(now?: number): number
}

/**
 * Rolling 24-hour total cap — the backstop that keeps a relaxed per-minute
 * limit from exposing the whole day's upstream quota. The HTTP layer wires this
 * to the `FALLBACK_DAILY_CAP` environment variable.
 *
 * @param limit allowance per 24 hours. 0 or less means no cap (always allowed)
 */
export function createDailyCap(limit: number): DailyCap {
  let count = 0
  let resetAt = 0

  function roll(now: number) {
    if (limit > 0 && now >= resetAt) {
      count = 0
      resetAt = now + 86_400_000
    }
  }

  return {
    take(n: number, now = Date.now()): Verdict {
      if (limit <= 0) return OK
      roll(now)
      if (count + n > limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) }
      }
      count += n
      return OK
    },
    used(now = Date.now()): number {
      if (limit <= 0) return 0
      roll(now)
      return count
    },
  }
}
