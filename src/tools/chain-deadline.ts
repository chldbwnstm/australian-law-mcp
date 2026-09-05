/**
 * Chain-level deadline + partial results.
 *
 * Parallelism lowers the average but does nothing about the upstream tail — the
 * same query has been measured finishing in 12 seconds and in 71. Once the
 * 60-second client limit is passed the user gets no partial result at all, only
 * a timeout.
 *
 * So when time runs out we **assemble what did arrive and leave a marker where
 * something did not**. A partial result is a valid answer, so it is not an
 * `isError` — but it must always say what is missing and which tool retrieves
 * that piece on its own (no silent omissions).
 *
 * Integer validation reuses the single copy in `execution-limits.parseIntegerLimit`:
 * two copies of a bounds check means one of them eventually regains
 * `parseInt("20x") → 20` leniency. The constants belong to this domain, so they
 * live here.
 *
 * Arming the timer goes through the `DeadlineTimer` seam below, so a test can
 * decide when the limit passes instead of waiting for it. See that type for why
 * a test that waits is a test that measures the machine.
 */

import { parseIntegerLimit } from "../lib/execution-limits.js"

/**
 * 45 seconds by default.
 * MCP clients default to a 60-second timeout, and after the deadline fires
 * there is still section assembly, truncateResponse (50KB) and transmission to
 * do. The 15-second margin covers that tail plus clock skew.
 */
export const DEFAULT_CHAIN_DEADLINE_MS = 45_000

/** Under 5s not even a healthy chain finishes; over 5 minutes no client waits. */
const MIN_DEADLINE_MS = 5_000
const MAX_DEADLINE_MS = 300_000

/** An empty string counts as "unset" — deployments commonly blank a var rather than delete it. */
export function resolveChainDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseIntegerLimit(
    "MCP_CHAIN_DEADLINE_MS",
    env.MCP_CHAIN_DEADLINE_MS || undefined,
    DEFAULT_CHAIN_DEADLINE_MS,
    MIN_DEADLINE_MS,
    MAX_DEADLINE_MS,
  )
}

export interface ChainDeadline {
  /** Cancellation signal shared by every branch — on expiry it cuts in-flight upstream requests */
  readonly signal: AbortSignal
  expired(): boolean
  /** Clear the timer. Always call this when the chain ends (handle leak). */
  dispose(): void
}

/**
 * How a deadline learns that its time is up: arm `fire` to run in `ms`, and
 * return the function that disarms it again.
 *
 * Expiry is the one thing about a chain that is a **wall-clock** event, and
 * that makes it the one thing a test must not measure with a wall clock. A test
 * that shortens the limit and then waits for it prices its assertions in
 * machine speed: under parallel test load the worker loses its core for longer
 * than the window, the chain's own work never lands inside it, and a different
 * case fails on every run — which is exactly what `chains.deadline.test.ts` did
 * before this seam existed.
 *
 * So arming the timer goes through here. Production installs nothing and gets
 * `setTimeout` below; a test installs `createManualChainClock()` and fires
 * expiry itself, at the precise point in the chain it means to test.
 */
export type DeadlineTimer = (fire: () => void, ms: number) => () => void

const realTimer: DeadlineTimer = (fire, ms) => {
  const timer = setTimeout(fire, ms)
  // This timer must never be what keeps the process alive
  timer.unref?.()
  return () => clearTimeout(timer)
}

let armDeadline: DeadlineTimer = realTimer

/**
 * Install the timer that every deadline started from now on will arm. Returns
 * the restore function — call it from an `afterEach`, so one file's manual
 * clock can never leak into another file's real one. Production never calls it.
 */
export function setChainDeadlineTimer(timer: DeadlineTimer | null): () => void {
  const previous = armDeadline
  armDeadline = timer ?? realTimer
  return () => {
    armDeadline = previous
  }
}

/** A deadline clock a test drives by hand — the companion to `setChainDeadlineTimer`. */
export interface ManualChainClock {
  /** Deadlines armed and neither fired nor disposed. `0` means nothing is waiting on time. */
  readonly armed: number
  /** Let the time limit pass, now, for every armed deadline. */
  expire(): void
  /** Put the real timer back. Call from `afterEach`. */
  restore(): void
}

/**
 * Replace the wall clock for the duration of a test.
 *
 * The point is not speed, it is that "the branch answered" and "the limit
 * passed" stop being a race the machine adjudicates: the test settles every
 * branch that *can* answer, then calls `expire()`, so the partial result it
 * asserts on is the same on an idle laptop and on a loaded CI box.
 */
export function createManualChainClock(): ManualChainClock {
  const armedTimers = new Set<() => void>()
  const restore = setChainDeadlineTimer((fire) => {
    armedTimers.add(fire)
    return () => armedTimers.delete(fire)
  })
  return {
    get armed() {
      return armedTimers.size
    },
    expire() {
      // Snapshot first: firing aborts the chain, which disposes the deadline
      // and mutates the set we would otherwise be iterating.
      for (const fire of [...armedTimers]) {
        armedTimers.delete(fire)
        fire()
      }
    },
    restore() {
      armedTimers.clear()
      restore()
    },
  }
}

export function startChainDeadline(ms: number = resolveChainDeadlineMs()): ChainDeadline {
  const controller = new AbortController()
  let fired = false
  const disarm = armDeadline(() => {
    fired = true
    controller.abort(new Error(`Chain time limit (${ms}ms) exceeded`))
  }, ms)
  return {
    signal: controller.signal,
    expired: () => fired,
    dispose: () => disarm(),
  }
}

export type LegOutcome<T> = { ok: true; value: T } | { ok: false }

/**
 * Race one branch against the deadline.
 *
 * A failure that happens before the deadline is rethrown rather than
 * swallowed — lumping timeouts together with real errors would disguise a
 * parse failure as "it must have been slow".
 */
export async function raceDeadline<T>(
  deadline: ChainDeadline,
  work: Promise<T>
): Promise<LegOutcome<T>> {
  const timedOut = new Promise<LegOutcome<T>>(resolve => {
    if (deadline.signal.aborted) return resolve({ ok: false })
    deadline.signal.addEventListener("abort", () => resolve({ ok: false }), { once: true })
  })
  const settled = work.then(
    (value): LegOutcome<T> => ({ ok: true, value }),
    (error): LegOutcome<T> => {
      if (deadline.expired()) return { ok: false }
      throw error
    }
  )
  return Promise.race([settled, timedOut])
}

/** Marker left where a section did not arrive in time — says what is missing and how to get it. */
export function timedOutSection(title: string, toolHint: string): string {
  return `▶ ${title}\n⏱ This section was not collected before the time limit — retrieve it with the individual tool (${toolHint}).`
}

/**
 * Closing marker for a chain that expired during its prefix (the groundwork or
 * earlier stages). Unlike a per-section marker it says "everything from here on
 * is missing" — the consumer also has to be told that what is above is all that
 * arrived in time, or the gaps get filled in by guesswork.
 */
export function timedOutChainNotice(): string {
  return "⏱ The chain time limit stopped later stages from being collected — everything above is all that arrived in time. Retrieve the rest with the individual tools, or retry shortly."
}
