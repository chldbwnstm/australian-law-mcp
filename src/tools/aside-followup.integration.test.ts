import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { boundToolResponse, type EvidenceItem } from "../lib/research-followup.js"
import { getCaseText, setAsideBridge } from "./precedents.js"
import { planResearchFollowup, checkResearchEvidence } from "./research-followup.js"
import { readAsideJudgment } from "../lib/sources/aside-case-pages.js"

const client = {} as never
const citation = "[2020] FCAFC 130"
const html = readFileSync(new URL("../lib/sources/__fixtures__/aside/fedcourt-tpg.html", import.meta.url), "utf8")
const policy = { mode: "missing_sources" as const, browser: "aside" as const, maxPages: 3, maxDocuments: 2, maxElapsedSeconds: 120, useAuthorizedAccounts: false }
// The same chain on both hosts Aside ships on. The probe is data the companion
// supplies, so this runs on any CI box; what it proves is that a Windows probe
// gets the same plan, from the same recorded pages, as a Mac one.
const hosts = {
  macOS: { probe: "local_companion" as const, execution: "local" as const, platform: "darwin" as const, osVersion: "15.1", asideConnected: true, asideTools: ["repl" as const] },
  Windows: { probe: "local_companion" as const, execution: "local" as const, platform: "win32" as const, osVersion: "10.0.26200", asideConnected: true, asideTools: ["repl" as const] },
}
const scope = { matter: "offline public judgment check", jurisdictions: ["Cth"] }
afterEach(() => setAsideBridge(null))

describe.each(Object.entries(hosts))("law tool → follow-up plan → supplied original passage on %s", (_name, eligibility) => {
  async function prepare() {
    setAsideBridge({ asideStatus: () => ({ enabled: true }), fetchViaAside: async () => html })
    const response = boundToolResponse(await getCaseText(client, { citation, full: true }), "get_case_text", 50_000)
    const gaps = response.structuredContent!.followup.gaps
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ kind: "truncated", target: { citation } })
    const plan = await planResearchFollowup(client, { gaps, policy, eligibility, scope })
    const task = plan.structuredContent!.followup.tasks![0]
    expect(task).toMatchObject({ route: "aside_repl", state: "planned", sourceUrls: gaps[0].sourceUrls })
    const page = readAsideJudgment(html, citation)
    if ("failure" in page) throw new Error(page.failure)
    const passage = /(?:^|\n)43 (.+)(?=\n|$)/.exec(page.text)![1]
    const evidence: EvidenceItem = {
      taskId: task.id, requestedUrl: gaps[0].sourceUrls[0], finalUrl: gaps[0].sourceUrls[0],
      sourcePublisher: "Federal Court of Australia", observedTitle: page.title, citation,
      retrievedAt: "2026-09-13T00:00:00.000Z", extractionMethod: "browser_text", passage,
      locator: { paragraph: "43" }, coverage: { status: "original_body" }, acquisition: "host_or_aside_supplied",
    }
    // A host persists these ordinary JSON values between stateless tool calls.
    return JSON.parse(JSON.stringify({ task, gap: gaps[0], evidence: [evidence], expectedQuote: passage }))
  }

  it("supports the exact supplied passage after serialization, without claiming legal verification", async () => {
    const result = await checkResearchEvidence(client, await prepare())
    expect(result.structuredContent?.followup.pending).toBe(false)
    expect(result.content[0].text).toContain("does not certify external authenticity")
  })

  it.each(["wrong_citation", "wrong_source", "wrong_task", "partial", "missing_locator", "ocr", "missing_quote", "omitted_annexes"])("keeps follow-up pending for %s", async fault => {
    const input = await prepare()
    const evidence = input.evidence[0]
    if (fault === "wrong_citation") evidence.citation = "[2020] FCAFC 13"
    if (fault === "wrong_source") evidence.requestedUrl = "https://example.org/other"
    if (fault === "wrong_task") evidence.taskId = "unrelated_task"
    if (fault === "partial") evidence.coverage.status = "partial_text"
    if (fault === "missing_locator") delete evidence.locator
    if (fault === "ocr") evidence.extractionMethod = "ocr"
    if (fault === "missing_quote") input.expectedQuote = "A sentence absent from the original."
    if (fault === "omitted_annexes") evidence.coverage.omittedAnnexes = true
    const result = await checkResearchEvidence(client, input)
    expect(result.structuredContent?.followup.pending).toBe(true)
    expect(result.structuredContent?.followup.gaps[0].sourceUrls).toEqual(input.gap.sourceUrls)
  })

  it("turns a PDF viewer into an original-document task with the actual PDF URL", async () => {
    const pdf = readFileSync(new URL("../lib/sources/__fixtures__/aside/austlii-vsc-pdf.html", import.meta.url), "utf8")
    setAsideBridge({ asideStatus: () => ({ enabled: true }), fetchViaAside: async () => pdf })
    const response = await getCaseText(client, { citation: "[2023] VSC 637" })
    expect(response.content[0].text).not.toContain("Reasons:")
    const gaps = response.structuredContent!.followup.gaps
    expect(gaps[0]).toMatchObject({ kind: "document_body", target: { citation: "[2023] VSC 637" }, sourceUrls: ["https://www.austlii.edu.au/au/cases/vic/VSC/2023/637.pdf"] })
    const plan = await planResearchFollowup(client, { gaps, policy: { ...policy, useAuthorizedAccounts: true }, eligibility, scope })
    expect(plan.structuredContent?.followup.tasks?.[0]).toMatchObject({ action: "read_document", route: "aside_repl", sourceUrls: gaps[0].sourceUrls })
  })

  it("describes an attempted browser lookup honestly and retains its links for follow-up", async () => {
    setAsideBridge({ asideStatus: () => ({ enabled: true }), fetchViaAside: async () => "<title>Page Not Found</title><h1>Page Not Found</h1>" })
    const response = await getCaseText(client, { citation })
    expect(response.content[0].text).toContain("Browser retrieval did not yield")
    expect(response.content[0].text).not.toContain("source was never queried")
    expect(response.structuredContent?.followup.gaps[0]).toMatchObject({ kind: "source_access", target: { citation } })
  })
})
