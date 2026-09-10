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
const { responses } = await speakMcp(root, undefined, {
  method: "tools/call",
  params: {
    name: "plan_research_followup",
    arguments: {
      gaps: [smokeGap],
      policy: { mode: "missing_sources", browser: "aside", maxPages: 2, maxDocuments: 1, maxElapsedSeconds: 60, useAuthorizedAccounts: false },
      eligibility: { probe: "local_companion", execution: "local", platform: "darwin", osVersion: "15.1", asideConnected: true, asideTools: ["repl"] },
      scope: { matter: "stdio verification", jurisdictions: ["Cth"] },
    },
  },
})
assert.equal(responses.get(1)?.result?.serverInfo?.version, VERSION)
assert.deepEqual(responses.get(2)?.result, listToolsPayload())
assert.equal(responses.get(3)?.result?.structuredContent?.followup?.schemaVersion, "1.0")
assert.equal(responses.get(3)?.result?.structuredContent?.followup?.tasks?.[0]?.route, "aside_repl")
console.log(`PASS — stdio starts, advertises ${listToolsPayload().tools.length} tools for ${VERSION}, and preserves follow-up metadata.`)
