/**
 * Finding the Act a chain is about.
 *
 * Every chain stacks upward from one title — Act → instruments → provisions →
 * cases — so if the first step comes back empty the whole chain does. And the
 * Federal Register's title search is a *name* search: hand it "can my landlord
 * keep my bond in Queensland" and it returns nothing, even though the routing
 * was perfectly correct. The chain then reports "no such law", which is a lie.
 *
 * Four attempts, cheapest first, each recorded so a failure can say what was
 * tried (a caller who is not told the search terms cannot rephrase):
 *
 *  1. The **alias table** — "the ACL", "FW Act", "TPA" are how people write.
 *  2. A **statute-shaped phrase lifted out of the query** ("… Fair Work Act
 *     2009 …"), because a question usually contains the title it is about.
 *  3. The **query as given**, which works whenever the user typed a name.
 *  4. **Full-text search** (`search_ai_law`'s ranked titles) — this is the step
 *     that turns a subject into a statute, and the only one that costs a second
 *     round trip, which is why it is last.
 *
 * The fourth rung carries a problem the first three do not, and it is the
 * reason for the local re-rank below. Full-text relevance ranks by the *body*
 * of a title, so an Act that merely mentions the words can bury the Act the
 * question is actually about. Measured live 2026-09-04, "penalty for
 * misleading conduct" answers with the *Foreign Passports (Law Enforcement and
 * Security) Act 2005* first and the *Competition and Consumer Act 2010*
 * sixteenth; a chain that takes hit #1 then spends its whole legislative
 * section on passports. Nothing false is asserted — every section is real —
 * but the answer is about the wrong statute, which is the failure mode this
 * server is built to avoid.
 *
 * So the candidates from that rung are re-ordered before one is picked:
 *
 *  a. a **subject anchor** wins — a question whose words the bundled term
 *     table already ties to an Act ("misleading conduct" → ACL → CCA) is not a
 *     guess, and it beats a body-text relevance score;
 *  b. **amending Acts sink**, whatever their names say — see
 *     `NON_PRINCIPAL_PENALTY`;
 *  c. then **content-word overlap** with the title's own name;
 *  d. then Acts over instruments;
 *  e. then the Register's relevance order, as the tiebreak.
 *
 * And when the winner shares no word with the question and no anchor fired,
 * the choice is **annotated rather than hidden** — the caller is told the base
 * law came from relevance alone and is given the runners-up.
 */

import type { AuApiClient } from "../lib/api-client.js"
import { LAW_ALIAS_ENTRIES, resolveLawAlias } from "../lib/law-alias.js"
import { LEGAL_TERM_ENTRIES } from "../lib/legal-terms-data.js"
import { SCENARIO_RULES } from "../lib/scenario-rules.js"
import type { FrlTitle } from "../lib/types.js"
import { searchAiLawStructured } from "./ai-search.js"
import { fold, rankSeedTerms, stem } from "./kb-utils.js"
import { TITLE_SELECT, looksLikeRegisterId, rankTitles } from "./statute-helpers/title-lookup.js"

export interface ChainBaseLaw {
  registerId: string
  name: string
  collection?: string
  status?: string
  /** Principal Act / instrument rather than an amending one. Used by the re-rank. */
  isPrincipal?: boolean
}

export interface ChainBaseLawResult {
  laws: ChainBaseLaw[]
  /** The search term that actually produced results, if any. */
  searchedWith?: string
  /** Every term tried, in order — printed verbatim in the failure message. */
  attempts: string[]
  /**
   * How the base law was chosen, when that is not self-evident. Printed under
   * the `Base law:` header so a reader can see a relevance-only pick for what
   * it is. Optional so older callers (and test doubles) stay valid.
   */
  notes?: string[]
}

/**
 * `Competition and Consumer Act 2010`, `Fair Work Regulations 2009` — the shape
 * of an Australian short title: capitalised words, then Act/Regulations/Rules/
 * Determination/Order/Code, then optionally a year.
 */
const TITLE_PHRASE =
  /\b([A-Z][A-Za-z'’-]*(?:\s+(?:of|and|for|the|in|on|to|[A-Z][A-Za-z'’-]*)){0,8}\s+(?:Act|Regulations?|Rules?|Determination|Instrument|Order|Code|Standard|Constitution)(?:\s+(?:19|20)\d{2})?)\b/

/** The statute-shaped phrase inside a question, if there is one. */
export function titlePhraseFrom(query: string): string | undefined {
  const match = TITLE_PHRASE.exec(query)
  return match?.[1]?.trim()
}

function toBaseLaw(title: FrlTitle): ChainBaseLaw {
  return {
    registerId: title.id,
    name: title.name,
    ...(title.collection ? { collection: title.collection } : {}),
    ...(title.status ? { status: title.status } : {}),
    ...(title.isPrincipal !== undefined ? { isPrincipal: title.isPrincipal } : {}),
  }
}

/**
 * Prefer the principal Act over its own delegated legislation.
 *
 * Full-text relevance ranks by word overlap, and a regulation repeats its
 * enabling Act's vocabulary — so "Fair Work Regulations 2009" routinely outranks
 * the *Fair Work Act 2009*. A chain built on the regulations produces a
 * three-tier view with nothing above it.
 */
function actsFirst(laws: ChainBaseLaw[]): ChainBaseLaw[] {
  const subordinate = (law: ChainBaseLaw) => law.collection !== undefined && law.collection !== "Act"
  return [...laws.filter((law) => !subordinate(law)), ...laws.filter(subordinate)]
}

// ──────────────────────────────────────────────────────────────────────────
// The full-text rung: local re-ranking
// ──────────────────────────────────────────────────────────────────────────

/**
 * How many titles the full-text rung asks for before re-ranking.
 *
 * Wider than the `max` the caller wants, because the re-rank can only promote
 * an Act it can see: on the recorded response for "penalty for misleading
 * conduct" five candidates leave the CCA out of the list entirely and eight
 * include it (relevance position 16, lifted to 4th by `rankTitles`). The
 * Register's ordering drifts between calls, so this is a better chance rather
 * than a guarantee — which is why a missing anchor is fetched by id below.
 *
 * Not wider still, and the ceiling is latency rather than payload. The
 * Register's full-text search slows as `$top` grows and some questions already
 * run close to the client's 30-second timeout: "how do I object to an amended
 * tax assessment" measured 18–32 s at `$top=10..16` on 2026-09-04 and timed
 * out repeatedly at `$top=24`. A rung that times out returns *no* base law,
 * which is a worse answer than a mediocre one. Eight is also exactly the width
 * `chain_full_research` already asks `search_ai_law` for in parallel
 * (`search_ai_law` requests `2 × limit`), so this adds no new latency class.
 */
const FULL_TEXT_CANDIDATES = 8

/**
 * Words that separate no two Australian statutes.
 *
 * Question scaffolding ("what", "can I") plus the vocabulary every title
 * shares ("act", "law", "Australian", "Commonwealth"). Left in, "act" alone
 * would make every candidate overlap every query, which is the same as having
 * no overlap signal at all.
 */
const NOISE_WORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "why", "how", "whether",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "done",
  "can", "could", "should", "would", "may", "might", "must", "will", "shall", "need",
  "i", "we", "you", "they", "he", "she", "it", "me", "us", "them", "my", "our", "your", "their",
  "a", "an", "the", "of", "for", "to", "and", "or", "in", "on", "at", "by", "with", "without",
  "from", "under", "over", "about", "as", "if", "that", "this", "these", "those", "there",
  "here", "not", "no", "any", "all", "some", "into", "than", "then", "get", "got", "have", "has",
  "act", "acts", "law", "laws", "legislation", "legislative", "regulation", "regulations",
  "rule", "rules", "section", "sections", "provision", "provisions", "australia", "australian",
  "commonwealth", "cth", "federal",
])

/**
 * The words in a phrase that could identify a statute: folded, stripped of
 * noise, stemmed so "penalties" and "penalty" are one word.
 */
export function contentWords(value: string): Set<string> {
  const out = new Set<string>()
  for (const word of fold(value).split(" ")) {
    if (!word || NOISE_WORDS.has(word)) continue
    const stemmed = stem(word)
    // Two-character stems ("no", "gs") match by accident far more often than
    // they match on purpose.
    if (stemmed.length < 3 || NOISE_WORDS.has(stemmed)) continue
    out.add(stemmed)
  }
  return out
}

/** Fraction of the question's content words that appear in the title's name. */
function overlapFraction(queryWords: ReadonlySet<string>, name: string): number {
  if (queryWords.size === 0) return 0
  const titleWords = contentWords(name)
  let hits = 0
  for (const word of queryWords) if (titleWords.has(word)) hits += 1
  return hits / queryWords.size
}

/** An Act the question's *subject* points at, independently of full-text relevance. */
export interface DomainAnchor {
  /** The term in the bundled dictionary that fired — named in the note. */
  term: string
  /** Official short title of the Act that term is anchored to. */
  official: string
  /** Federal Register id, taken from the alias table (never invented here). */
  titleId: string
}

/**
 * A `words` hit at 0.6 overlap. Below this the term shares one word out of
 * three with the question, which is a suggestion rather than an anchor —
 * see `scoreCandidate` in kb-utils for the scale.
 */
const ANCHOR_MIN_SCORE = 60

/** The official title an already-verified register id belongs to. */
function officialForTitleId(titleId: string): string | undefined {
  return LAW_ALIAS_ENTRIES.find((entry) => entry.titleId === titleId)?.official
}

/**
 * Does the question look like one of the scenarios the router knows?
 *
 * The gate on the anchor. `scenario-rules` owns this vocabulary — a second
 * copy here is how the same sentence starts being read two ways — and the
 * labelling `patterns` are the right list: they answer "is this a recognisable
 * kind of legal question", which is exactly the precondition for trusting a
 * subject anchor over the Register's own ordering.
 */
export function hasScenarioHint(query: string): boolean {
  return SCENARIO_RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(query)))
}

/**
 * The Act a question's subject belongs to, via the bundled term dictionary.
 *
 * "misleading conduct" is not a title, an alias or a phrase in any Act's name,
 * so no rung above this one can reach the CCA from it — but the term table
 * already records that the prohibition is ACL s 18, and the ACL is schedule 2
 * of the CCA. That chain of already-verified facts is a better answer than a
 * body-text relevance score, so when the question also reads as a recognised
 * scenario the anchor is allowed to win.
 *
 * Returns nothing on a miss: a subject this table does not cover is a gap in
 * the table, never a reason to distrust the search.
 */
export function domainAnchorFor(query: string): DomainAnchor | undefined {
  if (!hasScenarioHint(query)) return undefined
  for (const hit of rankSeedTerms(query, LEGAL_TERM_ENTRIES, 5)) {
    // `text` hits match inside the description only — a suggestion, and one
    // that scores below the floor anyway.
    if (hit.matchedBy === "text" || hit.score < ANCHOR_MIN_SCORE) continue
    const titleId = hit.item.provisions?.find((provision) => provision.titleId)?.titleId
    if (!titleId) continue
    const official = officialForTitleId(titleId)
    if (official) return { term: hit.item.term, official, titleId }
  }
  return undefined
}

// Points. The gaps are the specification, and only the gaps: an anchor
// outranks everything, an amending Act is out of the running whatever its name
// says, name overlap outranks the Act-over-instrument preference, and titles
// that tie on all of it keep the Register's relevance order.
const ANCHOR_POINTS = 200
const OVERLAP_FLOOR = 60
const OVERLAP_SPAN = 30
const PRINCIPAL_POINTS = 25
const ACT_POINTS = 20

/**
 * Bigger than the largest overlap award, and deliberately so.
 *
 * An *amending* Act is not a weaker base law, it is the wrong kind of thing:
 * `get_three_tier` on one finds nothing under it, because the sections it
 * inserted now live in the principal Act. And amending Acts are exactly the
 * titles that carry the subject in their name — "Trade Practices Amendment
 * (Cartel Conduct and Other Measures) Act 2009" shares two words with "maximum
 * penalty for a cartel offence" while the *Competition and Consumer Act 2010*
 * shares none. Left to compete on overlap they would win, and the chain would
 * be built on a spent amendment. So a title the Register marks non-principal
 * sits below every principal candidate whatever its name says. `undefined` is
 * not `false`: a title whose flag the Register did not send is not demoted.
 */
const NON_PRINCIPAL_PENALTY = 100

export interface RankedBaseLaws {
  laws: ChainBaseLaw[]
  /** Provenance for the choice, when it is not obvious from the names. */
  notes: string[]
}

/** A resolved anchor: the subject that fired, and the title it names. */
export interface AnchoredLaw {
  anchor: DomainAnchor
  law: ChainBaseLaw
}

function describe(law: ChainBaseLaw): string {
  return `${law.name} [${law.registerId}]`
}

/**
 * Re-order full-text candidates, and say how the winner was reached.
 *
 * Pure: the anchor's title has already been resolved by the caller, so this
 * function can be table-tested without a network.
 */
export function rankFullTextCandidates(
  query: string,
  candidates: readonly ChainBaseLaw[],
  anchored?: AnchoredLaw,
): RankedBaseLaws {
  const queryWords = contentWords(query)
  const relevanceTop = candidates[0]

  // The anchored Act joins the pool rather than replacing it, and merges with
  // its own entry when the search already found it.
  const pool = [...candidates]
  if (anchored && !pool.some((law) => law.registerId === anchored.law.registerId)) {
    pool.push(anchored.law)
  }

  const scored = pool.map((law, index) => {
    let points = 0
    if (anchored && law.registerId === anchored.law.registerId) points += ANCHOR_POINTS
    const fraction = overlapFraction(queryWords, law.name)
    if (fraction > 0) points += OVERLAP_FLOOR + Math.round(OVERLAP_SPAN * fraction)
    if (law.isPrincipal) points += PRINCIPAL_POINTS
    else if (law.isPrincipal === false) points -= NON_PRINCIPAL_PENALTY
    if (law.collection === "Act") points += ACT_POINTS
    return { law, index, points, fraction }
  })
  // Stable on the upstream order, which *is* the relevance ranking.
  scored.sort((a, b) => b.points - a.points || a.index - b.index)

  const laws = scored.map((entry) => entry.law)
  const notes: string[] = []
  const winner = scored[0]

  if (anchored && winner?.law.registerId === anchored.law.registerId) {
    notes.push(
      `Base law chosen by subject, not by search relevance: the question matches "${anchored.anchor.term}" in ` +
        `the bundled term dictionary, which is anchored to ${anchored.anchor.official}.` +
        (relevanceTop && relevanceTop.registerId !== anchored.law.registerId
          ? ` The full-text search ranked ${describe(relevanceTop)} first; that is a body-text match, not a ` +
            "subject match."
          : ""),
    )
  } else if (winner && winner.fraction === 0) {
    // Requirement met by saying so, not by suppressing the result: the Act may
    // well be right, but nothing in its name says it is.
    const alternatives = laws.slice(1, 3).map(describe)
    notes.push(
      "⚠️ Base law chosen by full-text relevance alone — no word of your question appears in its name, and no " +
        "subject anchor matched. Verify it is the Act you meant before relying on the sections below." +
        (alternatives.length > 0 ? ` Alternatives considered: ${alternatives.join("; ")}.` : ""),
    )
  }

  return { laws, notes }
}

export async function resolveChainBaseLaw(
  apiClient: AuApiClient,
  query: string,
  max = 3,
): Promise<ChainBaseLawResult> {
  const attempts: string[] = []
  const tried = new Set<string>()

  const byName = async (text: string): Promise<ChainBaseLaw[]> => {
    const key = text.trim()
    if (!key || tried.has(key)) return []
    tried.add(key)
    attempts.push(key)
    try {
      const found = await apiClient.searchTitles({
        text: key,
        searchType: "name",
        top: Math.max(max * 3, 10),
        select: TITLE_SELECT,
      })
      return rankTitles(key, found.titles).slice(0, max).map(toBaseLaw)
    } catch {
      // A failed attempt is not a failed chain: the next rung may answer, and
      // if none does, the caller is told which terms were tried.
      return []
    }
  }

  // 0) A register id typed straight in is a lookup, not a search.
  const trimmed = query.trim()
  if (looksLikeRegisterId(trimmed)) {
    try {
      const title = await apiClient.getTitle(trimmed)
      return { laws: [toBaseLaw(title)], searchedWith: trimmed, attempts: [trimmed] }
    } catch {
      attempts.push(trimmed)
    }
  }

  // 1) Alias table.
  const alias = resolveLawAlias(trimmed)
  if (!alias.needsJurisdiction && alias.searchText && alias.searchText !== trimmed) {
    const hits = await byName(alias.searchText)
    if (hits.length > 0) return { laws: actsFirst(hits), searchedWith: alias.searchText, attempts }
  }

  // 2) A title-shaped phrase inside the question.
  const phrase = titlePhraseFrom(trimmed)
  if (phrase && phrase !== trimmed) {
    const hits = await byName(phrase)
    if (hits.length > 0) return { laws: actsFirst(hits), searchedWith: phrase, attempts }
  }

  // 3) The query as typed.
  const asTyped = await byName(trimmed)
  if (asTyped.length > 0) return { laws: actsFirst(asTyped), searchedWith: trimmed, attempts }

  // 4) Subject → statute, via full text. Last because it costs an extra call
  //    and returns titles whose *body* mentions the words, not whose name does.
  //    Its output is re-ranked locally before a base law is taken from it, so
  //    `actsFirst` is not applied here — the ranking already prefers Acts, and
  //    a hard partition by collection would undo the overlap ordering.
  attempts.push(`${trimmed} (full text)`)
  try {
    const { titleSignals } = await searchAiLawStructured(apiClient, {
      query: trimmed,
      limit: Math.max(max, FULL_TEXT_CANDIDATES),
      provisionHints: false,
    })
    const candidates = titleSignals.map((signal) => ({
      registerId: signal.registerId,
      name: signal.name,
      ...(signal.collection ? { collection: signal.collection } : {}),
      ...(signal.status ? { status: signal.status } : {}),
      ...(signal.isPrincipal !== undefined ? { isPrincipal: signal.isPrincipal } : {}),
    }))

    const anchored = await resolveDomainAnchor(apiClient, trimmed, candidates, attempts)
    const ranked = rankFullTextCandidates(trimmed, candidates, anchored)
    if (ranked.laws.length > 0) {
      return {
        laws: ranked.laws.slice(0, max),
        searchedWith: `${trimmed} (full text)`,
        attempts,
        notes: ranked.notes,
      }
    }
  } catch {
    // Same contract as the name attempts: a broken rung never becomes a claim.
  }

  return { laws: [], attempts }
}

/**
 * The anchored Act as a candidate — from the search results when they already
 * contain it, otherwise fetched by its verified register id.
 *
 * A failed fetch drops the anchor rather than the rung: relevance order with
 * an annotation is still an answer, and one missing round trip must never turn
 * into "no such law".
 */
async function resolveDomainAnchor(
  apiClient: AuApiClient,
  query: string,
  candidates: readonly ChainBaseLaw[],
  attempts: string[],
): Promise<AnchoredLaw | undefined> {
  const anchor = domainAnchorFor(query)
  if (!anchor) return undefined

  const already = candidates.find((law) => law.registerId === anchor.titleId)
  if (already) return { anchor, law: already }

  attempts.push(`${anchor.official} (subject anchor: "${anchor.term}")`)
  try {
    return { anchor, law: toBaseLaw(await apiClient.getTitle(anchor.titleId)) }
  } catch {
    return undefined
  }
}
