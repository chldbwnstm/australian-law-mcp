import { describe, expect, it } from "vitest"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { loadConfig } from "./config.js"
import { approvalFor, qualityGate } from "./gates.js"
import { Check, GitHubPort, Issue, IssueEvent, issueHash, Pull, QualitySnapshot } from "./github.js"
import type { Run } from "./state.js"

function fixture() {
  const config = loadConfig(resolve("automation/config.example.json")), id = randomUUID()
  const issue: Issue = { number: 7, title: "Fix parser", body: "Acceptance criterion", state: "open", labels: ["agent-approved"] }
  const run: Run = { id, issueNumber: 7, branch: "agent/issue-7-" + id, stage: "checks", createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z", triagedAt: "2026-09-10T00:00:01.000Z", inputHash: issueHash(issue), policyHash: "a".repeat(64),
    headSha: "b".repeat(40), attempts: 1, workerCalls: 3, infrastructureFailures: 0, reservedWorkerSeconds: 100, labelsSynced: false }
  const pull: Pull = { number: 9, state: "open", draft: true, body: "", head: { sha: run.headSha!, ref: run.branch, repo: { full_name: config.owner + "/" + config.repo } },
    base: { ref: "main", sha: "a".repeat(40) }, merge_commit_sha: "c".repeat(40), mergeable: true }
  const event: IssueEvent = { id: 10, event: "labeled", label: { name: config.approvalLabel }, created_at: "2026-09-10T00:00:02.000Z",
    actor: { id: 1, login: "maintainer", type: "User" } }
  let events = [event], permission = "write"
  const github = { events: async () => events, permission: async () => permission } as GitHubPort
  const check = (sha: string, name: string, appId: number): Check => ({ id: 1, head_sha: sha, name, app: { id: appId }, status: "completed", conclusion: "success" })
  const snapshot: QualitySnapshot = {
    headChecks: [check(pull.head.sha, config.codeRabbit.checkName, config.codeRabbit.appId)],
    mergeChecks: [check(pull.merge_commit_sha!, config.requiredChecks[0].name, config.requiredChecks[0].appId)],
    statuses: [], reviews: [{ id: 1, user: { id: config.codeRabbit.reviewerId, login: "coderabbitai[bot]", type: "Bot" }, state: "APPROVED", commit_id: pull.head.sha }],
  }
  return { config, issue, run, pull, event, github, snapshot, setEvents: (value: IssueEvent[]) => { events = value }, setPermission: (value: string) => { permission = value } }
}
describe("approval binding", () => {
  it("accepts a human write/admin permission (including maintain mapped to write)", async () => {
    const f = fixture()
    expect((await approvalFor(f.issue, f.run, f.github, f.config))?.eventId).toBe(10)
    f.setPermission("admin")
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeDefined()
  })
  it.each(["read", "none", "triage"])("rejects permission %s", async permission => {
    const f = fixture(); f.setPermission(permission)
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
  })
  it("rejects bots, pre-triage labels and edited requirements", async () => {
    const f = fixture()
    f.event.actor!.type = "Bot"
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
    f.event.actor!.type = "User"; f.event.created_at = f.run.triagedAt!
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
    f.event.created_at = "2026-09-10T00:00:02.000Z"; f.issue.body = "Changed scope"
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
  })
  it("uses the latest approval event and never reuses a removed/re-added grant", async () => {
    const f = fixture()
    f.run.approval = await approvalFor(f.issue, f.run, f.github, f.config)
    f.setEvents([{ ...f.event, event: "unlabeled", id: 11, created_at: "2026-09-10T00:00:03.000Z" }, f.event])
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
    f.setEvents([f.event, { ...f.event, id: 12, created_at: "2026-09-10T00:00:04.000Z" }])
    expect(await approvalFor(f.issue, f.run, f.github, f.config)).toBeUndefined()
  })
})
describe("quality gates", () => {
  it("requires the current merge CI, head review check, and current CodeRabbit approval", () => {
    const f = fixture()
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("passed")
    f.snapshot.reviews = []
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
  })
  it("never passes an empty, spoofed, or stale check set", () => {
    const f = fixture()
    f.snapshot.mergeChecks[0].app.id++
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
    f.snapshot.mergeChecks[0].app.id--
    f.snapshot.mergeChecks[0].head_sha = "d".repeat(40)
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
    f.snapshot.mergeChecks = []
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
  })
  it("a new pending rerun overrides an older successful run", () => {
    const f = fixture()
    f.snapshot.mergeChecks.push({ ...f.snapshot.mergeChecks[0], id: 2, status: "in_progress", conclusion: null })
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
  })
  it.each(["failure", "cancelled", "timed_out", "neutral", "skipped"])("does not accept %s as success", conclusion => {
    const f = fixture(); f.snapshot.mergeChecks[0].conclusion = conclusion
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("failed")
  })
  it("rejects an approval for an earlier commit or from a different actor", () => {
    const f = fixture()
    f.snapshot.reviews[0].commit_id = "d".repeat(40)
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
    f.snapshot.reviews[0].commit_id = f.pull.head.sha
    f.snapshot.reviews[0].user!.id++
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
  })
  it("rejects a later dismissed or changes-requested review", () => {
    const f = fixture()
    f.snapshot.reviews.push({ ...f.snapshot.reviews[0], id: 2, state: "CHANGES_REQUESTED" })
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("failed")
    f.snapshot.reviews[1].state = "DISMISSED"
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("pending")
  })
  it("uses submission time when a previously drafted review is submitted later", () => {
    const f = fixture()
    f.snapshot.reviews[0].id = 10
    f.snapshot.reviews[0].submitted_at = "2026-09-10T00:00:01Z"
    f.snapshot.reviews.push({ ...f.snapshot.reviews[0], id: 5, submitted_at: "2026-09-10T00:00:02Z", state: "CHANGES_REQUESTED" })
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("failed")
  })
  it("supports an explicitly configured legacy CodeRabbit status surface", () => {
    const f = fixture(); f.config.codeRabbit.surface = "status"
    f.snapshot.statuses = [{ id: 1, context: f.config.codeRabbit.checkName, state: "success", description: null,
      creator: { id: f.config.codeRabbit.reviewerId, login: "coderabbitai[bot]", type: "Bot" } }]
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("passed")
  })
  it("blocks external pushes, target changes, and merge conflicts", () => {
    const f = fixture()
    f.pull.head.sha = "e".repeat(40)
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("blocked")
    f.pull.head.sha = f.run.headSha!; f.pull.base.ref = "other"
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("blocked")
    f.pull.base.ref = "main"; f.pull.mergeable = false
    expect(qualityGate(f.pull, f.run, f.snapshot, f.config).status).toBe("blocked")
  })
})
