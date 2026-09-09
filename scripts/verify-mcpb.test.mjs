import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
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
