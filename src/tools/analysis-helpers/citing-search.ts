/**
 * Back-tracing: which later material mentions this citation?
 *
 * The free Australian citator is a **citation graph**, not a citator
 * (docs/research §6.2). LawCite would be the natural backbone and refuses
 * automated clients, so the graph this server can build is the full-text
 * mention search of three sites: NSW Caselaw, Queensland Judgments and the High
 * Court's own listing.
 *
 * That produces two obligations the callers depend on:
 *
 *  - **Every source reports its own outcome.** A source that failed and a
 *    source that returned nothing look identical in a merged hit list, and only
 *    the second is evidence. `SourceOutcome` keeps them apart so a verdict can
 *    refuse to say `not_found` while any source is `failed`.
 *  - **One request per source.** Back-tracing is the expensive half of
 *    `cite_check` and `impact_map`; the phrase goes out once per site and the
 *    result is capped.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { UpstreamBlockedError } from "../../lib/errors.js"
import * as hcourt from "../../lib/sources/hcourt.js"
import * as nsw from "../../lib/sources/nsw-caselaw.js"
import * as qld from "../../lib/sources/qld-judgments.js"
import type { SourceHit } from "../../lib/sources/types.js"

export interface SourceOutcome {
  source: "NSW Caselaw" | "Queensland Judgments" | "High Court of Australia"
  status: "ok" | "failed" | "blocked" | "skipped"
  /** Hits this source contributed. */
  hits: SourceHit[]
  /** The upstream's own count, when it publishes one. */
  total?: number
  totalNote?: string
  note?: string
  /** The URL a human can open to repeat the search. */
  sourceUrl?: string
}

export interface BackTrace {
  outcomes: SourceOutcome[]
  hits: SourceHit[]
  /** True when every source answered — the only state in which "none" means "none". */
  complete: boolean
}

export interface BackTraceOptions {
  /** Restrict the fan-out. Default: all three. */
  sources?: ReadonlyArray<SourceOutcome["source"]>
  /** Hits kept per source. */
  perSource?: number
  /** Exclude hits whose own citation equals this (the target citing itself). */
  exclude?: string
}

const DEFAULT_PER_SOURCE = 20

function normalise(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /\[((?:1[89]|20)\d{2})\]\s*([A-Za-z]{2,14})\s*(\d{1,5})/.exec(value)
  return match ? `[${match[1]}] ${match[2].toUpperCase()} ${Number(match[3])}` : undefined
}

async function attempt(
  source: SourceOutcome["source"],
  run: () => Promise<{ hits: SourceHit[]; total?: number; totalNote?: string; sourceUrl: string }>,
): Promise<SourceOutcome> {
  try {
    const result = await run()
    return {
      source,
      status: "ok",
      hits: result.hits,
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.totalNote ? { totalNote: result.totalNote } : {}),
      sourceUrl: result.sourceUrl,
    }
  } catch (error) {
    return {
      source,
      status: error instanceof UpstreamBlockedError ? "blocked" : "failed",
      hits: [],
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Full-text mention search for `phrase` across the reachable case-law sources.
 *
 * The phrase is sent quoted where the site supports it; a citation is a rare
 * enough string that even an unquoted search is precise in practice.
 */
export async function backTrace(
  client: AuApiClient,
  phrase: string,
  options: BackTraceOptions = {},
): Promise<BackTrace> {
  const wanted = options.sources ?? ["NSW Caselaw", "Queensland Judgments", "High Court of Australia"]
  const perSource = options.perSource ?? DEFAULT_PER_SOURCE
  const excluded = normalise(options.exclude)

  const tasks: Array<Promise<SourceOutcome>> = []
  if (wanted.includes("NSW Caselaw")) {
    tasks.push(attempt("NSW Caselaw", () => nsw.search(client, { query: `"${phrase}"`, page: 0 })))
  }
  if (wanted.includes("Queensland Judgments")) {
    tasks.push(attempt("Queensland Judgments", () => qld.search(client, { text: phrase, perPage: perSource, page: 1 })))
  }
  if (wanted.includes("High Court of Australia")) {
    tasks.push(attempt("High Court of Australia", () => hcourt.search(client, { keywords: phrase, page: 0 })))
  }

  const outcomes = (await Promise.all(tasks)).map((outcome) => ({
    ...outcome,
    hits: outcome.hits
      .filter((hit) => !excluded || normalise(hit.citation) !== excluded)
      .slice(0, perSource),
  }))

  return {
    outcomes,
    hits: outcomes.flatMap((outcome) => outcome.hits),
    complete: outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "ok"),
  }
}

/**
 * Fold several traces (one per search phrase) into one.
 *
 * Hits are de-duplicated by source and id, and a source counts as `ok` only if
 * it answered for every phrase — a source that failed on one of them has not
 * been fully searched, and printing it as `ok` would overstate the coverage.
 */
export function mergeTraces(traces: readonly BackTrace[]): BackTrace {
  const bySource = new Map<SourceOutcome["source"], SourceOutcome>()
  const seen = new Set<string>()

  for (const trace of traces) {
    for (const outcome of trace.outcomes) {
      const existing = bySource.get(outcome.source)
      const hits = outcome.hits.filter((hit) => {
        const key = `${outcome.source}|${hit.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!existing) {
        bySource.set(outcome.source, { ...outcome, hits })
        continue
      }
      existing.hits = [...existing.hits, ...hits]
      if (existing.status === "ok" && outcome.status !== "ok") {
        existing.status = outcome.status
        if (outcome.note) existing.note = outcome.note
      }
    }
  }

  const outcomes = [...bySource.values()]
  return {
    outcomes,
    hits: outcomes.flatMap((outcome) => outcome.hits),
    complete: outcomes.length > 0 && outcomes.every((outcome) => outcome.status === "ok"),
  }
}

/** One line per source, so the reader can see what was actually searched. */
export function describeOutcomes(trace: BackTrace): string[] {
  return trace.outcomes.map((outcome) => {
    if (outcome.status === "ok") {
      const total =
        outcome.total !== undefined && outcome.total !== outcome.hits.length
          ? ` (source reports ${outcome.total}${outcome.totalNote ? "; " + outcome.totalNote : ""})`
          : ""
      return `  ${outcome.source}: ${outcome.hits.length} mention(s)${total}`
    }
    if (outcome.status === "blocked") {
      return `  ${outcome.source}: NOT searched — ${outcome.note ?? "blocked"}. Absence here means nothing.`
    }
    if (outcome.status === "skipped") {
      return `  ${outcome.source}: not searched (${outcome.note ?? "skipped"})`
    }
    return `  ${outcome.source}: SEARCH FAILED — ${outcome.note ?? "unknown error"}. Absence here means nothing.`
  })
}
