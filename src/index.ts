#!/usr/bin/env node

/**
 * Australian Law MCP server — process entry point.
 *
 * Two transports, one registry: stdio (the default, what an MCP client spawns)
 * and stateless Streamable HTTP (`--mode http`, what a container runs).
 *
 * The one rule that governs this file: **on the stdio path, stdout belongs to
 * the JSON-RPC framing**. A single stray `console.log` from anywhere in the
 * dependency tree corrupts the stream and the client reports a protocol error
 * that points nowhere near its cause, so the console writers are rebound to
 * stderr before the transport is connected.
 *
 * The second rule, learned from a user who lost a directory to it: **an
 * argument that asks a question never performs an action, and an argument this
 * file does not recognise is never dropped on the floor.** The subcommand
 * dispatch used to run before the `--help` check, so `setup-followup --help`
 * reached the installer, which took its defaults (`--client both`,
 * `--project $PWD`) and wrote config and skill files into whatever directory
 * the user was standing in. Help and version are therefore answered for every
 * subcommand first, and anything unknown exits non-zero instead of being
 * ignored while the command runs with its defaults.
 *
 * There is no API key to configure. Every upstream source is a keyless public
 * endpoint; the per-request key in the HTTP transport exists so a future keyed
 * source needs no transport change.
 */

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { AuApiClient } from "./lib/api-client.js"
import { readExecutionLimits, type ExecutionLimits } from "./lib/execution-limits.js"
import { parseHttpPort } from "./server/http-config.js"
import { startHTTPServer } from "./server/http-server.js"
import { registerTools } from "./tool-registry.js"
import { VERSION } from "./version.js"

/** One client per process: it holds the per-host politeness clock. */
const apiClient = new AuApiClient()

/**
 * HTTP mode builds a fresh server per request (stateless), so this has to stay
 * a factory rather than a singleton.
 */
function createServer(executionLimits: ExecutionLimits = readExecutionLimits()): Server {
  const server = new Server({ name: "australian-law", version: VERSION }, { capabilities: { tools: {} } })
  registerTools(server, apiClient, executionLimits)
  return server
}

const USAGE = `au-law-mcp ${VERSION}

  au-law-mcp                              start on stdio (what an MCP client spawns)
  au-law-mcp --mode http [--port 8000]
                                          start the stateless Streamable HTTP server
  au-law-mcp setup [--npx]                register this server in your MCP client configs
  au-law-mcp setup-followup [--client codex|claude-code|both] [--project DIR] [--aside-command PATH]
                                          opt in to the local macOS Aside companion
  au-law-mcp --version | --help

Options:
  --mode stdio|http   transport to start. Default: stdio. "sse" is accepted as a
                      legacy spelling of http.
  --port N            port for --mode http. Default: 8000, or $PORT.
  --help, -h          print help and exit 0 without doing anything else. It works
                      after a subcommand too, and prints that subcommand's own
                      help: "au-law-mcp setup-followup --help" lists the files
                      that command would write, and writes none of them.
  --version, -v       print the version and exit 0. Also works after a subcommand.

An unrecognised command, flag or value is an error: nothing runs on a typo.

HTTP mode binds 127.0.0.1 by default. A non-loopback MCP_HTTP_HOST requires
MCP_AUTH_TOKEN (or an explicit MCP_ALLOW_UNAUTHENTICATED_REMOTE=1). See
.env.example for the full environment.`

const SETUP_USAGE = `au-law-mcp setup — register this server in your MCP client configs

  au-law-mcp setup [--npx]

It lists the MCP clients it can find on this machine, asks which of them to
register (press Enter to choose none), and merges an "australian-law" entry
into each config file you pick, keeping every other server and setting in that
file. Nothing is written until you choose a client, and there is no API key
step — every source this server reads is keyless.

The entry it writes launches this build by absolute path, which is verified on
disk first. --npx asks for "npx -y au-law-mcp" instead; it is honoured only if
the registry actually serves that package, and falls back to the absolute path
with a note if it does not.

Config files it can write on this machine, if you select them:`

/** The two subcommands. A first argument that is not one of these is a typo. */
const SUBCOMMANDS = new Set(["setup", "setup-followup"])

const HELP_FLAGS = new Set(["--help", "-h"])
const VERSION_FLAGS = new Set(["--version", "-v"])

/** Flags the bare binary takes a value for. Everything else is rejected. */
const TOP_LEVEL_VALUE_FLAGS = ["--mode", "--port"] as const

/**
 * Parse `--flag value` pairs for one command and reject everything else.
 *
 * Two silent failures this closes, both of which used to end with the command
 * running anyway on its defaults: an unknown flag (`--prot 9000`, `--dry-run`)
 * was ignored, and a flag with nothing behind it (`--mode`) fell back to the
 * default as though it had never been typed — so a mistyped transport started
 * stdio and said nothing about it. A negative number is still a value; only
 * another flag, or the end of the line, counts as missing.
 */
export function parseOptions(args: readonly string[], command: string, valueFlags: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  const hint = `Run "${command} --help". Nothing was run.`

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (valueFlags.includes(token)) {
      const value = args[index + 1]
      if (value === undefined || (value.startsWith("-") && !/^-\d/.test(value))) {
        throw new Error(`${token} needs a value. ${hint}`)
      }
      values.set(token, value)
      index += 1
      continue
    }
    const kind = token.startsWith("-") ? "Unknown option" : "Unexpected argument"
    throw new Error(`${kind} ${JSON.stringify(token)} for "${command}". ${hint}`)
  }

  return values
}

/**
 * The help text for the command that was actually typed.
 *
 * `setup-followup`'s help lives beside the code that writes the files, so the
 * list of what it writes cannot drift from what it does, and the client paths
 * in `setup`'s help are read from the same detector the wizard uses rather
 * than copied here — a second copy is a second thing to go stale.
 */
async function usageFor(subcommand: string | undefined): Promise<string> {
  if (subcommand === "setup") {
    const { detectClients } = await import("./setup.js")
    const clients = detectClients().map((client) => `  ${client.name.padEnd(28)} ${client.configPath}`)
    return `${SETUP_USAGE}\n${clients.join("\n")}`
  }
  if (subcommand === "setup-followup") {
    const { FOLLOWUP_USAGE } = await import("./followup-setup.js")
    return FOLLOWUP_USAGE
  }
  return USAGE
}

async function runStdio(): Promise<void> {
  // Rebind before anything else can write: a diagnostic on stdout is a
  // corrupted MCP frame, and the client's error will not name this line.
  const toStderr = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(" ") + "\n")
  console.log = console.warn = console.info = console.debug = toStderr

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // The client normally closes the pipe; a signal is the operator doing it by
  // hand, and an in-flight tool call should still get to finish its response.
  const shutdown = (signal: string) => {
    console.error(`${signal} received, shutting down.`)
    const forceExit = setTimeout(() => process.exit(0), 5_000)
    forceExit.unref()
    server
      .close()
      .catch(() => {})
      .finally(() => process.exit(0))
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

export async function main(
  args: string[] = process.argv.slice(2),
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): Promise<void> {
  const subcommand = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : undefined
  const rest = subcommand === undefined ? args : args.slice(1)

  // Answered before anything dispatches, for every subcommand. `setup` opens an
  // interactive wizard and `setup-followup` writes into a project directory;
  // neither may run because someone asked what they do.
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    write((await usageFor(subcommand)) + "\n")
    return
  }
  if (args.some((arg) => VERSION_FLAGS.has(arg))) {
    write(VERSION + "\n")
    return
  }

  if (subcommand !== undefined && !SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Unknown command ${JSON.stringify(subcommand)}. Nothing was run.\n\n${USAGE}`)
  }

  if (subcommand === "setup") {
    // The wizard takes no flags; one passed here was meant for another command.
    parseOptions(rest, "au-law-mcp setup", [])
    const { runSetup } = await import("./setup.js")
    await runSetup()
    return
  }
  if (subcommand === "setup-followup") {
    // It parses and validates its own flags: it is the one that knows which of
    // them name a directory it is about to write into.
    const { runFollowupSetup } = await import("./followup-setup.js")
    await runFollowupSetup(rest, undefined, write)
    return
  }

  const options = parseOptions(rest, "au-law-mcp", TOP_LEVEL_VALUE_FLAGS)

  // `sse` is accepted as a legacy spelling of the HTTP transport: existing
  // container CMDs and process managers pass it, and silently starting stdio
  // instead would look like a server that boots and never answers.
  const mode = options.get("--mode") ?? "stdio"
  if (mode !== "stdio" && mode !== "http" && mode !== "sse") {
    throw new Error(`Unknown --mode ${JSON.stringify(mode)}. Use "stdio" or "http".`)
  }

  if (mode === "stdio") {
    await runStdio()
    return
  }

  // Validated here rather than at bind time, so a bad port fails before the
  // process reports itself as started.
  await startHTTPServer(createServer, parseHttpPort(options.get("--port")))
}

/**
 * True when this module is what the process was started to run.
 *
 * npm installs the `au-law-mcp` bin as a symlink into `node_modules/.bin`, so
 * `process.argv[1]` is the link rather than this file: both sides are resolved
 * through the filesystem, or the installed binary would load cleanly and then
 * do nothing at all.
 */
export function isEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  return real(fileURLToPath(moduleUrl)) === real(entryPath)
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    // A usage mistake is the caller's line, not a server fault: print the
    // message as written and leave a non-zero status behind it.
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
