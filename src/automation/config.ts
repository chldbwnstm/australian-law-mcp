import { readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"

const text = z.string().min(1).max(16_000)
const absolute = z.string().refine(p => isAbsolute(p) && !/[\x00-\x1f,]/.test(p), "Expected an absolute path without control characters or commas")
export const safePath = z.string().min(1).max(240).refine(p =>
  !p.startsWith("/") && !/[\\:\x00-\x1f]/.test(p) &&
  p.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git"),
"Expected a relative file path without traversal")
const command = z.object({
  executable: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/),
  argv: z.array(z.string().max(2000).refine(s => !s.includes("\0"))).max(40),
}).strict()
const check = z.object({
  name: text,
  appId: z.number().int().positive(),
  target: z.enum(["head", "merge"]),
}).strict()

export const configSchema = z.object({
  enabled: z.boolean().default(false),
  owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  baseBranch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/).refine(s => !s.includes("//")),
  botLogin: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/),
  stateDir: absolute,
  gitExecutable: absolute.default("/usr/bin/git"),
  candidateLabel: z.string().min(1).max(50).default("agent-candidate"),
  approvalLabel: z.string().min(1).max(50).default("agent-approved"),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
  maxIssuesPerPoll: z.number().int().min(1).max(20).default(3),
  maxActiveRuns: z.number().int().min(1).max(100).default(10),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  maxInfrastructureFailures: z.number().int().min(1).max(30).default(8),
  workerTimeoutSeconds: z.number().int().min(1).max(3600).default(900),
  maxWorkerCalls: z.number().int().min(3).max(30).default(8),
  maxReservedWorkerSeconds: z.number().int().min(1).max(86_400).default(7200),
  runTimeoutSeconds: z.number().int().min(60).max(604_800).default(86_400),
  checkTimeoutSeconds: z.number().int().min(30).max(86_400).default(3600),
  maxChangedFiles: z.number().int().min(1).max(200).default(30),
  maxSnapshotBytes: z.number().int().min(1024).max(268_435_456).default(67_108_864),
  maxSnapshotFiles: z.number().int().min(1).max(20_000).default(5000),
  allowedPaths: z.array(safePath).min(1).max(100),
  maxRisk: z.enum(["low", "medium"]).default("low"),
  requiredChecks: z.array(check).min(1).max(30),
  codeRabbit: z.object({
    checkName: text, appId: z.number().int().positive(), reviewerId: z.number().int().positive(),
    surface: z.enum(["check", "status"]).default("check"),
  }).strict(),
  sandbox: z.object({
    executable: absolute.default("/usr/bin/docker"),
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/),
    network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).refine(n => !["host", "bridge", "default"].includes(n)).default("none"),
    memoryMb: z.number().int().min(128).max(16_384).default(2048),
    cpus: z.number().min(0.1).max(16).default(2),
    secretNames: z.array(z.enum(["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"])).default([]),
    grok: command,
    fable: command,
    opus: command,
  }).strict(),
  autoMerge: z.literal(false).default(false),
}).strict().superRefine((c, ctx) => {
  if (c.candidateLabel === c.approvalLabel || [c.candidateLabel, c.approvalLabel].some(l => stageLabels.includes(l))) {
    ctx.addIssue({ code: "custom", message: "Input labels must be distinct from each other and from managed status labels" })
  }
  const names = c.requiredChecks.map(c => c.target + ":" + c.appId + ":" + c.name)
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "Duplicate required checks" })
  if (c.enabled && (c.sandbox.image.endsWith("0".repeat(64)) || c.botLogin.startsWith("REPLACE-"))) {
    ctx.addIssue({ code: "custom", message: "Replace example image and bot identity before enabling live automation" })
  }
})

export type Config = z.infer<typeof configSchema>
export const stageLabels = ["agent-triage", "agent-awaiting-approval", "agent-design", "agent-implementing",
  "agent-awaiting-checks", "agent-needs-human", "agent-cancelled", "ready-for-merge"]
export const triageSchema = z.object({ summary: text, eligible: z.boolean(), risk: z.enum(["low", "medium", "high"]) }).strict()
export const designSchema = z.object({
  summary: text, risk: z.enum(["low", "medium", "high"]),
  files: z.array(safePath).min(1).max(200),
  acceptanceCriteria: z.array(text).min(1).max(30),
  testPlan: z.array(text).min(1).max(30),
}).strict()
export const implementationSchema = z.object({ summary: text, tests: z.array(text).min(1).max(50) }).strict()
export type Design = z.infer<typeof designSchema>
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
export function loadConfig(path: string): Config {
  return configSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export class PolicyError extends Error {}

// These restrictions cannot be weakened by an issue, an agent, or config.allowedPaths.
export function assertAllowedPath(path: string, config: Config, design?: Design): void {
  const valid = safePath.safeParse(path)
  const blocked = /(^|\/)(?:\.git[^/]*|\.github|\.env[^/]*|AGENTS\.md|CLAUDE\.md|node_modules)(\/|$)/i.test(path) ||
    /^(?:automation|src\/automation|scripts|build|build-automation|companion)(\/|$)/.test(path) ||
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|.*lock.*|tsconfig[^/]*|vitest[^/]*|\.coderabbit\.yaml)$/.test(path)
  const allowed = config.allowedPaths.some(p => path === p || path.startsWith(p + "/"))
  if (!valid.success || blocked || !allowed || (design && !design.files.includes(path))) {
    throw new PolicyError("File outside approved policy: " + path)
  }
}
export function assertDesign(design: Design, config: Config): void {
  if (design.risk === "high" || (design.risk === "medium" && config.maxRisk === "low")) throw new PolicyError("Design risk requires a human")
  if (new Set(design.files).size !== design.files.length || design.files.length > config.maxChangedFiles) throw new PolicyError("Invalid design file count")
  for (const path of design.files) assertAllowedPath(path, config)
}
