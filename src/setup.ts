/**
 * Interactive setup wizard — `australian-law-mcp setup`.
 *
 * It registers this server in the MCP client configuration files that are
 * already on the machine. There is **no API key step**: every Australian source
 * this server reads (the Federal Register, the State registers, the courts and
 * tribunals, the ATO, DFAT) is a keyless public endpoint, so the only thing to
 * write is the launch command.
 *
 * Three client config shapes exist in the wild and all three are written here:
 * `mcpServers` (Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI),
 * `servers` (VS Code) and `context_servers` (Zed, which nests the command).
 * An existing file is read, merged and rewritten rather than replaced — these
 * files hold the user's other servers, and clobbering them to add one entry is
 * a worse failure than not installing at all.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, posix, win32 } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

/** The key this server is registered under, in every client. */
export const SERVER_KEY = "australian-law"

/** The npm package that provides the `australian-law-mcp` binary. */
const PACKAGE_NAME = "australian-law-mcp"

export interface ClientConfig {
  readonly name: string
  readonly configPath: string
  readonly format: "mcpServers" | "servers" | "context_servers"
}

export function detectClients(home = homedir(), os = platform(), cwd = process.cwd()): readonly ClientConfig[] {
  const clients: ClientConfig[] = []

  // Paths follow the *target* platform named by `os`, not the host running
  // this process: the parameter exists so tests can probe every client shape
  // from any machine, and host-flavoured resolve() turned "/Users/x" into
  // "C:\Users\x" the first time the suite ran on Windows.
  const resolve = os === "win32" ? win32.resolve : posix.resolve

  const claudeDesktopPaths: Record<string, string> = {
    darwin: resolve(home, "Library/Application Support/Claude/claude_desktop_config.json"),
    win32: resolve(process.env.APPDATA ?? resolve(home, "AppData/Roaming"), "Claude/claude_desktop_config.json"),
    linux: resolve(home, ".config/Claude/claude_desktop_config.json"),
  }
  const claudeDesktop = claudeDesktopPaths[os]
  if (claudeDesktop) clients.push({ name: "Claude Desktop", configPath: claudeDesktop, format: "mcpServers" })

  clients.push({ name: "Claude Code (this directory)", configPath: resolve(cwd, ".mcp.json"), format: "mcpServers" })
  clients.push({ name: "Cursor", configPath: resolve(home, ".cursor/mcp.json"), format: "mcpServers" })
  clients.push({ name: "VS Code (this directory)", configPath: resolve(cwd, ".vscode/mcp.json"), format: "servers" })
  clients.push({ name: "Windsurf", configPath: resolve(home, ".codeium/windsurf/mcp_config.json"), format: "mcpServers" })
  clients.push({ name: "Gemini CLI", configPath: resolve(home, ".gemini/settings.json"), format: "mcpServers" })

  const zedPaths: Record<string, string> = {
    darwin: resolve(home, ".zed/settings.json"),
    linux: resolve(home, ".config/zed/settings.json"),
    win32: resolve(home, ".zed/settings.json"),
  }
  const zed = zedPaths[os]
  if (zed) clients.push({ name: "Zed", configPath: zed, format: "context_servers" })

  return clients
}

/**
 * `npx -y` rather than a bare `australian-law-mcp`: the wizard runs before any
 * global install exists, and a command that is not on the client's PATH fails
 * with "server disconnected" rather than anything a user can act on.
 */
export function buildServerEntry(): Record<string, unknown> {
  return { command: "npx", args: ["-y", PACKAGE_NAME] }
}

/** Zed nests the launch command one level deeper under `context_servers`. */
export function buildZedEntry(): Record<string, unknown> {
  return { command: { path: "npx", args: ["-y", PACKAGE_NAME] } }
}

export function entryFor(format: ClientConfig["format"]): Record<string, unknown> {
  return format === "context_servers" ? buildZedEntry() : buildServerEntry()
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  const raw = await readFile(path, "utf-8")
  // An unparseable config is not ours to repair: overwriting it would discard
  // whatever the user already had in there.
  return JSON.parse(raw) as Record<string, unknown>
}

async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  const dir = dirname(path)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  // No secret is written (there is no API key), so the file keeps whatever
  // permissions the client gave it — silently tightening a user's existing
  // config to 0600 would be a surprise with nothing to protect.
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

/** Merge our entry into one config file, preserving every other server in it. */
export function mergeEntry(config: Record<string, unknown>, format: ClientConfig["format"]): Record<string, unknown> {
  const existing = (config[format] ?? {}) as Record<string, unknown>
  return { ...config, [format]: { ...existing, [SERVER_KEY]: entryFor(format) } }
}

// ── terminal output (no dependencies) ──────────────────────────────────────

const ESC = "\x1b["
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
} as const

function banner(): void {
  console.log()
  console.log(`  ${c.cyan}${c.bold}Australian Law MCP${c.reset} ${c.dim}— setup${c.reset}`)
  console.log(`  ${c.dim}Commonwealth, State and Territory law from keyless public sources.${c.reset}`)
  console.log(`  ${c.cyan}${"─".repeat(58)}${c.reset}`)
  console.log()
}

function stepHeader(step: number, total: number, title: string): void {
  console.log(`  ${c.cyan}${c.bold}[${step}/${total}]${c.reset} ${c.white}${c.bold}${title}${c.reset}`)
  console.log()
}

function printManualConfig(): void {
  console.log()
  console.log(`  ${c.dim}Add this to the "mcpServers" object of your client's config file:${c.reset}`)
  console.log()
  console.log(`  ${c.cyan}"${SERVER_KEY}"${c.reset}: ${JSON.stringify(buildServerEntry(), null, 4)}`)
  console.log()
}

// ── wizard ─────────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })

  try {
    banner()

    stepHeader(1, 2, "No API key required")
    console.log(`  ${c.dim}Every source this server reads is a keyless public endpoint — the${c.reset}`)
    console.log(`  ${c.dim}Federal Register of Legislation, the State and Territory registers,${c.reset}`)
    console.log(`  ${c.dim}the courts and tribunals, the ATO and DFAT. Nothing to sign up for.${c.reset}`)
    console.log()

    stepHeader(2, 2, "Choose your MCP clients")
    const clients = detectClients()
    clients.forEach((client, index) => {
      const badge = existsSync(client.configPath) ? `${c.green} [detected]${c.reset}` : ""
      console.log(`  ${c.cyan}${String(index + 1).padStart(2)}${c.reset}) ${c.white}${client.name}${c.reset}${badge}`)
      console.log(`      ${c.dim}${client.configPath}${c.reset}`)
    })
    console.log()

    const answer = (await rl.question(`  ${c.cyan}>${c.reset} Numbers (e.g. 1,3), or Enter to skip: `)).trim()
    const indices = answer
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < clients.length)

    if (indices.length === 0) {
      console.log(`\n  ${c.yellow}Nothing selected${c.reset} — manual configuration:`)
      printManualConfig()
      return
    }

    console.log()
    let written = 0
    for (const index of new Set(indices)) {
      const client = clients[index]
      try {
        const config = await readJsonFile(client.configPath)
        await writeJsonFile(client.configPath, mergeEntry(config, client.format))
        console.log(`  ${c.green}${c.bold}+${c.reset} ${c.white}${client.name}${c.reset} ${c.dim}${client.configPath}${c.reset}`)
        written += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`  ${c.red}${c.bold}x${c.reset} ${c.white}${client.name}${c.reset} ${c.dim}${message}${c.reset}`)
      }
    }

    console.log()
    if (written > 0) {
      console.log(`  ${c.green}${c.bold}Done.${c.reset} Restart the client and "${SERVER_KEY}" will be available.`)
    } else {
      console.log(`  ${c.yellow}No config file was written.${c.reset} Manual configuration:`)
      printManualConfig()
    }
    console.log()
  } finally {
    rl.close()
  }
}
