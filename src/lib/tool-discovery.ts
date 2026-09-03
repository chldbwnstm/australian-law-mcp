/**
 * Matching and ranking for `discover_tools` — which intent reaches which
 * category, and what a caller sees first.
 *
 * Split from `meta-tools.ts` along the grain rather than by line count: this
 * file answers "how is vocabulary matched", that one answers "how is the answer
 * shaped as an MCP tool". Every rule with a measurable justification lives here.
 *
 * The English adaptation matters. The reference server matches Korean, which
 * has no spaces between words, so it deliberately allows partial matches in
 * both directions. English does have word boundaries, and honouring them is
 * what stops "act" matching "practice", "transaction" and "contract" — a bare
 * substring test made the single commonest legal word in the language match
 * almost everything.
 */

import { TOOL_ALIASES, TOOL_CATEGORIES, V3_EXPOSED } from "./tool-profiles.js"

/** Match strength — lower is stronger, shown first, and survives the section cap. */
const TIER_ALIAS_TOOL = 0
const TIER_ALIAS_CATEGORY = 1
const TIER_CATEGORY_NAME = 2
const TIER_DESCRIPTION = 3

/**
 * Sections carried in one answer.
 *
 * Discovery is a *pointer*, not a catalogue: the point is the two or three
 * categories worth trying next. Without a cap, a broad word like "law" matches
 * a dozen categories and the answer becomes as long as the tool list it was
 * meant to replace — which is the cost the two-hop design exists to avoid.
 * Five leaves room for a genuine second and third choice.
 */
export const MAX_SECTIONS = 5

export interface DiscoverySection {
  category: string
  tools: string[]
  tier: number
}

export interface Discovery {
  sections: DiscoverySection[]
  /** Categories dropped by the cap. The caller MUST report this — no silent truncation. */
  omitted: number
}

/** Look a tool up by name. `undefined` means "not registered". */
export type ToolLookup = (name: string) => { description: string } | undefined

/**
 * Whole-word containment.
 *
 * `\b` on both sides, which is the difference between "act" matching the
 * legislation category and "act" matching contract, transaction, practice,
 * enact and redact. Multi-word aliases work unchanged ("high court", "public
 * interest disclosure"), and the boundary is computed rather than hard-coded so
 * an alias containing a hyphen or an apostrophe still matches.
 */
export function matchesAlias(query: string, alias: string): boolean {
  const term = alias.trim().toLowerCase()
  if (!term) return false
  if (query === term) return true
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // A term that starts or ends with a non-word character cannot take `\b`
  // there — `\bnsw)` would never fire. Apply the anchor only where it is valid.
  const left = /^\w/.test(term) ? "\\b" : ""
  const right = /\w$/.test(term) ? "\\b" : ""
  return new RegExp(`${left}${escaped}${right}`).test(query)
}

/**
 * Aliases whose *value* is a registered tool name: someone who types
 * `cite_check` is naming a tool, not a topic, and should get that tool's group.
 * Membership is decided by the registry rather than by a name-shape guess —
 * prefix lists miss exactly the tools that do not start with `search_`/`get_`.
 */
function aliasToolNames(query: string, isTool: (name: string) => boolean): string[] {
  for (const aliases of Object.values(TOOL_ALIASES)) {
    const names = aliases.filter(isTool)
    if (names.some((name) => matchesAlias(query, name))) return names
  }
  return []
}

/** Every alias category the query hits — not just the first, or the rest vanish. */
function aliasCategories(query: string): Set<string> {
  return new Set(
    Object.entries(TOOL_ALIASES)
      .filter(([, aliases]) => aliases.some((alias) => matchesAlias(query, alias)))
      .map(([category]) => category),
  )
}

/**
 * Sections for a query, strongest first. `query` must already be lower-cased
 * and trimmed.
 *
 * A tool appears in **one** section only, the strongest that claimed it: the
 * aggregate entry points (`legal_research`, `legal_analysis`) belong to several
 * categories, and left alone they are listed four times in one answer while
 * genuinely different tools are cut by the cap.
 */
export function selectSections(query: string, tool: ToolLookup): Discovery {
  const found: DiscoverySection[] = []

  const aliasTools = aliasToolNames(query, (name) => tool(name) !== undefined)
  if (aliasTools.length > 0) {
    found.push({ category: `named directly (${query})`, tools: aliasTools, tier: TIER_ALIAS_TOOL })
  }

  const byAlias = aliasCategories(query)
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (byAlias.has(category)) {
      found.push({ category, tools: [...tools], tier: TIER_ALIAS_CATEGORY })
      continue
    }
    // Category names are short English phrases, so both directions are useful:
    // "case" → "case law" (the query is the head word) and "state law and
    // territory" → "state law" (the query is the longer phrase).
    if (matchesAlias(category, query) || matchesAlias(query, category)) {
      found.push({ category, tools: [...tools], tier: TIER_CATEGORY_NAME })
      continue
    }
    // Description matching is the last resort and stays substring-based on the
    // tool NAME (snake_case has no word boundary at `_`), while the description
    // itself is matched on whole words.
    const matched = tools.filter((name) => {
      const entry = tool(name)
      if (!entry) return false
      return name.includes(query.replace(/\s+/g, "_")) || matchesAlias(entry.description.toLowerCase(), query)
    })
    if (matched.length > 0) found.push({ category, tools: matched, tier: TIER_DESCRIPTION })
  }

  found.sort((a, b) => a.tier - b.tier)

  const claimed = new Set<string>()
  const unique: DiscoverySection[] = []
  for (const section of found) {
    const fresh = section.tools.filter((name) => !claimed.has(name))
    fresh.forEach((name) => claimed.add(name))
    if (fresh.length > 0) unique.push({ ...section, tools: fresh })
  }

  // Within the weakest tier, order by "does this section carry an advertised
  // tool" and then by coverage. Insertion order alone buries the one-hop answer
  // below several two-hop ones purely because of where it was declared. The
  // re-sort happens after de-duplication so a section emptied by de-duplication
  // cannot hold a slot.
  const carriesExposed = (section: DiscoverySection) => (section.tools.some((name) => V3_EXPOSED.has(name)) ? 1 : 0)
  unique.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.tier === TIER_DESCRIPTION ? carriesExposed(b) - carriesExposed(a) || b.tools.length - a.tools.length : 0),
  )

  return {
    sections: unique.slice(0, MAX_SECTIONS),
    omitted: Math.max(0, unique.length - MAX_SECTIONS),
  }
}

// ── When nothing matched ──────────────────────────────────────────────────
// Listing all twenty categories is no help: the caller cannot tell which of
// them is near its question. Name the two or three that are close on the
// surface, and one direction to widen in.

const SUGGEST_LIMIT = 3
/** Suggest only when a third of the bigrams overlap. */
const SUGGEST_MIN_SIMILARITY = 1 / 3

function bigrams(text: string): string[] {
  const packed = text.toLowerCase().replace(/\s+/g, "")
  if (packed.length < 2) return packed ? [packed] : []
  return Array.from({ length: packed.length - 1 }, (_, index) => packed.slice(index, index + 2))
}

/** Character-bigram Dice coefficient — survives typos and plural endings. */
function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return 0
  const bag = new Set(right)
  return (2 * left.filter((gram) => bag.has(gram)).length) / (left.length + right.length)
}

/**
 * Categories whose surface form is close to an unmatched query.
 *
 * The cutoff rescues misspellings and near-misses ("legislaton", "tribunals",
 * "precedents") without inventing a connection for genuinely unknown
 * vocabulary. Lower it and unrelated words start attracting confident,
 * irrelevant suggestions, which is worse than none.
 */
export function suggestCategories(query: string): string[] {
  return Object.keys(TOOL_CATEGORIES)
    .map((category) => ({
      category,
      score: Math.max(...[category, ...(TOOL_ALIASES[category] ?? [])].map((candidate) => similarity(query, candidate))),
    }))
    .filter((hit) => hit.score >= SUGGEST_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGEST_LIMIT)
    .map((hit) => hit.category)
}

/**
 * Categories worth naming as a starting point — the ones holding an advertised
 * tool, so the suggestion is also the cheapest path.
 */
export function browsableCategories(limit = 4): string[] {
  return Object.entries(TOOL_CATEGORIES)
    .filter(([, tools]) => tools.some((name) => V3_EXPOSED.has(name)))
    .slice(0, limit)
    .map(([category]) => category)
}
