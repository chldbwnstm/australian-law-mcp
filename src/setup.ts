/**
 * Interactive setup wizard — `au-law-mcp setup`.
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
 *
 * **The wizard never writes a launch command it has not verified.** A command
 * the client cannot resolve fails with "server disconnected", an error that
 * names nothing the user can act on, and the config file it came from looks
 * correct. So the one thing written here is established by execution:
 * `process.execPath` (the Node running this wizard) plus the built
 * `index.js` this wizard is itself running from, checked with `existsSync`
 * immediately before it is written. See `resolveLaunchCommand`.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, join, posix, win32 } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"

/** The key this server is registered under, in every client. */
export const SERVER_KEY = "australian-law"

/** The npm package that would provide the `au-law-mcp` binary once published. */
const PACKAGE_NAME = "au-law-mcp"

/** Abbreviated packument endpoint — what `npx -y au-law-mcp` has to find. */
const REGISTRY_PACKAGE_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`

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

// ── the launch command ─────────────────────────────────────────────────────

/** What the client will spawn. `command` is absolute unless it is `npx`. */
export interface LaunchCommand {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * The outcome of establishing a launch command. `launch` is absent when
 * nothing could be verified, and the wizard then writes no config at all: a
 * config file naming a command that does not resolve is worse than no config,
 * because the failure surfaces later, inside the client, as "server
 * disconnected".
 */
export interface LaunchPlan {
  readonly launch?: LaunchCommand
  readonly form: "absolute" | "npx" | "unverified"
  /** What was actually checked. Printed verbatim, so the user sees the evidence. */
  readonly note: string
}

/** Asks whether the npm registry serves `au-law-mcp`. Injected in tests. */
export type RegistryProbe = () => Promise<boolean>

export interface LaunchOptions {
  /** Set by `au-law-mcp setup --npx`. Only a *request*: the registry decides. */
  readonly allowNpx?: boolean
  /** This module's URL. A parameter so tests can point it at a fixture layout. */
  readonly moduleUrl?: string
  /** The Node that will spawn the server. `process.execPath` is absolute by definition. */
  readonly execPath?: string
  readonly registryProbe?: RegistryProbe
}

/**
 * The built entry point this wizard is itself running from, or `undefined`.
 *
 * `au-law-mcp setup` runs out of `build/`, so `index.js` is this module's
 * sibling; the second candidate covers a source checkout driven through a
 * TypeScript loader, where this module is `src/setup.ts` and the build sits
 * one directory up. Every candidate is checked against the filesystem before
 * it is returned — an unchecked path is precisely the defect this exists to
 * prevent.
 */
export function resolveEntryPoint(moduleUrl: string = import.meta.url): string | undefined {
  const here = dirname(fileURLToPath(moduleUrl))
  for (const candidate of [join(here, "index.js"), join(here, "..", "build", "index.js")]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Does `npx -y au-law-mcp` have anything to fetch? Only the registry can say,
 * so ask it. As at 2026-09-12 `registry.npmjs.org/au-law-mcp` answers **404**:
 * nothing has been published under that name, so the npx form resolves nothing.
 */
export const probeRegistry: RegistryProbe = async () => {
  try {
    const response = await fetch(REGISTRY_PACKAGE_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    // No network, a proxy, a timeout: none of them establish that the package
    // is there, and "not established" is not "present".
    return false
  }
}

/**
 * Establish a launch command, or return none.
 *
 * The absolute form is the default because it is the only one this process can
 * prove: it is running from that file. `npx -y au-law-mcp` is written only when
 * the caller asks for it *and* the registry answers for the package — an
 * installed-from-registry directory layout is not evidence on its own
 * (`npm install ./au-law-mcp-1.0.0.tgz` and `npm link` produce the same
 * `node_modules/au-law-mcp/` layout without anything being published), so the
 * layout is not consulted at all.
 *
 * One consequence is named rather than hidden: once the package *is* published
 * and someone runs this wizard through `npx`, the entry point it is running
 * from sits in npm's `_npx` cache, which npm is free to evict, so the absolute
 * path would work when written and break later. `--npx` is the escape hatch for
 * that case, and it too is checked against the registry before it is written.
 */
export async function resolveLaunchCommand(options: LaunchOptions = {}): Promise<LaunchPlan> {
  const { allowNpx = false, moduleUrl, execPath = process.execPath, registryProbe = probeRegistry } = options

  let npxNote = ""
  if (allowNpx) {
    if (await registryProbe()) {
      return {
        launch: { command: "npx", args: ["-y", PACKAGE_NAME] },
        form: "npx",
        note: `${REGISTRY_PACKAGE_URL} answered: the registry serves ${PACKAGE_NAME}.`,
      }
    }
    npxNote = ` (--npx was ignored: ${REGISTRY_PACKAGE_URL} did not serve ${PACKAGE_NAME}, so npx would resolve nothing)`
  }

  const entryPoint = resolveEntryPoint(moduleUrl)
  if (entryPoint) {
    return {
      launch: { command: execPath, args: [entryPoint] },
      form: "absolute",
      note: `verified on disk: ${entryPoint}${npxNote}`,
    }
  }

  return {
    form: "unverified",
    note: `no built entry point beside this wizard — run \`npm run build\` in the checkout, then setup again${npxNote}`,
  }
}

// ── config entries ─────────────────────────────────────────────────────────

/** The `mcpServers` / `servers` shape, built from a verified launch command. */
export function buildServerEntry(launch: LaunchCommand): Record<string, unknown> {
  return { command: launch.command, args: [...launch.args] }
}

/** Zed nests the launch command one level deeper under `context_servers`. */
export function buildZedEntry(launch: LaunchCommand): Record<string, unknown> {
  return { command: { path: launch.command, args: [...launch.args] } }
}

export function entryFor(format: ClientConfig["format"], launch: LaunchCommand): Record<string, unknown> {
  return format === "context_servers" ? buildZedEntry(launch) : buildServerEntry(launch)
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
export function mergeEntry(
  config: Record<string, unknown>,
  format: ClientConfig["format"],
  launch: LaunchCommand,
): Record<string, unknown> {
  const existing = (config[format] ?? {}) as Record<string, unknown>
  return { ...config, [format]: { ...existing, [SERVER_KEY]: entryFor(format, launch) } }
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

function printManualConfig(launch: LaunchCommand): void {
  console.log()
  console.log(`  ${c.dim}Add this to the "mcpServers" object of your client's config file:${c.reset}`)
  console.log()
  console.log(`  ${c.cyan}"${SERVER_KEY}"${c.reset}: ${JSON.stringify(buildServerEntry(launch), null, 4)}`)
  console.log()
}

function printNoLaunchCommand(note: string): void {
  console.log(`  ${c.red}${c.bold}Nothing was written.${c.reset} ${c.white}No launch command could be verified.${c.reset}`)
  console.log(`  ${c.dim}${note}${c.reset}`)
  console.log()
  console.log(`  ${c.dim}A config naming a command that does not resolve fails inside the client${c.reset}`)
  console.log(`  ${c.dim}as "server disconnected", which names nothing you can act on.${c.reset}`)
  console.log()
}

// ── wizard ─────────────────────────────────────────────────────────────────

/**
 * `--npx` asks for the `npx -y au-law-mcp` form. It is honoured only if the
 * registry serves the package when setup runs; otherwise the absolute path is
 * written and the terminal says why.
 */
export async function runSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout })

  try {
    banner()

    stepHeader(1, 3, "No API key required")
    console.log(`  ${c.dim}Every source this server reads is a keyless public endpoint — the${c.reset}`)
    console.log(`  ${c.dim}Federal Register of Legislation, the State and Territory registers,${c.reset}`)
    console.log(`  ${c.dim}the courts and tribunals, the ATO and DFAT. Nothing to sign up for.${c.reset}`)
    console.log()

    stepHeader(2, 3, "Launch command")
    const plan = await resolveLaunchCommand({ allowNpx: argv.includes("--npx") })
    if (!plan.launch) {
      printNoLaunchCommand(plan.note)
      return
    }
    console.log(`  ${c.white}${plan.launch.command} ${plan.launch.args.join(" ")}${c.reset}`)
    console.log(`  ${c.dim}${plan.note}${c.reset}`)
    console.log()

    stepHeader(3, 3, "Choose your MCP clients")
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
      printManualConfig(plan.launch)
      return
    }

    console.log()
    let written = 0
    for (const index of new Set(indices)) {
      const client = clients[index]
      try {
        const config = await readJsonFile(client.configPath)
        await writeJsonFile(client.configPath, mergeEntry(config, client.format, plan.launch))
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
      printManualConfig(plan.launch)
    }
    console.log()
  } finally {
    rl.close()
  }
}
