import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from "node:fs"
import { release, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { speakMcp } from "./mcp-stdio.mjs"

/**
 * Which hosts a live run may start on: the two platforms Aside ships a
 * browser for, and on Windows only x64 — the CLI installer refuses ARM64, so
 * a run there would spawn nothing and report every case as unresolved, which
 * reads as a source problem rather than the host problem it is. Pure, so the
 * offline test can drive it without opening a browser.
 */
export function liveAsideHost(platform = process.platform, cpu = process.arch) {
  if (platform === "darwin") return { ok: true }
  if (platform === "win32") return cpu === "x64" ? { ok: true } : { ok: false, reason: `Aside for Windows is x64 only; this Node is ${cpu}` }
  return { ok: false, reason: `Live Aside verification requires local macOS or Windows x64; the Aside browser has no ${platform} build` }
}

/** The browser must already be running: the CLI never launches it (measured 2026-09-14, it fails with "not connected to the daemon"). */
function browserRunning() {
  try {
    if (process.platform === "win32") return /\bAside\.exe\b/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq Aside.exe", "/NH"], { encoding: "utf8", windowsHide: true }))
    execFileSync("pgrep", ["-x", "Aside"], { stdio: "ignore" })
    return true
  } catch { return false }
}

/** Importable offline: only main() opens public pages through the built MCP server. */
export function inspectAsideResult(message, expected = {}) {
  assert.ok(message?.result && !message.error, "MCP must answer with a tool result")
  const result = message.result
  const text = result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? ""
  const followup = result.structuredContent?.followup
  const reasons = /(?:^|\n)Reasons:\n/.test(text)
  const source = /^Source: (https:\/\/\S+)/m.exec(text)?.[1]
  const citation = /^Citation: (.+)$/m.exec(text)?.[1]
  const hits = [...text.matchAll(/^\d+\. (.+)\n\s+(https:\/\/\S+)/gm)].map(match => ({
    title: match[1], url: match[2], citation: /\[\d{4}\]\s+[A-Za-z][A-Za-z0-9.]+\s+\d+/.exec(match[1])?.[0],
  }))
  const browser = /Retrieved via: Aside/.test(text)
  const unavailable = followup?.pending === true && !reasons && hits.length === 0
  const empty = /publisher reports no documents for this query/i.test(text)
  if (reasons) {
    assert.ok(!result.isError && browser && source, "Reasons require successful browser retrieval and a source")
    assert.ok(!/^===.*(?:Page Not Found|Just a moment|Access Denied)/im.test(text), "Error pages must never be reasons")
    if (expected.citation) assert.equal(citation?.toUpperCase(), expected.citation.toUpperCase(), "Exact judgment identity")
    if (/\[TRUNCATED\]|Response truncated|⋯ omitted/.test(text)) {
      assert.ok(followup?.pending && followup.gaps.some(gap => gap.kind === "truncated" && gap.target.citation === citation && gap.sourceUrls.includes(source)), "Omitted reasons need a source-linked citation gap")
    }
  }
  for (const hit of hits) {
    assert.ok(hit.citation, "A search row must identify a judgment")
    const url = new URL(hit.url)
    assert.match(url.hostname, /(?:^|\.)austlii\.edu\.au$/)
    if (expected.court) assert.match(hit.citation, new RegExp(`\\] ${expected.court} \\d+$`, "i"))
    if (expected.jurisdiction) assert.match(url.pathname, new RegExp(`/au/cases/${expected.jurisdiction.toLowerCase()}/`, "i"))
  }
  if (hits.length) {
    assert.ok(browser && !result.isError)
    if (expected.page) assert.ok(text.includes(`Result page: ${expected.page};`))
  }
  const documentLink = browser && citation && source && !reasons && followup?.gaps.some(gap => gap.kind === "document_body" && gap.sourceUrls.some(url => /\.pdf$/i.test(url)))
  const status = reasons ? "retrieved" : documentLink ? "document_link" : hits.length ? "search_results" : empty ? "query_empty" : unavailable ? "unresolved" : "unexpected"
  assert.notEqual(status, "unexpected", `Unclassified response: ${text.slice(0,800)}`)
  if (expected.noReasons) assert.equal(reasons, false, "A nonexistent/unavailable citation must not acquire a document")
  return { status, citation, source, hits, browser, pending: followup?.pending ?? false, chars: text.length, serializedChars: JSON.stringify(result).length, gaps: followup?.gaps ?? [] }
}

export async function main() {
  assert.equal(process.env.LIVE_ASIDE, "1", "Opt in with LIVE_ASIDE=1; this check opens public pages in your local Aside browser")
  const host = liveAsideHost()
  assert.ok(host.ok, host.reason)
  assert.match(process.env.AU_LAW_ASIDE ?? "", /^(1|true|yes|on)$/i, "Set AU_LAW_ASIDE=true")
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const output = path.resolve(process.env.ASIDE_REPORT_DIR ?? path.join(tmpdir(), `au-law-aside-${process.platform}-${Date.now()}`))
  mkdirSync(output, { recursive: true })
  // The same resolver the server uses, so the report names the CLI that was
  // actually driven and its version — what makes a Windows record comparable
  // to a macOS one.
  const { asideStatus } = await import(new URL("../build/lib/sources/aside-browser.js", import.meta.url).href)
  const status = asideStatus()
  const asideCliVersion = status.command ? (() => { try { return execFileSync(status.command, ["--version"], { encoding: "utf8", windowsHide: true }).trim() } catch { return "unknown" } })() : undefined
  const report = {
    startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    osRelease: process.platform === "win32" ? release() : undefined,
    asideCommand: status.command ?? `(not found: ${status.reason})`, asideCliVersion,
    browserRunningAtStart: browserRunning(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    version: JSON.parse(readFileSync(path.join(root,"package.json"), "utf8")).version,
    note: "Point-in-time live observations from built source, not an installer certification or guarantee of publisher availability.",
    cases: [],
  }
  const run = async (id, name, args, expected) => {
    const start = Date.now()
    let observation
    try {
      const { responses } = await speakMcp(root, 240_000, { method: "tools/call", params: { name, arguments: args } })
      const message = responses.get(3)
      writeFileSync(path.join(output, `${id}.json`), JSON.stringify(message, null, 2))
      observation = { id, name, args, ...inspectAsideResult(message, expected) }
    } catch (error) { observation = { id, name, args, status: "failed", failure: String(error) } }
    observation.seconds = Math.round((Date.now() - start) / 10) / 100
    report.cases.push(observation)
    writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2))
    console.log(`${id}: ${observation.status} (${observation.seconds}s)${observation.failure ? ` — ${observation.failure}` : ""}`)
    return observation
  }
  for (const [id, citation, full, canonical] of [
    ["tpg-full", "[2020] FCAFC 130", true],
    ["tpg-compact", "[2020] FCAFC 130", false],
    ["tpg-pinpoint", "[2020] F.C.A.F.C. 130 at [38]", false, "[2020] FCAFC 130"],
    ["tpg-first-instance", "[2019] FCA 1677", false],
    ["mussalli", "[2021] FCAFC 71", false],
    ["gujarat", "[2013] FCAFC 109", false],
    ["vcat-reasons", "[2024] VCAT 199", false],
    ["vsc-older-reasons", "[1999] VSC 110", false],
  ]) await run(id, "get_case_text", { citation, full }, { citation: canonical ?? citation })
  const first = await run("fcafc-page1", "search_cases", { query: "prepayment", court: "FCAFC", limit: 3 }, { court: "FCAFC", page: 1 })
  const second = await run("fcafc-page2", "search_cases", { query: "prepayment", court: "FCAFC", limit: 3, page: 2 }, { court: "FCAFC", page: 2 })
  if (first.hits?.length && second.hits?.length && first.hits.map(hit => hit.citation).join() === second.hits.map(hit => hit.citation).join()) {
    second.status = "failed"; second.failure = "Page two repeated page one"
  }
  if (second.hits?.[0]?.citation) await run("search-to-judgment", "get_case_text", { citation: second.hits[0].citation }, { citation: second.hits[0].citation })
  await run("fca-alias", "search_cases", { query: "prepayment", court: "Federal Court of Australia", limit: 3 }, { court: "FCA" })
  const vic = await run("victoria", "search_cases", { query: "contract", jurisdiction: "Victoria", limit: 3 }, { jurisdiction: "Vic" })
  if (vic.hits?.[0]?.citation) await run("victoria-judgment", "get_case_text", { citation: vic.hits[0].citation }, { citation: vic.hits[0].citation })
  const wa = await run("western-australia", "search_cases", { query: "negligence", jurisdiction: "WA", limit: 3 }, { jurisdiction: "WA" })
  if (wa.hits?.[0]?.citation) await run("wa-judgment", "get_case_text", { citation: wa.hits[0].citation }, { citation: wa.hits[0].citation })
  const family = await run("family-court", "search_cases", { query: "property", court: "family court", limit: 3 }, { court: "FedCFamC1F" })
  if (family.hits?.[0]?.citation) await run("family-judgment", "get_case_text", { citation: family.hits[0].citation }, { citation: family.hits[0].citation })
  for (const jurisdiction of ["SA", "Tas", "ACT", "NT"]) {
    await run(`jurisdiction-${jurisdiction.toLowerCase()}`, "search_cases", { query: "contract", jurisdiction, limit: 3 }, { jurisdiction })
  }
  await run("empty-query", "search_cases", { query: "zzzx_au_law_robustness_20260913", court: "FCAFC" }, { court: "FCAFC", noReasons: true })
  await run("missing-citation", "get_case_text", { citation: "[2020] FCAFC 99999" }, { noReasons: true })
  const required = ["tpg-full", "tpg-compact", "tpg-pinpoint", "tpg-first-instance", "mussalli", "gujarat", "vcat-reasons", "vsc-older-reasons", "fcafc-page1", "fcafc-page2", "search-to-judgment"]
  report.requiredMissing = required.filter(id => !report.cases.some(item => item.id === id && ["retrieved", "search_results"].includes(item.status)))
  report.finishedAt = new Date().toISOString()
  report.passed = !report.requiredMissing.length && report.cases.every(item => item.status !== "failed")
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2))
  console.log(`Report: ${path.join(output, "report.json")}`)
  if (!report.passed) process.exitCode = 1
  return report
}

// Compared through realpath, as build-mcpb.mjs does: a silent no-op exit 0 is
// the worst outcome for a verification script, and `path.resolve` disagrees
// with the module URL through a symlinked /tmp on macOS or a junction on Windows.
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  try { return realpathSync(entry) === realpathSync(self) } catch { return path.resolve(entry) === self }
}

if (invokedDirectly()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
