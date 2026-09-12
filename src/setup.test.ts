import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import {
  SERVER_KEY,
  buildServerEntry,
  buildZedEntry,
  detectClients,
  entryFor,
  mergeEntry,
  resolveEntryPoint,
  resolveLaunchCommand,
} from "./setup.js"
import type { LaunchCommand } from "./setup.js"
import { followupHostEligibility, mergeClaudeAside, mergeCodexAside, runFollowupSetup } from "./followup-setup.js"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

describe("client detection", () => {
  it("uses the platform's Claude Desktop path", () => {
    const mac = detectClients("/Users/x", "darwin", "/work")
    expect(mac[0].configPath).toBe("/Users/x/Library/Application Support/Claude/claude_desktop_config.json")

    const windows = detectClients("C:/Users/x", "win32", "C:/work")
    expect(windows[0].configPath).toMatch(/Claude[\\/]claude_desktop_config\.json$/)
  })

  it("covers the three config shapes that exist in the wild", () => {
    const clients = detectClients("/Users/x", "darwin", "/work")
    const names = clients.map((client) => client.name)
    expect(names).toEqual(
      expect.arrayContaining(["Claude Desktop", "Claude Code (this directory)", "Cursor", "VS Code (this directory)", "Windsurf", "Gemini CLI", "Zed"]),
    )
    expect(clients.find((client) => client.name === "VS Code (this directory)")?.format).toBe("servers")
    expect(clients.find((client) => client.name === "Zed")?.format).toBe("context_servers")
    expect(clients.find((client) => client.name === "Cursor")?.configPath).toBe("/Users/x/.cursor/mcp.json")
  })
})

describe("optional Aside companion setup", () => {
  it("keeps Windows and remote hosts on standard research", () => {
    expect(followupHostEligibility({ platform: "win32", osVersion: "11", local: true }).eligible).toBe(false)
    expect(followupHostEligibility({ platform: "darwin", osVersion: "15.0", local: false }).eligible).toBe(false)
  })

  it("preserves unrelated Claude and Codex settings and reuses existing Aside entries", () => {
    const claude = mergeClaudeAside({ theme: "dark", mcpServers: { law: { command: "law" } } }, "/bin/aside") as any
    expect(claude.theme).toBe("dark")
    expect(claude.mcpServers.law).toEqual({ command: "law" })
    const codex = mergeCodexAside('model = "gpt-5"\n[mcp_servers.law]\ncommand = "law"\n', "/bin/aside")
    expect(codex).toContain('model = "gpt-5"')
    expect(codex).toContain("[mcp_servers.law]")
    expect(mergeCodexAside(codex, "/different/aside")).toBe(codex)
    const quoted = '["mcp_servers"."aside"] # existing desktop path\ncommand = "/custom/aside"\n'
    expect(mergeCodexAside(quoted, "/different/aside")).toBe(quoted)
    expect(() => mergeClaudeAside({ mcpServers: [] }, "/bin/aside")).toThrow("must be a JSON object")
  })

  it("installs both project-local skills and runs the helper through a symlink without global writes", async () => {
    const project = mkdtempSync(join(tmpdir(), "au-law-setup-"))
    const linkRoot = mkdtempSync(join(tmpdir(), "au-law-setup-link-"))
    const linkedProject = join(linkRoot, "project")
    const fakeHome = mkdtempSync(join(tmpdir(), "au-law-setup-home-"))
    const globalClaudePath = join(fakeHome, ".claude.json")
    const globalCodexPath = join(fakeHome, ".codex/config.toml")
    const globalClaude = `${JSON.stringify({ global: true, mcpServers: { existing: { command: "existing" } } }, null, 2)}\n`
    const globalCodex = 'model = "global"\n[mcp_servers.existing]\ncommand = "existing"\n'
    const savedHome = process.env.HOME
    const savedXdgConfigHome = process.env.XDG_CONFIG_HOME
    try {
      symlinkSync(project, linkedProject, process.platform === "win32" ? "junction" : "dir")
      writeFileSync(join(project, ".mcp.json"), JSON.stringify({ setting: true, mcpServers: { law: { command: "law" } } }))
      mkdirSync(join(project, ".codex"), { recursive: true })
      writeFileSync(join(project, ".codex/config.toml"), 'model = "project"\n[mcp_servers.law]\ncommand = "law"\n')
      mkdirSync(join(fakeHome, ".codex"), { recursive: true })
      writeFileSync(globalClaudePath, globalClaude)
      writeFileSync(globalCodexPath, globalCodex)
      process.env.HOME = fakeHome
      process.env.XDG_CONFIG_HOME = join(fakeHome, ".config")

      await runFollowupSetup(["--client", "both", "--project", linkedProject, "--aside-command", process.execPath], { platform: "darwin", osVersion: "15.0", local: true })
      const claude = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"))
      expect(claude.setting).toBe(true)
      expect(claude.mcpServers.law).toEqual({ command: "law" })
      expect(claude.mcpServers.aside).toEqual({ command: process.execPath, args: ["mcp", "--host", "local"] })
      const codex = readFileSync(join(project, ".codex/config.toml"), "utf8")
      expect(codex).toContain('model = "project"')
      expect(codex).toContain("[mcp_servers.law]")
      expect(codex).toContain("[mcp_servers.aside]")
      expect(readFileSync(join(project, ".claude/skills/au-law-followup/SKILL.md"), "utf8")).toContain("name: au-law-followup")
      expect(readFileSync(join(project, ".agents/skills/au-law-followup/SKILL.md"), "utf8")).toContain("name: au-law-followup")
      const followupHost = JSON.parse(readFileSync(join(project, ".au-law-followup-host.json"), "utf8"))
      expect(followupHost.asideCommand).toBe(process.execPath)

      const helper = join(linkedProject, ".agents/skills/au-law-followup/scripts/followup.mjs")
      const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [helper, ...args], { cwd: linkedProject, encoding: "utf8" }))
      const probe = cli("probe")
      expect(probe).toEqual(expect.objectContaining({ schemaVersion: "1.0", probe: "local_companion", asideConnected: false, eligible: false }))

      const matter = join(linkedProject, "matter")
      expect(cli("init", matter, "--mode", "missing_sources").policy.mode).toBe("missing_sources")
      const initialStatus = cli("status", matter)
      expect(initialStatus.remaining).toEqual({ pages: 10, documents: 3, activeSeconds: 300 })
      expect(cli("stop", matter)).toEqual(expect.objectContaining({ stopRequested: true }))
      expect(cli("resume-matter", matter)).toEqual(expect.objectContaining({ resumed: true, autoDispatched: false }))
      const resumedStatus = cli("status", matter)
      expect(resumedStatus.remaining).toEqual(initialStatus.remaining)
      expect(resumedStatus).toEqual(expect.objectContaining({ mayDispatch: true }))
      expect(resumedStatus.checkpoint).toEqual(expect.objectContaining({ stopRequested: false, pagesUsed: 0, documentsUsed: 0, activeElapsedSeconds: 0 }))

      expect(readFileSync(globalClaudePath, "utf8")).toBe(globalClaude)
      expect(readFileSync(globalCodexPath, "utf8")).toBe(globalCodex)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdgConfigHome
      rmSync(linkRoot, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})


/** A resolved launch command, the shape `resolveLaunchCommand` hands back. */
const LAUNCH: LaunchCommand = { command: "/usr/bin/node", args: ["/opt/au-law-mcp/build/index.js"] }

/** A directory that looks like `build/` — an `index.js` beside a `setup.js`. */
function builtLayout(): { dir: string; moduleUrl: string; entryPoint: string } {
  const dir = mkdtempSync(join(tmpdir(), "au-law-launch-"))
  const entryPoint = join(dir, "index.js")
  writeFileSync(entryPoint, "// built entry point\n")
  return { dir, moduleUrl: pathToFileURL(join(dir, "setup.js")).href, entryPoint }
}

describe("the launch command the wizard writes", () => {
  // `npx -y au-law-mcp` cannot be verified: registry.npmjs.org/au-law-mcp
  // answers 404 (checked 2026-09-12), so a client spawning it fails with
  // "server disconnected" and the config file that caused it looks correct.
  // What this process *can* prove is the file it is running from.
  it("writes the absolute entry point it is running from, checked on disk", async () => {
    const { dir, moduleUrl, entryPoint } = builtLayout()
    try {
      const plan = await resolveLaunchCommand({ moduleUrl, execPath: "/fake/node" })
      expect(plan.form).toBe("absolute")
      expect(plan.launch).toEqual({ command: "/fake/node", args: [entryPoint] })
      expect(plan.note).toContain(entryPoint)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes nothing at all when no built entry point is there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "au-law-launch-empty-"))
    try {
      const plan = await resolveLaunchCommand({ moduleUrl: pathToFileURL(join(dir, "setup.js")).href })
      expect(plan.form).toBe("unverified")
      expect(plan.launch).toBeUndefined()
      expect(plan.note).toContain("npm run build")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to the absolute path when --npx is asked for and the registry has no such package", async () => {
    const { dir, moduleUrl, entryPoint } = builtLayout()
    try {
      const plan = await resolveLaunchCommand({
        allowNpx: true,
        moduleUrl,
        execPath: "/fake/node",
        registryProbe: async () => false,
      })
      expect(plan.launch).toEqual({ command: "/fake/node", args: [entryPoint] })
      expect(plan.note).toContain("--npx was ignored")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes npx once the registry actually serves the package", async () => {
    const plan = await resolveLaunchCommand({ allowNpx: true, registryProbe: async () => true })
    expect(plan.form).toBe("npx")
    expect(plan.launch).toEqual({ command: "npx", args: ["-y", "au-law-mcp"] })
  })

  it("does not touch the network unless --npx was passed", async () => {
    const { dir, moduleUrl } = builtLayout()
    let probes = 0
    try {
      await resolveLaunchCommand({
        moduleUrl,
        registryProbe: async () => {
          probes += 1
          return true
        },
      })
      expect(probes).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The invariant, stated over this machine rather than a fixture: whatever the
  // wizard hands back, either it is a path that is there or it is nothing.
  it("never returns a command it has not verified", async () => {
    const plan = await resolveLaunchCommand()
    if (plan.form === "absolute") {
      expect(existsSync(plan.launch?.args[0] ?? "")).toBe(true)
      expect(plan.launch?.command).toBe(process.execPath)
      expect(resolveEntryPoint()).toBe(plan.launch?.args[0])
    } else {
      expect(plan.launch).toBeUndefined()
    }
  })
})

describe("the registered entry", () => {
  // Australian sources are keyless, so there is nothing to put in `env` — an
  // empty env block would only invite someone to paste a credential into it.
  it("carries no API key", () => {
    expect(buildServerEntry(LAUNCH)).toEqual({ command: "/usr/bin/node", args: ["/opt/au-law-mcp/build/index.js"] })
    expect(JSON.stringify(buildServerEntry(LAUNCH))).not.toMatch(/env|key/i)
  })

  it("nests the command for Zed", () => {
    expect(buildZedEntry(LAUNCH)).toEqual({
      command: { path: "/usr/bin/node", args: ["/opt/au-law-mcp/build/index.js"] },
    })
    expect(entryFor("context_servers", LAUNCH)).toEqual(buildZedEntry(LAUNCH))
    expect(entryFor("servers", LAUNCH)).toEqual(buildServerEntry(LAUNCH))
  })
})

describe("merging into an existing config", () => {
  it("keeps every other server and every unrelated setting", () => {
    const existing = { theme: "dark", mcpServers: { "some-other": { command: "node" } } }
    const merged = mergeEntry(existing, "mcpServers", LAUNCH) as { theme: string; mcpServers: Record<string, unknown> }
    expect(merged.theme).toBe("dark")
    expect(merged.mcpServers["some-other"]).toEqual({ command: "node" })
    expect(merged.mcpServers[SERVER_KEY]).toEqual(buildServerEntry(LAUNCH))
  })

  // The config the client reads must carry the verified command, not a package
  // name the client would have to resolve from a registry that 404s.
  it("writes the verified launch command into the file, not a registry name", () => {
    const merged = mergeEntry({}, "mcpServers", LAUNCH) as { mcpServers: Record<string, unknown> }
    expect(merged.mcpServers[SERVER_KEY]).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/au-law-mcp/build/index.js"],
    })
    const zed = mergeEntry({}, "context_servers", LAUNCH) as { context_servers: Record<string, unknown> }
    expect(zed.context_servers[SERVER_KEY]).toEqual({
      command: { path: "/usr/bin/node", args: ["/opt/au-law-mcp/build/index.js"] },
    })
  })

  it("replaces a previous registration rather than duplicating it", () => {
    const merged = mergeEntry({ mcpServers: { [SERVER_KEY]: { command: "stale" } } }, "mcpServers", LAUNCH) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(merged.mcpServers)).toEqual([SERVER_KEY])
    expect(merged.mcpServers[SERVER_KEY]).toEqual(buildServerEntry(LAUNCH))
  })

  it("writes into the key the client actually reads", () => {
    expect(Object.keys(mergeEntry({}, "servers", LAUNCH))).toEqual(["servers"])
    expect(Object.keys(mergeEntry({}, "context_servers", LAUNCH))).toEqual(["context_servers"])
  })
})
