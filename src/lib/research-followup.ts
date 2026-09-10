/** Versioned, stateless contract for optional host-coordinated browser follow-up. */
import { createHash } from "node:crypto"
import { z } from "zod"

export const FOLLOWUP_SCHEMA_VERSION = "1.0" as const

export const GapKindSchema = z.enum([
  "source_access", "coverage", "reported_citation", "document_body", "treatment",
  "commencement", "legal_interpretation", "ambiguous_reference", "truncated", "budget",
])
export const GapTargetSchema = z.object({
  citation: z.string().max(500).optional(),
  registerId: z.string().max(200).optional(),
  provision: z.string().max(500).optional(),
  documentId: z.string().max(500).optional(),
  query: z.string().max(2000).optional(),
})
export const ResearchGapSchema = z.object({
  id: z.string().min(1).max(80),
  kind: GapKindSchema,
  originTool: z.string().min(1).max(100),
  originalErrorCode: z.string().max(100).optional(),
  target: GapTargetSchema,
  jurisdiction: z.string().max(100).optional(),
  asAt: z.string().max(40).optional(),
  reason: z.string().min(1).max(2000),
  sourceUrls: z.array(z.string().url().max(4000)).max(20),
  sourceAccess: z.enum(["permitted", "requires_access", "unknown"]),
  evidenceNeeded: z.array(z.string().min(1).max(1000)).min(1).max(20),
})

export const FollowupPolicySchema = z.object({
  mode: z.enum(["off", "missing_sources", "extended"]),
  browser: z.literal("aside"),
  maxPages: z.number().int().min(1).max(100).default(10),
  maxDocuments: z.number().int().min(1).max(30).default(3),
  maxElapsedSeconds: z.number().int().min(30).max(3600).default(300),
  useAuthorizedAccounts: z.boolean().default(false),
})

export const LocalEligibilitySchema = z.object({
  probe: z.literal("local_companion"),
  execution: z.enum(["local", "remote", "unknown"]),
  platform: z.enum(["darwin", "win32", "linux", "unknown"]),
  osVersion: z.string().max(100),
  asideConnected: z.boolean(),
  asideTools: z.array(z.enum(["repl", "exec", "memory_search"])).max(3),
})

export const FollowupTaskSchema = z.object({
  id: z.string().min(1).max(80),
  gapIds: z.array(z.string()).min(1).max(50),
  dependsOn: z.array(z.string()).max(50),
  action: z.enum(["read_source", "read_document", "search_later_cases", "analyze"]),
  route: z.enum(["aside_repl", "aside_agent", "host_model"]),
  expectedEvidence: z.array(z.string()).min(1).max(20),
  state: z.enum(["planned", "running", "waiting_for_user", "evidence_collected", "assessed", "unresolved", "cancelled"]),
  sourceUrls: z.array(z.string().url()).max(20).optional(),
})

export const EvidenceItemSchema = z.object({
  taskId: z.string().min(1).max(80),
  requestedUrl: z.string().url().max(4000),
  finalUrl: z.string().url().max(4000),
  sourcePublisher: z.string().min(1).max(500),
  observedTitle: z.string().min(1).max(1000),
  citation: z.string().max(500).optional(),
  treatmentTargetCitation: z.string().max(500).optional(),
  registerId: z.string().max(200).optional(),
  provision: z.string().max(500).optional(),
  jurisdiction: z.string().max(100).optional(),
  asAt: z.string().max(40).optional(),
  documentDate: z.string().max(100).optional(),
  retrievedAt: z.string().datetime(),
  extractionMethod: z.enum(["browser_text", "original_download", "ocr", "metadata_only", "host_supplied"]),
  passage: z.string().max(24_576).optional(),
  locator: z.object({
    paragraph: z.string().max(100).optional(),
    printedPage: z.string().max(100).optional(),
    filePageIndex: z.number().int().min(0).optional(),
  }).optional(),
  coverage: z.object({
    status: z.enum(["original_body", "metadata_only", "partial_text", "unavailable"]),
    pagesVisited: z.number().int().min(0).max(10000).optional(),
    inspectedCount: z.number().int().min(0).max(100000).optional(),
    sourceReportedTotal: z.number().int().min(0).max(10000000).optional(),
    omittedAnnexes: z.boolean().optional(),
  }),
  artifact: z.object({ path: z.string().max(4000), sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().max(200), pageCount: z.number().int().positive().optional() }).optional(),
  acquisition: z.literal("host_or_aside_supplied"),
  notes: z.array(z.string().max(1000)).max(20).optional(),
})

export type ResearchGap = z.infer<typeof ResearchGapSchema>
export type FollowupPolicy = z.infer<typeof FollowupPolicySchema>
export type FollowupTask = z.infer<typeof FollowupTaskSchema>
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>

export interface FollowupEnvelope {
  schemaVersion: typeof FOLLOWUP_SCHEMA_VERSION
  gaps: ResearchGap[]
  tasks?: FollowupTask[]
  evidence?: EvidenceItem[]
  pending?: boolean
  notices?: string[]
  omittedGapCount?: number
  omittedTaskCount?: number
  omittedEvidenceCount?: number
}

function overflowGap(count: number): ResearchGap {
  return makeGap({
    kind: "budget",
    originTool: "followup_envelope",
    target: { query: `omitted:${count}` },
    reason: `${count} structured gap(s) were not returned within this serialized result. Re-run the originating call with narrower inputs.`,
    sourceUrls: [],
    sourceAccess: "unknown",
    evidenceNeeded: ["A narrower rerun of the originating call"],
  })
}

/** Bound metadata independently, with explicit overflow counts instead of silent loss. */
export function boundFollowupEnvelope(envelope: FollowupEnvelope, maxChars = 24_000): FollowupEnvelope {
  // A previous pass may already have inserted its synthetic overflow marker.
  // Rebuild that marker from the counts rather than treating it as real work.
  let gaps = envelope.gaps.filter((gap) => !(gap.originTool === "followup_envelope" && (envelope.omittedGapCount ?? 0) > 0))
  let tasks = [...(envelope.tasks ?? [])]
  let evidence = [...(envelope.evidence ?? [])]
  let notices = [...(envelope.notices ?? [])]
  let omittedGapCount = envelope.omittedGapCount ?? 0
  let omittedTaskCount = envelope.omittedTaskCount ?? 0
  let omittedEvidenceCount = envelope.omittedEvidenceCount ?? 0

  const build = (): FollowupEnvelope => {
    const omissionNotices = [
      omittedTaskCount ? `${omittedTaskCount} follow-up task(s) were omitted; the result remains pending and must be regenerated with narrower input.` : undefined,
      omittedEvidenceCount ? `${omittedEvidenceCount} evidence item(s) were omitted; the result remains pending and cannot be treated as a successful assessment.` : undefined,
    ].filter((notice): notice is string => Boolean(notice))
    const outputGaps = omittedGapCount ? [...gaps, overflowGap(omittedGapCount)] : gaps
    const pending = envelope.pending === true || omittedGapCount > 0 || omittedTaskCount > 0 || omittedEvidenceCount > 0
    return {
      schemaVersion: FOLLOWUP_SCHEMA_VERSION,
      gaps: outputGaps,
      ...(tasks.length ? { tasks } : {}),
      ...(evidence.length ? { evidence } : {}),
      ...(pending ? { pending: true } : envelope.pending === false ? { pending: false } : {}),
      ...(notices.length || omissionNotices.length ? { notices: [...notices, ...omissionNotices] } : {}),
      ...(omittedGapCount ? { omittedGapCount } : {}),
      ...(omittedTaskCount ? { omittedTaskCount } : {}),
      ...(omittedEvidenceCount ? { omittedEvidenceCount } : {}),
    }
  }

  // Preserve gaps ahead of derived task/evidence payloads, but always count
  // every item removed. Appending (rather than replacing with) the overflow
  // marker avoids the replacement off-by-one that used to lose a real gap.
  while (JSON.stringify(build()).length > maxChars && evidence.length) { evidence.pop(); omittedEvidenceCount += 1 }
  while (JSON.stringify(build()).length > maxChars && tasks.length) { tasks.pop(); omittedTaskCount += 1 }
  while (JSON.stringify(build()).length > maxChars && gaps.length) { gaps.pop(); omittedGapCount += 1 }
  while (JSON.stringify(build()).length > maxChars && notices.length) notices.pop()

  const result = build()
  if (JSON.stringify(result).length <= maxChars) return result

  // maxChars is configurable by embedders. Even the small overflow marker may
  // not fit an unusually tiny allowance, so the final form contains counts but
  // no unbounded caller-controlled strings.
  return {
    schemaVersion: FOLLOWUP_SCHEMA_VERSION,
    gaps: [],
    pending: true,
    ...(omittedGapCount ? { omittedGapCount } : {}),
    ...(omittedTaskCount + tasks.length ? { omittedTaskCount: omittedTaskCount + tasks.length } : {}),
    ...(omittedEvidenceCount + evidence.length ? { omittedEvidenceCount: omittedEvidenceCount + evidence.length } : {}),
    notices: ["Structured follow-up was omitted to fit the serialized result; re-run the originating call with narrower inputs."],
  }
}

type TextResultInput = {
  content: Array<{ type: string; text: string }>
  isError?: boolean
  structuredContent?: { followup: FollowupEnvelope }
}

type TextResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: { followup: FollowupEnvelope }
}

/** Bound text and structured follow-up together at every transport boundary. */
export function boundToolResponse(result: TextResultInput, originTool: string, maxChars: number): TextResult {
  const rawText = result.content.map((part) => part.text).join("\n")
  let envelope = result.structuredContent?.followup
  const makeResult = (text: string, followup = envelope): TextResult => ({
    content: [{ type: "text", text }],
    ...(result.isError ? { isError: true } : {}),
    ...(followup ? { structuredContent: { followup } } : {}),
  })

  if (envelope) envelope = boundFollowupEnvelope(envelope, Math.max(256, maxChars - 256))
  if (JSON.stringify(makeResult(rawText)).length <= maxChars) return makeResult(rawText)

  const truncationGap = makeGap({
    kind: "truncated",
    originTool,
    target: {},
    reason: `The response exceeded the ${maxChars}-character serialized transport limit.`,
    sourceUrls: [],
    sourceAccess: "unknown",
    evidenceNeeded: ["The omitted continuation or source document section"],
  })
  const prior = envelope
  envelope = boundFollowupEnvelope(followupEnvelope(mergeGaps(prior?.gaps, [truncationGap]), {
    ...(prior?.tasks ? { tasks: prior.tasks } : {}),
    ...(prior?.evidence ? { evidence: prior.evidence } : {}),
    pending: true,
    ...(prior?.notices ? { notices: prior.notices } : {}),
    ...(prior?.omittedGapCount ? { omittedGapCount: prior.omittedGapCount } : {}),
    ...(prior?.omittedTaskCount ? { omittedTaskCount: prior.omittedTaskCount } : {}),
    ...(prior?.omittedEvidenceCount ? { omittedEvidenceCount: prior.omittedEvidenceCount } : {}),
  }), Math.max(256, maxChars - 256))

  // Fit by actual JSON serialization rather than text length: quotes,
  // backslashes and newlines expand when the CLI or JSON-RPC transport writes.
  let low = 0
  let high = rawText.length
  let fitted = ""
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = middle < rawText.length ? `${rawText.slice(0, middle)}\n[TRUNCATED]` : rawText
    if (JSON.stringify(makeResult(candidate)).length <= maxChars) {
      fitted = candidate
      low = middle + 1
    } else high = middle - 1
  }
  if (JSON.stringify(makeResult(fitted)).length <= maxChars) return makeResult(fitted)

  // Structured data alone can consume the limit after the truncation gap was
  // added. Tighten it and retry once with an empty text part.
  envelope = boundFollowupEnvelope(envelope, Math.max(128, maxChars - 128))
  const minimal = makeResult("")
  if (JSON.stringify(minimal).length <= maxChars) return minimal
  return { content: [{ type: "text", text: "[TRUNCATED]" }], ...(result.isError ? { isError: true } : {}) }
}

function normal(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

function normalUrl(value: string): string {
  try {
    const url = new URL(value)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    return url.toString()
  } catch {
    return value.trim()
  }
}

/** Stable identity from legal target and scope, never from mutable explanatory prose. */
export function gapId(input: Omit<ResearchGap, "id" | "reason" | "evidenceNeeded">): string {
  const identity = [
    FOLLOWUP_SCHEMA_VERSION, input.kind, normal(input.originTool), normal(input.jurisdiction),
    normal(input.asAt), normal(input.target.citation), normal(input.target.registerId),
    normal(input.target.provision), normal(input.target.documentId), normal(input.target.query),
    [...input.sourceUrls].map(normalUrl).sort().join("|"),
  ].join("\u001f")
  return `gap_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`
}

export function makeGap(input: Omit<ResearchGap, "id">): ResearchGap {
  return { ...input, id: gapId(input) }
}

export function mergeGaps(...groups: Array<readonly ResearchGap[] | undefined>): ResearchGap[] {
  const byId = new Map<string, ResearchGap>()
  for (const gap of groups.flatMap((group) => group ?? [])) byId.set(gap.id, gap)
  return [...byId.values()]
}

export function followupEnvelope(gaps: readonly ResearchGap[], extra: Omit<FollowupEnvelope, "schemaVersion" | "gaps"> = {}): FollowupEnvelope {
  const merged = mergeGaps(gaps)
  const maximum = 100
  if (merged.length <= maximum) return { schemaVersion: FOLLOWUP_SCHEMA_VERSION, gaps: merged, ...extra }
  const omittedGapCount = (extra.omittedGapCount ?? 0) + merged.length - (maximum - 1)
  const overflow = makeGap({
    kind: "budget", originTool: "followup_envelope", target: { query: `omitted:${omittedGapCount}` },
    reason: `${omittedGapCount} additional structured gap(s) exceeded this stateless response envelope and were not returned. Re-run the named source or aggregate call with narrower inputs to recover them.`,
    sourceUrls: [], sourceAccess: "unknown", evidenceNeeded: ["A narrower rerun of the source or aggregate call that produced this overflow"],
  })
  return { schemaVersion: FOLLOWUP_SCHEMA_VERSION, gaps: [...merged.slice(0, maximum - 1), overflow], ...extra, omittedGapCount, pending: true }
}

export function isEligibleLocalAside(input: z.infer<typeof LocalEligibilitySchema>): { eligible: boolean; reason: string } {
  if (input.execution !== "local") return { eligible: false, reason: "Browser follow-up requires local client execution." }
  if (input.platform !== "darwin") return { eligible: false, reason: "Aside browser follow-up is available only on macOS." }
  const match = /^(\d+)(?:\.\d+){0,2}$/.exec(input.osVersion)
  const major = match ? Number(match[1]) : NaN
  if (!Number.isFinite(major) || major < 15) return { eligible: false, reason: "Aside browser follow-up requires macOS 15.0 or later." }
  if (!input.asideConnected) return { eligible: false, reason: "Aside MCP is not connected in this local host session." }
  if (!input.asideTools.includes("repl")) return { eligible: false, reason: "The connected Aside MCP does not expose its required repl tool." }
  return { eligible: true, reason: "Local macOS 15+ and Aside repl capability confirmed by the companion probe." }
}
