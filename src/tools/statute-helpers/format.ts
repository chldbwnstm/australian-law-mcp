/**
 * Rendering helpers shared by the statute tools.
 *
 * The annotations here exist because a bare FRL row is routinely misread:
 *
 *  - `status: "Repealed"` without the repealing act reads as "gone, nothing
 *    replaced it". `statusHistory[].reasons[].affectedByTitle` names the
 *    successor, so it always travels with the flag.
 *  - The **TPA → CCA rename is not a repeal**. `C2004A00109` is still in
 *    force under a new name; a `nameHistory` hit has to say "renamed", never
 *    anything that a reader could collapse into "repealed".
 *  - `hasCommencedUnincorporatedAmendments` means the compiled text on the
 *    Register is already out of date. Silently serving that text is the
 *    quietest way this server could be wrong, so the warning is unconditional.
 */

import type { FrlTitle, FrlVersion, FrlVersionReason } from "../../lib/types.js"
import { normaliseAliasKey } from "../../lib/law-alias.js"

/** `2015-06-30T00:00:00` / `2015-06-30` → `2015-06-30`; null → `—`. */
export function isoDay(value: string | null | undefined): string {
  if (!value) return "—"
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  return match ? match[1] : value.trim()
}

/** `Act` / `LegislativeInstrument` → a phrase a reader can use. */
export function collectionLabel(title: Pick<FrlTitle, "collection" | "subCollection">): string {
  const collection = title.collection ?? "unknown collection"
  const spaced = collection.replace(/([a-z])([A-Z])/g, "$1 $2")
  return title.subCollection ? `${spaced} (${title.subCollection})` : spaced
}

/** The act that repealed a repealed title, from `statusHistory`. */
export function repealedBy(title: FrlTitle): { name: string; titleId: string; provisions?: string; start?: string } | undefined {
  for (const entry of title.statusHistory ?? []) {
    if (entry.status !== "Repealed") continue
    for (const reason of entry.reasons ?? []) {
      const affecter = reason.affectedByTitle ?? reason.amendedByTitle
      if (affecter?.titleId) {
        return {
          name: affecter.name,
          titleId: affecter.titleId,
          ...(affecter.provisions ? { provisions: affecter.provisions } : {}),
          ...(entry.start ? { start: isoDay(entry.start) } : {}),
        }
      }
    }
  }
  return undefined
}

/**
 * Former names of a title, newest first. The current name is excluded — a
 * `nameHistory` row matching today's name is not a rename to report.
 */
export function formerNames(title: FrlTitle): string[] {
  const current = normaliseAliasKey(title.name)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of title.nameHistory ?? []) {
    const key = normaliseAliasKey(entry.name)
    if (!key || key === current || seen.has(key)) continue
    seen.add(key)
    out.push(entry.name)
  }
  return out
}

/**
 * Which former name (if any) the query actually matched. This is what turns a
 * puzzling result ("I searched the Trade Practices Act and got the CCA") into
 * an explained one.
 */
export function matchedFormerName(query: string, title: FrlTitle): string | undefined {
  const key = normaliseAliasKey(query)
  if (key.length < 5) return undefined
  const currentKey = normaliseAliasKey(title.name)
  if (currentKey.includes(key)) return undefined
  return formerNames(title).find((name) => {
    const nameKey = normaliseAliasKey(name)
    return nameKey.includes(key) || key.includes(nameKey)
  })
}

/**
 * The warning/status lines for one title, in the order a reader needs them.
 * `query` (when given) enables the historical-name explanation.
 */
export function titleAnnotations(title: FrlTitle, query?: string): string[] {
  const lines: string[] = []

  if (query) {
    const former = matchedFormerName(query, title)
    if (former) {
      lines.push(`↳ matched former name: "${former}" — now "${title.name}" (same register id, a rename, NOT a repeal).`)
    }
  }

  const previous = formerNames(title)
  if (previous.length > 0 && !lines.some((line) => line.includes("matched former name"))) {
    lines.push(`↳ previously named: ${previous.join("; ")} (renamed, not repealed — same register id).`)
  }

  if (title.status === "Repealed") {
    const by = repealedBy(title)
    lines.push(
      by
        ? `⚠️ REPEALED${by.start ? ` on ${by.start}` : ""} by ${by.name}${by.provisions ? ` ${by.provisions}` : ""} [${by.titleId}] — that title is the successor to check.`
        : "⚠️ REPEALED. The Register does not name a repealing title on this record; check statusHistory with get_law_history before concluding.",
    )
  } else if (title.status === "Ceased") {
    lines.push("⚠️ CEASED (sunset or self-repeal) — no longer in force.")
  } else if (title.status === "NeverEffective") {
    lines.push("⚠️ NEVER EFFECTIVE — registered but never commenced. Do not cite as operative law.")
  } else if (title.isInForce === false) {
    lines.push("⚠️ NOT YET IN FORCE at the current date (registered, commencement still to come).")
  }

  if (title.hasCommencedUnincorporatedAmendments) {
    lines.push(
      "⚠️ Commenced amendments are NOT yet incorporated into the compiled text. " +
        "The text served here is behind the law in force — check get_law_history / the amending acts before relying on it.",
    )
  }

  return lines
}

/** One search-result block. The register id is always present — follow-up calls need it. */
export function formatTitleBlock(title: FrlTitle, index: number, query?: string): string {
  const lines: string[] = []
  lines.push(`${index}. ${title.name}`)
  const facts: string[] = [`id: ${title.id}`, collectionLabel(title)]
  if (title.status) facts.push(title.status)
  if (title.isPrincipal === true) facts.push("principal")
  else if (title.isPrincipal === false) facts.push("amending/other")
  if (title.year) facts.push(`No ${title.number ?? "?"} of ${title.year}`)
  lines.push(`   ${facts.join(" | ")}`)
  for (const note of titleAnnotations(title, query)) lines.push(`   ${note}`)
  return lines.join("\n")
}

/** One `reasons[]` row as a sentence: which act, which provisions, what it did. */
export function reasonLine(reason: FrlVersionReason): string {
  const affecter = reason.amendedByTitle ?? reason.affectedByTitle
  const verb = reason.affect ?? "Change"
  if (!affecter) {
    const markdown = (reason.markdown ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim()
    return markdown ? `${verb}: ${markdown}` : verb
  }
  const provisions = affecter.provisions ? ` ${affecter.provisions}` : ""
  return `${verb}: ${affecter.name}${provisions} [${affecter.titleId}]`
}

/** One compilation as a list row. `registerId` is the id every text call needs. */
export function formatVersionLine(version: FrlVersion, index?: number): string {
  const prefix = index === undefined ? "•" : `${index}.`
  const window = `${isoDay(version.start)} → ${version.end ? isoDay(version.end) : "current"}`
  const flags: string[] = []
  if (version.compilationNumber) flags.push(`compilation ${version.compilationNumber}`)
  if (version.isCurrent) flags.push("in force now")
  if (version.isLatest) flags.push("latest registered")
  if (version.status) flags.push(version.status)
  if (version.hasUnincorporatedAmendments) flags.push("⚠️ unincorporated amendments")
  const id = version.registerId ? `registerId: ${version.registerId}` : "registerId: none yet (compilation pending)"
  return `${prefix} ${window} — ${id}${flags.length > 0 ? ` | ${flags.join(" | ")}` : ""}`
}

/** Footer used whenever a result set was cut short, so the caller knows how to widen it. */
export function moreHint(shown: number, total: number, how: string): string {
  return total > shown ? `\n… ${total - shown} more not shown. ${how}` : ""
}
