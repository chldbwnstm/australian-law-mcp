#!/usr/bin/env node
/**
 * Build the Claude Desktop MCP Bundle.
 *
 *   npm run build:mcpb   →   release/au-law-mcp-<version>.mcpb
 *
 * A bundle is a zip of `manifest.json` + `build/` + production `node_modules`.
 * Claude for macOS and Windows ships its own Node runtime, so a lawyer installs
 * the server by opening one file — no terminal, no `npx`, no Node install.
 *
 * Everything the manifest says about this server is DERIVED, never retyped:
 * the version, description, licence, repository and keywords come from
 * package.json, the runtime floor from `engines.node`, and the advertised tool
 * list from `build/tool-registry.js` filtered by `V3_EXPOSED` — the same set
 * `ListTools` answers with. A hand-written manifest is a second source of truth
 * that drifts silently, and the only symptom is a store listing that disagrees
 * with the server it installs.
 */

import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const STAGING = path.join(ROOT, "dist-mcpb")
const RELEASE = path.join(ROOT, "release")

/** The manifest spec version this file targets. See modelcontextprotocol/mcpb. */
const MANIFEST_VERSION = "0.3"

/** Bundles run inside Claude Desktop, which ships Node on these two platforms. */
const PLATFORMS = ["darwin", "win32"]

/**
 * `npm` and `npx` are `.cmd` shims on Windows, and since the Node 20.12/22
 * command-injection fix `execFileSync` refuses to spawn a `.cmd` without a
 * shell (EINVAL). So Windows goes through cmd.exe, and every argument is
 * quoted — a checkout under `C:\Users\Jane Doe\` would otherwise split.
 */
const WIN = process.platform === "win32"
const quote = (arg) => (WIN && /[\s&|<>^()"]/.test(arg) ? `"${arg}"` : arg)

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`)
  // The command is quoted too: `process.execPath` is `C:\Program Files\nodejs\node.exe`.
  return execFileSync(quote(command), args.map(quote), { stdio: "inherit", cwd: ROOT, shell: WIN, ...options })
}

/**
 * The one-line description a store listing shows for a tool.
 *
 * Whole tool descriptions are paragraphs — they are written for a model reading
 * a tool list, not for a human reading a card. Take whole sentences until there
 * is enough to be meaningful (a 24-character opener like "Four verification
 * modes." tells a reader nothing), then cap the result.
 */
function summarise(description, limit = 140, floor = 60) {
  const flat = description.replace(/\s+/g, " ").trim()
  let out = ""
  for (const sentence of flat.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [flat]) {
    out += sentence
    if (out.trim().length >= floor) break
  }
  out = out.trim()
  if (out.length <= limit) return out
  const hard = out.slice(0, limit - 1)
  const lastSpace = hard.lastIndexOf(" ")
  return `${(lastSpace > limit * 0.6 ? hard.slice(0, lastSpace) : hard).replace(/[\s,;:—-]+$/, "")}…`
}

/** `>=20.19.0` from package.json is already a valid semver range; keep it verbatim. */
function runtimeRange(engines) {
  const node = engines?.node
  if (!node) throw new Error("package.json has no engines.node — the manifest cannot state a runtime floor")
  return node.trim()
}

/**
 * The settings Claude Desktop renders for this extension, and the environment
 * variables they set.
 *
 * A Chat user has no config file to edit — `claude_desktop_config.json` is not
 * a thing a lawyer opens, and the app loads extensions only, not this project's
 * `.mcp.json` or its skills. `user_config` is the whole mechanism by which such
 * a user turns anything on, so a capability that is not declared here is, for
 * that user, a capability that does not exist.
 *
 * One table, two derived halves. The `user_config` block is what the app
 * renders; `server.mcp_config.env` is how the chosen values reach the server
 * process. Writing the placeholders out separately is how they come to name a
 * setting that was renamed or removed — and the substitution fails silently
 * (see `default` below), so the symptom is a feature that is off, or on, for no
 * reason the user can see.
 *
 * Every option carries a `default`. Claude Desktop only defines
 * `${user_config.<key>}` for keys that have a stored value **or** a manifest
 * default; a placeholder naming neither is left in the string verbatim, so the
 * server would receive the literal text `${user_config.aside_command}` as a
 * path. Verified against the reference implementation in
 * `@anthropic-ai/mcpb` 2.1.2 (`dist/shared/config.js`), which also converts a
 * boolean to the *string* `"true"` or `"false"` — never an absent variable.
 * `AU_LAW_ASIDE=false` is therefore what "off" looks like to the server, and
 * the server must read it as a value, not as mere presence.
 */
const USER_SETTINGS = [
  {
    key: "aside_followup",
    env: "AU_LAW_ASIDE",
    option: {
      type: "boolean",
      title: "Finish blocked legal sources using the Aside browser (Mac only)",
      description:
        "Off by default. Some publishers refuse this server outright — the Federal Court's judgment " +
        "site and AustLII among them — and those searches come back as a blocked source with a link, " +
        "not as results. Turn this on and the server may finish those lookups by driving Aside, the " +
        "browser app on this Mac, using the legal sites you are already signed in to. Because that is " +
        "a real browser holding your sessions, the server may only send it to legal-source addresses. " +
        "Requires macOS with Aside installed; with Aside absent this setting does nothing.",
      required: false,
      default: false,
    },
  },
  {
    key: "aside_command",
    env: "AU_LAW_ASIDE_COMMAND",
    option: {
      type: "string",
      title: "Aside CLI path (optional)",
      description:
        "Leave blank unless Aside is installed somewhere other than the standard location, which the " +
        "server finds on its own. If you moved it, give the full path to the Aside command line tool, " +
        "e.g. /Users/you/.aside/cli/Aside CLI.app/Contents/MacOS/aside. Ignored while the setting " +
        "above is off.",
      required: false,
      default: "",
    },
  },
]

/** `user_config` and the `env` placeholders, derived from one table so they cannot disagree. */
export function asideSettings(settings = USER_SETTINGS) {
  const userConfig = {}
  const env = {}
  for (const { key, env: variable, option } of settings) {
    if (option.default === undefined) {
      throw new Error(
        `user_config.${key} declares no default — an unset optional value leaves the literal ` +
        `"\${user_config.${key}}" in ${variable} instead of an empty value`,
      )
    }
    // Cloned: the manifest is data handed to a serialiser, and nothing that
    // touches it afterwards should be able to reach back into this table.
    userConfig[key] = structuredClone(option)
    env[variable] = `\${user_config.${key}}`
  }
  return { userConfig, env }
}

/**
 * The advertised tool list, read from the freshly built output so the manifest
 * can never advertise a tool list the shipped server does not answer with.
 */
export async function loadExposedTools(root = ROOT) {
  const registry = await import(pathToFileURL(path.join(root, "build", "tool-registry.js")).href)
  const profiles = await import(pathToFileURL(path.join(root, "build", "lib", "tool-profiles.js")).href)
  const exposed = registry.allTools.filter((tool) => profiles.V3_EXPOSED.has(tool.name))

  if (exposed.length !== registry.TOOL_COUNTS.exposed) {
    throw new Error(`exposed filter returned ${exposed.length}, TOOL_COUNTS says ${registry.TOOL_COUNTS.exposed}`)
  }
  return exposed
}

export function buildManifest(pkg, exposed) {
  const repositoryUrl = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "")
  const { userConfig, env } = asideSettings()

  return {
    manifest_version: MANIFEST_VERSION,
    name: pkg.name,
    display_name: "Australian Law",
    version: pkg.version,
    description: pkg.description,
    author: { name: "chldbwnstm", url: "https://github.com/chldbwnstm" },
    homepage: pkg.homepage,
    documentation: repositoryUrl ? `${repositoryUrl}#readme` : undefined,
    support: pkg.bugs?.url,
    icon: "icon.png",
    repository: pkg.repository ? { type: pkg.repository.type ?? "git", url: pkg.repository.url } : undefined,
    server: {
      type: "node",
      entry_point: "build/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/build/index.js"],
        env,
      },
    },
    tools: exposed.map((tool) => ({ name: tool.name, description: summarise(tool.description) })),
    tools_generated: false,
    user_config: userConfig,
    keywords: pkg.keywords,
    license: pkg.license,
    compatibility: {
      platforms: PLATFORMS,
      runtimes: { node: runtimeRange(pkg.engines) },
    },
  }
}

async function stage(manifest) {
  await rm(STAGING, { recursive: true, force: true })
  await mkdir(STAGING, { recursive: true })

  // Compiled output only. Nothing here should exist in build/ — tsconfig excludes
  // tests and emits no source maps — but a staging filter that assumes the
  // compiler's current settings is the kind of thing that quietly stops holding.
  await cp(path.join(ROOT, "build"), path.join(STAGING, "build"), {
    recursive: true,
    filter: (src) => !/\.map$|\.test\.js$|[\\/]__fixtures__([\\/]|$)/.test(src),
  })

  // `src/version.ts` resolves `../package.json` from build/, so package.json must
  // sit beside build/ or the server reports an undefined version at startup.
  await cp(path.join(ROOT, "package.json"), path.join(STAGING, "package.json"))
  await cp(path.join(ROOT, "package-lock.json"), path.join(STAGING, "package-lock.json"))
  await cp(path.join(ROOT, "LICENSE"), path.join(STAGING, "LICENSE"))
  await cp(path.join(ROOT, "NOTICE"), path.join(STAGING, "NOTICE"))
  await cp(path.join(ROOT, "docs", "assets", "icon.png"), path.join(STAGING, "icon.png"))

  await writeFile(
    path.join(STAGING, ".mcpbignore"),
    ["# Nothing here is read at runtime.", "*.map", "*.test.js", "__fixtures__/", "*.md", ""].join("\n"),
  )

  await writeFile(path.join(STAGING, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  // Production dependencies only: @modelcontextprotocol/sdk, commander, dotenv,
  // express, zod and their transitive deps. --ignore-scripts because a bundle is
  // shipped to someone else's machine and must not carry install-time hooks.
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: STAGING })
  await rm(path.join(STAGING, "package-lock.json"), { force: true })

  console.log(`\nStaged ${await countFiles(STAGING)} files in dist-mcpb/`)
}

async function countFiles(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += 1
  }
  return total
}

async function main() {
  if (!existsSync(path.join(ROOT, "package-lock.json"))) {
    throw new Error("package-lock.json is missing — `npm ci` inside the staging directory needs it")
  }

  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))

  run("npm", ["run", "build"])

  const manifest = buildManifest(pkg, await loadExposedTools())
  await stage(manifest)

  await mkdir(RELEASE, { recursive: true })
  const bundle = path.join(RELEASE, `${pkg.name}-${pkg.version}.mcpb`)
  await rm(bundle, { force: true })

  run("npx", ["-y", "@anthropic-ai/mcpb", "pack", "dist-mcpb", path.relative(ROOT, bundle)])
  run("npx", ["-y", "@anthropic-ai/mcpb", "validate", "dist-mcpb/manifest.json"])
  run("npx", ["-y", "@anthropic-ai/mcpb", "info", path.relative(ROOT, bundle)])

  const bytes = (await stat(bundle)).size
  console.log(`\nBundle: ${path.relative(ROOT, bundle)} — ${(bytes / 1024 / 1024).toFixed(2)} MiB`)
  console.log(`Advertised tools: ${manifest.tools.map((t) => t.name).join(", ")}`)
  console.log(`Extension settings: ${Object.keys(manifest.user_config).join(", ")}`)

  // The bundle is not the thing that runs — the unpacked copy is. Verify that.
  run(process.execPath, [path.join("scripts", "verify-mcpb.mjs"), path.relative(ROOT, bundle)])
}

// Running this file builds and packs; importing it (the manifest tests) must not.
// `npm ci`, `npm run build` and an `npx` download are not things a test suite does.
// Compared through realpath, not `path.resolve`: the wrong answer here is silent
// either way — a build that does nothing and exits 0, or a test run that starts
// by rebuilding the project — and a checkout reached through a symlinked path is
// the ordinary case on macOS (`/tmp`) and in worktrees.
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(entry) === realpathSync(self)
  } catch {
    return path.resolve(entry) === self
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(`\nbuild:mcpb failed — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
