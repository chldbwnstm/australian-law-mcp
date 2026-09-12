import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FollowupHost, parseFollowupArgs, runFollowupSetup } from "./followup-setup.js"

/** Eligible, so every test below exercises the argument handling and not the platform gate. */
const MAC: FollowupHost = { platform: "darwin", osVersion: "15.0", local: true }

/**
 * Each test runs with the process parked in an empty temporary directory.
 *
 * That is not tidiness: the directory the process happens to be standing in is
 * precisely what this installer used to write into when it was asked a
 * question, so "the current directory is still empty" is the assertion that
 * catches the reported bug — and it catches it without putting a `.mcp.json`,
 * a skill tree and a host record into the repository while the test runs.
 */
let sandbox = ""
let originalCwd = ""
const output: string[] = []
const write = (text: string): void => {
  output.push(text)
}

beforeEach(() => {
  originalCwd = process.cwd()
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "au-law-followup-")))
  process.chdir(sandbox)
  output.length = 0
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
})

describe("setup-followup argument handling", () => {
  it("answers --help with its own usage and writes nothing, even with an install's flags on the line", async () => {
    await runFollowupSetup(["--help", "--project", sandbox, "--aside-command", process.execPath], MAC, write)

    const help = output.join("")
    expect(help).toContain("au-law-mcp setup-followup")
    // the flags and their defaults, so the reader can predict the run
    expect(help).toContain("--client")
    expect(help).toContain("Default: both")
    expect(help).toContain("--project DIR")
    expect(help).toContain("--aside-command PATH")
    // and every file an install would write, named where it is written
    for (const written of [
      ".au-law-followup-host.json",
      ".mcp.json",
      ".claude/skills/au-law-followup",
      ".codex/config.toml",
      ".agents/skills/au-law-followup",
    ]) {
      expect(help).toContain(written)
    }

    expect(readdirSync(sandbox)).toEqual([])
  })

  it("answers --help on a host it would refuse to install on", async () => {
    // Help is documentation, so it is not gated on the platform check that the
    // install itself is gated on — and it still touches nothing.
    await runFollowupSetup(["--help"], { platform: "win32", osVersion: "11", local: true }, write)

    expect(output.join("")).toContain("au-law-mcp setup-followup")
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("refuses an unknown flag by name instead of installing with the defaults", async () => {
    const aside = ["--aside-command", process.execPath]

    await expect(runFollowupSetup(["--dry-run", "--project", sandbox, ...aside], MAC, write)).rejects.toThrow(/--dry-run/)
    await expect(runFollowupSetup(["--projekt", sandbox, ...aside], MAC, write)).rejects.toThrow(/--projekt/)
    await expect(runFollowupSetup(["install", "--project", sandbox, ...aside], MAC, write)).rejects.toThrow(/"install"/)

    expect(readdirSync(sandbox)).toEqual([])
  })

  it("refuses a flag with nothing behind it rather than falling back to its default", async () => {
    await expect(runFollowupSetup(["--project"], MAC, write)).rejects.toThrow("--project needs a value")
    // The trap: the next flag was read as the value, so this resolved — and
    // created — a project directory literally named "--client".
    await expect(runFollowupSetup(["--project", "--client", "codex"], MAC, write)).rejects.toThrow("--project needs a value")
    await expect(runFollowupSetup(["--client"], MAC, write)).rejects.toThrow("--client needs a value")
    await expect(runFollowupSetup(["--aside-command"], MAC, write)).rejects.toThrow("--aside-command needs a value")

    expect(readdirSync(sandbox)).toEqual([])
    expect(existsSync(join(sandbox, "--client"))).toBe(false)
  })

  it("will not install into the current directory unless the current directory was named", async () => {
    await expect(runFollowupSetup(["--aside-command", process.execPath], MAC, write)).rejects.toThrow(/--project/)
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("installs into the current directory when --yes says so", async () => {
    await runFollowupSetup(["--yes", "--client", "claude-code", "--aside-command", process.execPath], MAC, write)

    const claude = JSON.parse(readFileSync(join(sandbox, ".mcp.json"), "utf8"))
    expect(claude.mcpServers.aside).toEqual({ command: process.execPath, args: ["mcp", "--host", "local"] })
    expect(output.join("")).toContain(sandbox)
  })
})

describe("the install itself", () => {
  it("still installs both clients into a named project, keeping what is already there", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "au-law-followup-project-")))
    try {
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({ setting: true, mcpServers: { law: { command: "law" } } }))

      await runFollowupSetup(["--client", "both", "--project", project, "--aside-command", process.execPath], MAC, write)

      const claude = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"))
      expect(claude.setting).toBe(true)
      expect(claude.mcpServers.law).toEqual({ command: "law" })
      expect(claude.mcpServers.aside).toEqual({ command: process.execPath, args: ["mcp", "--host", "local"] })
      expect(readFileSync(join(project, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.aside]")
      expect(existsSync(join(project, ".claude/skills/au-law-followup/SKILL.md"))).toBe(true)
      expect(existsSync(join(project, ".agents/skills/au-law-followup/SKILL.md"))).toBe(true)
      expect(JSON.parse(readFileSync(join(project, ".au-law-followup-host.json"), "utf8")).asideCommand).toBe(process.execPath)
      // It names the directory it installed into: the caller may not have chosen it deliberately.
      expect(output.join("")).toContain(project)
      // The directory the process is standing in is not the project, and stays untouched.
      expect(readdirSync(sandbox)).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it("refuses an ineligible host before it resolves anything to write", async () => {
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", process.execPath], { platform: "win32", osVersion: "11", local: true }, write)).rejects.toThrow(
      /macOS/,
    )
    expect(readdirSync(sandbox)).toEqual([])
  })
})

describe("parseFollowupArgs", () => {
  it("defaults the client to both and leaves the project unnamed", () => {
    expect(parseFollowupArgs([])).toEqual({ client: "both", project: undefined, asideCommand: "aside", acceptCurrentDirectory: false })
    expect(parseFollowupArgs(["-y"]).acceptCurrentDirectory).toBe(true)
  })

  it("rejects a client it cannot install for", () => {
    expect(() => parseFollowupArgs(["--client", "vscode"])).toThrow(/codex, claude-code or both/)
  })
})
