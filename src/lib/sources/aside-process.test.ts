import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runAsideCommand, serialAsideRun } from "./aside-process.js"

const folders: string[] = []
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }) })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function folder() { const path = await mkdtemp(join(tmpdir(), "au law aside process ")); folders.push(path); return path }
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { const value = await readFile(path, "utf8"); if (value) return value } catch {}
    await pause(20)
  }
  throw new Error("Test child did not become ready")
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const options = { timeoutMs: 5000, maxOutputBytes: 4096 }

describe("real child-process lifecycle (no Aside or network)", () => {
  it("runs a script with spaces in its path and passes shell-looking arguments as data", async () => {
    const path = join(await folder(), "browser child.cjs")
    await writeFile(path, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    const argument = "$(printf not-executed); && 'quoted'"
    const result = await runAsideCommand(process.execPath, [path, argument], options)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([argument])
  })

  it("retains UTF-8 characters split across pipe chunks", async () => {
    const expected = "Australian law ⚖️ 한국어"
    const code = `const bytes=Buffer.from(${JSON.stringify(expected)}); let n=0; const timer=setInterval(()=>{if(n===bytes.length)clearInterval(timer);else process.stdout.write(bytes.subarray(n,n+++1))},1)`
    const result = await runAsideCommand(process.execPath, ["-e", code], options)
    expect(result.stdout).toBe(expected)
    expect(result.exitCode).toBe(0)
  })

  it("reports an executable that cannot start", async () => {
    const result = await runAsideCommand(join(await folder(), "missing-command"), [], options)
    expect(result.failedToStart).toBe(true)
    expect(result.stdout).toBe("")
  })

  it("keeps a nonzero exit distinct from a timeout and discards stderr", async () => {
    const result = await runAsideCommand(process.execPath, ["-e", "process.stderr.write('private diagnostics');process.stdout.write('output');process.exitCode=7"], options)
    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe("output")
    expect(result).not.toHaveProperty("stderr")
  })

  it("stops excess output instead of buffering it", async () => {
    const result = await runAsideCommand(process.execPath, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(10000)),1)"], { ...options, maxOutputBytes: 256 })
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256)
  })

  it("terminates a process that exceeds its wall-clock budget", async () => {
    const result = await runAsideCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeoutMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it("cancels a process which has actually started", async () => {
    const ready = join(await folder(), "ready")
    const controller = new AbortController()
    const work = runAsideCommand(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`], { ...options, signal: controller.signal })
    const outcome = work.catch(error => error)
    try { await waitForFile(ready) } finally { controller.abort() }
    expect(await outcome).toMatchObject({ name: "AbortError" })
  }, 10000)

  it.skipIf(process.platform === "win32")("kills a TERM-resistant grandchild even if its parent exits first", async () => {
    const ready = join(await folder(), "grandchild")
    const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`
    const controller = new AbortController()
    const work = runAsideCommand(process.execPath, ["-e", parent], { ...options, signal: controller.signal })
    const outcome = work.catch(error => error)
    let pid: number | undefined
    try {
      pid = Number(await waitForFile(ready))
      controller.abort()
      expect(await outcome).toMatchObject({ name: "AbortError" })
      const deadline = Date.now() + 2000
      let running = true
      while (Date.now() < deadline && running) {
        try { running = !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z") }
        catch { running = false }
        if (running) await pause(20)
      }
      expect(running).toBe(false)
    } finally {
      controller.abort()
      await outcome
      if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
    }
  }, 10000)
})

describe("serial ownership and queue backpressure", () => {
  it("does not overlap browser work from concurrent requests", async () => {
    let active = 0
    let maximum = 0
    const seen: number[] = []
    const all = Array.from({ length: 6 }, (_, i) => serialAsideRun(async () => {
      maximum = Math.max(maximum, ++active)
      seen.push(i)
      await pause(2)
      active--
      return i
    }, { timeoutMs: 1000 }))
    expect(await Promise.all(all)).toEqual([0, 1, 2, 3, 4, 5])
    expect(maximum).toBe(1)
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("cancels queued work promptly without letting the next job overtake the active one", async () => {
    const hold = deferred()
    const entered = deferred()
    const events: string[] = []
    const first = serialAsideRun(async () => { events.push("first"); entered.resolve(); await hold.promise }, { timeoutMs: 2000 })
    await entered.promise
    const controller = new AbortController()
    const second = serialAsideRun(async () => { events.push("cancelled") }, { timeoutMs: 2000, signal: controller.signal }).catch(error => error)
    const third = serialAsideRun(async () => { events.push("third") }, { timeoutMs: 2000 })
    try {
      controller.abort()
      expect(await second).toMatchObject({ name: "AbortError" })
      expect(events).toEqual(["first"])
    } finally { hold.resolve(); await first; await third }
    expect(events).toEqual(["first", "third"])
  })

  it("counts queue time in the call's deadline and never launches an expired job", async () => {
    const hold = deferred()
    const first = serialAsideRun(() => hold.promise, { timeoutMs: 2000 })
    let launched = false
    try {
      await expect(serialAsideRun(async () => { launched = true }, { timeoutMs: 30 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" })
      expect(launched).toBe(false)
    } finally { hold.resolve(); await first }
  })

  it("releases the queue after a failed task", async () => {
    const failed = serialAsideRun(async () => { throw new Error("failed") }, { timeoutMs: 1000 }).catch(error => error)
    const next = serialAsideRun(async () => "next", { timeoutMs: 1000 })
    expect(await failed).toMatchObject({ message: "failed" })
    expect(await next).toBe("next")
  })

  it("bounds the pending queue instead of scheduling unlimited browser work", async () => {
    const hold = deferred()
    const entered = deferred()
    const first = serialAsideRun(async () => { entered.resolve(); return hold.promise }, { timeoutMs: 2000 })
    await entered.promise
    const jobs = Array.from({ length: 20 }, () => serialAsideRun(async () => "done", { timeoutMs: 2000 }))
    const outcomes = Promise.allSettled(jobs)
    hold.resolve()
    await first
    const rejected = (await outcomes).filter(result => result.status === "rejected")
    expect(rejected).toHaveLength(5)
    for (const result of rejected) if (result.status === "rejected") expect(result.reason.code).toBe("RATE_LIMITED")
  })
})
