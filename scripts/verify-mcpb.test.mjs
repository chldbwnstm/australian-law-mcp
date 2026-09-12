import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
// Importing this must not build, pack or download anything — see the
// `invokedDirectly` guard at the foot of build-mcpb.mjs. If that guard goes,
// every test in this file starts by running `npm ci` and `npm run build`.
import { asideSettings, buildManifest } from "./build-mcpb.mjs"
import { speakMcp } from "./mcp-stdio.mjs"

const directories = []
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("mcp-stdio-test-")) {
      throw new Error("Unexpected test cleanup directory")
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function mockServer(source) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-stdio-test-"))
  directories.push(dir)
  await mkdir(path.join(dir, "build"))
  await writeFile(path.join(dir, "build", "index.js"), source)
  return dir
}

it("verifies MCP replies split across pipe chunks, including UTF-8 characters", async () => {
  const dir = await mockServer(`
    const { createInterface } = require("node:readline")
    createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line)
      if (!request.id) return
      const result = request.id === 1
        ? { serverInfo: { name: "법", version: "1.0.0" } }
        : { tools: [{ name: "example", description: "x".repeat(100000) }] }
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n")
      const split = request.id === 1 ? bytes.indexOf(Buffer.from("법")) + 1 : 123
      process.stdout.write(bytes.subarray(0, split))
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 20)
    })
  `)
  const { responses, stdout } = await speakMcp(dir, 1500)
  expect(responses.get(1).result.serverInfo.name).toBe("법")
  expect(responses.get(2).result.tools[0].description).toHaveLength(100000)
  expect(stdout.trim().split("\n")).toHaveLength(2)
})

it("reports an early server exit", async () => {
  const dir = await mockServer('process.stderr.write("startup failed\\n"); process.exit(1)')
  await expect(speakMcp(dir, 1500)).rejects.toThrow(/before answering tools\/list/)
})

it("terminates a server that never answers", async () => {
  const dir = await mockServer("setInterval(() => {}, 1000)")
  await expect(speakMcp(dir, 200)).rejects.toThrow(/no response within 200 ms/)
})

it("rejects stray logging on the protocol's stdout", async () => {
  const dir = await mockServer('process.stdout.write("debug message\\n"); setInterval(() => {}, 1000)')
  await expect(speakMcp(dir, 1500)).rejects.toThrow(/non-JSON line/)
})

// ── manifest: the settings a Claude Desktop user can actually reach ─────────
//
// A Chat user installs the .mcpb and never opens a config file, so anything
// not declared in `user_config` is unreachable for them. These tests pin the
// two Aside settings and — more importantly — the wiring between them and the
// environment the server is started with, which is where a rename goes wrong
// silently: Claude Desktop leaves an unresolvable `${user_config.x}` in the
// string verbatim rather than failing.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Shape only — buildManifest reads `name` and `description` from each tool. */
const TOOLS = [{ name: "search_all", description: "Search everything at once. Returns ranked hits." }]

const PKG = {
  name: "au-law-mcp",
  version: "9.9.9",
  description: "MCP server for Australian law",
  homepage: "https://example.invalid#readme",
  bugs: { url: "https://example.invalid/issues" },
  repository: { type: "git", url: "git+https://example.invalid/repo.git" },
  keywords: ["mcp", "australian-law"],
  license: "MIT",
  engines: { node: ">=20.19.0" },
}

/**
 * What Claude Desktop puts in the server's environment, given stored settings.
 *
 * The rule, from the reference implementation in `@anthropic-ai/mcpb` 2.1.2
 * (`dist/shared/config.js`): manifest defaults first, stored values over them,
 * a boolean becomes the *string* `"true"` or `"false"`, everything else
 * `String(value)` — and `${user_config.<key>}` is replaced only for a key that
 * survived that merge. A key with neither a stored value nor a default leaves
 * its placeholder in the string verbatim.
 */
function substituteLikeDesktop(manifest, stored) {
  const merged = {}
  for (const [key, option] of Object.entries(manifest.user_config)) {
    if (option.default !== undefined) merged[key] = option.default
  }
  Object.assign(merged, stored ?? {})

  const resolved = {}
  for (const [variable, template] of Object.entries(manifest.server.mcp_config.env)) {
    // String(true) is "true": a boolean setting has no other spelling on the wire.
    resolved[variable] = template.replace(/\$\{user_config\.([^}]+)\}/g, (placeholder, key) =>
      key in merged ? String(merged[key]) : placeholder,
    )
  }
  return resolved
}

describe("generated manifest", () => {
  it("renders an Aside toggle that is off until the user turns it on", () => {
    const setting = buildManifest(PKG, TOOLS).user_config.aside_followup

    expect(setting.type).toBe("boolean")
    expect(setting.default).toBe(false)
    expect(setting.required).toBe(false)
    // The label has to state the trade, because the user consenting to it is a
    // lawyer reading one line in Settings, not someone who read this repository.
    expect(setting.title).toMatch(/aside/i)
    expect(setting.description).toMatch(/federal court/i)
    expect(setting.description).toMatch(/signed in/i)
    expect(setting.description).toMatch(/legal-source/i)
  })

  it("offers an optional Aside CLI path with an empty default, never an absent one", () => {
    const setting = buildManifest(PKG, TOOLS).user_config.aside_command

    expect(setting.type).toBe("string")
    expect(setting.required).toBe(false)
    // Not `undefined`: Claude Desktop only defines ${user_config.aside_command}
    // for a key that has a stored value or a manifest default, and substitutes
    // nothing otherwise — the server would be handed the literal placeholder
    // text as the path to run.
    expect(setting.default).toBe("")
  })

  it("exposes those two settings and nothing else", () => {
    expect(Object.keys(buildManifest(PKG, TOOLS).user_config)).toEqual(["aside_followup", "aside_command"])
  })

  it("wires both settings through the server's environment", () => {
    expect(buildManifest(PKG, TOOLS).server.mcp_config.env).toEqual({
      AU_LAW_ASIDE: "${user_config.aside_followup}",
      AU_LAW_ASIDE_COMMAND: "${user_config.aside_command}",
    })
  })

  it("never references a user_config key it does not declare", () => {
    const manifest = buildManifest(PKG, TOOLS)
    const referenced = [...JSON.stringify(manifest.server.mcp_config).matchAll(/\$\{user_config\.([^}]+)\}/g)]

    expect(referenced.length).toBeGreaterThan(0)
    for (const [, key] of referenced) {
      expect(Object.keys(manifest.user_config)).toContain(key)
    }
  })

  it("hands the server the string \"true\" — a boolean setting has no other spelling", () => {
    const manifest = buildManifest(PKG, TOOLS)

    // Everything the server can ever see in these variables. `AU_LAW_ASIDE` is
    // therefore read as a value, not as presence: it is always set, and it is
    // never "1".
    expect(substituteLikeDesktop(manifest, undefined)).toEqual({ AU_LAW_ASIDE: "false", AU_LAW_ASIDE_COMMAND: "" })
    expect(substituteLikeDesktop(manifest, { aside_followup: true })).toEqual({
      AU_LAW_ASIDE: "true",
      AU_LAW_ASIDE_COMMAND: "",
    })
    expect(substituteLikeDesktop(manifest, { aside_followup: true, aside_command: "/opt/aside" })).toEqual({
      AU_LAW_ASIDE: "true",
      AU_LAW_ASIDE_COMMAND: "/opt/aside",
    })
  })

  it("refuses a setting with no default, which would send the placeholder text to the server", () => {
    const orphan = [{ key: "aside_command", env: "AU_LAW_ASIDE_COMMAND", option: { type: "string", title: "t", description: "d" } }]
    expect(() => asideSettings(orphan)).toThrow(/no default/)
  })

  it("is refusing something real: no default means the literal placeholder reaches the server", () => {
    const manifest = buildManifest(PKG, TOOLS)
    delete manifest.user_config.aside_command.default

    expect(substituteLikeDesktop(manifest, { aside_followup: true }).AU_LAW_ASIDE_COMMAND)
      .toBe("${user_config.aside_command}")
  })

  it("keeps every other manifest field derived from package.json", async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))
    const manifest = buildManifest(pkg, TOOLS)

    expect(manifest.name).toBe(pkg.name)
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.description).toBe(pkg.description)
    expect(manifest.keywords).toEqual(pkg.keywords)
    expect(manifest.license).toBe(pkg.license)
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node)
    // Whole sentences, taken until the summary is long enough to mean something.
    expect(manifest.tools).toEqual([
      { name: "search_all", description: "Search everything at once. Returns ranked hits." },
    ])
  })
})
