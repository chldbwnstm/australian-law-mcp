import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { isEntryPoint, main, parseOptions } from "./index.js"
import { VERSION } from "./version.js"

/**
 * The argument dispatch, tested from the outside.
 *
 * The rule every test here pins: an argument that asks a question is answered
 * before anything acts on the command line. `setup-followup --help` used to
 * reach the installer ahead of the `--help` check and install with its
 * defaults — `--client both`, `--project $PWD` — so the tests run with the
 * process parked in an empty temporary directory and assert that it is still
 * empty afterwards. Nothing below is allowed to reach a transport: a test that
 * started the stdio or HTTP server would be a test that hangs.
 */
let sandbox = ""
let originalCwd = ""
const output: string[] = []
const write = (text: string): void => {
  output.push(text)
}

beforeEach(() => {
  originalCwd = process.cwd()
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "au-law-index-")))
  process.chdir(sandbox)
  output.length = 0
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
})

describe("--help and --version reach every subcommand", () => {
  it("prints setup-followup's own help, and installs nothing, when help is asked for after the subcommand", async () => {
    // The reported bug, with the arguments the reporter would have typed: the
    // dispatch ran first, so this wrote .mcp.json and .claude/skills into the
    // current directory instead of printing anything.
    await main(["setup-followup", "--help", "--aside-command", process.execPath], write)

    const help = output.join("")
    expect(help).toContain("au-law-mcp setup-followup")
    expect(help).toContain(".mcp.json")
    expect(help).toContain(".claude/skills/au-law-followup")
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("prints setup's own help, with the config files it could write, and does not open the wizard", async () => {
    await main(["setup", "--help"], write)

    const help = output.join("")
    expect(help).toContain("au-law-mcp setup")
    // Every flag the command accepts has to appear here. The earlier wording
    // claimed it "takes no flags" while --npx existed, so a reader who trusted
    // the help could not discover the one flag that changes what gets written.
    expect(help).toContain("--npx")
    // The client paths are read from the detector the wizard uses, so the help
    // names the files this machine would actually be offered.
    expect(help).toContain(join(sandbox, ".mcp.json"))
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("answers --version after a subcommand as well as before one", async () => {
    for (const args of [["--version"], ["-v"], ["setup", "--version"], ["setup-followup", "--version"]]) {
      output.length = 0
      await main(args, write)
      expect(output.join("")).toBe(VERSION + "\n")
    }
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("still prints the top-level usage for the bare binary", async () => {
    await main(["--help"], write)

    const help = output.join("")
    expect(help).toContain("au-law-mcp " + VERSION)
    expect(help).toContain("--mode http")
    expect(help).toContain("setup-followup")
  })
})

describe("unrecognised arguments stop the command", () => {
  it("refuses a flag on setup rather than running the wizard and ignoring it", async () => {
    await expect(main(["setup", "--client", "codex"], write)).rejects.toThrow(/--client/)
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("refuses an unknown flag passed through to setup-followup", async () => {
    await expect(main(["setup-followup", "--dry-run", "--project", sandbox], write)).rejects.toThrow(/--dry-run/)
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("refuses a mistyped command instead of quietly starting the stdio server", async () => {
    await expect(main(["setupp"], write)).rejects.toThrow(/Unknown command "setupp"/)
    await expect(main(["setup-follwup"], write)).rejects.toThrow(/Unknown command/)
  })
})

describe("parseOptions", () => {
  it("reads --flag value pairs", () => {
    expect(parseOptions(["--mode", "http", "--port", "8123"], "au-law-mcp", ["--mode", "--port"])).toEqual(
      new Map([
        ["--mode", "http"],
        ["--port", "8123"],
      ]),
    )
  })

  it("treats a flag with nothing behind it as an error, not as the default", () => {
    // `--mode` with no value used to fall back to stdio, so a truncated
    // `--mode http` started a server that answered on the wrong transport.
    expect(() => parseOptions(["--mode"], "au-law-mcp", ["--mode", "--port"])).toThrow("--mode needs a value")
    expect(() => parseOptions(["--mode", "--port", "8123"], "au-law-mcp", ["--mode", "--port"])).toThrow("--mode needs a value")
    // A negative number is a value; it fails later, in the port validator.
    expect(parseOptions(["--port", "-1"], "au-law-mcp", ["--mode", "--port"]).get("--port")).toBe("-1")
  })

  it("names the argument it does not know", () => {
    expect(() => parseOptions(["--prot", "9000"], "au-law-mcp", ["--mode", "--port"])).toThrow(/Unknown option "--prot"/)
    expect(() => parseOptions(["http"], "au-law-mcp", ["--mode", "--port"])).toThrow(/Unexpected argument "http"/)
    expect(() => parseOptions(["--client", "codex"], "au-law-mcp setup", [])).toThrow('Run "au-law-mcp setup --help"')
  })
})

describe("isEntryPoint", () => {
  it("recognises the module as the entry point through a bin symlink", () => {
    // npm installs the bin as a symlink in node_modules/.bin, so argv[1] is the
    // link. Comparing the two paths literally would leave the installed binary
    // loading cleanly and then doing nothing at all.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "au-law-bin-")))
    try {
      const real = join(directory, "index.js")
      const link = join(directory, "au-law-mcp")
      writeFileSync(real, "")
      symlinkSync(real, link)

      expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true)
      expect(isEntryPoint(pathToFileURL(real).href, real)).toBe(true)
      expect(isEntryPoint(pathToFileURL(real).href, join(directory, "other.js"))).toBe(false)
      expect(isEntryPoint(pathToFileURL(real).href, undefined)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
