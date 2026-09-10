import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { designSchema, shaSchema, triageSchema } from "./config.js"

export const stages = ["triage", "awaiting-approval", "design", "implement", "running", "publish", "checks", "ready", "needs-human", "cancelled"] as const
export const runSchema = z.object({
  id: z.string().uuid(), issueNumber: z.number().int().positive(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(stages), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  triage: triageSchema.optional(), triagedAt: z.string().datetime().optional(),
  approval: z.object({ eventId: z.number().int(), actorId: z.number().int(), login: z.string(), approvedAt: z.string().datetime() }).optional(),
  startedAt: z.string().datetime().optional(), design: designSchema.optional(),
  baseSha: shaSchema.optional(), headSha: shaSchema.optional(), pushedSha: shaSchema.optional(),
  branch: z.string().regex(/^agent\/issue-[0-9]+-[a-f0-9-]+$/),
  prNumber: z.number().int().positive().optional(),
  attempts: z.number().int().nonnegative(), workerCalls: z.number().int().nonnegative(),
  reservedWorkerSeconds: z.number().int().nonnegative(),
  infrastructureFailures: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime().optional(), checksSince: z.string().datetime().optional(),
  feedback: z.string().max(32_000).optional(), reason: z.string().max(2000).optional(),
  labelsSynced: z.boolean().default(false),
}).strict().superRefine((run, ctx) => {
  const require = (condition: boolean, message: string) => {
    if (!condition) ctx.addIssue({ code: "custom", message })
  }
  if (run.stage === "awaiting-approval" || ["design", "implement", "running", "publish", "checks", "ready"].includes(run.stage)) {
    require(Boolean(run.triage && run.triagedAt), "Active run has no recorded triage")
  }
  if (["design", "implement", "running", "publish", "checks", "ready"].includes(run.stage)) {
    require(Boolean(run.approval && run.startedAt), "Active run has no bound approval")
  }
  if (["implement", "running", "publish", "checks", "ready"].includes(run.stage)) {
    require(Boolean(run.design && run.baseSha), "Implementation has no design or base")
  }
  if (["publish", "checks", "ready"].includes(run.stage)) require(Boolean(run.headSha), "Published run has no implementation commit")
  if (["checks", "ready"].includes(run.stage)) require(Boolean(run.prNumber && run.checksSince), "Quality gate has no PR or deadline")
})
export type Run = z.infer<typeof runSchema>
const documentSchema = z.object({ version: z.literal(1), runs: z.array(runSchema) }).strict()
export interface RunStore { all(): Run[]; save(run: Run): void }

// A single local daemon owns this journal. Deliberately never steals a stale lock:
// an operator must stop/reap workers before recovering from SIGKILL or host failure.
export class FileStore implements RunStore {
  private runs: Run[] = []
  private locked = false
  constructor(readonly directory: string) {}
  acquire(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("State directory must be a private directory (mode 0700)")
    }
    const lock = join(this.directory, "daemon.lock")
    try { mkdirSync(lock, { mode: 0o700 }) }
    catch { throw new Error("Daemon lock exists; see the documented crash-recovery procedure") }
    this.locked = true
    try {
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), { mode: 0o600 })
      const path = join(this.directory, "state.json")
      this.runs = existsSync(path) ? documentSchema.parse(JSON.parse(readFileSync(path, "utf8"))).runs : []
      if (new Set(this.runs.map(r => r.issueNumber)).size !== this.runs.length) throw new Error("Duplicate issue records in journal")
    } catch { this.release(); throw new Error("Journal is invalid or unreadable; follow the documented recovery procedure") }
  }
  release(): void {
    if (this.locked) { rmSync(join(this.directory, "daemon.lock"), { recursive: true }); this.locked = false }
  }
  all(): Run[] {
    if (!this.locked) throw new Error("Journal must be locked")
    return structuredClone(this.runs)
  }
  save(run: Run): void {
    if (!this.locked) throw new Error("Journal must be locked")
    const validated = runSchema.parse(run)
    const next = this.runs.filter(r => r.issueNumber !== run.issueNumber).concat(validated)
    const temporary = join(this.directory, "state-" + randomUUID() + ".tmp")
    const fd = openSync(temporary, "wx", 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, runs: next }, null, 2) + "\n"); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, join(this.directory, "state.json"))
    // POSIX directory fsync makes the rename durable across a power failure.
    if (process.platform !== "win32") {
      const directoryFd = openSync(this.directory, "r")
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    }
    this.runs = next
  }
}
