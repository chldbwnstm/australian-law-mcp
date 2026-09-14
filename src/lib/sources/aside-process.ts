/** Bounded CLI lifecycle and serial ownership of this server's browser work. */
import { spawn } from "node:child_process"
import { win32 as win32Path } from "node:path"
import { ErrorCodes, LawApiError, type ErrorCode } from "../errors.js"
import { requestCancelledError } from "../session-state.js"
import type { AsideRunner, AsideRunResult } from "./aside-browser.js"

/**
 * What the CLI child may see of this process's environment.
 *
 * Two tables, chosen by the platform the child runs on, because what a process
 * needs in order to start differs: a POSIX Aside wants HOME and PATH; a Windows
 * one is conventionally handed the system root, the AppData roots, TEMP and
 * PATHEXT. Measured 2026-09-14 against CLI 1.26.906.1630: libuv backfills only
 * HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN,
 * USERNAME, USERPROFILE and WINDIR into an empty child environment — never
 * LOCALAPPDATA or APPDATA, which that CLI uses for its native module and its
 * config directory — and that build happens to start even with nothing, so the
 * Windows list is there for the build that does read them. Neither table
 * carries this server's own configuration or any credential
 * (`automation/process.ts` keeps the same line for its git children).
 */
const POSIX_CHILD_ENV_KEYS = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"] as const
const WINDOWS_CHILD_ENV_KEYS = [
  "SystemRoot", "windir", "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP",
  "PATH", "PATHEXT", "COMSPEC", "USERNAME", "LANG",
] as const

export function asideChildEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return Object.fromEntries(POSIX_CHILD_ENV_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]))
  // Windows variable names are case-insensitive: a real `process.env` answers
  // `env.systemroot`, but a plain object handed in by a test does not, and the
  // child should get the variable under whichever spelling the parent has.
  const wanted = new Set<string>(WINDOWS_CHILD_ENV_KEYS.map(key => key.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && wanted.has(key.toUpperCase())))
}

/**
 * `taskkill` by absolute path: this process's own PATH may be a desktop app's
 * restricted one, and the whole point of the call is that nothing else is
 * running the way it should.
 */
function windowsTaskkill(env: NodeJS.ProcessEnv = process.env): string {
  return win32Path.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe")
}

/** Also used with harmless Node child processes by the offline integration tests. */
export const runAsideCommand: AsideRunner = (command, args, options) => new Promise<AsideRunResult>((resolve, reject) => {
  if (options.signal?.aborted) { reject(requestCancelledError(options.signal.reason)); return }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...args], {
      shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      detached: process.platform !== "win32", env: asideChildEnv(),
    })
  } catch {
    // Node refuses some spawns synchronously rather than through the 'error'
    // event — a .cmd/.bat without a shell (EINVAL) on Windows, a bad option —
    // and that is a CLI that could not be started, reported the same way.
    resolve({ stdout: "", exitCode: null, failedToStart: true })
    return
  }
  const chunks: Buffer[] = []
  let bytes = 0
  let timedOut = false
  let truncated = false
  let failedToStart = false
  let cancelled: Error | undefined
  let hardKill: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  /**
   * Stop the CLI and everything it started.
   *
   * POSIX: the child is its own process group (`detached`), so one signal to
   * `-pid` reaches a helper that outlives its parent. Windows has no groups;
   * `taskkill /T` walks the parent-PID tree, which it can only do while the
   * root is alive, so it is issued at stop time and never after `close`.
   * Measured 2026-09-14: during a `repl` call the CLI's only child is its
   * console host, and the browser is never the CLI's child — with the browser
   * closed the CLI fails ("profile is not connected to the daemon") rather
   * than launching it — so the tree kill cannot reach the user's browser.
   * TerminateProcess on the root (`child.kill`) is the fallback when taskkill
   * cannot be started, and the hard kill 500 ms later.
   */
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") {
        // Only while the root is still running: once it has exited (even before
        // 'close', while stdout drains) its PID may already belong to another process.
        if (signal === "SIGTERM" && child.pid && child.exitCode === null && child.signalCode === null) {
          spawn(windowsTaskkill(), ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true, shell: false })
            .on("error", () => { try { child.kill() } catch { /* already gone */ } })
        } else child.kill()
      } else if (child.pid) process.kill(-child.pid, signal)
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
    // POSIX only: on Windows the tree was walked while the root was alive, and
    // a PID that has closed may already belong to some other process.
    if (stopping && process.platform !== "win32") kill("SIGKILL")
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
