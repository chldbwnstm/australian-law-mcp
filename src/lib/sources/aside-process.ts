/** Bounded CLI lifecycle and serial ownership of this server's browser work. */
import { spawn } from "node:child_process"
import { ErrorCodes, LawApiError, type ErrorCode } from "../errors.js"
import { requestCancelledError } from "../session-state.js"
import type { AsideRunner, AsideRunResult } from "./aside-browser.js"

const CHILD_ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"] as const

export function asideChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(CHILD_ENV_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]))
}

/** Also used with harmless Node child processes by the offline integration tests. */
export const runAsideCommand: AsideRunner = (command, args, options) => new Promise<AsideRunResult>((resolve, reject) => {
  if (options.signal?.aborted) { reject(requestCancelledError(options.signal.reason)); return }
  const child = spawn(command, [...args], {
    shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    detached: process.platform !== "win32", env: asideChildEnv(),
  })
  const chunks: Buffer[] = []
  let bytes = 0
  let timedOut = false
  let truncated = false
  let failedToStart = false
  let cancelled: Error | undefined
  let hardKill: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* process group already gone */ }
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    kill("SIGTERM")
    hardKill = setTimeout(() => kill("SIGKILL"), 500)
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
  const onAbort = () => { cancelled = requestCancelledError(options.signal?.reason); stop() }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  // Close the check/listener registration race as well.
  if (options.signal?.aborted) onAbort()
  child.stdout?.on("data", (data: Buffer) => {
    bytes += data.byteLength
    if (bytes > options.maxOutputBytes) { truncated = true; stop(); return }
    if (!stopping) chunks.push(data)
  })
  child.on("error", () => { failedToStart = true })
  child.on("close", code => {
    clearTimeout(timer)
    if (hardKill) clearTimeout(hardKill)
    // A parent can exit before a detached grandchild that ignores SIGTERM.
    // Do not release serial ownership while that cancelled group can still run.
    if (stopping) kill("SIGKILL")
    options.signal?.removeEventListener("abort", onAbort)
    if (cancelled) reject(cancelled)
    else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code, timedOut, truncated, failedToStart })
  })
})

let tail = Promise.resolve()
let outstanding = 0
const MAX_OUTSTANDING = 16

export class AsideQueueError extends LawApiError {
  constructor(message: string, code: ErrorCode) {
    super(message, code)
    this.name = "AsideQueueError"
  }
}

/** Queued cancellation is prompt, but never lets later work overtake the active CLI. */
export async function serialAsideRun<T>(run: (remainingMs: number) => Promise<T>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<T> {
  if (options.signal?.aborted) throw requestCancelledError(options.signal.reason)
  if (outstanding >= MAX_OUTSTANDING) throw new AsideQueueError("The Aside browser queue is full. Retry after the current research finishes.", ErrorCodes.RATE_LIMITED)
  outstanding++
  const deadline = Date.now() + options.timeoutMs
  let started = false
  let cancelled: Error | undefined
  let rejectQueued!: (error: Error) => void
  const cancelledWhileQueued = new Promise<never>((_, reject) => { rejectQueued = reject })
  const cancel = (error: Error) => {
    if (started) return
    cancelled = error
    rejectQueued(error)
  }
  const onAbort = () => cancel(requestCancelledError(options.signal?.reason))
  const timer = setTimeout(() => cancel(new AsideQueueError("Aside timed out waiting for the current browser task.", ErrorCodes.TIMEOUT)), options.timeoutMs)
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const work = tail.then(async () => {
    if (cancelled) throw cancelled
    if (options.signal?.aborted) throw requestCancelledError(options.signal.reason)
    started = true
    clearTimeout(timer)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new AsideQueueError("Aside timed out before the browser task could start.", ErrorCodes.TIMEOUT)
    return run(remaining)
  }).finally(() => { outstanding-- })
  tail = work.then(() => undefined, () => undefined)
  try { return await Promise.race([work, cancelledWhileQueued]) }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort) }
}
