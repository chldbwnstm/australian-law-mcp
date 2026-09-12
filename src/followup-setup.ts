/**
 * Opt-in project-local installation for the macOS Aside companion workflow.
 *
 * This command writes files. That is the whole reason its argument handling is
 * as strict as it is: `--help` is answered before anything is detected,
 * spawned or written; an argument it does not recognise is refused by name
 * rather than ignored while the install runs on its defaults; and the project
 * directory it installs into is never inferred in silence — `--project DIR`,
 * or `--yes` to say out loud that the current directory is meant.
 */
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface FollowupHost { platform: string; osVersion: string; local: boolean }

/**
 * This command's own help. It lives here, next to the code that does the
 * writing, so the list of files cannot drift away from the install it
 * describes — a reader has to be able to predict what running it will do.
 */
export const FOLLOWUP_USAGE = `au-law-mcp setup-followup — opt in to the local macOS Aside companion (preview)

  au-law-mcp setup-followup --project DIR [--client codex|claude-code|both] [--aside-command PATH]
  au-law-mcp setup-followup --yes [...]      install into the current directory
  au-law-mcp setup-followup --help

Options:
  --project DIR         the project folder to install into. The default is the
                        current directory, but because this command writes files
                        the default is never taken in silence: with no --project
                        you must pass --yes.
  --client WHICH        codex, claude-code or both. Default: both.
  --aside-command PATH  absolute path to the Aside executable, as shown in Aside's
                        Developer settings. Default: the first "aside" on PATH.
                        The path is recorded for desktop processes with a
                        restricted PATH.
  --yes, -y             accept the current directory as the project folder.
  --help, -h            print this and exit 0. Nothing is read, written or spawned.

An unrecognised flag is an error, not a no-op: "--dry-run" and "--projekt ./x"
stop the command instead of installing with the defaults.

What an install writes, all of it inside the project folder:
  .au-law-followup-host.json          always. The Aside executable path, mode 0600
  .mcp.json                           --client claude-code or both. Adds an "aside"
                                      MCP entry if there is not one already; every
                                      other server and setting is kept
  .claude/skills/au-law-followup/     --client claude-code or both. The companion
                                      skill, overwritten if it is already there
  .codex/config.toml                  --client codex or both. Appends an
                                      [mcp_servers.aside] table if absent; the rest
                                      of the file is kept
  .agents/skills/au-law-followup/     --client codex or both. The companion skill,
                                      overwritten if it is already there

Nothing outside the project folder is touched: no home directory, no global client
config. An eligible host is local macOS 15.0 or later; anything else is refused,
and the core law server is unaffected either way.

Afterwards: restart the client, then run the au-law-followup skill's probe before
first use.`

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

const CLIENTS = ["codex", "claude-code", "both"] as const
const VALUE_FLAGS = ["--client", "--project", "--aside-command"] as const

export interface FollowupOptions {
  client: (typeof CLIENTS)[number]
  /** Undefined means "not named"; it is not the same as the current directory. */
  project: string | undefined
  asideCommand: string
  /** The caller said the current directory is the project they meant. */
  acceptCurrentDirectory: boolean
}

/**
 * Read the command line, or refuse it.
 *
 * Every rejection here happens before a single byte is written. The failures it
 * closes all used to look identical from the outside — the install ran with
 * `--client both` into `$PWD`: an unknown flag was ignored (`--dry-run`), a
 * misspelled one was ignored (`--projekt ./x`), and a flag with nothing behind
 * it silently fell back to its default (`--project --client codex` resolved a
 * directory literally named "--client").
 */
export function parseFollowupArgs(args: readonly string[]): FollowupOptions {
  const hint = 'Run "au-law-mcp setup-followup --help" for the flags it accepts. Nothing was written.'
  const values = new Map<string, string>()
  let acceptCurrentDirectory = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === "--yes" || token === "-y") {
      acceptCurrentDirectory = true
      continue
    }
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("-")) throw new Error(`${token} needs a value. ${hint}`)
      values.set(token, value)
      index += 1
      continue
    }
    const kind = token.startsWith("-") ? "Unknown option" : "Unexpected argument"
    throw new Error(`${kind} ${JSON.stringify(token)} for "au-law-mcp setup-followup". ${hint}`)
  }

  const client = values.get("--client") ?? "both"
  if (!(CLIENTS as readonly string[]).includes(client)) {
    throw new Error(`--client must be codex, claude-code or both, not ${JSON.stringify(client)}. Nothing was written.`)
  }

  return {
    client: client as FollowupOptions["client"],
    project: values.get("--project"),
    asideCommand: values.get("--aside-command") ?? "aside",
    acceptCurrentDirectory,
  }
}

function findExecutable(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) return resolve(name)
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function runFollowupSetup(
  args: string[],
  hostOverride?: FollowupHost,
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): Promise<void> {
  // First statement in the function, deliberately: asking what this command
  // does must not detect a host, spawn sw_vers, or write anything. It is also
  // answered on a host that is not eligible — the answer is documentation.
  if (args.includes("--help") || args.includes("-h")) {
    write(FOLLOWUP_USAGE + "\n")
    return
  }

  const options = parseFollowupArgs(args)

  const host: FollowupHost = hostOverride ?? {
    platform: platform(),
    osVersion: platform() === "darwin" ? spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim() : "unknown",
    local: !(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.WSL_DISTRO_NAME || process.env.CODESPACES || process.env.REMOTE_CONTAINERS),
  }
  const eligibility = followupHostEligibility(host)
  if (!eligibility.eligible) throw new Error(eligibility.reason)

  // The directory this installs into is stated, never assumed. The default is
  // still the current directory, but taking it requires --yes: an installer
  // run from the wrong prompt used to leave .mcp.json, a skill tree and a host
  // record in a directory nobody chose.
  if (options.project === undefined && !options.acceptCurrentDirectory) {
    throw new Error(
      `setup-followup installs into a project folder and none was named. Re-run with --project ${process.cwd()} to install there, ` +
        "--project DIR for somewhere else, or --yes to accept the current directory. Nothing was written.",
    )
  }
  const project = resolve(options.project ?? process.cwd())
  const client = options.client

  const asideCommand = findExecutable(options.asideCommand)
  if (!asideCommand || !existsSync(asideCommand)) {
    throw new Error(`Aside executable not found (${options.asideCommand}). Pass the path shown in Aside Developer settings with --aside-command.`)
  }
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
  write(`Installed the project-local Aside companion for ${client} into ${project}. Restart the client, then run the au-law-followup skill's probe before first use.\n`)
}
