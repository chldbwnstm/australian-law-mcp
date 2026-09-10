/** Opt-in project-local installation for the macOS Aside companion workflow. */
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface FollowupHost { platform: string; osVersion: string; local: boolean }

export function followupHostEligibility(host: FollowupHost): { eligible: boolean; reason: string } {
  if (!host.local) return { eligible: false, reason: "Aside follow-up cannot be installed for a remote client execution host." }
  if (host.platform !== "darwin") return { eligible: false, reason: "Aside follow-up is currently supported only on local macOS 15+. Standard law-server setup is unchanged." }
  const match = /^(\d+)(?:\.\d+){0,2}$/.exec(host.osVersion)
  const major = match ? Number(match[1]) : NaN
  if (!Number.isFinite(major) || major < 15) return { eligible: false, reason: "Aside follow-up requires macOS 15.0 or later." }
  return { eligible: true, reason: "Eligible local macOS host." }
}

export function mergeClaudeAside(config: Record<string, unknown>, asideCommand: string): Record<string, unknown> {
  if (config.mcpServers !== undefined && (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers))) {
    throw new Error("Existing mcpServers must be a JSON object; the config was not changed.")
  }
  const existing = (config.mcpServers ?? {}) as Record<string, unknown>
  if (existing.aside) return config
  return { ...config, mcpServers: { ...existing, aside: { command: asideCommand, args: ["mcp", "--host", "local"] } } }
}

/** Append only when absent: existing commands, enabled_tools and permission settings win. */
export function mergeCodexAside(toml: string, asideCommand: string): string {
  const existingAside = /^\s*\[\s*(?:mcp_servers|["']mcp_servers["'])\s*\.\s*(?:aside|["']aside["'])\s*\]\s*(?:#.*)?$/m
  if (existingAside.test(toml) || /^\s*mcp_servers(?:\.aside)?\s*=.*\baside\b/m.test(toml)) return toml
  const escaped = asideCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const prefix = toml.length && !toml.endsWith("\n") ? `${toml}\n` : toml
  return `${prefix}\n[mcp_servers.aside]\ncommand = "${escaped}"\nargs = ["mcp", "--host", "local"]\nenabled_tools = ["repl", "exec"]\ntool_timeout_sec = 150\n`
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function findExecutable(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) return resolve(name)
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function runFollowupSetup(args: string[] = process.argv.slice(3), hostOverride?: FollowupHost): Promise<void> {
  const host: FollowupHost = hostOverride ?? {
    platform: platform(),
    osVersion: platform() === "darwin" ? spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim() : "unknown",
    local: !(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WSL_DISTRO_NAME || process.env.CODESPACES || process.env.REMOTE_CONTAINERS),
  }
  const eligibility = followupHostEligibility(host)
  if (!eligibility.eligible) throw new Error(eligibility.reason)

  const project = resolve(flag(args, "--project") ?? process.cwd())
  const client = flag(args, "--client") ?? "both"
  if (!["codex", "claude-code", "both"].includes(client)) throw new Error("--client must be codex, claude-code or both")
  const requestedAside = flag(args, "--aside-command") ?? "aside"
  const asideCommand = findExecutable(requestedAside)
  if (!asideCommand || !existsSync(asideCommand)) throw new Error(`Aside executable not found (${requestedAside}). Pass the path shown in Aside Developer settings with --aside-command.`)
  const sourceSkill = resolve(dirname(fileURLToPath(import.meta.url)), "../companion/au-law-followup")
  if (!existsSync(sourceSkill)) throw new Error("The packaged companion skill is missing. Reinstall au-law-mcp from a complete package.")

  if (client === "claude-code" || client === "both") {
    const configPath = join(project, ".mcp.json")
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(mergeClaudeAside(await readJson(configPath), asideCommand), null, 2)}\n`, "utf8")
    await cp(sourceSkill, join(project, ".claude/skills/au-law-followup"), { recursive: true, force: true })
  }
  if (client === "codex" || client === "both") {
    const configPath = join(project, ".codex/config.toml")
    await mkdir(dirname(configPath), { recursive: true })
    const current = existsSync(configPath) ? await readFile(configPath, "utf8") : ""
    await writeFile(configPath, mergeCodexAside(current, asideCommand), "utf8")
    await cp(sourceSkill, join(project, ".agents/skills/au-law-followup"), { recursive: true, force: true })
  }
  await writeFile(join(project, ".au-law-followup-host.json"), `${JSON.stringify({ schemaVersion: "1.0", asideCommand }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  process.stdout.write(`Installed the project-local Aside companion for ${client}. Restart the client, then run the au-law-followup skill's probe before first use.\n`)
}
