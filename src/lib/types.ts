/**
 * MCP tool type definitions.
 *
 * Source-specific response shapes (legislation records, judgments, …) belong
 * with the client that produces them. Only the tool contract lives here —
 * plus the four types the frozen `AuApiClient` contract names as living in
 * this file (docs/ARCHITECTURE.md): `FrlTitle`, `FrlVersion`, `NcxEntry`,
 * `ProvisionText`.
 */

import { z } from "zod"
import type { FollowupEnvelope } from "./research-followup.js"

// ──────────────────────────────────────────────────────────────────────────
// Federal Register of Legislation entities (docs/research/frl-api-reference.md §1)
// ──────────────────────────────────────────────────────────────────────────

/** One entry of `Title.nameHistory` (the TPA → CCA rename trail). */
export interface FrlNameHistoryEntry {
  name: string
  start: string | null
  affecterTitleId: string | null
  affecterName: string | null
}

/** The amending/repealing title behind a version or status change. */
export interface FrlAffectedByTitle {
  titleId: string
  name: string
  /** Which provisions of the affecter did it: `"sch 1 (item 66)"`. */
  provisions: string | null
  year: number | null
  number: number | null
  /** `Act | SR | SLI` after normalisation (the asAt form sends numeric codes). */
  seriesType: string | null
}

/** One `reasons[]` row — why a compilation or status change happened. */
export interface FrlVersionReason {
  /** `AsMade | Amend | Repeal | Cease | ChangeDate | Disallow` after normalisation. */
  affect: string
  markdown?: string | null
  affectedByTitle?: FrlAffectedByTitle | null
  amendedByTitle?: FrlAffectedByTitle | null
}

/** One entry of `Title.statusHistory` — includes what repealed a repealed act. */
export interface FrlStatusHistoryEntry {
  status: string
  start: string | null
  reasons: FrlVersionReason[]
}

/**
 * A `Titles` row. Fields follow the live OData shape; everything beyond `id`
 * and `name` is optional because callers `$select` different projections.
 */
export interface FrlTitle {
  id: string
  name: string
  collection?: string
  subCollection?: string | null
  status?: string
  isPrincipal?: boolean
  isInForce?: boolean
  hasCommencedUnincorporatedAmendments?: boolean
  year?: number | null
  number?: number | null
  seriesType?: string | null
  makingDate?: string | null
  asMadeRegisteredAt?: string | null
  originatingBillUri?: string | null
  nameHistory?: FrlNameHistoryEntry[]
  statusHistory?: FrlStatusHistoryEntry[]
}

/**
 * A `Versions` row / `Versions/Find(...)` result, **after normalisation**:
 * camelCase keys (the `asAt=` form answers in PascalCase) and string enums
 * (the same form answers with numeric codes — see api-client.ts).
 */
export interface FrlVersion {
  titleId: string
  start: string | null
  end: string | null
  retrospectiveStart?: string | null
  retrospectiveEnd?: string | null
  isCurrent: boolean
  /** Newest *registered* compilation; `isCurrent` may have `registerId: null`. */
  isLatest: boolean
  name?: string
  status?: string
  registerId: string | null
  registeredAt?: string | null
  compilationNumber?: string | null
  hasUnincorporatedAmendments?: boolean
  reasons?: FrlVersionReason[]
}

// ──────────────────────────────────────────────────────────────────────────
// Epub NCX table of contents + sliced provision text
// ──────────────────────────────────────────────────────────────────────────

/**
 * One `<navPoint>` of an FRL epub NCX table of contents.
 *
 * The `parent` chain is preserved (not just the depth number) because the same
 * label can exist twice at the same shape — CCA body s 18 vs Schedule 2 s 18 —
 * and only an ancestor walk can tell whose subtree a navPoint sits in.
 */
export interface NcxEntry {
  /** Label with NBSPs normalised and whitespace collapsed: `"18 Misleading or deceptive conduct"`. */
  label: string
  /** Volume document the anchor lives in: `"document_4/document_4.html"`. */
  volumeDoc: string
  /** Fragment inside the volume, e.g. `"_Toc235543096"`; absent on a volume root. */
  anchor?: string
  /** `playOrder` — NCX document order, which matches text order. */
  order: number
  /** Nesting depth; direct children of `navMap` (the volumes) are 1. */
  depth: number
  parent?: NcxEntry
}

/** A provision sliced out of a volume by `provision-slicer.ts`. */
export interface ProvisionText {
  /** Canonical AGLC form of the requested reference, e.g. `"sch 2 s 18"`. */
  ref: string
  /** The matched NCX label, e.g. `"18 Misleading or deceptive conduct"`. */
  heading: string
  /** Readable text: headings, `(1)`-numbered subsections, indentation kept. */
  text: string
  volumeDoc: string
  anchor?: string
  /** Ancestor labels, outermost first: `["Volume 4", "Schedule 2—The Australian Consumer Law", …]`. */
  breadcrumb: string[]
}

/**
 * MCP tool response
 */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: { followup: FollowupEnvelope }
}

/** Loose shape a tool handler may return (allows `{ type: string }`). */
export interface LooseToolResponse {
  content: Array<{ type: string; text: string }>
  isError?: boolean
  structuredContent?: { followup: FollowupEnvelope }
}

/**
 * MCP tool definition.
 *
 * `TClient` is the upstream API client handed to every handler. The core
 * library is source-agnostic, so the concrete client type is supplied by the
 * layer that registers the tool (`McpTool<AustralianLawApiClient>`).
 */
export interface McpTool<TClient = any> {
  /** Tool name (snake_case) */
  name: string
  /** Tool description */
  description: string
  /** Zod input schema */
  schema: z.ZodSchema
  /** Handler (input is guaranteed by Zod at runtime; each tool narrows it internally) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (apiClient: TClient, input: any) => Promise<LooseToolResponse>
}
