import { describe, expect, it } from "vitest"
import { SERVER_KEY, buildServerEntry, buildZedEntry, detectClients, entryFor, mergeEntry } from "./setup.js"

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

describe("the registered entry", () => {
  // Australian sources are keyless, so there is nothing to put in `env` — an
  // empty env block would only invite someone to paste a credential into it.
  it("carries no API key", () => {
    expect(buildServerEntry()).toEqual({ command: "npx", args: ["-y", "au-law-mcp"] })
    expect(JSON.stringify(buildServerEntry())).not.toMatch(/env|key/i)
  })

  it("nests the command for Zed", () => {
    expect(buildZedEntry()).toEqual({ command: { path: "npx", args: ["-y", "au-law-mcp"] } })
    expect(entryFor("context_servers")).toEqual(buildZedEntry())
    expect(entryFor("servers")).toEqual(buildServerEntry())
  })
})

describe("merging into an existing config", () => {
  it("keeps every other server and every unrelated setting", () => {
    const existing = { theme: "dark", mcpServers: { "some-other": { command: "node" } } }
    const merged = mergeEntry(existing, "mcpServers") as { theme: string; mcpServers: Record<string, unknown> }
    expect(merged.theme).toBe("dark")
    expect(merged.mcpServers["some-other"]).toEqual({ command: "node" })
    expect(merged.mcpServers[SERVER_KEY]).toEqual(buildServerEntry())
  })

  it("replaces a previous registration rather than duplicating it", () => {
    const merged = mergeEntry({ mcpServers: { [SERVER_KEY]: { command: "stale" } } }, "mcpServers") as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(merged.mcpServers)).toEqual([SERVER_KEY])
    expect(merged.mcpServers[SERVER_KEY]).toEqual(buildServerEntry())
  })

  it("writes into the key the client actually reads", () => {
    expect(Object.keys(mergeEntry({}, "servers"))).toEqual(["servers"])
    expect(Object.keys(mergeEntry({}, "context_servers"))).toEqual(["context_servers"])
  })
})
