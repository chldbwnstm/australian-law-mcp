#!/usr/bin/env node
/**
 * Prove the packed bundle actually runs.
 *
 *   node scripts/verify-mcpb.mjs [release/au-law-mcp-<version>.mcpb]
 *
 * The staging directory is not what a user installs — the unpacked zip is. So
 * this unpacks the .mcpb somewhere else entirely, starts `node build/index.js`
 * from there exactly as Claude Desktop's `mcp_config` would, and speaks real
 * MCP stdio at it: `initialize`, `notifications/initialized`, `tools/list`.
 *
 * What it establishes:
 *   - the entry point resolves its dependencies from the bundled node_modules
 *   - `src/version.ts` still finds package.json beside build/ (serverInfo.version)
 *   - ListTools answers with exactly the tools the manifest advertises
 *   - nothing writes to stdout but JSON-RPC — one stray `console.log` corrupts
 *     the framing and the client's error points nowhere near the cause
 */

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { speakMcp } from "./mcp-stdio.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// See scripts/build-mcpb.mjs: on Windows `npx` is a `.cmd` shim and execFileSync
// will not spawn one without a shell, so arguments are quoted for cmd.exe.
const WIN = process.platform === "win32"
const quote = (arg) => (WIN && /[\s&|<>^()"]/.test(arg) ? `"${arg}"` : arg)

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}


async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))
  const bundle = path.resolve(ROOT, process.argv[2] ?? path.join("release", `${pkg.name}-${pkg.version}.mcpb`))

  console.log(`\nVerifying ${path.relative(ROOT, bundle)}`)

  const workDir = await mkdtemp(path.join(os.tmpdir(), "mcpb-verify-"))
  const extracted = path.join(workDir, "bundle")
  try {
    // `mcpb unpack` rather than tar or PowerShell: it is the same CLI that
    // packed the file and it behaves the same on Windows and macOS.
    execFileSync("npx", ["-y", "@anthropic-ai/mcpb", "unpack", bundle, extracted].map(quote), {
      stdio: "inherit",
      shell: WIN,
    })

    const manifest = JSON.parse(await readFile(path.join(extracted, "manifest.json"), "utf8"))
    const entries = await readdir(extracted, { withFileTypes: true, recursive: true })
    const fileCount = entries.filter((entry) => entry.isFile()).length

    console.log(`  unpacked ${fileCount} files\n`)

    check("manifest version matches package.json", manifest.version === pkg.version, manifest.version)
    check("entry point is build/index.js", manifest.server.entry_point === "build/index.js")
    // Exact, not `includes`: an accidental "linux" would advertise the Aside
    // switch on a platform Aside ships no browser for.
    const platforms = [...(manifest.compatibility?.platforms ?? [])].sort()
    check("manifest declares exactly darwin and win32", JSON.stringify(platforms) === JSON.stringify(["darwin", "win32"]), platforms.join(", "))
    const switchTitle = manifest.user_config?.aside_followup?.title ?? ""
    check("the Aside switch is not labelled for one platform", !/\b(?:mac|windows|pc)[ -]only\b/i.test(switchTitle), switchTitle)

    const { stdout, stderr, responses } = await speakMcp(extracted)

    const init = responses.get(1)?.result
    check("initialize returned a result", Boolean(init))
    check("serverInfo.name is present", Boolean(init?.serverInfo?.name), init?.serverInfo?.name)
    check(
      "serverInfo.version matches package.json",
      init?.serverInfo?.version === pkg.version,
      `${init?.serverInfo?.version} vs ${pkg.version}`,
    )

    const listed = responses.get(2)?.result?.tools ?? []
    const listedNames = listed.map((tool) => tool.name).sort()
    const manifestNames = (manifest.tools ?? []).map((tool) => tool.name).sort()

    check(
      `tools/list returned ${manifestNames.length} tools`,
      listedNames.length === manifestNames.length,
      `${listedNames.length} listed`,
    )
    check(
      "tools/list names equal the manifest's tools[]",
      JSON.stringify(listedNames) === JSON.stringify(manifestNames),
      listedNames.join(", "),
    )

    const nonJson = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        try {
          JSON.parse(line)
          return false
        } catch {
          return true
        }
      })
    check("stdout carries JSON-RPC lines only", nonJson.length === 0, nonJson[0]?.slice(0, 120))

    const trace = stderr.split("\n").find((line) => /^\s+at\s|\bUnhandled|\bError:/.test(line))
    check("stderr carries no stack trace", !trace, trace?.trim().slice(0, 120))

    // The extension switch, end to end and offline. With the fallback on and
    // the CLI path pointing nowhere, a Federal Court lookup — a source the
    // server never fetches itself — must come back as the blocked-source note
    // that names the configured path, on whichever platform this runs. A
    // server that still gated on macOS would answer "requires macOS" here on
    // Windows, and the switch a Windows user sees would be a control that does
    // nothing. No browser is involved: the path does not exist.
    const missingCli = path.join(workDir, WIN ? "no-such\\aside.exe" : "no-such/aside")
    const probe = await speakMcp(
      extracted,
      undefined,
      { method: "tools/call", params: { name: "get_case_text", arguments: { citation: "[2020] FCAFC 130" } } },
      { env: { AU_LAW_ASIDE: "true", AU_LAW_ASIDE_COMMAND: missingCli } },
    )
    const answer = (probe.responses.get(3)?.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
    check(
      "switch on + missing CLI answers the blocked-source note naming that path, not a platform refusal",
      /\[UPSTREAM_BLOCKED\]/.test(answer) && answer.includes(missingCli) && !/requires macOS|macOS and Windows only/i.test(answer),
      answer.replace(/\s+/g, " ").slice(0, 200),
    )
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} check(s) failed: ${failures.join("; ")}`)
    process.exit(1)
  }
  console.log("\nPASS — the packed bundle unpacks, starts, and advertises the manifest's tools.")
}

main().catch((error) => {
  console.error(`\nFAIL — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
