import { afterEach, describe, expect, it, vi } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { assertAllowedPath, assertDesign, configSchema, loadConfig } from "./config.js"
import { cleanEnvironment, runProcess } from "./process.js"
import { dockerArguments, workerEnvironment } from "./sandbox.js"
import { FileStore, Run } from "./state.js"
import { scanFiles } from "./workspace.js"
import { main, parseArguments } from "./daemon.js"

const roots: string[] = []
function directory() { const dir = mkdtempSync(join(tmpdir(), "issue-agent-test-")); roots.push(dir); return dir }
function config() { return loadConfig(resolve("automation/config.example.json")) }
function record(): Run {
  const id = randomUUID(), date = "2026-09-10T00:00:00.000Z"
  return { id, issueNumber: 1, inputHash: "a".repeat(64), policyHash: "b".repeat(64), stage: "triage",
    branch: "agent/issue-1-" + id, createdAt: date, updatedAt: date, attempts: 0, workerCalls: 0,
    reservedWorkerSeconds: 0, infrastructureFailures: 0, labelsSynced: false }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("configuration and file policy", () => {
  it("validates the example but rejects auto merge, arbitrary secret names and unsafe networks", () => {
    const c = config()
    expect(c.enabled).toBe(false)
    expect(() => configSchema.parse({ ...c, autoMerge: true })).toThrow()
    expect(() => configSchema.parse({ ...c, sandbox: { ...c.sandbox, secretNames: ["GH_TOKEN"] } })).toThrow()
    expect(() => configSchema.parse({ ...c, sandbox: { ...c.sandbox, network: "host" } })).toThrow()
    expect(() => configSchema.parse({ ...c, approvalLabel: c.candidateLabel })).toThrow()
    expect(() => configSchema.parse({ ...c, shell: true })).toThrow()
  })
  it.each(["../README.md", "src/lib/../../.github/workflows/ci.yml", "src/lib\\evil.ts", "src/lib/.git/config",
    ".github/workflows/ci.yml", "src/automation/config.ts", "package.json", "src/lib/AGENTS.md", "src/lib/.env"])(
    "denies %s even if allowedPaths attempts to permit it", path => {
      const c = config()
      c.allowedPaths = ["src", ".github", "package.json"]
      expect(() => assertAllowedPath(path, c)).toThrow()
    })
  it("requires every changed path to be in the validated design", () => {
    const c = config()
    const design = { summary: "Fix", risk: "low" as const, files: ["src/lib/a.ts"], acceptanceCriteria: ["Works"], testPlan: ["Test"] }
    expect(() => assertAllowedPath("src/lib/a.ts", c, design)).not.toThrow()
    expect(() => assertAllowedPath("src/lib/b.ts", c, design)).toThrow()
    expect(() => assertDesign({ ...design, risk: "high" }, c)).toThrow()
  })
  it("rejects a worker-created git directory and oversized output", () => {
    const dir = directory(), c = config()
    mkdirSync(join(dir, ".git"))
    expect(() => scanFiles(dir, c)).toThrow(/Unsafe/)
    rmSync(join(dir, ".git"), { recursive: true })
    writeFileSync(join(dir, "large"), "x".repeat(1025))
    c.maxSnapshotBytes = 1024
    expect(() => scanFiles(dir, c)).toThrow(/size/)
  })
  it.skipIf(process.platform === "win32")("rejects symlinks rather than following them outside the snapshot", () => {
    const dir = directory()
    symlinkSync("/etc/passwd", join(dir, "escape"))
    expect(() => scanFiles(dir, config())).toThrow(/Links/)
  })
})

describe("process and sandbox boundaries", () => {
  it.skipIf(process.platform === "win32")("normalizes provider JSON through the shipped adapter without shell interpolation", async () => {
    const dir = directory(), cli = join(dir, "fake-provider")
    writeFileSync(cli, "#!" + process.execPath + "\n" + [
      'const assert=require("node:assert/strict"); let input="";',
      'process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{',
      'const args=process.argv.slice(2), prompt=JSON.parse(input);',
      'assert(args.includes("--json-schema")); assert(args.includes("--permission-mode"));',
      'assert(prompt.untrustedData.includes("$(touch injected)"));',
      'const value={summary:"Validated",tests:["ok"]};',
      'process.stdout.write(JSON.stringify(args.includes("--prompt-file")?{response:JSON.stringify(value)}:{structured_output:value}));',
      '});',
    ].join("\n"))
    chmodSync(cli, 0o755)
    for (const role of ["grok", "fable", "opus"]) {
      const result = await runProcess(process.execPath, [resolve("automation/agent-json.mjs"), role, cli], {
        cwd: dir, env: cleanEnvironment(),
        stdin: JSON.stringify({ outputSchema: { type: "object" }, untrustedData: "$(touch injected)" }), timeoutMs: 3000,
      })
      expect(JSON.parse(result.stdout)).toEqual({ summary: "Validated", tests: ["ok"] })
      expect(existsSync(join(dir, "injected"))).toBe(false)
    }
  })
  it("passes metacharacters literally as stdin and argv without shell execution", async () => {
    const dir = directory()
    const script = join(dir, "fake.cjs")
    writeFileSync(script, 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify({s, args:process.argv.slice(2), gh:process.env.GH_TOKEN})));')
    const malicious = "$(touch injected); & echo hacked"
    const result = await runProcess(process.execPath, [script, malicious], { cwd: dir, env: cleanEnvironment(), stdin: malicious, timeoutMs: 2000 })
    expect(JSON.parse(result.stdout)).toEqual({ s: malicious, args: [malicious] })
    expect(existsSync(join(dir, "injected"))).toBe(false)
  })
  it("uses a fresh environment, keeps provider values out of argv and makes Fable read-only", () => {
    const c = config()
    const env = workerEnvironment(c, {
      GH_TOKEN: "gh-secret", GITHUB_TOKEN: "github-secret", AUTOMATION_GITHUB_TOKEN: "orchestrator-secret",
      SSH_AUTH_SOCK: "/host/agent", NODE_OPTIONS: "--require=/host/injection.js",
      XAI_API_KEY: "model-x", ANTHROPIC_API_KEY: "model-a",
    })
    expect(Object.values(env)).not.toContain("orchestrator-secret")
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe("model-a")
    const args = dockerArguments(c, "fable", randomUUID(), "/private/scratch", 1000, 1000)
    expect(args).toContain("type=bind,src=/private/scratch,dst=/workspace,readonly")
    expect(args).toContain("--cap-drop=ALL")
    expect(args).toContain("--read-only")
    expect(args.join(" ")).not.toContain("model-a")
    expect(() => dockerArguments(c, "opus", randomUUID(), "/tmp/x,dst=/host", 1000, 1000)).toThrow()
    expect(() => dockerArguments(c, "opus", randomUUID(), "/tmp/x", 0, 0)).toThrow()
  })
  it("bounds execution time and output size", async () => {
    const options = { cwd: directory(), env: cleanEnvironment(), timeoutMs: 100 }
    await expect(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], options)).rejects.toThrow(/timed out/)
    await expect(runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'],
      { ...options, timeoutMs: 2000, maxOutputBytes: 100 })).rejects.toThrow(/output/)
  })
  it("honors cancellation without exposing stderr secrets", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runProcess(process.execPath, [], { cwd: directory(), env: cleanEnvironment(), timeoutMs: 1000, signal: controller.signal })).rejects.toThrow(/cancelled/)
    await expect(runProcess(process.execPath, ["-e", 'process.stderr.write("SECRET");process.exit(1)'],
      { cwd: directory(), env: cleanEnvironment(), timeoutMs: 2000 })).rejects.toThrow("Configured executable returned a nonzero exit code")
  })
})

describe("durable journal and dry-run", () => {
  it("prevents concurrent owners and preserves attempts across restart", () => {
    const dir = directory(), first = new FileStore(dir), second = new FileStore(dir)
    first.acquire()
    try {
      const run = record(); run.attempts = 2
      first.save(run)
      expect(() => second.acquire()).toThrow(/lock/)
      expect(first.all()[0].attempts).toBe(2)
    } finally { first.release() }
    second.acquire()
    try { expect(second.all()[0].attempts).toBe(2) } finally { second.release() }
  })
  it("fails closed on a stale lock or corrupted journal", () => {
    const dir = directory()
    mkdirSync(join(dir, "daemon.lock"))
    const store = new FileStore(dir)
    expect(() => store.acquire()).toThrow(/lock/)
    rmSync(join(dir, "daemon.lock"), { recursive: true })
    writeFileSync(join(dir, "state.json"), '{"version":1,"runs":[{"attempts":-1}]}')
    expect(() => store.acquire()).toThrow()
    expect(existsSync(join(dir, "daemon.lock"))).toBe(false)
  })
  it("cannot persist an implementation state that has no bound approval", () => {
    const store = new FileStore(directory())
    store.acquire()
    try {
      const run = record(); run.stage = "implement"
      expect(() => store.save(run)).toThrow(/approval/)
      expect(store.all()).toEqual([])
    } finally { store.release() }
  })
  it("offline dry-run never starts processes, creates state, or reaches GitHub", async () => {
    const dir = directory(), c = config()
    c.stateDir = join(dir, "must-not-exist")
    const path = join(dir, "config.json")
    writeFileSync(path, JSON.stringify(c))
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await main(["--config", path, "--dry-run", "--offline", "--once"])
    const report = JSON.parse(String(output.mock.calls[0][0]))
    expect(report.effects).toEqual({ githubWrites: 0, workers: 0, worktrees: 0, journalWrites: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(c.stateDir)).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(c))
  })
  it("rejects misspelled flags and accidental offline live mode", () => {
    expect(() => parseArguments(["--offline"])).toThrow()
    expect(() => parseArguments(["--config"])).toThrow()
    expect(() => parseArguments(["--dryrun"])).toThrow()
  })
})
