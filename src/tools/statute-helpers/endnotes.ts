/**
 * The compilation endnotes — the Register's own per-provision amendment table.
 *
 * `Versions.reasons[]` cannot answer "what happened to section 18": its
 * `provisions` field describes the **amending Act's** items (`sch 1 (item 66)`
 * of the amending Act), not the sections of the Act being amended. Scanning it
 * for "s 18" would match an amending Act's own s 18 and produce a history that
 * is confidently about the wrong provision.
 *
 * Every OPC compilation instead carries `Endnote 4—Amendment history`, a table
 * of exactly the mapping wanted (verified live 2026-09-04 on the CCA):
 *
 *     s 18....................
 *     am No 17, 1986; No 88, 1995; No 159, 2007
 *
 * and, under a bare `Schedule 2` scope heading, the ACL's own entry:
 *
 *     s 18....................
 *     ad No 103, 2010
 *
 * Both `s 18` rows exist in the same table, so scope tracking is not a
 * refinement — without it the ACL's history is served as the CCA's.
 *
 * One volume fetch answers the whole question. The alternative (fetching the
 * provision's text at each of 210 compilations) is both slower and less exact.
 */

import { htmlToText } from "../../lib/provision-slicer.js"
import type { SectionRef } from "../../lib/section-ref.js"
import { vocabFor } from "../../lib/section-ref-vocab.js"
import type { NcxEntry } from "../../lib/types.js"

/** OPC endnote abbreviations (Endnote 2, "Abbreviation key"). */
export const EFFECT_CODES: Readonly<Record<string, string>> = {
  ad: "added or inserted",
  am: "amended",
  ed: "editorial change",
  exp: "expired or ceased to have effect",
  mod: "modified",
  reloc: "relocated",
  renum: "renumbered",
  rep: "repealed",
  rs: "repealed and substituted",
  "am and rs": "amended, then repealed and substituted",
  disallowed: "disallowed by Parliament",
}

/** `No 103, 2010` — an Act by year and number, the only citation form the table uses. */
export interface ActRef {
  year: number
  number: number
  raw: string
}

export interface EndnoteEffect {
  /** `am`, `ad`, `rep`, `rs`, `ed`, … as written. */
  code: string
  /** Expanded meaning when the abbreviation key covers it. */
  meaning?: string
  /** The Acts cited on this line, in order. */
  acts: ActRef[]
  /** The line verbatim, so nothing is lost to the parser's judgement. */
  raw: string
}

export interface EndnoteEntry {
  /** The provision as the table writes it: `s 18`, `Schedule 2`, `Title`. */
  provision: string
  /** `2` when the row sits under a bare `Schedule 2` scope heading. */
  schedule?: string
  /** Nearest structural heading above the row: `Part 2-1`, `Chapter 2`. */
  scope?: string
  effects: EndnoteEffect[]
}

/** Locate the amendment-history endnote in a TOC. */
export function findAmendmentHistoryNode(entries: readonly NcxEntry[]): NcxEntry | undefined {
  return entries.find((entry) => /amendment\s+history/i.test(entry.label))
}

const DOTTED = /^(.*?)\.{3,}$/
const EFFECT = /^(am and rs|ad|am|ed|exp|mod|reloc|renum|rep|rs|disallowed)\b\s*(.*)$/i
const ACT_REF = /No\s*(\d+),\s*(\d{4})/g
const BARE_SCHEDULE = /^schedules?\s+([0-9]+[A-Za-z]*|[IVXLCDM]+)$/i
const BARE_SCOPE = /^(chapter|part|division|subdivision|schedule)\s+\S+$/i

/**
 * Parse the amendment-history table.
 *
 * Accepts either the endnote's raw XHTML or the text already extracted from it
 * (`sliceSubtree` returns text) — the two callers differ, and silently
 * returning nothing for the wrong one is exactly the failure this tolerance
 * removes.
 *
 * The table is a flat run of paragraphs: dotted rows are provisions, the lines
 * under them are effects, and bare structural headings set scope. Anything
 * unrecognised is skipped rather than guessed at.
 */
export function parseAmendmentHistory(source: string): EndnoteEntry[] {
  const lines = (source.includes("<p") ? htmlToText(source) : source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const entries: EndnoteEntry[] = []
  let schedule: string | undefined
  let scope: string | undefined
  let current: EndnoteEntry | undefined

  for (const line of lines) {
    const dotted = DOTTED.exec(line)
    if (dotted) {
      const provision = dotted[1].trim()
      if (!provision) continue
      current = {
        provision,
        ...(schedule ? { schedule } : {}),
        ...(scope ? { scope } : {}),
        effects: [],
      }
      entries.push(current)
      continue
    }

    const effect = EFFECT.exec(line)
    if (effect && current) {
      const code = effect[1].toLowerCase()
      current.effects.push({
        code,
        ...(EFFECT_CODES[code] ? { meaning: EFFECT_CODES[code] } : {}),
        acts: parseActRefs(line),
        raw: line,
      })
      continue
    }

    const bareSchedule = BARE_SCHEDULE.exec(line)
    if (bareSchedule) {
      schedule = bareSchedule[1]
      scope = undefined
      current = undefined
      continue
    }
    if (BARE_SCOPE.test(line)) {
      scope = line
      current = undefined
    }
  }

  return entries
}

function parseActRefs(line: string): ActRef[] {
  const out: ActRef[] = []
  for (const match of line.matchAll(ACT_REF)) {
    out.push({ number: Number(match[1]), year: Number(match[2]), raw: `No ${match[1]}, ${match[2]}` })
  }
  return out
}

/** Fold a table provision label (`s 18`, `Schedule 2`) for comparison. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[\s ]+/g, "").replace(/[‑–—]/g, "-")
}

/**
 * How the endnote table might write this reference. The table uses the AGLC
 * abbreviation for sections (`s 18`) but the English word for structural units
 * (`Schedule 2`, `Part 2-1`), so both spellings are candidates.
 *
 * The schedule prefix is deliberately dropped: inside the table, an ACL row is
 * written `s 18` under a `Schedule 2` scope heading, not `sch 2 s 18`.
 */
function candidateLabels(ref: SectionRef): string[] {
  const vocab = vocabFor(ref.kind)
  const number = `${ref.number}${ref.letterSuffix ?? ""}`
  const labels = [`${vocab.singular} ${number}`]
  if (vocab.ncxWord) labels.push(`${vocab.ncxWord} ${number}`)
  return labels.map(fold)
}

/**
 * The rows describing one reference. A `sch N …` reference matches only rows
 * inside that schedule's scope; an unqualified one matches only body rows —
 * the same discipline `findNavPoint` applies to the table of contents, for the
 * same reason. Without it, ACL s 18 ("ad No 103, 2010") and CCA s 18
 * ("am No 17, 1986; …") are indistinguishable rows in one table.
 */
export function entriesForRef(entries: readonly EndnoteEntry[], ref: SectionRef): EndnoteEntry[] {
  const wanted = candidateLabels(ref)
  const matches = entries.filter((entry) => {
    const label = fold(entry.provision)
    return wanted.some((candidate) => label === candidate || label.startsWith(`${candidate}(`))
  })
  if (ref.schedule) return matches.filter((entry) => entry.schedule === ref.schedule)
  if (ref.kind === "schedule") return matches
  return matches.filter((entry) => entry.schedule === undefined)
}
