import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { listToolsPayload } from "../build/tool-registry.js"
import { VERSION } from "../build/version.js"
import { speakMcp } from "./mcp-stdio.mjs"

// The same driver used for the unpacked desktop bundle, run without a bundle
// dependency so CI checks the actual process entry point on every platform.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { responses } = await speakMcp(root)
assert.equal(responses.get(1)?.result?.serverInfo?.version, VERSION)
assert.deepEqual(responses.get(2)?.result, listToolsPayload())
console.log(`PASS — stdio starts and advertises ${listToolsPayload().tools.length} tools for ${VERSION}.`)
