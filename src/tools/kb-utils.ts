/**
 * Matching and formatting shared by the seven knowledge-base tools.
 *
 * The matcher is deliberately forgiving in one direction only. A user types
 * "directors duties", "Director's Duty" or "duties of directors" and must
 * reach the same entry, so folding drops case and punctuation and a crude
 * stemmer collapses plurals. But every match carries **how** it was reached
 * (`matchedBy`) and a score, and the tools print both: a definition-text hit
 * is a suggestion, not a lookup, and a caller that cannot tell them apart
 * will quote a loose match as if it were the term's meaning.
 */

import type { GlossaryEntry, GlossaryLoad } from "../lib/glossary.js"
import { GLOSSARY_SOURCE, GLOSSARY_URL } from "../lib/glossary.js"
import type { LegalTermEntry, TermProvision } from "../lib/legal-terms-data.js"
import type { ToolResponse } from "../lib/types.js"

/** How a candidate was reached, strongest first. */
export type MatchKind = "exact" | "alias" | "prefix" | "contains" | "words" | "text"

export interface Ranked<T> {
  item: T
  score: number
  matchedBy: MatchKind
}

const SCORES: Record<MatchKind, number> = {
  exact: 100,
  alias: 90,
  prefix: 78,
  contains: 66,
  words: 45,
  text: 24,
}

/** Lower case, punctuation to spaces, whitespace collapsed. */
export function fold(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Crude suffix stripper — enough to join singular and plural, no more. */
export function stem(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith("sses") || word.endsWith("shes") || word.endsWith("ches")) return word.slice(0, -2)
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3)
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2)
  return word
}

/** Words that carry no discriminating power in a legal-term query. */
const STOP_WORDS = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "is", "what", "law", "act"])

export function tokens(value: string): string[] {
  return fold(value)
    .split(" ")
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map(stem)
}

function wordOverlap(query: string, candidate: string): number {
  const wanted = tokens(query)
  if (wanted.length === 0) return 0
  const have = new Set(tokens(candidate))
  const hits = wanted.filter((word) => have.has(word)).length
  return hits / wanted.length
}

/**
 * Score one candidate. `aliases` are treated as headwords; `text` is the
 * definition body and can only ever produce the weakest kind of hit.
 */
export function scoreCandidate(
  query: string,
  term: string,
  extra: { aliases?: readonly string[]; text?: string } = {},
): Ranked<null> | null {
  const q = fold(query)
  if (q.length === 0) return null
  const t = fold(term)
  if (q === t) return { item: null, score: SCORES.exact, matchedBy: "exact" }
  for (const alias of extra.aliases ?? []) {
    if (fold(alias) === q) return { item: null, score: SCORES.alias, matchedBy: "alias" }
  }
  if (t.startsWith(q) || q.startsWith(t)) {
    const penalty = Math.min(12, Math.abs(t.length - q.length))
    return { item: null, score: SCORES.prefix - penalty, matchedBy: "prefix" }
  }
  if (t.includes(q) || q.includes(t)) return { item: null, score: SCORES.contains, matchedBy: "contains" }

  const overlap = Math.max(
    wordOverlap(query, term),
    ...(extra.aliases ?? []).map((alias) => wordOverlap(query, alias)),
  )
  if (overlap >= 0.5) return { item: null, score: SCORES.words + Math.round(overlap * 25), matchedBy: "words" }

  if (extra.text && fold(extra.text).includes(q) && q.length >= 4) {
    return { item: null, score: SCORES.text, matchedBy: "text" }
  }
  return null
}

function rank<T>(
  query: string,
  items: readonly T[],
  describe: (item: T) => { term: string; aliases?: readonly string[]; text?: string },
  limit: number,
): Ranked<T>[] {
  const scored: Array<Ranked<T> & { term: string }> = []
  for (const item of items) {
    const parts = describe(item)
    const hit = scoreCandidate(query, parts.term, parts)
    if (hit) scored.push({ item, score: hit.score, matchedBy: hit.matchedBy, term: parts.term })
  }
  // Ties break towards the shorter headword, then alphabetically: with equal
  // evidence the more specific term is the one the user typed a prefix of,
  // and an arbitrary tie order would make the same query rank differently
  // after an unrelated entry is added to the table.
  scored.sort((a, b) => b.score - a.score || a.term.length - b.term.length || a.term.localeCompare(b.term))
  return scored.slice(0, limit).map(({ item, score, matchedBy }) => ({ item, score, matchedBy }))
}

/** Seed-dictionary search over term, plain-language aliases and see-also names. */
export function rankSeedTerms(
  query: string,
  entries: readonly LegalTermEntry[],
  limit = 10,
): Ranked<LegalTermEntry>[] {
  return rank(query, entries, (entry) => ({
    term: entry.term,
    aliases: entry.plainAliases ?? [],
    text: `${entry.plain} ${entry.legal ?? ""}`,
  }), limit)
}

/** Plain-language search: the everyday phrasings and the plain sentence rank first. */
export function rankPlainTerms(
  query: string,
  entries: readonly LegalTermEntry[],
  limit = 10,
): Ranked<LegalTermEntry>[] {
  return rank(query, entries, (entry) => ({
    term: entry.plainAliases?.[0] ?? entry.term,
    aliases: [entry.term, ...(entry.plainAliases ?? [])],
    text: entry.plain,
  }), limit)
}

export function rankGlossary(
  query: string,
  entries: readonly GlossaryEntry[],
  limit = 10,
): Ranked<GlossaryEntry>[] {
  return rank(query, entries, (entry) => ({
    term: entry.term,
    aliases: entry.aliases,
    text: entry.definition,
  }), limit)
}

/** Find the single best seed entry for a term name, or nothing. */
export function findSeedTerm(
  query: string,
  entries: readonly LegalTermEntry[],
): LegalTermEntry | undefined {
  return rankSeedTerms(query, entries, 1)[0]?.item
}

// ── formatting ────────────────────────────────────────────────────────────

export function formatProvision(provision: TermProvision): string {
  const id = provision.titleId ? ` [titleId ${provision.titleId}]` : ""
  return `${provision.title} ${provision.ref}${id}`
}

export function formatMatchNote(matchedBy: MatchKind): string {
  switch (matchedBy) {
    case "exact":
      return "exact term match"
    case "alias":
      return "matched a plain-language phrasing of this term"
    case "prefix":
      return "matched the start of the term"
    case "contains":
      return "the query is contained in the term"
    case "words":
      return "matched on shared words — confirm this is the term you meant"
    case "text":
      return "matched inside the description only, not the term itself — treat as a suggestion"
  }
}

/** Full entry body used by the detail tools. */
export function formatSeedEntry(entry: LegalTermEntry, links: string[] = []): string {
  const lines = [`${entry.term}`, "", `Plain English: ${entry.plain}`]
  if (entry.legal) lines.push("", `In law: ${entry.legal}`)
  if (entry.provisions && entry.provisions.length > 0) {
    lines.push("", "Statutory anchors:")
    for (const provision of entry.provisions) lines.push(`  - ${formatProvision(provision)}`)
  }
  if (links.length > 0) {
    lines.push("", "Read the current text:")
    for (const link of links) lines.push(`  - ${link}`)
  }
  if (entry.plainAliases && entry.plainAliases.length > 0) {
    lines.push("", `Everyday phrasings: ${entry.plainAliases.join(", ")}`)
  }
  if (entry.seeAlso && entry.seeAlso.length > 0) lines.push("", `See also: ${entry.seeAlso.join(", ")}`)
  return lines.join("\n")
}

export function formatGlossaryEntry(entry: GlossaryEntry): string {
  const also = entry.aliases.length > 1 ? ` (also: ${entry.aliases.slice(1).join(", ")})` : ""
  return `${entry.term}${also}\n  ${entry.definition}`
}

/** One line naming the glossary's contribution — or why it made none. */
export function glossaryNote(load: GlossaryLoad): string {
  if (load.unavailable) {
    return `Glossary: not consulted — ${load.unavailable}. This says nothing about whether the term exists; ${GLOSSARY_URL} opens fine in a browser.`
  }
  return `Glossary: ${load.entries.length} plain-language entries from the ${GLOSSARY_SOURCE} (${GLOSSARY_URL}).`
}

/**
 * The empty answer. It states which sources were consulted, because "not in
 * the bundled dictionary" and "no such legal term" are different claims and
 * only the first one is ever true here.
 */
export function termNotFound(query: string, sources: string[], suggestions: string[] = []): ToolResponse {
  const lines = [
    `[NOT_FOUND] No entry for '${query}'.`,
    "",
    "⚠️ This is a miss in the sources listed below — it is NOT evidence that the phrase is not a legal term. Do not invent a definition; say the lookup missed and offer the next step.",
    "",
    "Consulted:",
    ...sources.map((source) => `  - ${source}`),
  ]
  if (suggestions.length > 0) {
    lines.push("", "Closest entries in the bundled dictionary:", ...suggestions.map((s) => `  - ${s}`))
  }
  lines.push(
    "",
    "Next: search the legislation itself (search_law / get_law_text) — definitions usually sit in a dictionary section such as Corporations Act 2001 (Cth) s 9 or Fair Work Act 2009 (Cth) s 12.",
  )
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true }
}
