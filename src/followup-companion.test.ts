import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { beginTask, checkpoint, finishTask, initMatter, markDisconnected, resumeMatter, setSession } from "../companion/au-law-followup/scripts/followup.mjs"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const script = resolve("companion/au-law-followup/scripts/followup.mjs")

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
