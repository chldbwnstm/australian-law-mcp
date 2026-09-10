import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { config as loadEnvironment } from "dotenv"
import { loadConfig } from "./config.js"
import { GitHubClient, issueHash } from "./github.js"
import { FileStore } from "./state.js"
import { Pipeline } from "./engine.js"
import { DockerWorker } from "./sandbox.js"
import { GitWorkspaces } from "./workspace.js"

export function parseArguments(args: string[]) {
  const result = { config: "automation/config.example.json", dryRun: false, offline: false, once: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1] && !args[i + 1].startsWith("--")) result.config = args[++i]
    else if (args[i] === "--dry-run") result.dryRun = true
    else if (args[i] === "--offline") result.offline = true
    else if (args[i] === "--once") result.once = true
    else throw new Error("Unknown or incomplete argument: " + args[i])
  }
  if (result.offline && !result.dryRun) throw new Error("--offline requires --dry-run")
  return result
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(args)
  const config = loadConfig(resolve(options.config))
  if (options.dryRun) {
    const report: Record<string, unknown> = {
      mode: options.offline ? "offline-dry-run" : "read-only-dry-run",
      configValid: true, repository: config.owner + "/" + config.repo,
      stages: ["grok", "maintainer-approval", "fable", "opus", "draft-pr", "ci-and-coderabbit", "ready-label"],
      maxAttempts: config.maxAttempts, maxWorkerCalls: config.maxWorkerCalls,
      requiredChecks: config.requiredChecks, codeRabbit: config.codeRabbit,
      effects: { githubWrites: 0, workers: 0, worktrees: 0, journalWrites: 0 },
    }
    if (!options.offline) {
      loadEnvironment({ path: process.env.AUTOMATION_ENV_FILE ?? "automation/.env", quiet: true })
      const github = new GitHubClient(config, process.env.AUTOMATION_GITHUB_TOKEN ?? "", true)
      report.candidates = (await github.candidates()).map(i => ({ number: i.number, inputHash: issueHash(i), action: "Would triage; approval is not inferred in dry-run" }))
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return
  }
  if (!config.enabled) throw new Error("Live automation is disabled in configuration")
  if (process.platform !== "linux" || !process.getuid || process.getuid() === 0) {
    throw new Error("Live automation requires a dedicated non-root Linux account")
  }
  const major = Number(process.versions.node.split(".")[0])
  if (major < 22) throw new Error("The daemon requires Node 22 or newer; use a supported LTS")
  loadEnvironment({ path: process.env.AUTOMATION_ENV_FILE ?? "automation/.env", quiet: true })
  const token = process.env.AUTOMATION_GITHUB_TOKEN ?? ""
  const github = new GitHubClient(config, token)
  const store = new FileStore(config.stateDir)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  store.acquire()
  try {
    const pipeline = new Pipeline(config, github, store, new DockerWorker(config), new GitWorkspaces(config, token),
      undefined, controller.signal)
    do {
      try { await pipeline.tick() }
      catch {
        if (options.once) throw new Error("Polling failed; inspect configuration, GitHub access, and journal availability")
        process.stderr.write("Polling failed; no new work will start until the next poll.\n")
      }
      if (options.once || controller.signal.aborted) break
      await sleep(config.pollSeconds * 1000, undefined, { signal: controller.signal }).catch(() => {})
    } while (!controller.signal.aborted)
  } finally {
    store.release()
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Configuration diagnostics contain paths/options, never environment values.
    process.stderr.write((error instanceof Error ? error.message : "Automation failed") + "\n")
    process.exitCode = 1
  })
}
