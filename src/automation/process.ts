import { spawn } from "node:child_process"

export interface ProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number
  maxOutputBytes?: number
  signal?: AbortSignal
}
export class ProcessFailure extends Error {
  constructor(readonly exitCode: number | null, reason: string) { super(reason) }
}
// Only trusted configuration supplies executable/argv. Untrusted content is stdin.
// Do not include command output or argv in exceptions: either can contain secrets.
export function runProcess(executable: string, argv: string[], options: ProcessOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ProcessFailure(null, "Process cancelled")); return }
    const child = spawn(executable, argv, {
      shell: false, cwd: options.cwd, env: options.env,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    })
    let failure: string | undefined
    let hardKill: ReturnType<typeof setTimeout> | undefined
    let total = 0
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* already exited */ }
    }
    const stop = (reason: string) => {
      if (failure) return
      failure = reason
      kill("SIGTERM")
      hardKill = setTimeout(() => kill("SIGKILL"), 500)
    }
    const cancel = () => stop("Process cancelled")
    options.signal?.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(() => stop("Process timed out"), options.timeoutMs)
    const consume = (chunks: Buffer[], data: Buffer) => {
      total += data.byteLength
      if (total > (options.maxOutputBytes ?? 1_048_576)) { stop("Process output exceeded limit"); return }
      chunks.push(data)
    }
    child.stdout.on("data", data => consume(stdout, data))
    child.stderr.on("data", data => consume(stderr, data))
    child.stdin.on("error", () => { /* Early CLI exit is handled by close. */ })
    child.on("error", () => { failure = "Failed to start configured executable" })
    child.on("close", code => {
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      options.signal?.removeEventListener("abort", cancel)
      if (failure || code !== 0) reject(new ProcessFailure(code, failure ?? "Configured executable returned a nonzero exit code"))
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
    })
    child.stdin.end(options.stdin ?? "")
  })
}

export function cleanEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/local/bin:/usr/bin:/bin",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
}
