#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const VERSION = "1.0"
const STATE_DIR = ".au-law-followup"
const MAX_STDIN = 64 * 1024

function die(message) { process.stderr.write(`${message}\n`); process.exitCode = 1 }
function json(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }
function executable(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
}
function localExecution() {
  return !(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WSL_DISTRO_NAME || process.env.CODESPACES || process.env.REMOTE_CONTAINERS)
}
function osVersion() {
  if (process.platform !== "darwin") return process.release?.name ?? "unknown"
  return spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 3000 }).stdout.trim() || "unknown"
}
function safeMatter(value) {
  const folder = resolve(value)
  if (!isAbsolute(folder) || folder === "/" || folder === homedir() || dirname(folder) === folder) throw new Error("Choose a dedicated matter folder, not the filesystem or home root.")
  return folder
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temp, path)
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")) }
async function stdinJson() {
  let body = ""
  for await (const chunk of process.stdin) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_STDIN) throw new Error(`stdin exceeds ${MAX_STDIN} bytes`)
  }
  return JSON.parse(body)
}

async function asideProbe(command) {
  return new Promise((resolveProbe) => {
    const child = spawn(command, ["mcp", "--host", "local"], { stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => finish({ connected: false, tools: [], reason: "Aside MCP handshake timed out" }), 12000)
    timer.unref?.()
    let finished = false
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.kill()
      resolveProbe(result)
    }
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)
        }
        if (message.id === 2) {
          const tools = (message.result?.tools ?? []).map((tool) => tool.name).filter((name) => ["repl", "exec", "memory_search"].includes(name))
          const schemas = Object.fromEntries((message.result?.tools ?? []).filter((tool) => tools.includes(tool.name)).map((tool) => [tool.name, tool.inputSchema]))
          finish({ connected: true, tools, schemas })
        }
      } catch { finish({ connected: false, tools: [], reason: "Aside MCP emitted invalid JSON" }) }
    })
    child.on("error", (error) => finish({ connected: false, tools: [], reason: error.message }))
    child.on("exit", (code) => { if (!finished) finish({ connected: false, tools: [], reason: `Aside MCP exited with code ${code}` }) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "au-law-followup-probe", version: VERSION } } })}\n`)
  })
}

async function buildProbe() {
  const platform = ["darwin", "win32", "linux"].includes(process.platform) ? process.platform : "unknown"
  const execution = localExecution() ? "local" : "remote"
  const version = osVersion()
  let configured
  const commandIndex = process.argv.indexOf("--aside-command")
  if (commandIndex >= 0) configured = process.argv[commandIndex + 1]
  if (!configured && process.env.AU_LAW_ASIDE_COMMAND) configured = process.env.AU_LAW_ASIDE_COMMAND
  if (!configured && existsSync(resolve(".au-law-followup-host.json"))) configured = (await readJson(resolve(".au-law-followup-host.json"))).asideCommand
  const asideCommand = configured ? resolve(configured) : executable("aside")
  const aside = platform === "darwin" && execution === "local" && asideCommand && existsSync(asideCommand) ? await asideProbe(asideCommand) : { connected: false, tools: [], reason: "Aside was not probed on an ineligible or unavailable host" }
  const versionMatch = /^(\d+)(?:\.\d+){0,2}$/.exec(version)
  const major = versionMatch ? Number(versionMatch[1]) : NaN
  const eligible = platform === "darwin" && execution === "local" && major >= 15 && aside.connected && aside.tools.includes("repl")
  return { schemaVersion: VERSION, probe: "local_companion", execution, platform, osVersion: version, asideConnected: aside.connected, asideTools: aside.tools, eligible, reason: eligible ? "Local macOS 15+ and Aside repl confirmed" : aside.reason ?? "Local platform or required Aside capability is ineligible", asideCommand, asideSchemas: aside.schemas }
}
async function probe() { json(await buildProbe()) }

export async function initMatter(folder, mode) {
  const root = safeMatter(folder)
  if (!["missing_sources", "extended"].includes(mode)) throw new Error("mode must be missing_sources or extended")
  const state = join(root, STATE_DIR)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const limits = mode === "extended" ? { maxPages: 30, maxDocuments: 10, maxElapsedSeconds: 900 } : { maxPages: 10, maxDocuments: 3, maxElapsedSeconds: 300 }
  const policyPath = join(state, "policy.json")
  if (!existsSync(policyPath)) await atomic(policyPath, { schemaVersion: VERSION, mode, browser: "aside", ...limits, useAuthorizedAccounts: false, optedInAt: new Date().toISOString() })
  if (!existsSync(join(state, "checkpoint.json"))) await atomic(join(state, "checkpoint.json"), { schemaVersion: VERSION, stopRequested: false, pagesUsed: 0, documentsUsed: 0, activeElapsedSeconds: 0, tasks: [], updatedAt: new Date().toISOString() })
  if (!existsSync(join(state, "evidence.jsonl"))) await writeFile(join(state, "evidence.jsonl"), "", { mode: 0o600 })
  if (!existsSync(join(state, "assessments.jsonl"))) await writeFile(join(state, "assessments.jsonl"), "", { mode: 0o600 })
  json({ matterFolder: root, stateFolder: state, policy: await readJson(policyPath) })
}

export async function matterStatus(folder) {
  const root = safeMatter(folder), state = join(root, STATE_DIR)
  const policy = await readJson(join(state, "policy.json")), checkpoint = await readJson(join(state, "checkpoint.json"))
  const remaining = { pages: Math.max(0, policy.maxPages - checkpoint.pagesUsed), documents: Math.max(0, policy.maxDocuments - checkpoint.documentsUsed), activeSeconds: Math.max(0, policy.maxElapsedSeconds - checkpoint.activeElapsedSeconds) }
  json({ policy, checkpoint, remaining, mayDispatch: !checkpoint.stopRequested && remaining.pages > 0 && remaining.activeSeconds > 0 })
}

async function setPolicy(folder) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "policy.json"), policy = await readJson(path)
  const mode = option("--mode") ?? policy.mode
  if (!["off", "missing_sources", "extended"].includes(mode)) throw new Error("--mode must be off, missing_sources or extended")
  const accountValue = option("--use-authorized-accounts")
  if (accountValue !== undefined && !["true", "false"].includes(accountValue)) throw new Error("--use-authorized-accounts must be true or false")
  const next = { ...policy, mode, ...(accountValue !== undefined ? { useAuthorizedAccounts: accountValue === "true" } : {}), updatedAt: new Date().toISOString() }
  await atomic(path, next); json(next)
}

async function savePlan(folder) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "checkpoint.json")
  const checkpoint = await readJson(path), incoming = await stdinJson()
  const envelope = incoming.followup ?? incoming.structuredContent?.followup ?? incoming
  if (envelope.schemaVersion !== VERSION || !Array.isArray(envelope.tasks)) throw new Error("Expected a version 1.0 follow-up envelope containing tasks")
  const byId = new Map((checkpoint.tasks ?? []).map((task) => [task.id, task]))
  for (const task of envelope.tasks) if (!byId.has(task.id)) byId.set(task.id, task)
  const oldGaps = checkpoint.gaps ?? [], gapMap = new Map(oldGaps.map((gap) => [gap.id, gap]))
  for (const gap of envelope.gaps ?? []) gapMap.set(gap.id, gap)
  await atomic(path, { ...checkpoint, tasks: [...byId.values()], gaps: [...gapMap.values()], omittedGapCount: (checkpoint.omittedGapCount ?? 0) + (envelope.omittedGapCount ?? 0), updatedAt: new Date().toISOString() })
  json({ savedTasks: envelope.tasks.length, totalTasks: byId.size })
}

export async function recordEvidence(folder) {
  const root = safeMatter(folder), state = join(root, STATE_DIR), item = await stdinJson()
  for (const key of ["taskId", "requestedUrl", "finalUrl", "sourcePublisher", "observedTitle", "retrievedAt", "extractionMethod", "coverage", "acquisition"]) if (item[key] === undefined) throw new Error(`Evidence item is missing ${key}`)
  if (item.acquisition !== "host_or_aside_supplied") throw new Error("Evidence acquisition must be labelled host_or_aside_supplied")
  await appendFile(join(state, "evidence.jsonl"), `${JSON.stringify(item)}\n`, "utf8")
  const path = join(state, "checkpoint.json"), checkpoint = await readJson(path)
  await atomic(path, { ...checkpoint, updatedAt: new Date().toISOString() })
  json({ recorded: true, taskId: item.taskId })
}

export async function checkpoint(folder, stopRequested = false) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "checkpoint.json"), value = await readJson(path)
  const next = { ...value, stopRequested: stopRequested || value.stopRequested, ...(stopRequested ? { stopRequestedAt: new Date().toISOString(), cancellationVerified: false, note: "No new tasks will be scheduled. Any running Aside exec may still be active." } : {}), updatedAt: new Date().toISOString() }
  await atomic(path, next); json(next)
}

/** Clear a user stop only through an explicit command; never dispatch work here. */
export async function resumeMatter(folder) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "checkpoint.json"), value = await readJson(path)
  if (!value.stopRequested) { json({ resumed: false, alreadyActive: true, checkpoint: value }); return }
  const { stopRequestedAt, cancellationVerified, note, ...rest } = value
  const resumedAt = new Date().toISOString()
  const next = {
    ...rest,
    stopRequested: false,
    resumedAt,
    lastStop: { stopRequestedAt, cancellationVerified, note },
    updatedAt: resumedAt,
  }
  await atomic(path, next)
  json({ resumed: true, autoDispatched: false, checkpoint: next, instruction: "Run resume-task for the same running task; it will recheck local eligibility before any browser call." })
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function beginTask(folder, taskId, resume = false, probeFn = buildProbe) {
  const root = safeMatter(folder), state = join(root, STATE_DIR), path = join(state, "checkpoint.json")
  const policy = await readJson(join(state, "policy.json")), checkpoint = await readJson(path)
  if (policy.mode === "off") throw new Error("Follow-up policy is off for this matter.")
  if (checkpoint.stopRequested) throw new Error("This matter is stopped; no new Aside work may be scheduled.")
  const tasks = checkpoint.tasks ?? [], index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) throw new Error(`No planned task ${taskId}`)
  const task = tasks[index]
  const usesAside = task.route === "aside_repl" || task.route === "aside_agent"
  const probeResult = await probeFn()
  if (!probeResult.eligible) throw new Error(`Eligibility recheck failed: ${probeResult.reason}`)
  const requiredCapability = task.route === "aside_agent" ? "exec" : task.route === "aside_repl" ? "repl" : undefined
  if (requiredCapability && !probeResult.asideTools.includes(requiredCapability)) throw new Error(`The selected ${task.route} route requires Aside ${requiredCapability}, which is not available.`)
  const anotherRunning = tasks.find((candidate) => candidate.id !== taskId && candidate.state === "running")
  if (anotherRunning) throw new Error(`Task ${anotherRunning.id} is already running; Aside work is serial for this matter.`)
  if (task.state === "running" && !resume) { json({ dispatchAllowed: false, alreadyRunning: true, task, reason: "Do not duplicate this dispatch." }); return }
  if (!resume && task.state !== "planned") throw new Error(`Task ${taskId} cannot begin from state ${task.state}`)
  if (resume && !["running", "unresolved", "waiting_for_user"].includes(task.state)) throw new Error(`Task ${taskId} is not resumable from state ${task.state}`)
  const gap = (checkpoint.gaps ?? []).find((candidate) => task.gapIds.includes(candidate.id))
  if (usesAside && gap?.sourceAccess === "requires_access" && !policy.useAuthorizedAccounts && option("--access-confirmed") !== "true") throw new Error("This source requires an access decision. Re-run with --access-confirmed true only after the user has authorised the account/access condition for this matter.")
  if (usesAside && gap?.sourceAccess === "unknown" && option("--access-confirmed") !== "true") throw new Error("Source access conditions are unknown. Confirm they permit this research before dispatch.")
  const pagesReserved = Number(option("--pages") ?? (usesAside ? 1 : 0)), documentsReserved = Number(option("--documents") ?? (task.action === "read_document" ? 1 : 0))
  if (!Number.isInteger(pagesReserved) || pagesReserved < 0 || !Number.isInteger(documentsReserved) || documentsReserved < 0) throw new Error("--pages and --documents must be non-negative integers")
  const otherReservations = tasks.filter((candidate) => candidate.id !== taskId && candidate.state === "running").reduce((sum, candidate) => ({ pages: sum.pages + (candidate.pagesReserved ?? 0), documents: sum.documents + (candidate.documentsReserved ?? 0) }), { pages: 0, documents: 0 })
  let activeElapsedSeconds = checkpoint.activeElapsedSeconds
  if (resume && task.state === "running" && task.startedAt) activeElapsedSeconds += Math.max(0, Math.ceil((Date.now() - Date.parse(task.startedAt)) / 1000))
  if (checkpoint.pagesUsed + otherReservations.pages + pagesReserved > policy.maxPages || checkpoint.documentsUsed + otherReservations.documents + documentsReserved > policy.maxDocuments || activeElapsedSeconds >= policy.maxElapsedSeconds) throw new Error("Matter budget is exhausted; checkpoint the task as unresolved.")
  const startedAt = new Date().toISOString()
  const sessionId = option("--session-id") ?? task.sessionId
  const updated = { ...task, state: "running", startedAt, pagesReserved, documentsReserved, ...(sessionId ? { sessionId } : {}), ...(usesAside ? { eligibility: { checkedAt: startedAt, platform: probeResult.platform, osVersion: probeResult.osVersion, asideTools: probeResult.asideTools } } : {}), completionUnverified: false }
  tasks[index] = updated
  await atomic(path, { ...checkpoint, tasks, activeElapsedSeconds, updatedAt: startedAt })
  json({ dispatchAllowed: true, resume, task: updated, policy, probe: probeResult })
}

export async function finishTask(folder, taskId) {
  const root = safeMatter(folder), state = join(root, STATE_DIR), path = join(state, "checkpoint.json")
  const checkpoint = await readJson(path), policy = await readJson(join(state, "policy.json")), tasks = checkpoint.tasks ?? []
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) throw new Error(`No task ${taskId}`)
  const task = tasks[index], nextState = option("--state") ?? "unresolved"
  if (task.state !== "running") { json({ task, alreadyFinished: true, charged: false }); return }
  if (!["waiting_for_user", "evidence_collected", "assessed", "unresolved"].includes(nextState)) throw new Error("finish state must be waiting_for_user, evidence_collected, assessed or unresolved")
  const started = Date.parse(task.startedAt ?? ""), elapsed = Number.isFinite(started) ? Math.max(0, Math.ceil((Date.now() - started) / 1000)) : 0
  const activeElapsedSeconds = Math.min(policy.maxElapsedSeconds, checkpoint.activeElapsedSeconds + elapsed)
  const sessionId = option("--session-id") ?? task.sessionId
  const { pagesReserved: _pagesReserved, documentsReserved: _documentsReserved, ...settledTask } = task
  const pagesUsed = Number(option("--pages-used") ?? task.pagesReserved ?? 0)
  const documentsUsed = Number(option("--documents-used") ?? task.documentsReserved ?? 0)
  if (!Number.isInteger(pagesUsed) || pagesUsed < 0 || !Number.isInteger(documentsUsed) || documentsUsed < 0) throw new Error("--pages-used and --documents-used must be non-negative integers")
  tasks[index] = { ...settledTask, state: nextState, finishedAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...(nextState === "waiting_for_user" ? { waitingStartedAt: new Date().toISOString() } : {}) }
  await atomic(path, { ...checkpoint, tasks, pagesUsed: checkpoint.pagesUsed + pagesUsed, documentsUsed: checkpoint.documentsUsed + documentsUsed, activeElapsedSeconds, updatedAt: new Date().toISOString() })
  json({ task: tasks[index], activeElapsedSeconds, budgetExhausted: activeElapsedSeconds >= policy.maxElapsedSeconds })
}

export async function setSession(folder, taskId, sessionId) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "checkpoint.json"), checkpoint = await readJson(path), tasks = checkpoint.tasks ?? []
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0 || tasks[index].state !== "running") throw new Error(`Task ${taskId} is not running`)
  tasks[index] = { ...tasks[index], sessionId, sessionRecordedAt: new Date().toISOString() }
  await atomic(path, { ...checkpoint, tasks, updatedAt: new Date().toISOString() })
  json({ task: tasks[index], saved: true })
}

/** Preserve serial ownership when an exec connection ends without a terminal result. */
export async function markDisconnected(folder, taskId) {
  const root = safeMatter(folder), state = join(root, STATE_DIR), path = join(state, "checkpoint.json")
  const checkpoint = await readJson(path), policy = await readJson(join(state, "policy.json")), tasks = checkpoint.tasks ?? []
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0 || tasks[index].state !== "running") throw new Error(`Task ${taskId} is not running`)
  const task = tasks[index], started = Date.parse(task.startedAt ?? "")
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.ceil((Date.now() - started) / 1000)) : 0
  const pagesUsed = Number(option("--pages-used") ?? 0), documentsUsed = Number(option("--documents-used") ?? 0)
  if (!Number.isInteger(pagesUsed) || pagesUsed < 0 || !Number.isInteger(documentsUsed) || documentsUsed < 0) throw new Error("--pages-used and --documents-used must be non-negative integers")
  const { startedAt: _startedAt, pagesReserved: _pagesReserved, documentsReserved: _documentsReserved, ...rest } = task
  tasks[index] = { ...rest, state: "running", completionUnverified: true, disconnectedAt: new Date().toISOString() }
  const next = { ...checkpoint, tasks, pagesUsed: checkpoint.pagesUsed + pagesUsed, documentsUsed: checkpoint.documentsUsed + documentsUsed, activeElapsedSeconds: Math.min(policy.maxElapsedSeconds, checkpoint.activeElapsedSeconds + elapsed), updatedAt: new Date().toISOString() }
  await atomic(path, next)
  json({ task: tasks[index], serialOwnershipRetained: true, charged: { pages: pagesUsed, documents: documentsUsed, activeSeconds: elapsed }, instruction: "Resume this same task and recheck its saved exec session before any other Aside dispatch." })
}

/** Persist host reasoning separately from acquired browser evidence. */
export async function recordAssessment(folder) {
  const root = safeMatter(folder), state = join(root, STATE_DIR), item = await stdinJson()
  for (const key of ["taskId", "assessedAt", "summary", "analysis", "uncertainties", "sourceUrls"]) if (item[key] === undefined) throw new Error(`Assessment is missing ${key}`)
  if (!Array.isArray(item.uncertainties) || !Array.isArray(item.sourceUrls)) throw new Error("Assessment uncertainties and sourceUrls must be arrays")
  const checkpoint = await readJson(join(state, "checkpoint.json"))
  const task = (checkpoint.tasks ?? []).find((candidate) => candidate.id === item.taskId)
  if (!task || task.route !== "host_model") throw new Error("Assessment task must exist and use the host_model route")
  await appendFile(join(state, "assessments.jsonl"), `${JSON.stringify({ schemaVersion: VERSION, ...item, interpretation: "host_model" })}\n`, "utf8")
  json({ recorded: true, taskId: item.taskId, semanticUncertaintyRetained: true })
}

async function reconcile(folder, taskId) {
  const root = safeMatter(folder), path = join(root, STATE_DIR, "checkpoint.json"), checkpoint = await readJson(path), result = await stdinJson()
  const envelope = result.followup ?? result.structuredContent?.followup ?? result
  if (envelope.schemaVersion !== VERSION || !Array.isArray(envelope.gaps)) throw new Error("Expected checker follow-up envelope version 1.0")
  const tasks = checkpoint.tasks ?? [], index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) throw new Error(`No task ${taskId}`)
  const remaining = envelope.gaps, resolvedIds = new Set(tasks[index].gapIds)
  const gapMap = new Map((checkpoint.gaps ?? []).filter((gap) => !resolvedIds.has(gap.id)).map((gap) => [gap.id, gap]))
  for (const gap of remaining) gapMap.set(gap.id, gap)
  tasks[index] = { ...tasks[index], state: envelope.pending === false && remaining.length === 0 ? "assessed" : "unresolved", assessedAt: new Date().toISOString() }
  await atomic(path, { ...checkpoint, tasks, gaps: [...gapMap.values()], updatedAt: new Date().toISOString() })
  json({ task: tasks[index], remainingGaps: remaining.length })
}

const [command, folder, ...rest] = process.argv.slice(2)
// Node canonicalises an ESM module URL even when argv retains a directory
// symlink (notably macOS /var -> /private/var), so compare real paths.
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (isMainModule()) try {
  if (command === "probe") await probe()
  else if (command === "init" && folder) await initMatter(folder, rest.includes("--mode") ? rest[rest.indexOf("--mode") + 1] : "missing_sources")
  else if (command === "status" && folder) await matterStatus(folder)
  else if (command === "set-policy" && folder) await setPolicy(folder)
  else if (command === "save-plan" && folder) await savePlan(folder)
  else if (command === "record-evidence" && folder) await recordEvidence(folder)
  else if (command === "record-assessment" && folder) await recordAssessment(folder)
  else if (command === "checkpoint" && folder) await checkpoint(folder)
  else if (command === "stop" && folder) await checkpoint(folder, true)
  else if (command === "resume-matter" && folder) await resumeMatter(folder)
  else if (command === "begin-task" && folder && rest[0]) await beginTask(folder, rest[0], false)
  else if (command === "resume-task" && folder && rest[0]) await beginTask(folder, rest[0], true)
  else if (command === "finish-task" && folder && rest[0]) await finishTask(folder, rest[0])
  else if (command === "set-session" && folder && rest[0] && rest[1]) await setSession(folder, rest[0], rest[1])
  else if (command === "mark-disconnected" && folder && rest[0]) await markDisconnected(folder, rest[0])
  else if (command === "reconcile" && folder && rest[0]) await reconcile(folder, rest[0])
  else die("Usage: followup.mjs probe [--aside-command PATH] | init <matter> [--mode missing_sources|extended] | status|set-policy|save-plan|record-evidence|record-assessment|checkpoint|stop|resume-matter <matter> | begin-task|resume-task|finish-task|set-session|mark-disconnected|reconcile <matter> <task-id> [options]")
} catch (error) { die(error instanceof Error ? error.message : String(error)) }
