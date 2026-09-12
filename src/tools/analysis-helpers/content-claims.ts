/**
 * What does the surrounding prose claim the cited provision *says*?
 *
 * Existence checking cannot catch "s 18 prohibits misleading or deceptive
 * conduct" — s 18 of the *Competition and Consumer Act 2010* (Cth) exists, and
 * is "Meetings of Commission". Catching that needs the assertion, and the
 * assertion is in the sentence, not in the citation.
 *
 * Only a small set of shapes is recognised, and each one is a construction in
 * which the writer is plainly describing the provision. Harvesting looser
 * material would manufacture claims the writer never made, and a wrongly
 * reported CONTENT_MISMATCH is itself a confident wrong answer.
 *
 * Nothing here decides whether a claim is true — that is
 * `citation-content-matcher.ts` against the Register's own heading.
 */

export type ClaimSource = "parenthetical" | "dash" | "titled" | "verb" | "preceding" | "proposition"

export interface ContentClaim {
  text: string
  source: ClaimSource
}

/** Words that carry no content, used only to reject a claim that is all filler. */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "or", "and", "to", "in", "on", "for", "with", "by", "is", "are", "was",
  "were", "be", "been", "that", "this", "it", "its", "as", "at", "from", "any", "all", "such",
  "which", "who", "whom", "not", "no", "but", "if", "then", "there", "their",
])

const MAX_CLAIM_CHARS = 180

/** Verbs a writer uses when saying what a provision does. */
const CLAIM_VERBS =
  "prohibits|prohibit|forbids|creates|create|provides for|provide for|deals with|deal with|" +
  "requires|require|imposes|impose|establishes|establish|defines|define|governs|govern|" +
  "covers|cover|concerns|concern|relates to|relate to|confers|confer|sets out|set out|" +
  "renders|makes it an offence to|allows|permits|entitles|obliges"

/** `s 18 (misleading or deceptive conduct)` — the parenthetical gloss. */
const PARENTHETICAL = /^[\s,]{0,4}\(([^)\n]{3,70})\)/
/** `s 18 — misleading or deceptive conduct` */
const DASHED = /^\s{0,3}[:—–-]\s{0,3}([^.;\n]{3,70})/
/** `s 18, titled 'Misleading or deceptive conduct'` */
const TITLED =
  /^[\s,]{0,4}(?:which is |that is |and is )?(?:titled|headed|entitled|is headed|is titled)\s*[:,]?\s*["'‘“]?([^"'.;\n’”]{3,80})/i
/** `s 18 prohibits misleading or deceptive conduct` */
const VERB = new RegExp(`^[\\s,]{0,4}(?:which |that |and )?(?:${CLAIM_VERBS})\\s+([^.;\n]{3,${MAX_CLAIM_CHARS}})`, "i")
/** `s 18 makes misleading or deceptive conduct unlawful` */
const MAKES = /^[\s,]{0,4}(?:which |that |and )?makes?\s+([^.;\n]{3,60}?)\s+(?:unlawful|an offence|actionable|void|voidable)\b/i

/** "Under s 18, a corporation must not ..." states more than a heading's topic. */
const PROPOSITION = /^[\s,]{0,6}((?:a|an|the|any|each|every|no)\s+[^.;:\n]{1,70}?\b(?:must|shall|may|cannot|can)\b[^.;:\n]{3,170})/i
const STATES = new RegExp(`^[\\s,]{0,4}(?:provides|states|says)\\s+(?:that\\s+)?([^.;\n]{3,${MAX_CLAIM_CHARS}})`, "i")

/** Past participles a writer uses when saying, in the passive, what a provision does. */
const PASSIVE_PARTICIPLES =
  "prohibited|forbidden|banned|governed|regulated|covered|created|defined|dealt with|set out|addressed|found|imposed|required"

/** `misleading or deceptive conduct is prohibited by <cite>` */
const PRECEDING_PASSIVE = new RegExp(
  `(?:^|[.;:]\\s|\\band\\s|\\bbut\\s)([A-Za-z][^.;:\\n]{3,80}?)\\s+(?:is|are|was|were)\\s+(?:${PASSIVE_PARTICIPLES})\\s+(?:by|in|under|at)\\s*(?:the\\s+)?$`,
  "i",
)

/**
 * `Under the CCA s 18, misleading conduct is prohibited` — the mirror image of
 * PRECEDING_PASSIVE, and the shape a model writing legal prose reaches for most
 * often, because "Under <Act> <section>, …" is how the sentence starts. Without
 * it the flagship trap this whole file exists for went uncaught: the claim was
 * never extracted, so s 18 was ticked off on existence alone.
 *
 * The comma is required. `s 18 misleading conduct is prohibited` with no
 * punctuation is not a sentence anyone writes, and matching it would let a
 * citation swallow the subject of the *next* clause.
 */
const FOLLOWING_PASSIVE = new RegExp(
  `^\\s{0,3},\\s{0,3}(?:where\\s+|under\\s+which\\s+)?([A-Za-z][^.;:\\n]{3,80}?)\\s+(?:is|are|was|were)\\s+(?:${PASSIVE_PARTICIPLES})\\b`,
  "i",
)
/** `the prohibition on misleading or deceptive conduct in <cite>` */
const PRECEDING_NOUN =
  /\b(?:prohibition|rule|provision|requirement|offence|duty|obligation|test|definition|ban)\s+(?:on|of|against|for|about)\s+([^.;:\n]{3,80}?)\s+(?:in|under|at)\s*(?:the\s+)?$/i

function clean(value: string): string {
  return value
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'‘“]+|[\s"'‘“’”,]+$/g, "")
    .trim()
}

/**
 * Reject glosses that are not descriptions: a jurisdiction, a date, a
 * subsection pointer, an amendment note, a bare citation.
 */
function isDescriptive(value: string): boolean {
  if (value.length < 3 || value.length > MAX_CLAIM_CHARS) return false
  if (/^(?:Cth|NSW|Vic|Qld|SA|WA|Tas|ACT|NT)$/i.test(value)) return false
  if (/^\s*(?:as )?(?:am|ad|rep|rs|repealed|inserted|amended|substituted)\b/i.test(value)) return false
  if (/^\d/.test(value)) return false
  if (/^(?:No\s*\d|[ivxlcdm]+\)?$)/i.test(value)) return false
  if (/^(?:s|ss|sch|pt|div|ch|reg|regs|r|cl|para|sub-s)\b/i.test(value)) return false
  if (/\b(?:19|20)\d{2}\b/.test(value) && !/[a-z]{4}/i.test(value.replace(/\b(?:19|20)\d{2}\b/g, ""))) return false
  const words = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
  return words.length >= 2
}

/**
 * The claim attached to a citation, or `undefined` when the prose does not
 * describe the provision. `after` is the text following the pinpoint; `before`
 * is the text preceding the whole citation.
 */
export function extractContentClaim(before: string, after: string): ContentClaim | undefined {
  // Closing markdown emphasis belongs to the citation, not the next clause.
  after = after.replace(/[*_`]/g, "")
  const ordered: Array<[ClaimSource, RegExpExecArray | null]> = [
    ["parenthetical", PARENTHETICAL.exec(after)],
    ["titled", TITLED.exec(after)],
    ["dash", DASHED.exec(after)],
    ["verb", VERB.exec(after)],
    ["verb", MAKES.exec(after)],
    // Last of the `after` shapes: an active-voice description immediately after
    // the pinpoint is the stronger evidence, so it wins where both could match.
    ["verb", FOLLOWING_PASSIVE.exec(after)],
    ["proposition", PROPOSITION.exec(after)],
    ["proposition", STATES.exec(after)],
  ]
  for (const [source, match] of ordered) {
    if (!match) continue
    const text = clean(match[1])
    if (isDescriptive(text)) return { text, source }
  }

  for (const pattern of [PRECEDING_NOUN, PRECEDING_PASSIVE]) {
    const match = pattern.exec(before)
    if (!match) continue
    const text = clean(match[1])
    if (isDescriptive(text)) return { text, source: "preceding" }
  }
  return undefined
}
