import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { ASIDE_HOST_FLOORS as HELPER_FLOORS, beginTask, checkpoint, findAsideExecutable, finishTask, hostEligibility, initMatter, isAcceptableCommandPath, markDisconnected, resumeMatter, setSession, standardAsideCommand } from "../companion/au-law-followup/scripts/followup.mjs"
import { ASIDE_HOST_FLOORS, isEligibleLocalAside } from "./lib/research-followup.js"
import { defaultAsideCommandPath, isAbsoluteCommandPath } from "./lib/sources/aside-browser.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const script = resolve("companion/au-law-followup/scripts/followup.mjs")

/**
 * The helper is copied into user projects and cannot import this package, so
 * its eligibility rule and CLI resolver are copies of the server's. These
 * tests are what keep the copies honest: same table, same paths, same verdicts.
 */
describe("companion host eligibility — the installed copy of the server's rule", () => {
  it("keeps its floor table in lock-step with the server's", () => {
    const shape = (table: Record<string, { name: string; minMajor: number }>) =>
      Object.fromEntries(Object.entries(table).map(([platform, floor]) => [platform, { name: floor.name, minMajor: floor.minMajor }]))
    expect(shape(HELPER_FLOORS)).toEqual(shape(ASIDE_HOST_FLOORS as never))
  })

  it("keeps its standard CLI path in lock-step with the server's", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }
    expect(standardAsideCommand("win32", env, "C:\\Users\\tester")).toBe(defaultAsideCommandPath("C:\\Users\\tester", "win32", env))
    const custom = { ...env, ASIDE_CLI_INSTALL_DIR: "D:\\Tools\\AsideCLI" }
    expect(standardAsideCommand("win32", custom, "C:\\Users\\tester")).toBe(defaultAsideCommandPath("C:\\Users\\tester", "win32", custom))
    expect(standardAsideCommand("win32", {}, "C:\\Users\\tester")).toBe(defaultAsideCommandPath("C:\\Users\\tester", "win32", {}))
    expect(standardAsideCommand("darwin", {}, "/Users/tester")).toBe(defaultAsideCommandPath("/Users/tester", "darwin", {}))
  })

  const connected = { connected: true, tools: ["repl", "exec"] }
  it.each([
    ["win32", "10.0.26200", "local", connected],
    ["win32", "10.0.19045", "local", connected],
    ["darwin", "15.1", "local", connected],
    ["win32", "6.3.9600", "local", connected],
    ["win32", "10.0.26200", "remote", connected],
    ["linux", "6.8", "local", connected],
    ["unknown", "unknown", "local", connected],
    ["darwin", "14.7", "local", connected],
    ["win32", "10.0.26200", "local", { connected: false, tools: [] }],
    ["win32", "10.0.26200", "local", { connected: true, tools: ["exec"] }],
  ] as const)("decides %s %s (%s) the same way as the server", (platform, osVersion, execution, aside) => {
    const helper = hostEligibility({ platform, osVersion, execution, aside })
    const server = isEligibleLocalAside({ probe: "local_companion", execution, platform: platform as never, osVersion, asideConnected: aside.connected, asideTools: [...aside.tools] as never })
    expect(helper.eligible).toBe(server.eligible)
    expect(typeof helper.reason).toBe("string")
    expect(helper.reason.length).toBeGreaterThan(0)
  })

  it("resolves aside.exe in the server's order — the installer's location, then PATH with relative entries skipped", () => {
    const env = { PATH: `.;"C:\\Program Files\\Tools";C:\\Tools`, LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }
    const standard = "C:\\Users\\tester\\AppData\\Local\\Aside\\CLI\\current\\aside.exe"
    const probed: string[] = []
    expect(findAsideExecutable("aside", "win32", env, (path: string) => { probed.push(path); return path === "C:\\Tools\\aside.exe" }, "C:\\Users\\tester")).toBe("C:\\Tools\\aside.exe")
    expect(probed[0]).toBe(standard)
    expect(probed).toContain("C:\\Program Files\\Tools\\aside.exe")
    expect(probed.every((path) => /^[A-Za-z]:\\/.test(path))).toBe(true)
    expect(findAsideExecutable("aside", "win32", env, (path: string) => path === standard || path === "C:\\Tools\\aside.exe", "C:\\Users\\tester")).toBe(standard)
    expect(findAsideExecutable("aside", "win32", env, () => false, "C:\\Users\\tester")).toBeUndefined()
    expect(findAsideExecutable("aside", "darwin", { PATH: ".:/usr/local/bin:/usr/bin" }, (path: string) => path === "/usr/bin/aside", "/Users/tester")).toBe("/usr/bin/aside")
    expect(findAsideExecutable("aside", "darwin", { PATH: "." }, (path: string) => path === "aside", "/Users/tester")).toBeUndefined()
  })

  it("accepts exactly the configured paths the server accepts, on both platforms", () => {
    const candidates = [
      "/Applications/Aside.app/Contents/MacOS/aside", "aside", "C:\\Users\\tester\\aside.exe", "C:/Users/tester/aside.exe",
      "\\\\fileserver\\tools\\aside.exe", "\\Aside\\CLI\\current\\aside.exe", "/Users/tester/aside", "%LOCALAPPDATA%\\Aside\\CLI\\current\\aside.exe", "~\\aside.exe", "",
    ]
    for (const platform of ["darwin", "win32"] as const) {
      for (const candidate of candidates) {
        expect(isAcceptableCommandPath(candidate, platform), `${platform} ${candidate}`).toBe(isAbsoluteCommandPath(candidate, platform))
      }
    }
    // and the standard path ignores relative overrides the same way the server does
    const relative = { LOCALAPPDATA: "AppData\\Local", ASIDE_CLI_INSTALL_DIR: "tools" }
    expect(standardAsideCommand("win32", relative, "C:\\Users\\tester")).toBe(defaultAsideCommandPath("C:\\Users\\tester", "win32", relative))
  })

  // The probe spawns the CLI. These cases must be decided before that, and
  // must produce JSON the agent can read rather than a non-zero exit.
  it.each([
    ["a drive-less Windows path the server would refuse", "\\Aside\\CLI\\current\\aside.exe"],
    ["an unexpanded %LOCALAPPDATA%", "%LOCALAPPDATA%\\Aside\\CLI\\current\\aside.exe"],
    ["a bare name", "aside"],
    ["a relative path", "./aside"],
  ])("refuses %s as --aside-command without spawning anything", (_name, configured) => {
    // Run the real CLI on a simulated supported Windows host. On Linux the
    // host refusal correctly takes precedence over the path error; inheriting
    // the runner's platform would therefore test a different branch in CI.
    const bootstrap = `
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: "win32" });
      os.release = () => "10.0.26200";
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(script)}, "probe", "--aside-command", ${JSON.stringify(configured)}];
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", bootstrap], {
      encoding: "utf8",
      env: { ...process.env, AU_LAW_ASIDE_COMMAND: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined,
        WSL_DISTRO_NAME: undefined, CODESPACES: undefined, REMOTE_CONTAINERS: undefined },
    })
    const probe = JSON.parse(output)
    expect(probe).toMatchObject({ platform: "win32", osVersion: "10.0.26200", execution: "local", eligible: false, asideConnected: false })
    expect(probe.reason).toContain("absolute path")
    expect(probe.asideCommand).toBeUndefined()
  })

  it("answers with JSON, not a crash, when the configured command cannot be started at all", () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-badcli-")); roots.push(root)
    // A file that exists and is absolute, but is not something Node can spawn:
    // on Windows a .cmd without a shell throws synchronously (EINVAL).
    const wrapper = join(root, process.platform === "win32" ? "aside.cmd" : "aside")
    writeFileSync(wrapper, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 9\n", { mode: 0o644 })
    const output = execFileSync(process.execPath, [script, "probe", "--aside-command", wrapper], { encoding: "utf8" })
    const probe = JSON.parse(output)
    expect(probe.eligible).toBe(false)
    expect(probe.asideConnected).toBe(false)
    expect(typeof probe.reason).toBe("string")
  })

  it("reads a JSON payload from --input as UTF-8, for a shell that re-encodes a pipe", () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-input-")); roots.push(root)
    execFileSync(process.execPath, [script, "init", root, "--mode", "missing_sources"])
    const payload = join(root, "plan.json")
    const task = { id: "t1", gapIds: ["g1"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["passage — “§ 18” café ⚖️"], state: "planned" }
    writeFileSync(payload, "\uFEFF" + JSON.stringify({ schemaVersion: "1.0", tasks: [task], gaps: [] }), "utf8")
    const saved = JSON.parse(execFileSync(process.execPath, [script, "save-plan", root, "--input", payload], { encoding: "utf8" }))
    expect(saved).toEqual({ savedTasks: 1, totalTasks: 1 })
    expect(JSON.parse(readFileSync(join(root, ".au-law-followup/checkpoint.json"), "utf8")).tasks[0].expectedEvidence).toEqual(task.expectedEvidence)
  })

  it("dispatches on a Windows-shaped probe exactly as on a Mac, recording the Windows host on the task", async () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-win-")); roots.push(root)
    await initMatter(root, "missing_sources")
    const checkpointPath = join(root, ".au-law-followup/checkpoint.json")
    const initial = JSON.parse(readFileSync(checkpointPath, "utf8"))
    initial.tasks = [{ id: "one", gapIds: ["g1"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["body"], state: "planned" }]
    initial.gaps = [{ id: "g1", sourceAccess: "permitted" }]
    writeFileSync(checkpointPath, JSON.stringify(initial))
    const windowsProbe = async () => ({ eligible: true, reason: "test", platform: "win32", osVersion: "10.0.26200", asideTools: ["repl"] })
    const savedArgv = process.argv
    try {
      process.argv = ["node", "test", "--pages", "1", "--documents", "0"]
      await beginTask(root, "one", false, windowsProbe)
      const state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state.tasks[0]).toEqual(expect.objectContaining({ state: "running", eligibility: expect.objectContaining({ platform: "win32", osVersion: "10.0.26200" }) }))
    } finally { process.argv = savedArgv }
  })
})

describe("companion checkpoints", () => {
  it("has no CLI side effects when imported", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(script).href)})`], { encoding: "utf8" })
    expect(output).toBe("")
  })

  it("persists matter opt-in, budget and honest stop state", () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-")); roots.push(root)
    execFileSync(process.execPath, [script, "init", root, "--mode", "missing_sources"])
    const before = JSON.parse(execFileSync(process.execPath, [script, "status", root], { encoding: "utf8" }))
    expect(before.policy.mode).toBe("missing_sources")
    expect(before.remaining).toEqual({ pages: 10, documents: 3, activeSeconds: 300 })
    execFileSync(process.execPath, [script, "stop", root])
    const stopped = JSON.parse(readFileSync(join(root, ".au-law-followup/checkpoint.json"), "utf8"))
    expect(stopped).toEqual(expect.objectContaining({ stopRequested: true, cancellationVerified: false }))
    expect(stopped.note).toContain("may still be active")
  })

  it("enforces serial lifecycle, idempotent finish, resume, sessions and page budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-life-")); roots.push(root)
    await initMatter(root, "missing_sources")
    const checkpointPath = join(root, ".au-law-followup/checkpoint.json")
    const initial = JSON.parse(readFileSync(checkpointPath, "utf8"))
    initial.tasks = [
      { id: "one", gapIds: ["g1"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["body"], state: "planned" },
      { id: "two", gapIds: ["g2"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["body"], state: "planned" },
    ]
    initial.gaps = [
      { id: "g1", sourceAccess: "permitted" }, { id: "g2", sourceAccess: "permitted" },
    ]
    writeFileSync(checkpointPath, JSON.stringify(initial))
    const fakeProbe = async () => ({ eligible: true, reason: "test", platform: "darwin", osVersion: "15.0", asideTools: ["repl"] })
    const savedArgv = process.argv
    try {
      process.argv = ["node", "test", "--pages", "2", "--documents", "0"]
      await beginTask(root, "one", false, fakeProbe)
      await expect(beginTask(root, "two", false, fakeProbe)).rejects.toThrow("already running")
      await setSession(root, "one", "aside-session-1")
      let running = JSON.parse(readFileSync(checkpointPath, "utf8"))
      running.tasks[0].startedAt = new Date(Date.now() - 2100).toISOString()
      writeFileSync(checkpointPath, JSON.stringify(running))
      process.argv = ["node", "test", "--pages-used", "2", "--documents-used", "0"]
      await markDisconnected(root, "one")
      let state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state.tasks[0]).toEqual(expect.objectContaining({ state: "running", sessionId: "aside-session-1", completionUnverified: true }))
      expect(state.activeElapsedSeconds).toBeGreaterThanOrEqual(2)
      await expect(beginTask(root, "two", false, fakeProbe)).rejects.toThrow("already running")
      process.argv = ["node", "test", "--pages", "0", "--documents", "0", "--session-id", "aside-session-1"]
      await beginTask(root, "one", true, fakeProbe)
      process.argv = ["node", "test", "--state", "unresolved", "--pages-used", "0", "--documents-used", "0"]
      await finishTask(root, "one")
      await finishTask(root, "one")
      state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state.pagesUsed).toBe(2)
      expect(state.tasks[0].sessionId).toBe("aside-session-1")
      process.argv = ["node", "test", "--pages", "1", "--documents", "0", "--session-id", "aside-session-1"]
      await beginTask(root, "one", true, fakeProbe)
      await checkpoint(root, true)
      state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state.tasks[0]).toEqual(expect.objectContaining({ state: "running", sessionId: "aside-session-1" }))
      expect(state).toEqual(expect.objectContaining({ stopRequested: true, cancellationVerified: false }))
      const budgetAtStop = { pagesUsed: state.pagesUsed, activeElapsedSeconds: state.activeElapsedSeconds }
      await resumeMatter(root)
      state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state).toEqual(expect.objectContaining({ stopRequested: false, ...budgetAtStop }))
      expect(state.tasks[0]).toEqual(expect.objectContaining({ state: "running", sessionId: "aside-session-1" }))
      let eligibilityChecks = 0
      process.argv = ["node", "test", "--pages", "0", "--documents", "0", "--session-id", "aside-session-1"]
      await beginTask(root, "one", true, async () => { eligibilityChecks += 1; return fakeProbe() })
      expect(eligibilityChecks).toBe(1)
      state = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(state.tasks[0]).toEqual(expect.objectContaining({ state: "running", sessionId: "aside-session-1" }))
    } finally { process.argv = savedArgv }
  })

  it("enforces policy, platform, access transition and route capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-gates-")); roots.push(root)
    await initMatter(root, "extended")
    const checkpointPath = join(root, ".au-law-followup/checkpoint.json")
    const policyPath = join(root, ".au-law-followup/policy.json")
    const state = JSON.parse(readFileSync(checkpointPath, "utf8"))
    state.tasks = [
      { id: "agent", gapIds: ["ga"], dependsOn: [], action: "search_later_cases", route: "aside_agent", expectedEvidence: ["coverage"], state: "planned" },
      { id: "access", gapIds: ["gx"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["body"], state: "waiting_for_user" },
      { id: "host", gapIds: ["gh"], dependsOn: [], action: "analyze", route: "host_model", expectedEvidence: ["assessment"], state: "planned" },
    ]
    state.gaps = [{ id: "ga", sourceAccess: "permitted" }, { id: "gx", sourceAccess: "requires_access" }, { id: "gh", sourceAccess: "unknown" }]
    writeFileSync(checkpointPath, JSON.stringify(state))
    const replOnly = async () => ({ eligible: true, reason: "test", platform: "darwin", osVersion: "15.0", asideTools: ["repl"] })
    const ineligible = async () => ({ eligible: false, reason: "remote host", platform: "darwin", osVersion: "15.0", asideTools: ["repl"] })
    const savedArgv = process.argv
    try {
      process.argv = ["node", "test"]
      await expect(beginTask(root, "agent", false, replOnly)).rejects.toThrow("requires Aside exec")
      await expect(beginTask(root, "access", false, replOnly)).rejects.toThrow("cannot begin")
      process.argv = ["node", "test", "--access-confirmed", "true", "--pages", "1", "--documents", "0"]
      await beginTask(root, "access", true, replOnly)
      process.argv = ["node", "test", "--state", "unresolved", "--pages-used", "0", "--documents-used", "0"]
      await finishTask(root, "access")
      await expect(beginTask(root, "host", false, ineligible)).rejects.toThrow("Eligibility recheck failed")
      process.argv = ["node", "test"]
      await beginTask(root, "host", false, replOnly)
      let updated = JSON.parse(readFileSync(checkpointPath, "utf8"))
      expect(updated.tasks[2]).toEqual(expect.objectContaining({ state: "running", pagesReserved: 0, documentsReserved: 0 }))
      process.argv = ["node", "test", "--state", "assessed", "--pages-used", "0", "--documents-used", "0"]
      await finishTask(root, "host")
      const policy = JSON.parse(readFileSync(policyPath, "utf8")); policy.mode = "off"; writeFileSync(policyPath, JSON.stringify(policy))
      updated = JSON.parse(readFileSync(checkpointPath, "utf8")); updated.tasks[0].state = "planned"; writeFileSync(checkpointPath, JSON.stringify(updated))
      await expect(beginTask(root, "agent", false, async () => ({ ...await replOnly(), asideTools: ["repl", "exec"] }))).rejects.toThrow("policy is off")
    } finally { process.argv = savedArgv }
  })

  it("applies page and document budgets only to the work that needs them", async () => {
    const root = mkdtempSync(join(tmpdir(), "au-law-followup-budget-")); roots.push(root)
    await initMatter(root, "missing_sources")
    const checkpointPath = join(root, ".au-law-followup/checkpoint.json")
    const state = JSON.parse(readFileSync(checkpointPath, "utf8"))
    state.documentsUsed = 3
    state.tasks = [
      { id: "html", gapIds: ["g-html"], dependsOn: [], action: "read_source", route: "aside_repl", expectedEvidence: ["body"], state: "planned" },
      { id: "pdf", gapIds: ["g-pdf"], dependsOn: [], action: "read_document", route: "aside_repl", expectedEvidence: ["body"], state: "planned" },
    ]
    state.gaps = [{ id: "g-html", sourceAccess: "permitted" }, { id: "g-pdf", sourceAccess: "permitted" }]
    writeFileSync(checkpointPath, JSON.stringify(state))
    const fakeProbe = async () => ({ eligible: true, reason: "test", platform: "darwin", osVersion: "15.0", asideTools: ["repl"] })
    const savedArgv = process.argv
    try {
      process.argv = ["node", "test", "--pages", "1", "--documents", "0"]
      await beginTask(root, "html", false, fakeProbe)
      process.argv = ["node", "test", "--state", "unresolved", "--pages-used", "1", "--documents-used", "0"]
      await finishTask(root, "html")
      process.argv = ["node", "test", "--pages", "1", "--documents", "1"]
      await expect(beginTask(root, "pdf", false, fakeProbe)).rejects.toThrow("budget is exhausted")
      const exhausted = JSON.parse(readFileSync(checkpointPath, "utf8")); exhausted.pagesUsed = 10; exhausted.tasks[0].state = "planned"; writeFileSync(checkpointPath, JSON.stringify(exhausted))
      process.argv = ["node", "test", "--pages", "1", "--documents", "0"]
      await expect(beginTask(root, "html", false, fakeProbe)).rejects.toThrow("budget is exhausted")
    } finally { process.argv = savedArgv }
  })
})
