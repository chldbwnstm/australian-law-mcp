import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * Drive one MCP stdio session. Newline-delimited JSON in, newline-delimited
 * JSON out; the request for a step is written only once the previous step has
 * answered, so a server that answers out of order fails loudly rather than
 * being papered over by a buffered write.
 */
export function speakMcp(entryDir, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["build/index.js"], {
      cwd: entryDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    })

    let stdout = ""
    let stderr = ""
    const responses = new Map()
    const timer = setTimeout(() => {
      finish(new Error(`no response within ${timeoutMs} ms`))
    }, timeoutMs)

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    let done = false
    let failure
    /**
     * Resolve only once the child has actually closed. On Windows the temp
     * directory cannot be removed while the process still holds it open, so a
     * resolve on `kill()` alone turns a passing run into an EBUSY failure.
     */
    const finish = (error) => {
      if (done) return
      done = true
      failure = error
      clearTimeout(timer)
      child.kill()
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    // A pipe chunk is not a message boundary. readline retains partial lines;
    // setEncoding above also retains incomplete UTF-8 code points.
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (done) return
      const text = line.trim()
      if (!text) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        finish(new Error("Server stdout contains a non-JSON line"))
        return
      }
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
        finish(new Error("Server stdout contains an invalid JSON-RPC message"))
        return
      }
      if (message.id === undefined) return
      responses.set(message.id, message)
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      }
      if (message.id === 2) finish()
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    child.on("error", finish)
    child.stdin.on("error", finish)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (!done) reject(new Error(`server exited (code ${code}) before answering tools/list\n${stderr}`))
      else resolve({ stdout, stderr, responses })
    })

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcpb-verify", version: "1.0.0" },
      },
    })
  })
}
