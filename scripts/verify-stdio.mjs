import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { listToolsPayload } from "../build/tool-registry.js"
import { VERSION } from "../build/version.js"
import { speakMcp } from "./mcp-stdio.mjs"

// The same driver used for the unpacked desktop bundle, run without a bundle
// dependency so CI checks the actual process entry point on every platform.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const smokeGap = {
  id: "gap_stdio_smoke", kind: "document_body", originTool: "verify_stdio", target: { documentId: "public" },
  reason: "The original body still needs inspection.", sourceUrls: ["https://www.legislation.gov.au/"],
  sourceAccess: "permitted", evidenceNeeded: ["Original body and locator"],
}
const policy = { mode: "missing_sources", browser: "aside", maxPages: 2, maxDocuments: 1, maxElapsedSeconds: 60, useAuthorizedAccounts: false }
const scope = { matter: "stdio verification", jurisdictions: ["Cth"] }

// One planner call per simulated host: the two Aside platforms plan a browser
// task, and a platform Aside ships no browser for keeps the gap and plans none.
// The probe is data the companion supplies, so the host running this script
// is irrelevant — which is the point: the darwin and win32 rows both pass on
// ubuntu and on windows-latest, or neither does.
const probes = [
  { platform: "darwin", osVersion: "15.1", browserTask: true },
  { platform: "win32", osVersion: "10.0.26200", browserTask: true },
  { platform: "linux", osVersion: "6.8", browserTask: false },
]
let handshake
for (const { platform, osVersion, browserTask } of probes) {
  const { responses } = await speakMcp(root, undefined, {
    method: "tools/call",
    params: {
      name: "plan_research_followup",
      arguments: {
        gaps: [smokeGap],
        policy,
        eligibility: { probe: "local_companion", execution: "local", platform, osVersion, asideConnected: true, asideTools: ["repl"] },
        scope,
      },
    },
  })
  handshake ??= responses
  const followup = responses.get(3)?.result?.structuredContent?.followup
  assert.equal(followup?.schemaVersion, "1.0", `${platform}: follow-up envelope`)
  if (browserTask) assert.equal(followup?.tasks?.[0]?.route, "aside_repl", `${platform} ${osVersion} must plan a browser task`)
  else {
    assert.equal(followup?.tasks, undefined, `${platform} must not plan a browser task`)
    assert.equal(followup?.pending, true, `${platform} keeps the gap pending`)
    assert.equal(followup?.gaps?.length, 1, `${platform} retains the gap`)
  }
}
assert.equal(handshake.get(1)?.result?.serverInfo?.version, VERSION)
assert.deepEqual(handshake.get(2)?.result, listToolsPayload())
console.log(`PASS — stdio starts, advertises ${listToolsPayload().tools.length} tools for ${VERSION}, plans browser follow-up for macOS and Windows probes, and keeps a Linux probe on standard research.`)
