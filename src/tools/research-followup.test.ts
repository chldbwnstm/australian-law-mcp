import { describe, expect, it } from "vitest"
import { makeGap } from "../lib/research-followup.js"
import { checkResearchEvidence, planResearchFollowup } from "./research-followup.js"

const client = {} as never
const gap = makeGap({
  kind: "reported_citation", originTool: "cite_check", target: { citation: "(1992) 175 CLR 1" },
  reason: "reported citation", sourceUrls: ["https://www.austlii.edu.au/cgi-bin/LawCite"], sourceAccess: "requires_access",
  evidenceNeeded: ["matching report identity", "passage and locator"],
})
const policy = { mode: "missing_sources" as const, browser: "aside" as const, maxPages: 10, maxDocuments: 3, maxElapsedSeconds: 300, useAuthorizedAccounts: false }

describe("follow-up tools", () => {
  const mac = { probe: "local_companion" as const, execution: "local" as const, platform: "darwin" as const, osVersion: "15.1", asideConnected: true, asideTools: ["repl" as const, "exec" as const] }
  const windows = { ...mac, platform: "win32" as const, osVersion: "10.0.26200" }

  it("creates the same bounded browser task on an eligible local Windows host as on a Mac", async () => {
    for (const eligibility of [mac, windows]) {
      const result = await planResearchFollowup(client, { gaps: [gap], policy, scope: { matter: "test", jurisdictions: ["Cth"] }, eligibility })
      expect(result.structuredContent?.followup.tasks).toEqual([expect.objectContaining({ route: "aside_repl", state: "waiting_for_user", gapIds: [gap.id] })])
    }
    const result = await planResearchFollowup(client, { gaps: [gap], policy, scope: { matter: "test", jurisdictions: ["Cth"] }, eligibility: windows })
    expect(result.content[0].text).not.toMatch(/macOS/)
  })

  // The honesty guarantee that parity must not cost: an ineligible Windows host
  // — pre-10, remote, or without a connected Aside — retains every gap and link.
  it("creates no executable browser task on an ineligible Windows or Linux host, and keeps the gap", async () => {
    for (const [eligibility, reason] of [
      [{ ...windows, osVersion: "6.3.9600" }, "Windows 10"],
      [{ ...windows, execution: "remote" as const }, "local client"],
      [{ ...windows, asideConnected: false, asideTools: [] }, "not connected"],
      [{ ...windows, platform: "linux" as const, osVersion: "6.8" }, "only on macOS and Windows"],
    ] as const) {
      const result = await planResearchFollowup(client, { gaps: [gap], policy, scope: { matter: "test", jurisdictions: [] }, eligibility })
      expect(result.structuredContent?.followup.tasks).toBeUndefined()
      expect(result.structuredContent?.followup.gaps).toHaveLength(1)
      expect(result.content[0].text).toContain(reason)
    }
  })

  it("keeps host-model companion tasks unavailable on ineligible Windows and remote hosts", async () => {
    const interpretation = makeGap({ ...gap, kind: "legal_interpretation", sourceAccess: "unknown", reason: "host assessment needed" })
    for (const eligibility of [
      { ...windows, osVersion: "6.3.9600" },
      { ...mac, execution: "remote" as const },
    ]) {
      const result = await planResearchFollowup(client, { gaps: [interpretation], policy, scope: { matter: "test", jurisdictions: [] }, eligibility })
      expect(result.structuredContent?.followup.tasks).toBeUndefined()
      expect(result.structuredContent?.followup.gaps).toHaveLength(1)
    }
  })

  it("plans host analysis without browser access prompts on an eligible local Mac or Windows PC", async () => {
    const interpretation = makeGap({ ...gap, kind: "legal_interpretation", sourceAccess: "unknown", reason: "host assessment needed" })
    for (const eligibility of [{ ...mac, asideTools: ["repl" as const] }, { ...windows, asideTools: ["repl" as const] }]) {
      const result = await planResearchFollowup(client, { gaps: [interpretation], policy, scope: { matter: "test", jurisdictions: [] }, eligibility })
      expect(result.structuredContent?.followup.tasks).toEqual([expect.objectContaining({ route: "host_model", state: "planned" })])
    }
  })

  it("rejects a same-name or mismatched citation and missing body/locator", async () => {
    const task = { id: "task_1", gapIds: [gap.id], dependsOn: [], action: "read_source" as const, route: "aside_repl" as const, expectedEvidence: gap.evidenceNeeded, state: "evidence_collected" as const }
    const result = await checkResearchEvidence(client, { task, gap, evidence: [{ taskId: task.id, requestedUrl: gap.sourceUrls[0], finalUrl: gap.sourceUrls[0], sourcePublisher: "LawCite", observedTitle: "Same parties", citation: "(1993) 175 CLR 1", retrievedAt: "2026-09-10T00:00:00.000Z", extractionMethod: "metadata_only", coverage: { status: "metadata_only" }, acquisition: "host_or_aside_supplied" }] })
    expect(result.content[0].text).toContain("citation identity does not match")
    expect(result.content[0].text).toContain("no relevant passage")
    expect(result.structuredContent?.followup.pending).toBe(true)
  })

  it("preserves a later judgment's own citation while associating it with the seed case", async () => {
    const treatment = makeGap({ ...gap, kind: "treatment", sourceAccess: "permitted", sourceUrls: ["https://court.example/later"], reason: "later case uninspected" })
    const task = { id: "task_later", gapIds: [treatment.id], dependsOn: [], action: "search_later_cases" as const, route: "aside_agent" as const, expectedEvidence: treatment.evidenceNeeded, state: "evidence_collected" as const }
    const result = await checkResearchEvidence(client, { task, gap: treatment, evidence: [{ taskId: task.id, requestedUrl: treatment.sourceUrls[0], finalUrl: treatment.sourceUrls[0], sourcePublisher: "Court", observedTitle: "Later v Party", citation: "[2025] HCA 9", treatmentTargetCitation: "(1992) 175 CLR 1", retrievedAt: "2026-09-10T00:00:00.000Z", extractionMethod: "browser_text", passage: "At [42] the Court considered (1992) 175 CLR 1.", locator: { paragraph: "42" }, coverage: { status: "original_body", sourceReportedTotal: 1, inspectedCount: 1 }, acquisition: "host_or_aside_supplied" }] })
    expect(result.content[0].text).not.toContain("citation identity does not match")
    expect(result.content[0].text).toContain("treatment assessment remains pending")
    expect(result.structuredContent?.followup.evidence?.[0].citation).toBe("[2025] HCA 9")
  })
})
