import { z } from "zod"
import { Config, fingerprint, shaSchema, stageLabels } from "./config.js"
import type { Run } from "./state.js"

const actorSchema = z.object({ id: z.number().int(), login: z.string(), type: z.string() })
const issueSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  pull_request: z.unknown().optional(),
})
export type Issue = z.infer<typeof issueSchema>
const eventSchema = z.object({
  id: z.number().int(), event: z.string(), created_at: z.string().datetime(),
  actor: actorSchema.nullable(), label: z.object({ name: z.string() }).optional(),
})
export type IssueEvent = z.infer<typeof eventSchema>
const pullSchema = z.object({
  number: z.number().int().positive(), state: z.enum(["open", "closed"]), draft: z.boolean(),
  merged: z.boolean().optional(), body: z.string().nullable(),
  head: z.object({ sha: shaSchema, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ sha: shaSchema, ref: z.string() }),
  merge_commit_sha: shaSchema.nullable(), mergeable: z.boolean().nullable().optional(),
})
export type Pull = z.infer<typeof pullSchema>
const checkSchema = z.object({
  id: z.number().int(), name: z.string(), head_sha: shaSchema,
  status: z.string(), conclusion: z.string().nullable(),
  app: z.object({ id: z.number().int() }),
  output: z.object({ title: z.string().nullable(), summary: z.string().nullable(), text: z.string().nullable().optional() }).optional(),
})
export type Check = z.infer<typeof checkSchema>
const reviewSchema = z.object({
  id: z.number().int(), user: actorSchema.nullable(), state: z.string(),
  commit_id: shaSchema, submitted_at: z.string().datetime().nullable().optional(),
})
export type Review = z.infer<typeof reviewSchema>
const statusSchema = z.object({
  id: z.number().int(), context: z.string(), state: z.string(), creator: actorSchema,
  description: z.string().nullable(),
})
export type CommitStatus = z.infer<typeof statusSchema>
export interface QualitySnapshot { headChecks: Check[]; mergeChecks: Check[]; statuses: CommitStatus[]; reviews: Review[] }
export interface GitHubPort {
  candidates(): Promise<Issue[]>
  issue(number: number): Promise<Issue>
  events(number: number): Promise<IssueEvent[]>
  permission(login: string): Promise<string>
  baseSha(): Promise<string>
  comment(number: number, marker: string, body: string): Promise<{ created_at: string }>
  labels(number: number, desired: string): Promise<void>
  findPull(branch: string): Promise<Pull | undefined>
  pull(number: number): Promise<Pull>
  createPull(run: Run): Promise<Pull>
  branchSha(branch: string): Promise<string | undefined>
  quality(pull: Pull): Promise<QualitySnapshot>
  feedback(pull: Pull, snapshot: QualitySnapshot): Promise<string>
  markReady(number: number): Promise<void>
}
export function issueHash(issue: Issue): string { return fingerprint({ number: issue.number, title: issue.title, body: issue.body ?? "" }) }
export function hasLabel(issue: Issue, name: string): boolean {
  return issue.labels.some(l => (typeof l === "string" ? l : l.name) === name)
}
export class GitHubError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super("GitHub request failed (HTTP " + status + ")") }
}

export class GitHubClient implements GitHubPort {
  private prefix: string
  constructor(private config: Config, private token: string, private readOnly = false, private fetcher: typeof fetch = fetch) {
    if (!token || /[\r\n]/.test(token)) throw new Error("A valid AUTOMATION_GITHUB_TOKEN is required")
    this.prefix = "/repos/" + config.owner + "/" + config.repo
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (this.readOnly && method !== "GET") throw new Error("Dry-run forbids GitHub mutations")
    if (!path.startsWith(this.prefix + "/")) throw new Error("Request outside configured repository")
    const response = await this.fetcher("https://api.github.com" + path, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: "Bearer " + this.token, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const delay = Number(response.headers.get("retry-after") ?? 0) * 1000
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000 - Date.now()
      await response.body?.cancel()
      throw new GitHubError(response.status, Math.max(0, delay, response.headers.get("x-ratelimit-remaining") === "0" ? reset : 0))
    }
    if (response.status === 204) return undefined
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Empty GitHub response")
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 16_777_216) throw new Error("GitHub response exceeded limit")
        chunks.push(part.value)
      }
    } finally { await reader.cancel() }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }
  private async pages<T>(path: string, schema: z.ZodType<T>, key?: string): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page)
      const entries = z.array(schema).parse(key ? (data as Record<string, unknown>)[key] : data)
      result.push(...entries)
      if (entries.length < 100) return result
    }
    throw new Error("GitHub pagination limit reached; refusing an incomplete view")
  }
  async candidates(): Promise<Issue[]> {
    return (await this.pages(this.prefix + "/issues?state=open&labels=" + encodeURIComponent(this.config.candidateLabel), issueSchema))
      .filter(i => i.pull_request === undefined)
  }
  async issue(number: number): Promise<Issue> { return issueSchema.parse(await this.request(this.prefix + "/issues/" + number)) }
  events(number: number): Promise<IssueEvent[]> { return this.pages(this.prefix + "/issues/" + number + "/events", eventSchema) }
  async permission(login: string): Promise<string> {
    try {
      const data = await this.request(this.prefix + "/collaborators/" + encodeURIComponent(login) + "/permission")
      return z.object({ permission: z.string() }).parse(data).permission
    } catch (error) { if (error instanceof GitHubError && error.status === 404) return "none"; throw error }
  }
  async baseSha(): Promise<string> {
    return z.object({ sha: shaSchema }).parse(await this.request(this.prefix + "/commits/" + encodeURIComponent(this.config.baseBranch))).sha
  }
  async comment(number: number, marker: string, body: string): Promise<{ created_at: string }> {
    const schema = z.object({ id: z.number().int(), body: z.string(), user: actorSchema, created_at: z.string().datetime() })
    const path = this.prefix + "/issues/" + number + "/comments"
    const existing = (await this.pages(path, schema)).find(c => c.user.login === this.config.botLogin && c.body.startsWith(marker + "\n"))
    // Never edit the triage snapshot after it has been presented for approval.
    if (existing) return existing
    return schema.parse(await this.request(path, "POST", { body: marker + "\n" + body }))
  }
  async labels(number: number, desired: string): Promise<void> {
    if (!stageLabels.includes(desired)) throw new Error("Unknown managed label")
    const issue = await this.issue(number)
    // Revoke readiness before publishing a different state.
    for (const name of stageLabels.filter(n => n !== desired && hasLabel(issue, n))) {
      try { await this.request(this.prefix + "/issues/" + number + "/labels/" + encodeURIComponent(name), "DELETE") }
      catch (error) { if (!(error instanceof GitHubError && error.status === 404)) throw error }
    }
    if (!hasLabel(issue, desired)) await this.request(this.prefix + "/issues/" + number + "/labels", "POST", { labels: [desired] })
  }
  async findPull(branch: string): Promise<Pull | undefined> {
    const list = await this.pages(this.prefix + "/pulls?state=all&head=" + encodeURIComponent(this.config.owner + ":" + branch), z.object({ number: z.number().int() }))
    if (list.length > 1) throw new Error("Multiple PRs for managed branch")
    return list[0] ? this.pull(list[0].number) : undefined
  }
  async pull(number: number): Promise<Pull> { return pullSchema.parse(await this.request(this.prefix + "/pulls/" + number)) }
  async createPull(run: Run): Promise<Pull> {
    return pullSchema.parse(await this.request(this.prefix + "/pulls", "POST", {
      title: "Agent implementation for issue #" + run.issueNumber,
      body: prMarker(run) + "\n\nCloses #" + run.issueNumber + "\n\nImplementation follows the approved issue snapshot and Fable design recorded on the issue.\n\nCI and CodeRabbit must pass before maintainer merge.",
      head: run.branch, base: this.config.baseBranch, draft: true,
    }))
  }
  async branchSha(branch: string): Promise<string | undefined> {
    try { return z.object({ object: z.object({ sha: shaSchema }) }).parse(await this.request(this.prefix + "/git/ref/heads/" + branch)).object.sha }
    catch (error) { if (error instanceof GitHubError && error.status === 404) return undefined; throw error }
  }
  async quality(pull: Pull): Promise<QualitySnapshot> {
    const checks = (sha: string) => this.pages(this.prefix + "/commits/" + sha + "/check-runs?filter=all", checkSchema, "check_runs")
    const [headChecks, mergeChecks, statuses, reviews] = await Promise.all([
      checks(pull.head.sha),
      pull.merge_commit_sha ? checks(pull.merge_commit_sha) : Promise.resolve([]),
      this.pages(this.prefix + "/commits/" + pull.head.sha + "/statuses", statusSchema),
      this.pages(this.prefix + "/pulls/" + pull.number + "/reviews", reviewSchema),
    ])
    return { headChecks, mergeChecks, statuses, reviews }
  }
  async feedback(pull: Pull, snapshot: QualitySnapshot): Promise<string> {
    const comments = await this.pages(this.prefix + "/pulls/" + pull.number + "/comments",
      z.object({ id: z.number().int(), user: actorSchema, body: z.string(), path: z.string() }))
    const failures = [...snapshot.headChecks, ...snapshot.mergeChecks]
      .filter(c => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion) && this.config.requiredChecks.some(r => r.appId === c.app.id))
      .map(c => ({ name: c.name, conclusion: c.conclusion, output: c.output }))
    return JSON.stringify({ checks: failures, reviews: comments.filter(c => c.user.id === this.config.codeRabbit.reviewerId).slice(-50) }).slice(0, 32_000)
  }
  async markReady(number: number): Promise<void> {
    // REST has no draft-to-ready endpoint. Keep the PR draft; a maintainer changes
    // draft status after inspecting the ready-for-merge label. Never auto-merge.
    await this.labels(number, "ready-for-merge")
  }
}
export function prMarker(run: Run): string { return "<!-- issue-agent:" + run.id + " -->" }
