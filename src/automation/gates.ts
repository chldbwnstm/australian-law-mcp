import { Config } from "./config.js"
import { Check, GitHubPort, hasLabel, Issue, IssueEvent, issueHash, Pull, QualitySnapshot } from "./github.js"
import type { Run } from "./state.js"

export async function approvalFor(issue: Issue, run: Run, github: GitHubPort, config: Config): Promise<Run["approval"]> {
  if (issue.state !== "open" || issue.pull_request !== undefined || issueHash(issue) !== run.inputHash ||
      !hasLabel(issue, config.approvalLabel) || !run.triagedAt) return undefined
  const latest: IssueEvent | undefined = (await github.events(issue.number))
    .filter(e => ["labeled", "unlabeled"].includes(e.event) && e.label?.name === config.approvalLabel)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0]
  if (!latest || latest.event !== "labeled" || latest.actor?.type !== "User" ||
      Date.parse(latest.created_at) <= Date.parse(run.triagedAt)) return undefined
  if (run.approval && (run.approval.eventId !== latest.id || run.approval.actorId !== latest.actor.id)) return undefined
  if (!["write", "admin"].includes(await github.permission(latest.actor.login))) return undefined
  return { eventId: latest.id, actorId: latest.actor.id, login: latest.actor.login, approvedAt: latest.created_at }
}

export type GateResult = { status: "passed" | "pending" | "failed" | "blocked"; reason: string }
function checkResult(checks: Check[], name: string, appId: number, sha: string | null): GateResult {
  const latest = checks.filter(c => c.name === name && c.app.id === appId && c.head_sha === sha).sort((a, b) => b.id - a.id)[0]
  if (!latest || latest.status !== "completed") return { status: "pending", reason: "Waiting for " + name }
  if (latest.conclusion === "success") return { status: "passed", reason: name }
  // Skipped and neutral are deliberately insufficient for this automation,
  // even when GitHub branch protection would accept them.
  return { status: "failed", reason: name + ": " + latest.conclusion }
}
export function qualityGate(pull: Pull, run: Run, snapshot: QualitySnapshot, config: Config): GateResult {
  if (pull.state !== "open") return { status: "blocked", reason: "PR closed or merged" }
  if (pull.head.sha !== run.headSha || pull.head.ref !== run.branch ||
      pull.head.repo?.full_name.toLowerCase() !== (config.owner + "/" + config.repo).toLowerCase() ||
      pull.base.ref !== config.baseBranch) return { status: "blocked", reason: "PR source or target changed outside this run" }
  if (pull.mergeable === false) return { status: "blocked", reason: "Merge conflict requires a human" }
  if (pull.mergeable == null) return { status: "pending", reason: "GitHub is computing mergeability" }
  const results = config.requiredChecks.map(r => checkResult(
    r.target === "head" ? snapshot.headChecks : snapshot.mergeChecks,
    r.name, r.appId, r.target === "head" ? pull.head.sha : pull.merge_commit_sha,
  ))
  const rabbit = config.codeRabbit
  if (rabbit.surface === "check") results.push(checkResult(snapshot.headChecks, rabbit.checkName, rabbit.appId, pull.head.sha))
  else {
    const status = snapshot.statuses.filter(s => s.context === rabbit.checkName && s.creator.id === rabbit.reviewerId).sort((a, b) => b.id - a.id)[0]
    results.push(!status || status.state === "pending" ? { status: "pending", reason: "Waiting for CodeRabbit status" } :
      { status: status.state === "success" ? "passed" : "failed", reason: "CodeRabbit status: " + status.state })
  }
  const review = snapshot.reviews.filter(r => r.user?.id === rabbit.reviewerId && r.state !== "PENDING")
    .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? "") || b.id - a.id)[0]
  results.push(!review || review.commit_id !== pull.head.sha ? { status: "pending", reason: "Waiting for CodeRabbit review of current HEAD" } :
    review.state === "APPROVED" ? { status: "passed", reason: "CodeRabbit approved" } :
    review.state === "CHANGES_REQUESTED" ? { status: "failed", reason: "CodeRabbit requested changes" } :
    { status: "pending", reason: "CodeRabbit approval is required" })
  // Wait for the complete feedback set before spending an implementation attempt.
  const pending = results.find(r => r.status === "pending")
  if (pending) return pending
  return results.find(r => r.status === "failed") ?? { status: "passed", reason: "All required checks and review passed" }
}
