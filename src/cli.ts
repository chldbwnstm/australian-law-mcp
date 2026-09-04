#!/usr/bin/env node

/**
 * `australian-law` — the natural-language command line.
 *
 * The same tools the MCP server exposes, driven from a shell. Three ways in,
 * in the order people reach for them:
 *
 *   australian-law "what does s 18 of the ACL say"   # routed
 *   australian-law get_law_text --query CCA --provision "s 18"
 *   australian-law                                   # REPL
 *
 * A bare string is a query, not a mistake. Requiring a `query` subcommand for
 * the commonest case is the kind of ceremony that makes a tool feel like it
 * does not want to be used, so anything that is not a registered command name
 * and does not start with `-` is routed.
 *
 * Every tool in the registry gets a subcommand, generated from its Zod schema.
 * Hand-written subcommands would drift from the schemas the moment one gained
 * a parameter, and the drift shows up as a flag that is accepted and ignored.
 */

import { Command } from "commander"
import * as readline from "node:readline"
import { z } from "zod"
import { AuApiClient } from "./lib/api-client.js"
import {
  type CliOption,
  coerceValue,
  extractOptionsFromSchema,
  fmt,
  formatOutput,
  printBanner,
  printInteractiveHelp,
  printToolList,
} from "./lib/cli-format.js"
import {
  executeDirect,
  executeNaturalQuery,
  executeNaturalQueryJson,
  executeTool,
  getApiClient,
  unsupportedParams,
} from "./lib/cli-executor.js"
import { ErrorCodes, LawApiError, formatToolError } from "./lib/errors.js"
import { explainRoute, routeQuery } from "./lib/query-router.js"
import { TOOL_CATEGORIES } from "./lib/tool-profiles.js"
import type { McpTool } from "./lib/types.js"
import { allTools, toMcpInputSchema } from "./tool-registry.js"
import { VERSION } from "./version.js"

const BIN = "australian-law"

/**
 * Categories come from `TOOL_CATEGORIES`, not from a prefix in the tool's
 * description.
 *
 * That table is what `discover_tools` searches, so `list --category "case
 * law"` and `discover_tools("case law")` return the same tools. Filtering on a
 * description prefix instead would give the CLI a second, poorer taxonomy that
 * disagrees with the one the tools themselves advertise.
 */
export function toolsInCategory(wanted: string): McpTool[] {
  const key = wanted.trim().toLowerCase()
  const names = new Set(
    Object.entries(TOOL_CATEGORIES)
      .filter(([category]) => category.toLowerCase().includes(key))
      .flatMap(([, tools]) => tools),
  )
  return allTools.filter((tool) => names.has(tool.name))
}

/** Every category a tool appears in — several tools sit in more than one. */
export function categoriesOf(name: string): string[] {
  return Object.entries(TOOL_CATEGORIES)
    .filter(([, tools]) => tools.includes(name))
    .map(([category]) => category)
}

/**
 * The heading a tool is printed under. Every list in this CLI has to use this
 * one, or the two disagree: `cli-format`'s default categoriser reads a `[...]`
 * prefix off the description, which is the taxonomy this project abandoned, and
 * an Australian tool description has no such prefix — so that default silently
 * files all 81 tools under "Other".
 */
export function headingFor(tool: McpTool): string {
  return categoriesOf(tool.name)[0] ?? "other"
}

/**
 * The parameters one tool advertises, as CLI options.
 *
 * `toMcpInputSchema` is the projection ListTools publishes, and it deletes the
 * fields that are never a caller's parameter: `legal_research.__taskWas` is set
 * by that tool's own preprocess step to explain a correction it made, so a
 * `--__taskWas` flag — which generating from the raw schema produced — makes
 * the answer open with a correction the caller never triggered. The flag set
 * is therefore the projection's, while the descriptions stay the raw schema's:
 * the projection clips those to fit the ListTools context budget, which is a
 * constraint the terminal does not have.
 *
 * A schema the projection cannot read is advertised as accepting anything, so
 * the raw options are the honest fallback rather than no flags at all.
 */
export function cliOptionsFor(tool: McpTool): CliOption[] {
  const options = extractOptionsFromSchema(tool.schema)
  const advertised = (toMcpInputSchema(tool.schema) as { properties?: Record<string, unknown> }).properties
  if (!advertised || Object.keys(advertised).length === 0) return options
  return options.filter((option) => option.name in advertised)
}

/**
 * The `[INVALID_PARAMETER]` answer for parameter names the target tool has no
 * field for, or `undefined` when every key is one it accepts.
 *
 * Zod strips an unknown key in silence, so `--json-input
 * '{"query":"Privacy Act 1988","asAt":"2001-01-01"}'` on get_law_text (whose
 * parameter is `date`) returns the current compilation presented as the law at
 * a date the caller named. `execute_tool` refuses exactly this over MCP
 * (`rejectUnknownParams` in `tools/meta-tools.ts`) and the two direct CLI
 * paths — `--json-input` and the REPL's `@tool {...}` — are the same hazard,
 * so they get the same answer. The flag path cannot reach it: its keys are
 * generated from the schema.
 */
export function unknownParamError(toolName: string, params: Record<string, unknown>): string | undefined {
  const unknown = unsupportedParams(toolName, params)
  if (unknown.length === 0) return undefined

  const tool = allTools.find((entry) => entry.name === toolName)
  const accepted = tool ? cliOptionsFor(tool).map((option) => option.name) : []
  const suggestions = [
    `${toolName} accepts: ${accepted.join(", ")}.`,
    "The value was NOT applied and NOT dropped silently — re-run with a supported name. Do not report the " +
      "result as if this parameter had been honoured.",
  ]
  return formatToolError(
    new LawApiError(
      `${toolName} has no parameter named ${unknown.map((key) => `"${key}"`).join(", ")}.`,
      ErrorCodes.INVALID_PARAM,
      suggestions,
    ),
    toolName,
  ).content[0].text
}

// ──────────────────────────────────────────────────────────────────────────
// REPL
// ──────────────────────────────────────────────────────────────────────────

async function runInteractive(): Promise<void> {
  const apiClient = getApiClient()

  printBanner(allTools.length)
  console.log(fmt.green("  Interactive mode."))
  console.log(fmt.dim("  Ask in plain English. `help` for commands, `exit` to leave."))
  console.log()
  console.log(fmt.dim("  Try:"))
  console.log(fmt.dim("    > what does s 18 of the ACL say"))
  console.log(fmt.dim("    > is [2019] HCA 23 still good law"))
  console.log(fmt.dim("    > what changed in the Privacy Act since 2020"))
  console.log()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.cyan("law> "),
    historySize: 200,
  })

  const history: string[] = []
  // One query at a time. Without this an impatient second line starts a second
  // fan-out against the same upstreams while the first is still running, and
  // the two sets of output interleave into something unreadable.
  let executing = false
  let sigints = 0

  rl.prompt()

  rl.on("line", async (line: string) => {
    const input = line.trim()

    if (!input) {
      rl.prompt()
      return
    }

    if (executing) {
      console.log(fmt.dim("  (still working on the last one)"))
      return
    }

    if (input === "exit" || input === "quit" || input === "q") {
      rl.close()
      return
    }
    if (input === "help" || input === "?") {
      printInteractiveHelp()
      rl.prompt()
      return
    }
    if (input === "history") {
      console.log(fmt.bold("\n  History:"))
      history.forEach((entry, index) => console.log(fmt.dim(`    ${index + 1}. ${entry}`)))
      console.log()
      rl.prompt()
      return
    }
    if (input === "tools" || input === "list") {
      printToolList(allTools, headingFor)
      rl.prompt()
      return
    }
    if (input.startsWith("explain ")) {
      console.log(fmt.dim(explainRoute(input.slice("explain ".length).trim())))
      rl.prompt()
      return
    }

    executing = true
    rl.pause()
    try {
      if (input.startsWith("@")) {
        await handleDirectCall(apiClient, input)
      } else {
        history.push(input)
        console.log()
        await executeNaturalQuery(apiClient, input, {})
      }
    } catch (error) {
      console.error(fmt.red(`  ${error instanceof Error ? error.message : String(error)}`))
    }
    console.log()
    executing = false
    sigints = 0
    rl.resume()
    rl.prompt()
  })

  // Ctrl+C mid-query cancels the prompt, not the request: the upstream call is
  // already in flight and killing the process would leave the result unread.
  // Twice in a row is taken as meaning it.
  rl.on("SIGINT", () => {
    if (!executing) {
      rl.close()
      return
    }
    sigints += 1
    if (sigints >= 2) {
      console.log(fmt.dim("\n  Stopping."))
      process.exit(130)
    }
    console.log(fmt.yellow("\n  (waiting for the current query — Ctrl+C again to force)"))
  })

  rl.on("close", () => {
    console.log(fmt.dim("\n  Bye."))
    process.exit(0)
  })
}

/**
 * Read `@tool_name {"json": true}` or `@tool_name key=value key2=value2`.
 *
 * Exported for the test: the typing of a `key=value` value is the whole
 * behaviour, and it is not observable from the printed output of a tool run.
 */
export function parseDirectCall(input: string): { toolName: string; params: Record<string, unknown> } {
  const space = input.indexOf(" ")
  const toolName = space > 0 ? input.slice(1, space) : input.slice(1)
  const rest = space > 0 ? input.slice(space + 1).trim() : ""

  const params: Record<string, unknown> = {}
  if (!rest) return { toolName, params }

  try {
    return { toolName, params: JSON.parse(rest) as Record<string, unknown> }
  } catch {
    // Not JSON. `key=value` is what people type when the JSON quoting is
    // more trouble than the call is worth — so it has to reach the same
    // schema. Typed from the tool's own parameters, because a bare string for
    // every value means `limit=5` is rejected outright ("expected number,
    // received string") rather than searching.
    const tool = allTools.find((entry) => entry.name === toolName)
    const types = new Map((tool ? cliOptionsFor(tool) : []).map((option) => [option.name, option.type]))
    for (const pair of rest.split(/\s+/)) {
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const key = pair.slice(0, eq)
      params[key] = coerceValue(pair.slice(eq + 1).replace(/^["']|["']$/g, ""), types.get(key) ?? "string")
    }
    return { toolName, params }
  }
}

async function handleDirectCall(apiClient: AuApiClient, input: string): Promise<void> {
  const { toolName, params } = parseDirectCall(input)

  const rejection = unknownParamError(toolName, params)
  if (rejection) {
    console.error(fmt.red(rejection))
    process.exitCode = 1
    return
  }

  await executeDirect(apiClient, toolName, params)
}

// ──────────────────────────────────────────────────────────────────────────
// Program
// ──────────────────────────────────────────────────────────────────────────

/** Exported so a test can inspect the generated surface without running it. */
export function createProgram(): Command {
  const program = new Command()
    .name(BIN)
    .description("Australian law from the command line — legislation, cases and instruments, in plain English.")
    .version(VERSION)

  program
    .command("query <question...>")
    .alias("q")
    .description("Ask in plain English (the default when the first argument is not a command).")
    .option("-v, --verbose", "show the routing decision as well as the answer")
    .option("--json", "emit the route and the result as JSON")
    .action(async (words: string[], opts: { verbose?: boolean; json?: boolean }) => {
      const apiClient = getApiClient()
      const question = words.join(" ")
      if (opts.json) await executeNaturalQueryJson(apiClient, question)
      else await executeNaturalQuery(apiClient, question, { verbose: opts.verbose })
    })

  program
    .command("interactive")
    .alias("i")
    .description("Interactive prompt (also what runs with no arguments).")
    .action(runInteractive)

  program
    .command("explain <question...>")
    .description("Show where a question would be routed, without running anything.")
    .option("--json", "emit the route as JSON")
    .action((words: string[], opts: { json?: boolean }) => {
      const question = words.join(" ")
      // No client is constructed and no tool is called: `explain` answers from
      // the routing table alone, which is what makes it safe to run against a
      // question you are not sure you want to send anywhere.
      console.log(opts.json ? JSON.stringify(routeQuery(question), null, 2) : explainRoute(question))
    })

  program
    .command("list")
    .alias("ls")
    .description("List every tool.")
    .option("-c, --category <category>", `filter by category, e.g. 'case law' (${Object.keys(TOOL_CATEGORIES).length} of them)`)
    .option("--json", "emit as JSON")
    .action((opts: { category?: string; json?: boolean }) => {
      const tools = opts.category ? toolsInCategory(opts.category) : allTools

      if (opts.json) {
        console.log(
          JSON.stringify(
            tools.map((tool) => ({ name: tool.name, category: categoriesOf(tool.name), description: tool.description })),
            null,
            2,
          ),
        )
        return
      }

      if (tools.length === 0) {
        console.error(fmt.red(`No tool category matches "${opts.category}".`))
        console.error(fmt.dim(`Categories: ${Object.keys(TOOL_CATEGORIES).join(", ")}`))
        process.exitCode = 1
        return
      }

      printBanner(allTools.length)
      printToolList(tools, headingFor)
      console.log(fmt.dim(`  Direct call:  ${BIN} <tool> --param value`))
      console.log(fmt.dim(`  Plain English: ${BIN} "what does s 18 of the ACL say"`))
      console.log(fmt.dim(`  Interactive:   ${BIN}`))
      console.log()
    })

  program
    .command("help <tool-name>")
    .description("Parameters and an example for one tool.")
    .action((toolName: string) => {
      const tool = allTools.find((entry) => entry.name === toolName)
      if (!tool) {
        console.error(fmt.red(`No tool named "${toolName}".`))
        console.error(fmt.dim(`Run \`${BIN} list\` to see them all.`))
        process.exitCode = 1
        return
      }

      const options = cliOptionsFor(tool)
      console.log()
      console.log(fmt.bold(tool.name))
      console.log("─".repeat(tool.name.length))
      console.log(tool.description)
      console.log()

      if (options.length > 0) {
        console.log(fmt.bold("Parameters:"))
        for (const option of options) {
          const required = option.required ? fmt.red("(required)") : fmt.dim("(optional)")
          const fallback = option.defaultValue !== undefined ? fmt.dim(` [default: ${String(option.defaultValue)}]`) : ""
          // A boolean is settable both ways, and printing only `--flag` beside
          // `[default: true]` advertises a parameter that cannot be changed.
          const label = option.type === "boolean" ? `--${option.name} / --no-${option.name}` : `--${option.name}`
          console.log(`  ${fmt.cyan(label.padEnd(22))} ${required} ${option.description}${fallback}`)
        }
        console.log()
      }

      const example = options
        .filter((option) => option.required)
        .map((option) => (option.type === "object" ? `--${option.name} '{"key":"value"}'` : `--${option.name} "<value>"`))
        .join(" ")
      console.log(fmt.dim(`Example: ${BIN} ${tool.name} ${example}`))
      console.log()
    })

  // ── one subcommand per tool, generated from its schema ──
  for (const tool of allTools) {
    const command = program.command(tool.name).description(tool.description)
    const options = cliOptionsFor(tool)

    for (const option of options) {
      // Nothing is declared `requiredOption`: commander would reject the call
      // before the schema could, and the schema's message names the parameter
      // and says what it wants. One error path, and it is the better one.
      if (option.type === "boolean") {
        // Both spellings, and no commander default for either. A bare presence
        // flag can only ever set true, so the eight parameters whose schema
        // default is true — `inForceOnly`, `includeMermaid`, … — could not be
        // turned off from the CLI at all, while the same tool over MCP takes
        // false. Leaving the value undefined when neither flag is given lets
        // the schema's default apply, which is where it is written down once.
        command.option(`--${option.name}`, option.description)
        command.option(
          `--no-${option.name}`,
          `set ${option.name} to false${option.defaultValue === true ? " (it defaults to true)" : ""}`,
        )
        continue
      }
      const flag = `--${option.name} <value>`
      if (option.defaultValue !== undefined) command.option(flag, option.description, String(option.defaultValue))
      else command.option(flag, option.description)
    }

    command.option("--json-input <json>", "pass every parameter as one JSON object (wins over the flags)")
    command.option("--json", "emit the raw result as JSON")

    command.action(async (cmdOptions: Record<string, string | boolean>) => {
      const apiClient = new AuApiClient()

      let input: Record<string, unknown> = {}
      const asJson = cmdOptions.json === true
      /** One refusal, in whichever shape the caller asked for. */
      const refuse = (text: string): void => {
        if (asJson) console.log(JSON.stringify({ tool: tool.name, params: input, result: text, isError: true }, null, 2))
        else console.error(fmt.red(text))
        process.exitCode = 1
      }

      const jsonInput = cmdOptions.jsonInput
      if (typeof jsonInput === "string") {
        try {
          input = JSON.parse(jsonInput) as Record<string, unknown>
        } catch (error) {
          console.error(fmt.red(`--json-input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
          process.exitCode = 1
          return
        }
        // Only this path can carry a name the tool has no field for; the flags
        // are generated from its schema. Zod would strip it in silence and the
        // answer would come back looking as though the parameter was honoured.
        const rejection = unknownParamError(tool.name, input)
        if (rejection) {
          refuse(rejection)
          return
        }
      } else {
        for (const option of options) {
          const value = cmdOptions[option.name]
          if (value === undefined) continue
          if (typeof value !== "string") {
            input[option.name] = value
            continue
          }
          try {
            input[option.name] = coerceValue(value, option.type)
          } catch (error) {
            refuse(`--${option.name}: ${error instanceof Error ? error.message : String(error)}`)
            return
          }
        }
      }

      if (asJson) {
        const result = await executeTool(apiClient, tool.name, input)
        console.log(
          JSON.stringify(
            { tool: tool.name, params: input, result: result.content.map((part) => part.text).join("\n"), isError: Boolean(result.isError) },
            null,
            2,
          ),
        )
        if (result.isError) process.exitCode = 1
        return
      }

      try {
        // Validated here so a rejected parameter still gets the message that
        // names it and says what it wants, which is the reason this path did
        // not go through cli-executor in the first place.
        tool.schema.parse(input)
      } catch (error) {
        if (error instanceof z.ZodError) {
          console.error(fmt.red("These parameters are not right:"))
          for (const issue of error.issues) console.error(`  ${issue.path.join(".") || "(input)"}: ${issue.message}`)
          console.error(fmt.dim(`\nRun \`${BIN} help ${tool.name}\` for the full list.`))
        } else {
          console.error(fmt.red(error instanceof Error ? error.message : String(error)))
        }
        process.exitCode = 1
        return
      }

      // The run itself goes through cli-executor, like the `--json` path above:
      // `withRequestBudget` lives there, and the upstream ceilings read the
      // budget out of AsyncLocalStorage through an optional chain. Calling
      // `tool.handler` from here left them all silent no-ops, so the same
      // command with and without `--json` had different upstream limits — one
      // metered, one unbounded.
      const result = await executeTool(apiClient, tool.name, input)
      for (const part of result.content) console.log(formatOutput(part.text))
      if (result.isError) process.exitCode = 1
    })
  }

  return program
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Command names that are not queries. Everything else on argv[2] is one. */
export function knownCommands(toolNames: readonly string[]): Set<string> {
  return new Set(["query", "q", "interactive", "i", "explain", "list", "ls", "help", ...toolNames])
}

/**
 * Pull the flags out of a bare query so `"… " --verbose` works without the
 * words after a flag being eaten as its value.
 */
export function separateFlags(args: readonly string[]): { words: string[]; verbose: boolean; json: boolean } {
  const words: string[] = []
  let verbose = false
  let json = false
  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") verbose = true
    else if (arg === "--json") json = true
    else words.push(arg)
  }
  return { words, verbose, json }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    await runInteractive()
    return
  }

  const commands = knownCommands(allTools.map((tool) => tool.name))
  const first = args[0]

  if (!commands.has(first) && !first.startsWith("-")) {
    const { words, verbose, json } = separateFlags(args)
    const question = words.join(" ")
    if (!question) {
      await runInteractive()
      return
    }
    const apiClient = getApiClient()
    if (json) await executeNaturalQueryJson(apiClient, question)
    else await executeNaturalQuery(apiClient, question, { verbose })
    return
  }

  await createProgram().parseAsync(process.argv)
}

/**
 * Only run when this file is the program.
 *
 * Without the guard, importing anything from here — a test reading
 * `separateFlags`, a script reusing `knownCommands` — starts the REPL and
 * hangs on stdin. The check is on the entry path rather than on
 * `import.meta.url`, because the installed binary is a symlink and its two
 * paths never compare equal.
 */
const ENTRY_IS_CLI = /(?:^|[\\/])(?:cli\.(?:js|ts)|australian-law)$/.test(process.argv[1] ?? "")

if (ENTRY_IS_CLI) {
  main().catch((error) => {
    console.error(fmt.red(error instanceof Error ? error.message : String(error)))
    process.exit(1)
  })
}
