/**
 * State Library of NSW plain-language legal glossary
 * (`legalanswers.sl.nsw.gov.au/glossary`, research §10).
 *
 * The page is server-rendered HTML: one `<dl>` of `<dt>` term / `<dd>`
 * definition pairs inside the site chrome. Two decisions matter here:
 *
 *  - **A glossary failure is never absence.** The glossary is a *supplement*
 *    to the bundled seed dictionary, so `loadGlossary` returns a result
 *    object carrying an `unavailable` reason instead of throwing. A tool that
 *    still has seed hits must answer with them and say the scrape did not
 *    land; a tool with nothing must say "not in the bundled dictionary and
 *    the glossary was unreachable", which is a different claim from "no such
 *    term".
 *  - **A `<dt>` can name several terms.** "Accused, Defendant" and
 *    "Callover/Mention" are one definition serving two headwords, so both
 *    are exposed as `aliases` and become independently matchable. The
 *    ampersand form ("Summary & Indictable offences") is deliberately left
 *    whole — splitting it would invent two terms that the source does not
 *    define separately.
 */

import { ARTICLE_CACHE_TTL, lawCache } from "./cache.js"

/** Path this server asks for. It 301s twice; global fetch follows both hops. */
export const GLOSSARY_PATH = "/glossary"

/** The stable human URL, cited in every answer built from this source. */
export const GLOSSARY_URL = "https://legalanswers.sl.nsw.gov.au/glossary"

export const GLOSSARY_SOURCE = "State Library of NSW — Find Legal Answers glossary"

export interface GlossaryEntry {
  /** Headword exactly as published, e.g. `"Accused, Defendant"`. */
  term: string
  /** Plain-English definition, tags stripped and whitespace collapsed. */
  definition: string
  /**
   * Individual headwords when the `<dt>` names several, comma- or
   * slash-separated. Empty for a single-term entry.
   */
  aliases: string[]
}

export interface GlossaryLoad {
  entries: GlossaryEntry[]
  /**
   * Why the glossary contributed nothing. Present ⇒ the entries list says
   * nothing about which terms exist; absent ⇒ the list is the real glossary.
   */
  unavailable?: string
}

/** Minimal client surface — keeps the parser testable without a live host. */
export interface GlossaryFetcher {
  fetchHtml(host: "glossary", path: string): Promise<string>
}

const CACHE_KEY = "glossary:sl-nsw:v1"

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
}

/** Decode the named and numeric entities Drupal emits; leave anything else alone. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Split a multi-headword `<dt>` on commas and slashes.
 *
 * Only applied when every part survives as a plausible headword (2+
 * characters, no sentence punctuation), so "Summary & Indictable offences"
 * and "Hearsay rule" stay whole.
 */
export function splitHeadwords(term: string): string[] {
  if (!/[,/]/.test(term)) return []
  const parts = term.split(/\s*[,/]\s*/).map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return []
  if (parts.some((part) => part.length < 2 || /[.;:]/.test(part))) return []
  return parts
}

/**
 * Parse the glossary page. Returns `[]` when the definition list is absent —
 * a shape change upstream, which callers must report as "unavailable", never
 * as an empty glossary.
 */
export function parseGlossaryHtml(html: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  const seen = new Set<string>()
  // Comments first: the live page carries `<!-- noindex -->` markers and the
  // recorded fixture carries a provenance note, and either can contain the
  // literal text `<dt>` — matching inside one invents a headword out of prose.
  const body = html.replace(/<!--[\s\S]*?-->/g, " ")
  const pairs = body.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)
  for (const pair of pairs) {
    const term = textOf(pair[1])
    const definition = textOf(pair[2])
    if (!term || !definition) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ term, definition, aliases: splitHeadwords(term) })
  }
  return entries
}

/**
 * Fetch and parse the glossary, cached for 24 hours (the page is a static
 * book chapter; the politeness interval in the hosts table is per-request,
 * this cache is what stops the request happening at all).
 *
 * Never throws: a network failure, a block or a markup change all come back
 * as `unavailable` so a caller cannot accidentally turn one into `NOT_FOUND`.
 */
export async function loadGlossary(client: GlossaryFetcher): Promise<GlossaryLoad> {
  const cached = lawCache.get<GlossaryEntry[]>(CACHE_KEY)
  if (cached) return { entries: cached }

  let html: string
  try {
    html = await client.fetchHtml("glossary", GLOSSARY_PATH)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { entries: [], unavailable: `the glossary host could not be read (${reason})` }
  }

  const entries = parseGlossaryHtml(html)
  if (entries.length === 0) {
    return {
      entries: [],
      unavailable: "the glossary page returned no <dt>/<dd> definition pairs (markup change upstream)",
    }
  }
  lawCache.set(CACHE_KEY, entries, ARTICLE_CACHE_TTL)
  return { entries }
}

/** Drop the cached copy — used by tests and by any future refresh command. */
export function clearGlossaryCache(): void {
  lawCache.delete(CACHE_KEY)
}
