#!/usr/bin/env node
// Installed inside the pinned worker image, never executed on the daemon host.
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"

const [role, executable, model, budget = "5"] = process.argv.slice(2)
if (!["grok", "fable", "opus"].includes(role) || !executable || !isAbsolute(executable) ||
    (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) ||
    !/^[0-9]+(?:\.[0-9]+)?$/.test(budget) || Number(budget) <= 0 || Number(budget) > 100) {
  throw new Error("Usage: agent-json.mjs grok|fable|opus /absolute/cli [model] [max-budget-usd]")
}
let input = ""
for await (const chunk of process.stdin) {
  input += chunk
  if (Buffer.byteLength(input) > 1_048_576) throw new Error("Prompt exceeds adapter limit")
}
const payload = JSON.parse(input)
if (!payload.outputSchema || payload.outputSchema.type !== "object") throw new Error("Missing output schema")
const schema = JSON.stringify(payload.outputSchema)
const args = role === "grok" ? [
  "--prompt-file", "/dev/stdin", "--json-schema", schema, "--verbatim",
  "--no-subagents", "--disable-web-search", "--tools", "", "--max-turns", "1", "--permission-mode", "plan",
  ...(model ? ["--model", model] : []),
] : [
  "--print", "--bare", "--no-session-persistence", "--strict-mcp-config",
  "--input-format", "text", "--output-format", "json", "--json-schema", schema,
  "--model", model ?? role, "--max-budget-usd", budget, "--permission-mode", "dontAsk",
  "--tools", role === "fable" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash",
  "--allowedTools", role === "fable" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash",
]
const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: process.env })
let stdout = "", bytes = 0, exceeded = false
const onSignal = () => child.kill("SIGTERM")
process.once("SIGTERM", onSignal)
process.once("SIGINT", onSignal)
const consume = (chunk, capture) => {
  bytes += chunk.byteLength
  if (bytes > 1_048_576) { exceeded = true; child.kill("SIGTERM"); return }
  if (capture) stdout += chunk.toString("utf8")
}
child.stdout.on("data", chunk => consume(chunk, true))
child.stderr.on("data", chunk => consume(chunk, false))
child.stdin.on("error", () => {})
const completed = new Promise((resolve, reject) => {
  child.once("error", () => reject(new Error("Could not start provider CLI")))
  child.once("close", code => code === 0 && !exceeded ? resolve() : reject(new Error("Provider CLI failed or exceeded output limit")))
})
child.stdin.end(input)
await completed
process.removeListener("SIGTERM", onSignal)
process.removeListener("SIGINT", onSignal)
const envelope = JSON.parse(stdout)
if (envelope.is_error || envelope.error) throw new Error("Provider reported an error")
// Current Claude structured output plus explicit Grok/plain-JSON envelopes.
// An unsupported provider format fails closed instead of extracting arbitrary
// markdown or treating a successful process exit as a successful agent result.
const result = envelope.structured_output ?? envelope.result ?? envelope.response ?? envelope
const value = typeof result === "string" ? JSON.parse(result) : result
if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Provider did not return a JSON object")
process.stdout.write(JSON.stringify(value))
