/**
 * The command-line surface.
 *
 * Nothing is executed here — the assertions are about what exists and how
 * argv is read. Two of them matter more than they look:
 *
 *  - importing this module must not start the REPL, or every test that
 *    touches it hangs on stdin;
 *  - every tool must have a subcommand, because the subcommands are generated
 *    from the registry and a tool that stops appearing is a capability that
 *    silently left the CLI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  categoriesOf,
  cliOptionsFor,
  createProgram,
  headingFor,
  knownCommands,
  parseDirectCall,
  separateFlags,
  toolsInCategory,
  unknownParamError,
} from "./cli.js"
import { allTools } from "./tool-registry.js"
import { extractOptionsFromSchema } from "./lib/cli-format.js"
import { requestContext } from "./lib/session-state.js"
import type { AuApiClient } from "./lib/api-client.js"

describe("importing the CLI does not run it", () => {
  it("reached this test, which means no REPL was started", () => {
    // The entry guard compares process.argv[1] against the CLI's own name.
    // Under a test runner it is the runner's path, so `main()` never fires.
    expect(typeof createProgram).toBe("function")
  })
})

describe("generated subcommands", () => {
  const program = createProgram()
  const names = new Set(program.commands.map((command) => command.name()))

  it("registers one subcommand per tool", () => {
    for (const tool of allTools) {
      expect([tool.name, names.has(tool.name)]).toEqual([tool.name, true])
    }
  })

  it("covers the whole registry, not a hand-picked subset", () => {
    const toolCommands = program.commands.filter((command) => allTools.some((tool) => tool.name === command.name()))
    expect(toolCommands).toHaveLength(allTools.length)
  })

  it("registers the fixed commands as well", () => {
    for (const name of ["query", "interactive", "explain", "list", "help"]) {
      expect([name, names.has(name)]).toEqual([name, true])
    }
  })

  it("gives every tool command --json-input and --json", () => {
    for (const tool of allTools) {
      const command = program.commands.find((entry) => entry.name() === tool.name)!
      const flags = command.options.map((option) => option.long)
      expect([tool.name, flags.includes("--json-input")]).toEqual([tool.name, true])
      expect([tool.name, flags.includes("--json")]).toEqual([tool.name, true])
    }
  })

  it("turns each advertised schema field into a flag", () => {
    // Spot-checked on the tools whose parameters the corpus exercises, rather
    // than all eighty: the generation is one loop, so a few prove it runs.
    for (const name of ["get_law_text", "search_decisions", "cite_check", "legal_research"]) {
      const tool = allTools.find((entry) => entry.name === name)!
      const command = createProgram().commands.find((entry) => entry.name() === name)!
      const flags = new Set(command.options.map((option) => option.long))
      for (const option of cliOptionsFor(tool)) {
        expect([name, option.name, flags.has(`--${option.name}`)]).toEqual([name, option.name, true])
      }
    }
  })

  it("offers no flag for an internal field the advertised schema deletes", () => {
    // `__taskWas` is set by legal_research's own preprocess step to explain a
    // correction it made. Generated from the raw schema it became a flag, and
    // `--__taskWas foo` made the answer open with a correction of a task the
    // caller never supplied.
    const research = allTools.find((entry) => entry.name === "legal_research")!
    const raw = extractOptionsFromSchema(research.schema).map((option) => option.name)
    expect(raw, "the raw schema is still the one with the internal field").toContain("__taskWas")

    expect(cliOptionsFor(research).map((option) => option.name)).not.toContain("__taskWas")
    const command = createProgram().commands.find((entry) => entry.name() === "legal_research")!
    expect(command.options.map((option) => option.long)).not.toContain("--__taskWas")
  })

  it("gives a boolean parameter both spellings, so it can be turned off", () => {
    const command = createProgram().commands.find((entry) => entry.name() === "suggest_law_names")!
    const flags = command.options.map((option) => option.long)
    expect(flags).toContain("--inForceOnly")
    expect(flags).toContain("--no-inForceOnly")
  })

  it("declares no parameter as commander-mandatory", () => {
    // The schema rejects a missing parameter with a message that names it and
    // says what it wants; commander would refuse first, with a worse one.
    // (`option.required` is commander's flag for "takes a value" — the one
    // that means "must be supplied" is `mandatory`.)
    for (const tool of allTools) {
      const command = program.commands.find((entry) => entry.name() === tool.name)!
      for (const option of command.options) {
        expect([tool.name, option.long, option.mandatory]).toEqual([tool.name, option.long, false])
      }
    }
  })
})

describe("list --category", () => {
  it("uses the same taxonomy discover_tools searches", () => {
    // Not the `[Prefix]` heuristic in cli-format: that reads Australian tool
    // descriptions as "Other" and "chain", two buckets, which is not a
    // taxonomy. TOOL_CATEGORIES is the table the tools themselves advertise.
    const names = toolsInCategory("case law").map((tool) => tool.name)
    expect(names).toContain("search_cases")
    expect(names).toContain("get_case_text")
    expect(names).not.toContain("get_law_text")
  })

  it("matches on a partial category name", () => {
    expect(toolsInCategory("tax").map((tool) => tool.name)).toContain("search_rulings")
  })

  it("returns nothing for a category that does not exist, rather than everything", () => {
    expect(toolsInCategory("zzz")).toEqual([])
  })

  // The filter used TOOL_CATEGORIES while the *headings* still came from
  // cli-format's default `[Prefix]` reader, so `list --category "case law"`
  // returned the right six tools and printed them all under "── Other ──".
  it("prints the heading from the same table it filters on", () => {
    expect(headingFor(allTools.find((tool) => tool.name === "search_cases")!)).toBe("case law")
    expect(headingFor(allTools.find((tool) => tool.name === "search_rulings")!)).toBe("tax and rulings")
  })

  it("never falls back to the abandoned description-prefix bucket", () => {
    expect(allTools.map(headingFor)).not.toContain("Other")
  })

  it("reports every category a tool belongs to", () => {
    // search_decisions is the entry point for case law and for tribunals, and
    // showing only the first would hide half of what it does.
    expect(categoriesOf("search_decisions").length).toBeGreaterThan(1)
    expect(categoriesOf("not_a_tool")).toEqual([])
  })
})

describe("knownCommands", () => {
  const commands = knownCommands(allTools.map((tool) => tool.name))

  it("contains the fixed commands and their aliases", () => {
    for (const name of ["query", "q", "interactive", "i", "explain", "list", "ls", "help"]) {
      expect([name, commands.has(name)]).toEqual([name, true])
    }
  })

  it("contains every tool name", () => {
    expect(allTools.every((tool) => commands.has(tool.name))).toBe(true)
  })

  it("does not contain ordinary English", () => {
    // Anything not in this set and not starting with `-` is treated as a
    // question, so a word landing in here by accident would silently stop
    // being answerable.
    for (const word of ["what", "s", "is", "the", "cases", "privacy"]) {
      expect([word, commands.has(word)]).toEqual([word, false])
    }
  })
})

describe("separateFlags", () => {
  it("keeps the question and lifts the flags out of it", () => {
    expect(separateFlags(["what", "does", "s", "18", "say", "--verbose"])).toEqual({
      words: ["what", "does", "s", "18", "say"],
      verbose: true,
      json: false,
    })
  })

  it("accepts the flag anywhere, including first", () => {
    expect(separateFlags(["--json", "s", "46", "CCA"])).toEqual({ words: ["s", "46", "CCA"], verbose: false, json: true })
  })

  it("accepts the short form", () => {
    expect(separateFlags(["-v", "hello"]).verbose).toBe(true)
  })

  it("leaves an unrecognised flag in the question rather than swallowing it", () => {
    // A word beginning with `-` inside a question ("cost-benefit --", a dash
    // in a case name) is more likely to be part of it than a typo'd flag.
    expect(separateFlags(["--colour", "hello"]).words).toEqual(["--colour", "hello"])
  })

  it("returns nothing when there was nothing but flags", () => {
    expect(separateFlags(["--json"]).words).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Running a generated subcommand
//
// Nothing reaches the network: the target tool's handler is replaced, which is
// also how the input it was finally given — and the request context it ran in —
// can be read at all.
// ──────────────────────────────────────────────────────────────────────────

describe("running a generated subcommand", () => {
  let errors: string[] = []

  /** One tool's handler, replaced by a recorder. Returns what it was called with. */
  function record(name: string): { calls: Record<string, unknown>[]; budgets: boolean[] } {
    const tool = allTools.find((entry) => entry.name === name)!
    const seen = { calls: [] as Record<string, unknown>[], budgets: [] as boolean[] }
    vi.spyOn(tool, "handler").mockImplementation(async (_client: AuApiClient, input: Record<string, unknown>) => {
      seen.calls.push(input)
      seen.budgets.push(requestContext.getStore()?.budget !== undefined)
      return { content: [{ type: "text" as const, text: "recorded" }] }
    })
    return seen
  }

  beforeEach(() => {
    errors = []
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line))
    })
    // Commander exits the process on an unknown option. Turned into a throw so
    // a regression fails this test instead of killing the test worker.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it("charges the run to an execution budget, with or without --json", async () => {
    // `fetchWithRetry` and `readResponseBytes` read the budget out of
    // AsyncLocalStorage through an optional chain, so a run outside a request
    // context has no attempt ceiling and no byte ceiling at all — it is not
    // unlimited by design, it is unmetered by accident.
    const seen = record("parse_section_ref")
    await createProgram().parseAsync(["parse_section_ref", "--text", "s 18"], { from: "user" })
    await createProgram().parseAsync(["parse_section_ref", "--text", "s 18", "--json"], { from: "user" })
    expect(seen.budgets).toEqual([true, true])
  })

  it("can turn off a parameter whose schema default is true", async () => {
    // `suggest_law_names.inForceOnly` filters out every repealed title, so with
    // no way to say false the CLI could never surface the Trade Practices Act
    // 1974 while the same tool over MCP returns it.
    const seen = record("suggest_law_names")
    await createProgram().parseAsync(["suggest_law_names", "--partial", "Trade Practices", "--no-inForceOnly"], { from: "user" })
    await createProgram().parseAsync(["suggest_law_names", "--partial", "Trade Practices", "--inForceOnly"], { from: "user" })
    // Neither flag: the schema's own default is the one that applies.
    await createProgram().parseAsync(["suggest_law_names", "--partial", "Trade Practices"], { from: "user" })
    expect(seen.calls.map((call) => call.inForceOnly)).toEqual([false, true, true])
  })

  it("accepts JSON for an object-valued parameter", async () => {
    const seen = record("search_decisions")
    await createProgram().parseAsync(
      ["search_decisions", "--domain", "cases", "--query", "misleading conduct", "--options", '{"court":"HCA"}'],
      { from: "user" },
    )
    expect(seen.calls[0]?.options).toEqual({ court: "HCA" })
  })

  it("says what an object-valued parameter wanted instead of 'expected record, received string'", async () => {
    const seen = record("search_decisions")
    await createProgram().parseAsync(["search_decisions", "--domain", "cases", "--options", "court=HCA"], { from: "user" })
    expect(seen.calls).toEqual([])
    expect(errors.join("\n")).toContain("--options")
    expect(errors.join("\n")).toContain("JSON object")
  })

  it("names a --json-input parameter the tool does not have instead of dropping it", async () => {
    // get_law_text's parameter is `date`. Stripped in silence, `asAt` returns
    // the current compilation presented as the law at a date the caller named.
    const seen = record("get_law_text")
    await createProgram().parseAsync(
      ["get_law_text", "--json-input", '{"query":"Privacy Act 1988","asAt":"2001-01-01"}'],
      { from: "user" },
    )
    expect(seen.calls).toEqual([])
    expect(errors.join("\n")).toContain("[INVALID_PARAMETER]")
    expect(errors.join("\n")).toContain("asAt")
  })
})

describe("unknownParamError", () => {
  it("answers an unsupported name the way execute_tool does over MCP", () => {
    const message = unknownParamError("get_law_text", { query: "Privacy Act 1988", asAt: "2001-01-01" })
    expect(message).toContain("[INVALID_PARAMETER]")
    expect(message).toContain('get_law_text has no parameter named "asAt"')
    expect(message).toContain("Tool: get_law_text")
    expect(message).toContain("date")
    expect(message).toContain("NOT applied and NOT dropped silently")
  })

  it("says nothing about a parameter the tool accepts, or one it defaults", () => {
    expect(unknownParamError("get_law_text", { query: "Privacy Act 1988", date: "2001-01-01" })).toBeUndefined()
    expect(unknownParamError("get_law_text", {})).toBeUndefined()
  })

  it("leaves an unknown tool to the executor's own message", () => {
    expect(unknownParamError("no_such_tool", { anything: 1 })).toBeUndefined()
  })
})

describe("@tool direct calls", () => {
  it("types a key=value from the tool's schema", () => {
    // Every value as a string means `limit=5` is rejected outright — "expected
    // number, received string" — rather than searching.
    const { toolName, params } = parseDirectCall("@search_law query=privacy limit=5")
    expect(toolName).toBe("search_law")
    expect(params).toEqual({ query: "privacy", limit: 5 })
    const tool = allTools.find((entry) => entry.name === "search_law")!
    expect(tool.schema.safeParse(params).success).toBe(true)
  })

  it("types a boolean the same way", () => {
    expect(parseDirectCall("@search_law query=privacy searchText=true").params).toEqual({
      query: "privacy",
      searchText: true,
    })
  })

  it("still reads a JSON body, and a bare name", () => {
    expect(parseDirectCall('@get_law_text {"query":"CCA","provision":"s 18"}')).toEqual({
      toolName: "get_law_text",
      params: { query: "CCA", provision: "s 18" },
    })
    expect(parseDirectCall("@list_categories")).toEqual({ toolName: "list_categories", params: {} })
  })
})
