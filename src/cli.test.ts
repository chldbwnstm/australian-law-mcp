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

import { describe, expect, it } from "vitest"
import { categoriesOf, createProgram, knownCommands, separateFlags, toolsInCategory } from "./cli.js"
import { allTools } from "./tool-registry.js"
import { extractOptionsFromSchema } from "./lib/cli-format.js"

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

  it("turns each schema field into a flag", () => {
    // Spot-checked on the tools whose parameters the corpus exercises, rather
    // than all eighty: the generation is one loop, so a few prove it runs.
    for (const name of ["get_law_text", "search_decisions", "cite_check", "legal_research"]) {
      const tool = allTools.find((entry) => entry.name === name)!
      const command = createProgram().commands.find((entry) => entry.name() === name)!
      const flags = new Set(command.options.map((option) => option.long))
      for (const option of extractOptionsFromSchema(tool.schema)) {
        expect([name, option.name, flags.has(`--${option.name}`)]).toEqual([name, option.name, true])
      }
    }
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
