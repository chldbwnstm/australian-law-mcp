import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectFollowupHost, findExecutable, type FollowupHost, followupHostEligibility, mergeClaudeAside, mergeCodexAside, parseFollowupArgs, runFollowupSetup } from "./followup-setup.js"

/** Eligible, so every test below exercises the argument handling and not the platform gate. */
const MAC: FollowupHost = { platform: "darwin", osVersion: "15.0", local: true }
/** Equally eligible: Windows 11 24H2 as os.release() reports it. */
const WINDOWS: FollowupHost = { platform: "win32", osVersion: "10.0.26200", local: true }
const WIN_ASIDE = "C:\\Users\\Jane Doe\\AppData\\Local\\Aside\\CLI\\current\\aside.exe"

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
    // both platforms, and the Windows path rendered with its backslashes (a
    // template literal silently drops a lone `\A`)
    expect(help).toContain("Windows")
    expect(help).toContain("%LOCALAPPDATA%\\Aside\\CLI\\current\\aside.exe")
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
    await runFollowupSetup(["--help"], { platform: "linux", osVersion: "6.8", local: true }, write)

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

  it("installs into a named project on a local Windows host exactly as on a Mac", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "au-law-followup-windows-")))
    try {
      await runFollowupSetup(["--client", "both", "--project", project, "--aside-command", process.execPath], WINDOWS, write)
      expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers.aside).toEqual({ command: process.execPath, args: ["mcp", "--host", "local"] })
      expect(readFileSync(join(project, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.aside]")
      expect(JSON.parse(readFileSync(join(project, ".au-law-followup-host.json"), "utf8")).asideCommand).toBe(process.execPath)
      expect(readdirSync(sandbox)).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it("refuses an ineligible host before it resolves anything to write", async () => {
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", process.execPath], { platform: "linux", osVersion: "6.8", local: true }, write)).rejects.toThrow(
      /macOS 15\+ and 64-bit Windows/,
    )
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", process.execPath], { platform: "win32", osVersion: "6.3.9600", local: true }, write)).rejects.toThrow(
      /Windows 10 or later/,
    )
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", process.execPath], { ...WINDOWS, local: false }, write)).rejects.toThrow(/remote/)
    expect(readdirSync(sandbox)).toEqual([])
  })
})

describe("host eligibility and CLI resolution", () => {
  it("admits local macOS 15+ and Windows 10/11 and refuses everything else, from the shared floor table", () => {
    expect(followupHostEligibility(MAC)).toEqual({ eligible: true, reason: "Eligible local macOS host." })
    expect(followupHostEligibility(WINDOWS)).toEqual({ eligible: true, reason: "Eligible local Windows host." })
    expect(followupHostEligibility({ platform: "win32", osVersion: "10.0.19045", local: true }).eligible).toBe(true)
    expect(followupHostEligibility({ platform: "win32", osVersion: "6.3.9600", local: true })).toMatchObject({ eligible: false, reason: expect.stringContaining("Windows 10 or later") })
    expect(followupHostEligibility({ platform: "darwin", osVersion: "14.7", local: true })).toMatchObject({ eligible: false, reason: expect.stringContaining("macOS 15.0 or later") })
    expect(followupHostEligibility({ platform: "linux", osVersion: "6.8", local: true })).toMatchObject({ eligible: false, reason: expect.stringContaining("linux") })
    expect(followupHostEligibility({ ...WINDOWS, local: false })).toMatchObject({ eligible: false, reason: expect.stringContaining("remote") })
  })

  it("describes the machine it runs on without shelling out on Windows", () => {
    const host = detectFollowupHost({})
    expect(host.platform).toBe(process.platform)
    expect(host.local).toBe(true)
    if (process.platform === "win32") expect(host.osVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(detectFollowupHost({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }).local).toBe(false)
    expect(detectFollowupHost({ WSL_DISTRO_NAME: "Ubuntu" }).local).toBe(false)
  })

  it("resolves aside.exe in the server's order — the installer's location, then a Windows PATH with relative entries skipped", () => {
    const env = { PATH: `.;"C:\\Program Files\\Tools";C:\\Tools;`, LOCALAPPDATA: "C:\\Users\\Jane Doe\\AppData\\Local" }
    const probed: string[] = []
    expect(findExecutable("aside", env, (path) => { probed.push(path); return path === "C:\\Tools\\aside.exe" }, "win32", "C:\\Users\\Jane Doe")).toBe("C:\\Tools\\aside.exe")
    expect(probed[0]).toBe(WIN_ASIDE)
    expect(probed).toContain("C:\\Program Files\\Tools\\aside.exe")
    expect(probed.every((path) => /^[A-Za-z]:\\/.test(path))).toBe(true)
    // Both present: the installer's location wins, as it does for the server's switch.
    expect(findExecutable("aside", env, (path) => path === WIN_ASIDE || path === "C:\\Tools\\aside.exe", "win32", "C:\\Users\\Jane Doe")).toBe(WIN_ASIDE)
    expect(findExecutable("aside.exe", env, (path) => path === WIN_ASIDE, "win32", "C:\\Users\\Jane Doe")).toBe(WIN_ASIDE)
    expect(findExecutable("aside", env, () => false, "win32", "C:\\Users\\Jane Doe")).toBeUndefined()
  })

  it("resolves aside on a Mac in the same order — the install path, then a POSIX PATH with relative entries skipped", () => {
    const standard = "/Users/tester/.aside/cli/Aside CLI.app/Contents/MacOS/aside"
    expect(findExecutable("aside", { PATH: ".:/usr/local/bin:/usr/bin" }, (path) => path === "/usr/bin/aside", "darwin", "/Users/tester")).toBe("/usr/bin/aside")
    expect(findExecutable("aside", { PATH: "." }, (path) => path === "aside", "darwin", "/Users/tester")).toBeUndefined()
    expect(findExecutable("aside", { PATH: "/usr/bin" }, (path) => path === standard, "darwin", "/Users/tester")).toBe(standard)
    expect(findExecutable("aside", { PATH: "/usr/bin" }, (path) => path === standard || path === "/usr/bin/aside", "darwin", "/Users/tester")).toBe(standard)
  })

  it("names exactly where it looked when the CLI is not found", async () => {
    // A path with a separator is checked as given — the message must not claim PATH was searched.
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", "/nope/aside"], MAC, write)).rejects.toThrow(/nothing at .*nope.*aside(?! or on PATH)/)
    await expect(runFollowupSetup(["--project", sandbox, "--aside-command", "/nope/aside"], MAC, write)).rejects.not.toThrow(/on PATH/)
    expect(readdirSync(sandbox)).toEqual([])
  })

  it("writes a Windows CLI path so that each client parses it back to the same path", () => {
    const claude = mergeClaudeAside({}, WIN_ASIDE) as { mcpServers: { aside: { command: string } } }
    expect(JSON.parse(JSON.stringify(claude)).mcpServers.aside.command).toBe(WIN_ASIDE)
    // TOML basic string: every backslash doubled, the space left alone.
    const codex = mergeCodexAside("", WIN_ASIDE)
    expect(codex).toContain('command = "C:\\\\Users\\\\Jane Doe\\\\AppData\\\\Local\\\\Aside\\\\CLI\\\\current\\\\aside.exe"')
    expect(mergeCodexAside(codex, "D:\\other\\aside.exe")).toBe(codex)
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
