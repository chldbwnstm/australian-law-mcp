/**
 * Does the cited *content* match the provision that was cited?
 *
 * Existence checking alone cannot catch the most dangerous statutory
 * hallucination: a real section number carrying a description of a different
 * provision. *Competition and Consumer Act 2010* (Cth) s 18 exists — it is
 * "Meetings of Commission". A model that writes "s 18 prohibits misleading or
 * deceptive conduct" has cited a real section for a proposition it does not
 * contain, and an existence-only verifier signs it off with a tick.
 *
 * Two layers, ported from the reference implementation's
 * `lib/citation-content-matcher.ts` (which itself ports LexDiff):
 *
 *   L1 (exact)   — a common substring of at least 30 normalised characters,
 *                  or containment for a claim shorter than that.
 *   L2 (jaccard) — character-bigram Jaccard >= 0.25.
 *
 * Character bigrams rather than words: the reference chose them because Korean
 * agglutination makes word tokens unreliable, and they survive the move to
 * English for a different but equally real reason — legal headings inflect and
 * abbreviate ("Misleading or deceptive conduct" vs "misleading conduct"), and
 * a word-level measure scores that pair as poorly as an unrelated one. Measured
 * on the flagship pair: "misleading or deceptive conduct" vs "Meetings of
 * Commission" scores 0.18 (mismatch), while "misleading conduct" vs
 * "Misleading or deceptive conduct" scores 0.55 (match).
 *
 * Deviations from the reference, both deliberate:
 *  - normalisation lower-cases (Korean has no case; English headings are title
 *    case in the Register and sentence case in prose, and that difference must
 *    not read as a content difference);
 *  - the Korean-specific transforms (circled digits, 「」 brackets, interpuncts)
 *    are replaced by their English equivalents — markdown emphasis, smart
 *    quotes, and the em/en dashes the Register's headings are full of.
 */

export type MatchMethod = "exact" | "token-jaccard" | "mismatch"

export interface ContentMatchResult {
  matched: boolean
  method: MatchMethod
  score: number
  normalizedLenClaim: number
  normalizedLenActual: number
}

/** Shortest common substring accepted as an exact match, in normalised characters. */
const MIN_EXACT_LEN = 30

/**
 * Practical threshold for character-bigram Jaccard. Unrelated legal headings
 * sit at 0.05–0.20; a paraphrase of the same heading sits at 0.35–0.80.
 */
const JACCARD_THRESHOLD = 0.25

/** U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM. */
function isZeroWidth(codePoint: number): boolean {
  return codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff
}

/** Non-breaking, thin and figure spaces — Register text and pasted citations are full of them. */
function isOddSpace(codePoint: number): boolean {
  return codePoint === 0x00a0 || (codePoint >= 0x2000 && codePoint <= 0x200a) || codePoint === 0x202f
}

const SMART_SINGLE = /[‘’‚‛′]/g
const SMART_DOUBLE = /[“”„‟″]/g
/** Hyphen-like and dash-like code points: the Register writes "Part IVA—News media". */
const DASHES = /[‐‑‒–—―−]/g

/**
 * Fold a claim or a heading to the form both layers compare.
 *
 * Everything removed here is presentational: emphasis markers, quote style,
 * dash style, spacing. Nothing that changes what the text says is touched.
 */
export function normalizeLegalText(value: string): string {
  if (!value) return ""

  let cleaned = ""
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0) as number
    if (isZeroWidth(codePoint)) continue
    cleaned += isOddSpace(codePoint) ? " " : character
  }

  return cleaned
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(DASHES, " ")
    .replace(/[*_`]/g, "")
    .replace(/['"]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The title half of an NCX navLabel.
 *
 * The Register writes provisions as `"18  Meetings of Commission"` and
 * structural units as `"Schedule 2—The Australian Consumer Law"`. Comparing a
 * claim against the raw label would let the section number and the word
 * "Schedule" contribute to the score, which is noise in one direction and a
 * false match in the other.
 */
export function headingTitle(label: string): string {
  const collapsed = label.replace(/[ ]/g, " ").replace(/\s+/g, " ").trim()
  const worded =
    /^(?:Schedule|Part|Division|Subdivision|Chapter|Appendix|Order)\s+\S{1,12}\s*[‐-―−-]\s*(.+)$/i.exec(
      collapsed,
    )
  if (worded) return stripLeadingArticle(worded[1].trim())
  const numbered = /^(?:[0-9]{1,4}(?:[.\-][0-9]{1,4}){0,3}[A-Za-z]{0,4}|[IVXLCDM]{1,8}[A-Z]?)[.\s]\s*(.+)$/.exec(collapsed)
  if (numbered) return numbered[1].trim()
  return collapsed
}

/** "The Australian Consumer Law" → "Australian Consumer Law". */
function stripLeadingArticle(value: string): string {
  return value.replace(/^the\s+/i, "").trim()
}

/**
 * Character bigrams of the punctuation-free, space-free fold.
 *
 * Punctuation and spacing are removed *before* the bigrams are cut so that
 * "misleading or deceptive" and "misleading-or-deceptive" produce the same
 * token set.
 */
function tokenize(value: string): string[] {
  const compact = normalizeLegalText(value).replace(/[^a-z0-9]+/gu, "")
  if (compact.length < 2) return compact ? [compact] : []
  const grams: string[] = []
  for (let index = 0; index < compact.length - 1; index++) grams.push(compact.slice(index, index + 2))
  return grams
}

/**
 * Longest common substring length. O(n·m) with a single retained row — legal
 * headings are tens of characters, so the quadratic table is never the cost.
 */
function longestCommonSubstringLen(a: string, b: string): number {
  if (!a || !b) return 0
  const n = a.length
  const m = b.length
  let previous = new Uint16Array(m + 1)
  let current = new Uint16Array(m + 1)
  let best = 0
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        const value = previous[j - 1] + 1
        current[j] = value
        if (value > best) best = value
      } else {
        current[j] = 0
      }
    }
    ;[previous, current] = [current, previous]
    current.fill(0)
  }
  return best
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compare what a citation *claims* a provision says against what it actually
 * says. An empty side is never a match — silence is not agreement.
 */
export function matchCitationContent(claim: string, actual: string): ContentMatchResult {
  const c = normalizeLegalText(claim)
  const a = normalizeLegalText(actual)

  if (!c || !a) {
    return { matched: false, method: "mismatch", score: 0, normalizedLenClaim: c.length, normalizedLenActual: a.length }
  }

  // A claim too short for the substring floor is judged by containment: "meetings"
  // inside "meetings of commission" is agreement, and nothing longer is available
  // to measure.
  //
  // The score is coverage of the heading, not a flat 1. Containment is always a
  // match, but it is not always the *best* match, and `bestHeadingMatch` ranks
  // candidates by this number: "misleading conduct" sits inside ACL s 31
  // ("Misleading conduct as to the nature etc. of employment") and a flat 1 made
  // that beat ACL s 18 ("Misleading or deceptive conduct"), which is the
  // provision the writer meant. Coverage scores the buried match 0.35 and leaves
  // the paraphrase's 0.55 on top. A claim that is nearly the whole heading still
  // scores near 1.
  if (c.length < MIN_EXACT_LEN && a.includes(c)) {
    return {
      matched: true,
      method: "exact",
      score: c.length / Math.max(1, a.length),
      normalizedLenClaim: c.length,
      normalizedLenActual: a.length,
    }
  }

  const lcs = longestCommonSubstringLen(c, a)
  if (lcs >= MIN_EXACT_LEN) {
    return {
      matched: true,
      method: "exact",
      score: Math.min(1, lcs / Math.max(1, c.length)),
      normalizedLenClaim: c.length,
      normalizedLenActual: a.length,
    }
  }

  const score = jaccard(new Set(tokenize(c)), new Set(tokenize(a)))
  if (score >= JACCARD_THRESHOLD) {
    return { matched: true, method: "token-jaccard", score, normalizedLenClaim: c.length, normalizedLenActual: a.length }
  }

  return {
    matched: false,
    method: "mismatch",
    score: Math.max(lcs / Math.max(1, c.length), score),
    normalizedLenClaim: c.length,
    normalizedLenActual: a.length,
  }
}
