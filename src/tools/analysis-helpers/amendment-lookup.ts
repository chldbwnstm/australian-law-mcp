/**
 * "What has happened to this provision, and when?" — shared by the three
 * analysis tools that need it.
 *
 * The source is the compilation's own `Endnote 4—Amendment history`, for the
 * reason C's `statute-helpers/endnotes.ts` documents at length: `Versions
 * .reasons[]` describes the **amending Act's** items, not the sections it
 * amended, so scanning it for "s 18" answers a different question convincingly.
 * This module only orchestrates — the table's grammar, the schedule-scope rule
 * that keeps ACL s 18 apart from CCA s 18, and the effect codes all live there.
 *
 * The one judgement made here is about **dates**. The endnote cites amending
 * Acts as `No 103, 2010` — a year and a number, never a commencement date. An
 * Act numbered in a given year usually commences in it, but not always, so
 * `amendedAfter` is explicitly a filter on the *year of the amending Act* and
 * every caller prints that caveat rather than implying a date comparison.
 */

import type { AuApiClient } from "../../lib/api-client.js"
import { ARTICLE_CACHE_TTL, lawCache } from "../../lib/cache.js"
import type { SectionRef } from "../../lib/section-ref.js"
import type { FrlTitle, NcxEntry } from "../../lib/types.js"
import {
  entriesForRef,
  findAmendmentHistoryNode,
  parseAmendmentHistory,
  type ActRef,
  type EndnoteEntry,
} from "../statute-helpers/endnotes.js"
import { cachedToc, sliceSubtree } from "../statute-helpers/toc.js"

export interface AmendmentHistory {
  /** Rows of the endnote table for the requested reference. */
  rows: EndnoteEntry[]
  /** False when the compilation carries no amendment-history endnote at all. */
  available: boolean
  /** Why the table could not be read, when it could not. */
  note?: string
}

/** The whole amendment-history table of a compilation, cached per (title, date). */
export async function amendmentTable(
  client: AuApiClient,
  titleId: string,
  date?: string,
): Promise<{ entries: EndnoteEntry[]; toc: NcxEntry[] } | { error: string; toc?: NcxEntry[] }> {
  let toc: NcxEntry[]
  try {
    toc = await cachedToc(client, titleId, date)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const node = findAmendmentHistoryNode(toc)
  if (!node) return { error: "this compilation has no 'Amendment history' endnote", toc }

  const key = `endnote4:${titleId}:${date ?? "latest"}`
  const cached = lawCache.get<EndnoteEntry[]>(key)
  if (cached) return { entries: cached, toc }

  try {
    const volume = /document_(\d+)/.exec(node.volumeDoc)
    const html = await client.getVolumeHtml(titleId, volume ? Number(volume[1]) : 1, date)
    const slice = sliceSubtree(html, toc, node)
    const parsed = slice === null ? [] : parseAmendmentHistory(slice)
    lawCache.set(key, parsed, ARTICLE_CACHE_TTL)
    return { entries: parsed, toc }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), toc }
  }
}

/** The endnote rows describing one provision. Never throws. */
export async function provisionHistory(
  client: AuApiClient,
  titleId: string,
  ref: SectionRef,
  date?: string,
): Promise<AmendmentHistory> {
  const table = await amendmentTable(client, titleId, date)
  if ("error" in table) return { rows: [], available: false, note: table.error }
  return { rows: entriesForRef(table.entries, ref), available: true }
}

export interface DatedEffect {
  /** `am`, `ad`, `rep`, … */
  code: string
  meaning?: string
  act: ActRef
  /** The endnote line verbatim. */
  raw: string
  /** Which row it came from, e.g. `"s 18"` under `Schedule 2`. */
  provision: string
}

/**
 * Effects on a provision attributable to an Act numbered in `year` or later.
 *
 * Deliberately a **year** comparison: the endnote has no commencement dates, so
 * a finer filter would be invented precision. The boundary year is included,
 * because an Act numbered in the year of the event may well have commenced
 * after it — the caller shows the row and lets a human decide.
 */
export function amendedAfter(rows: readonly EndnoteEntry[], year: number): DatedEffect[] {
  const out: DatedEffect[] = []
  for (const row of rows) {
    for (const effect of row.effects) {
      for (const act of effect.acts) {
        if (act.year < year) continue
        out.push({
          code: effect.code,
          ...(effect.meaning ? { meaning: effect.meaning } : {}),
          act,
          raw: effect.raw,
          provision: row.schedule ? `${row.provision} (Schedule ${row.schedule})` : row.provision,
        })
      }
    }
  }
  return out.sort((a, b) => a.act.year - b.act.year || a.act.number - b.act.number)
}

/** `No 103, 2010` → the Act on the Register. Cached; returns undefined on any failure. */
export async function resolveActByNumber(client: AuApiClient, act: ActRef): Promise<FrlTitle | undefined> {
  const key = `actByNumber:${act.year}/${act.number}`
  const cached = lawCache.get<FrlTitle>(key)
  if (cached) return cached
  try {
    const found = await client.searchTitles({
      filter: `year eq ${act.year} and number eq ${act.number} and seriesType eq 'Act'`,
      select: "id,name,year,number,status",
      top: 1,
    })
    const title = found.titles[0]
    if (title) lawCache.set(key, title, ARTICLE_CACHE_TTL)
    return title
  } catch {
    // A failed resolution must not lose the citation: callers print the raw
    // `No 103, 2010` either way, marked as unresolved.
    return undefined
  }
}

/** De-duplicate amending-Act citations, preserving order. */
export function distinctActs(effects: readonly DatedEffect[]): ActRef[] {
  const seen = new Set<string>()
  const out: ActRef[] = []
  for (const effect of effects) {
    const key = `${effect.act.year}/${effect.act.number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(effect.act)
  }
  return out
}
