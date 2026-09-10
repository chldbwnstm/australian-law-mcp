import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { loadConfig, Config } from "./config.js"
import { Pipeline } from "./engine.js"
import { GitHubClient, GitHubError, Issue, IssueEvent, Pull } from "./github.js"
import { FileStore, Run, RunStore } from "./state.js"
import { Role, Worker, workerEnvironment } from "./sandbox.js"
import { runProcess } from "./process.js"
import { GitWorkspaces } from "./workspace.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const bot = { id: 20, login: "automation-bot", type: "User" }
const maintainer = { id: 7, login: "maintainer", type: "User" }

class MockGitHub {
  date = new Date("2026-09-10T00:00:00.000Z")
  issue: Issue = { number: 1, title: "Fix a parser; $(touch injected)", body: "Return a positive value and test it.", state: "open", labels: ["agent-candidate"] }
  events: IssueEvent[] = []
  permission = "write"
  comments = new Map<number, Array<{ id: number; body: string; user: typeof bot; created_at: string }>>()
  pull?: Pull
  pullLabels: string[] = []
  baseSha = ""
  remoteSha?: string
  ci: "success" | "failure" | "pending" = "success"
  rabbit: "APPROVED" | "CHANGES_REQUESTED" | "missing" = "APPROVED"
  requests: Array<{ path: string; method: string }> = []
  createCount = 0
  loseCreateResponse = false
  discoveryUnavailable = false
  constructor(readonly config: Config) {}
  approve() {
    this.issue.labels.push(this.config.approvalLabel)
    this.events.push({ id: this.events.length + 1, event: "labeled", label: { name: this.config.approvalLabel },
      actor: maintainer, created_at: this.date.toISOString() })
  }
  pushed(sha: string) {
    this.remoteSha = sha
    if (this.pull) {
      this.pull.head.sha = sha
      this.pull.merge_commit_sha = createHash("sha1").update("merge:" + sha).digest("hex")
    }
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), path = url.pathname.replace("/repos/" + this.config.owner + "/" + this.config.repo, "")
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined
    this.requests.push({ path, method })
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
    if (path === "/issues" && method === "GET") return this.discoveryUnavailable ? response({}, 503) : response(this.issue.state === "open" ? [this.issue] : [])
    if (path === "/issues/1" && method === "GET") return response(this.issue)
    if (path === "/issues/10" && method === "GET" && this.pull) return response({ ...this.issue, number: 10, labels: this.pullLabels, pull_request: {}, state: this.pull.state })
    if (path === "/issues/1/events") return response(this.events)
    if (path === "/collaborators/maintainer/permission") return response({ permission: this.permission })
    if (path === "/commits/main") return response({ sha: this.baseSha })
    const comment = path.match(/^\/issues\/(\d+)\/comments$/)
    if (comment) {
      const number = Number(comment[1]), entries = this.comments.get(number) ?? []
      if (method === "GET") return response(entries)
      const created = { id: entries.length + 1, body: body.body, user: bot, created_at: this.date.toISOString() }
      entries.push(created); this.comments.set(number, entries); return response(created, 201)
    }
    const labels = path.match(/^\/issues\/(\d+)\/labels(?:\/(.+))?$/)
    if (labels) {
      const number = Number(labels[1]), list = number === 1 ? this.issue.labels : this.pullLabels
      if (method === "POST") {
        for (const label of body.labels) if (!list.includes(label)) list.push(label)
      } else if (method === "DELETE") {
        const index = list.indexOf(decodeURIComponent(labels[2]))
        if (index !== -1) list.splice(index, 1)
      }
      return response([])
    }
    if (path === "/pulls" && method === "GET") return response(this.pull ? [{ number: this.pull.number }] : [])
    if (path === "/pulls" && method === "POST") {
      this.createCount++
      this.pull = {
        number: 10, state: "open", draft: body.draft, body: body.body,
        head: { sha: this.remoteSha!, ref: body.head, repo: { full_name: this.config.owner + "/" + this.config.repo } },
        base: { ref: body.base, sha: this.baseSha }, mergeable: true,
        merge_commit_sha: createHash("sha1").update("merge:" + this.remoteSha).digest("hex"),
      }
      if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new Error("Lost response after creation") }
      return response(this.pull, 201)
    }
    if (path === "/pulls/10" && method === "GET") return response(this.pull)
    if (path.startsWith("/git/ref/heads/")) return this.remoteSha ? response({ object: { sha: this.remoteSha } }) : response({}, 404)
    if (path.match(/^\/commits\/[a-f0-9]+\/check-runs$/)) {
      const sha = path.split("/")[2], isHead = sha === this.pull?.head.sha
      const check = isHead ? this.config.codeRabbit : this.config.requiredChecks[0]
      return response({ check_runs: [{ id: isHead ? 2 : 3, name: isHead ? this.config.codeRabbit.checkName : this.config.requiredChecks[0].name,
        head_sha: sha, app: { id: check.appId }, status: !isHead && this.ci === "pending" ? "in_progress" : "completed",
        conclusion: isHead ? "success" : this.ci === "pending" ? null : this.ci }] })
    }
    if (path.endsWith("/statuses")) return response([])
    if (path === "/pulls/10/reviews") return response(this.rabbit === "missing" ? [] : [{
      id: 5, user: { id: this.config.codeRabbit.reviewerId, login: "coderabbitai[bot]", type: "Bot" },
      state: this.rabbit, commit_id: this.pull!.head.sha, submitted_at: this.date.toISOString(),
    }])
    if (path === "/pulls/10/comments") return response([])
    throw new Error("Unhandled mock request " + method + " " + path)
  }
}

class FakeCLIWorker implements Worker {
  calls: Role[] = []
  recoveries = 0
  highRisk = false
  constructor(private config: Config, private executableScript: string) {}
  async recover() { this.recoveries++ }
  async run(role: Role, _id: string, directory: string, prompt: string, signal?: AbortSignal): Promise<string> {
    this.calls.push(role)
    if (this.highRisk && role === "fable") return JSON.stringify({ summary: "Requires credential changes", risk: "high",
      files: ["src/lib/value.ts"], acceptanceCriteria: ["Works"], testPlan: ["Test"] })
    const result = await runProcess(process.execPath, [this.executableScript, role], {
      cwd: directory, env: workerEnvironment(this.config, { GH_TOKEN: "secret", AUTOMATION_GITHUB_TOKEN: "private", SSH_AUTH_SOCK: "/host/key" }),
      stdin: prompt, timeoutMs: 5000, signal,
    })
    return result.stdout
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "issue-agent-integration-")); roots.push(root)
  const config = loadConfig(resolve("automation/config.example.json"))
  config.stateDir = join(root, "state")
  config.botLogin = bot.login
  config.workerTimeoutSeconds = 5
  config.maxReservedWorkerSeconds = 100
  config.sandbox.secretNames = []
  config.gitExecutable = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
  const script = join(root, "fake-cli.cjs")
  writeFileSync(script, [
    'const fs = require("node:fs"), assert = require("node:assert/strict");',
    'assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.AUTOMATION_GITHUB_TOKEN, undefined); assert.equal(process.env.SSH_AUTH_SOCK, undefined);',
    'let input=""; process.stdin.on("data", d=>input+=d); process.stdin.on("end",()=>{',
    'const prompt=JSON.parse(input); assert(prompt.outputSchema); const role=process.argv[2]; let out;',
    'if(role==="grok") out={summary:"Small parser fix",eligible:true,risk:"low"};',
    'if(role==="fable") out={summary:"Implement positive value",risk:"low",files:["src/lib/value.ts","src/lib/value.test.ts"],acceptanceCriteria:["Value is positive"],testPlan:["Assert value > 0"]};',
    'if(role==="opus"){ const old=fs.readFileSync("src/lib/value.ts","utf8"); const value=Number(old.match(/= (\\d+)/)[1])+1;',
    'fs.writeFileSync("src/lib/value.ts","export const value = "+value+"\\n");',
    'fs.writeFileSync("src/lib/value.test.ts", "import {expect,it} from \\"vitest\\"; import {value} from \\"./value.js\\"; it(\\"positive\\",()=>expect(value).toBeGreaterThan(0));\\n");',
    'assert(value>0); out={summary:"Fixed parser",tests:["Positive-value assertion passed"]}; }',
    'process.stdout.write(JSON.stringify(out)); });',
  ].join("\n"))
  const store = new FileStore(config.stateDir); store.acquire()
  const server = new MockGitHub(config)
  const github = new GitHubClient(config, "test-token", false, server.fetch)
  const worker = new FakeCLIWorker(config, script)
  class TestWorkspaces extends GitWorkspaces {
    pushes = 0
    async push(run: Run) { this.pushes++; server.pushed(run.headSha!) }
  }
  const workspaces = new TestWorkspaces(config, "test-token")
  let currentStore: RunStore = store
  let pipeline = new Pipeline(config, github, currentStore, worker, workspaces, () => server.date, undefined, () => {})
  const tick = async () => { server.date = new Date(server.date.getTime() + 15_000); await pipeline.tick() }
  const restart = (replacement: RunStore = store) => {
    currentStore = replacement
    pipeline = new Pipeline(config, github, currentStore, worker, workspaces, () => server.date, undefined, () => {})
  }
  const run = () => store.all()[0]
  const seed = () => {
    const source = join(root, "seed")
    mkdirSync(join(source, "src", "lib"), { recursive: true })
    writeFileSync(join(source, "src", "lib", "value.ts"), "export const value = 0\n")
    const git = (args: string[], cwd = source) => execFileSync(config.gitExecutable, ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    git(["init"]); git(["add", "."]); git(["commit", "-m", "Fixture"])
    server.baseSha = git(["rev-parse", "HEAD"])
    const repo = join(config.stateDir, "repos", run().id + ".git"), tree = join(config.stateDir, "worktrees", run().id)
    mkdirSync(dirname(repo), { recursive: true }); mkdirSync(dirname(tree), { recursive: true })
    git(["clone", "--bare", source, repo])
    git(["--git-dir", repo, "worktree", "add", "--detach", tree, server.baseSha])
  }
  const toDesign = async () => {
    await tick()
    expect(run().stage).toBe("awaiting-approval")
    server.date = new Date(server.date.getTime() + 1000); server.approve()
    await tick()
    expect(run().stage).toBe("design")
    seed()
  }
  const toChecks = async () => {
    await toDesign()
    await tick(); expect(run().stage).toBe("implement")
    await tick(); expect(run().stage).toBe("publish")
    await tick(); expect(run().stage).toBe("checks")
  }
  return { root, config, store, server, github, worker, workspaces, tick, run, restart, toDesign, toChecks }
}

describe("issue-to-PR pipeline with a mock REST API, real Git worktrees and fake CLI executable", () => {
  it("waits for maintainer approval, creates a draft, passes gates and revokes ready after an external push", async () => {
    const f = fixture()
    try {
      await f.tick(); await f.tick()
      expect(f.worker.calls).toEqual(["grok"])
      f.server.permission = "read"; f.server.date = new Date(f.server.date.getTime() + 1000); f.server.approve()
      await f.tick(); expect(f.worker.calls).toEqual(["grok"])
    } finally { f.store.release() }
    const approved = fixture()
    try {
      await approved.toChecks(); await approved.tick()
      expect(approved.run().stage).toBe("ready")
      expect(approved.server.pull?.draft).toBe(true)
      expect(approved.server.pullLabels).toContain("ready-for-merge")
      expect(approved.worker.calls).toEqual(["grok", "fable", "opus"])
      expect(approved.server.createCount).toBe(1)
      approved.server.pushed("f".repeat(40))
      await approved.tick()
      expect(approved.run().stage).toBe("needs-human")
      expect(approved.server.pullLabels).not.toContain("ready-for-merge")
      expect(approved.server.requests.some(r => r.path.endsWith("/merge"))).toBe(false)
    } finally { approved.store.release() }
  })
  it("feeds failed checks into a bounded repair attempt on the same PR", async () => {
    const f = fixture()
    try {
      await f.toChecks()
      const firstSha = f.run().headSha
      f.server.ci = "failure"; await f.tick()
      expect(f.run().stage).toBe("implement")
      expect(f.run().feedback).toContain("failure")
      await f.tick(); await f.tick()
      expect(f.run().headSha).not.toBe(firstSha)
      f.server.ci = "success"; await f.tick()
      expect(f.run().stage).toBe("ready")
      expect(f.run().attempts).toBe(2)
      expect(f.server.createCount).toBe(1)
      expect(f.workspaces.pushes).toBe(2)
    } finally { f.store.release() }
  })
  it("keeps the implementation attempt limit after a daemon restart", async () => {
    const f = fixture()
    try {
      f.config.maxAttempts = 1; f.restart()
      await f.toChecks()
      f.store.release(); f.store.acquire(); f.restart()
      f.server.ci = "failure"; await f.tick(); await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.run().attempts).toBe(1)
      expect(f.worker.calls.filter(r => r === "opus")).toHaveLength(1)
    } finally { f.store.release() }
  })
  it("reconciles a PR created successfully before the response was lost", async () => {
    const f = fixture()
    try {
      await f.toDesign(); await f.tick(); await f.tick()
      f.server.loseCreateResponse = true
      await f.tick()
      expect(f.server.createCount).toBe(1)
      expect(f.run().stage).toBe("publish")
      f.store.release(); f.store.acquire(); f.restart()
      await f.tick(); await f.tick()
      expect(f.run().stage).toBe("ready")
      expect(f.server.createCount).toBe(1)
      expect(f.workspaces.pushes).toBe(1)
    } finally { f.store.release() }
  })
  it("recovers a commit made just before the journal update failed without running Opus twice", async () => {
    const f = fixture()
    try {
      await f.toDesign(); await f.tick()
      let crashed = false
      f.restart({
        all: () => f.store.all(),
        save: run => {
          if (run.stage === "publish") crashed = true
          if (crashed) throw new Error("Simulated process loss")
          f.store.save(run)
        },
      })
      await expect(f.tick()).rejects.toThrow()
      expect(f.run().stage).toBe("running")
      f.restart(); await f.tick()
      expect(f.run().stage).toBe("publish")
      await f.tick(); await f.tick()
      expect(f.run().stage).toBe("ready")
      expect(f.worker.calls.filter(r => r === "opus")).toHaveLength(1)
    } finally { f.store.release() }
  })
  it("stops before implementation when approved requirements change", async () => {
    const f = fixture()
    try {
      await f.toDesign()
      f.server.issue.body = "Now change authentication and workflows"
      await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.worker.calls).toEqual(["grok"])
      expect(f.workspaces.pushes).toBe(0)
    } finally { f.store.release() }
  })
  it("stops a high-risk Fable design and never invokes Opus", async () => {
    const f = fixture()
    try {
      await f.toDesign(); f.worker.highRisk = true
      await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.worker.calls).toEqual(["grok", "fable"])
    } finally { f.store.release() }
  })
  it("escalates missing reviews after the deadline without spending repair attempts", async () => {
    const f = fixture()
    try {
      f.config.checkTimeoutSeconds = 30; f.restart()
      await f.toChecks()
      f.server.rabbit = "missing"
      await f.tick()
      expect(f.run().stage).toBe("checks")
      await f.tick(); await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.run().attempts).toBe(1)
    } finally { f.store.release() }
  })
  it("charges reserved worker time before execution and stops when exhausted", async () => {
    const f = fixture()
    try {
      f.config.maxReservedWorkerSeconds = 5; f.restart()
      await f.toDesign(); await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.worker.calls).toEqual(["grok"])
      expect(f.run().reservedWorkerSeconds).toBe(5)
    } finally { f.store.release() }
  })
  it("continues readiness revocation when issue discovery fails", async () => {
    const f = fixture()
    try {
      await f.toChecks(); await f.tick()
      f.server.discoveryUnavailable = true
      f.server.issue.labels = f.server.issue.labels.filter(l => l !== f.config.approvalLabel)
      const before = f.worker.recoveries
      await f.tick()
      expect(f.run().stage).toBe("needs-human")
      expect(f.server.pullLabels).not.toContain("ready-for-merge")
      expect(f.worker.recoveries).toBeGreaterThan(before)
    } finally { f.store.release() }
  })
})

describe("REST adapter failure boundaries", () => {
  it("denies mutations in read-only mode before issuing a request", async () => {
    const f = fixture()
    try {
      const client = new GitHubClient(f.config, "test-token", true, f.server.fetch)
      await f.tick()
      const before = f.server.requests.length
      await expect(client.createPull(f.run())).rejects.toThrow(/Dry-run/)
      expect(f.server.requests).toHaveLength(before)
    } finally { f.store.release() }
  })
  it("preserves rate-limit backoff without exposing the token or response body", async () => {
    const config = loadConfig(resolve("automation/config.example.json"))
    const client = new GitHubClient(config, "SUPER-SECRET", false,
      async () => new Response("SUPER-SECRET", { status: 429, headers: { "retry-after": "120" } }))
    try { await client.candidates(); throw new Error("Expected rate limit") }
    catch (error) {
      expect(error).toBeInstanceOf(GitHubError)
      expect((error as GitHubError).retryAfterMs).toBe(120_000)
      expect(String(error)).not.toContain("SUPER-SECRET")
    }
  })
  it("reads all event pages before determining the latest approval event", async () => {
    const config = loadConfig(resolve("automation/config.example.json"))
    const pages: string[] = []
    const client = new GitHubClient(config, "test-token", false, async input => {
      const page = new URL(String(input)).searchParams.get("page")!
      pages.push(page)
      const event = { id: 1, event: "labeled", actor: maintainer, created_at: "2026-09-10T00:00:00Z", label: { name: config.approvalLabel } }
      return new Response(JSON.stringify(page === "1" ? Array.from({ length: 100 }, (_, id) => ({ ...event, id })) : [{ ...event, id: 101, event: "unlabeled" }]))
    })
    expect((await client.events(1)).at(-1)?.event).toBe("unlabeled")
    expect(pages).toEqual(["1", "2"])
  })
})
