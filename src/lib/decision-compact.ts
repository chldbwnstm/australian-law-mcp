/**
 * Token budgeting for decision bodies — the English counterpart of the
 * reference server's `decision-compact.ts`.
 *
 * A single Australian judgment runs to 100 KB of reasons. Returning all of it
 * for every `get_decision_text` call burns the response budget on text the
 * caller usually does not need, and truncating it at a fixed character count
 * severs the *conclusion*, which is the part that matters most. So the body is
 * shortened from the middle: a generous head, a marked gap, and the tail.
 *
 * Two rules keep this safe:
 *
 *  - **Every function returns its input unchanged when it cannot do better.**
 *    Short text, no recognised section header, no saving worth making — all
 *    return the original rather than a mangled version.
 *  - **The gap is always announced**, with the exact number of characters
 *    removed and how to ask for the whole thing. A silent elision is a lie by
 *    omission to a reader that cannot see the source.
 */

export interface CompactOptions {
  /** true → no shortening at all; the text comes back verbatim. */
  full?: boolean
  /** Characters kept at the start (default 1,600). */
  headSize?: number
  /** Characters kept at the end (default 800). */
  tailSize?: number
  /** Do not shorten unless at least this much would be saved (default 500). */
  minSave?: number
}

const DEFAULT_HEAD = 1600
const DEFAULT_TAIL = 800
const DEFAULT_MIN_SAVE = 500

export const OMISSION_MARKER = "⋯ omitted"
const FULL_HINT = "call again with full=true for the complete text"

function omissionNotice(omitted: number): string {
  return `\n\n⋯ omitted ${omitted.toLocaleString()} characters (${FULL_HINT}) ⋯\n\n`
}

/**
 * Cut a long body down to head + marker + tail.
 *
 * Both cuts prefer a sentence or paragraph boundary. English legal prose gives
 * two reliable ones: a full stop followed by whitespace, and the bracketed
 * paragraph number (`[42]`) that every Australian judgment numbers its
 * paragraphs with. A boundary is only used when it is close enough to the
 * budget to be worth it — otherwise the raw offset is used, because moving the
 * cut by 700 characters to land on a full stop wastes more than it gains.
 */
export function compactBody(text: string, opts: CompactOptions = {}): string {
  if (opts.full || !text) return text

  const head = opts.headSize ?? DEFAULT_HEAD
  const tail = opts.tailSize ?? DEFAULT_TAIL
  const minSave = opts.minSave ?? DEFAULT_MIN_SAVE
  if (text.length <= head + tail + minSave) return text

  const headRaw = text.slice(0, head)
  const headCandidates = [
    headRaw.lastIndexOf("\n\n"),
    lastParagraphMarker(headRaw),
    headRaw.lastIndexOf(". "),
    headRaw.lastIndexOf(".\n"),
  ]
  const headCut = Math.max(...headCandidates)
  const headEnd = headCut > head * 0.5 ? headCut + 2 : head
  const headText = text.slice(0, headEnd).trimEnd()

  const tailStart = text.length - tail
  const tailRaw = text.slice(tailStart)
  const tailCandidates = [
    tailRaw.indexOf("\n\n"),
    firstParagraphMarker(tailRaw),
    tailRaw.indexOf(". "),
  ].filter((index) => index >= 0)
  const tailOffset = tailCandidates.length > 0 ? Math.min(...tailCandidates) : -1
  const tailFrom = tailOffset >= 0 && tailOffset < tail * 0.5 ? tailStart + tailOffset + 2 : tailStart
  const tailText = text.slice(tailFrom).trimStart()

  const omitted = text.length - headText.length - tailText.length
  if (omitted < minSave) return text
  return `${headText}${omissionNotice(omitted)}${tailText}`
}

/** Index of the last `\n[42]`-style paragraph marker, or -1. */
function lastParagraphMarker(text: string): number {
  let last = -1
  for (const match of text.matchAll(/\n\[\d{1,4}\]/g)) {
    if (match.index !== undefined) last = match.index
  }
  return last
}

/** Index of the first `\n[42]`-style paragraph marker, or -1. */
function firstParagraphMarker(text: string): number {
  const match = /\n\[\d{1,4}\]/.exec(text)
  return match?.index ?? -1
}

/**
 * Section headers this project's renderers emit for a long body.
 *
 * Ordered longest-first so `Reasons for decision` wins over `Reasons` when both
 * would match at the same offset.
 */
export const KNOWN_SECTION_HEADERS = [
  "Reasons for decision",
  "Reasons for judgment",
  "Full text",
  "Consideration",
  "Background",
  "Discussion",
  "Conclusion",
  "Determination",
  "Judgment",
  "Decision",
  "Findings",
  "Reasons",
  "Ruling",
  "Orders",
  "Text",
  "Body",
] as const

/**
 * Post-processing shortener for `get_decision_text`.
 *
 * Finds the **last** known section header in a rendered response and shortens
 * everything after it. The last one is the right one: these renderers put
 * metadata and summaries first and the long body last, so shortening an earlier
 * section would drop the short, useful parts and keep the long one.
 *
 * Returns the input unchanged when there is no header, when the text is already
 * short, or when it has already been shortened — double-shortening would
 * produce a body with two gap markers and no way to tell how much is missing.
 */
export function compactLongSections(text: string): string {
  if (!text || text.length < 3000) return text
  if (text.includes(OMISSION_MARKER) && text.includes(FULL_HINT)) return text

  const pattern = new RegExp(`\\n(${KNOWN_SECTION_HEADERS.join("|")}):\\n`, "g")
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) last = match
  if (!last) return text

  const start = last.index + last[0].length
  const body = text.slice(start)
  const compacted = compactBody(body)
  return compacted === body ? text : text.slice(0, start) + compacted
}

/**
 * Drop a summary that the body repeats verbatim.
 *
 * Several of these sources print the catchwords or the orders both as their own
 * field and again at the top of the reasons. The end of the repeat is located
 * by matching the summary's own tail, and when that fails only the summary's
 * length is removed — a conservative bound, so a failed match can never eat
 * unrelated body text.
 */
export function stripRepeatedSummary(body: string, summaries: Array<string | undefined>): string {
  if (!body) return body
  let result = body
  for (const summary of summaries) {
    if (!summary || summary.length < 40) continue
    const trimmed = summary.trim()
    const headLength = Math.min(120, trimmed.length)
    const head = trimmed.slice(0, headLength)
    if (head.length < 40) continue

    const zone = result.slice(0, Math.floor(result.length * 0.3))
    const index = zone.indexOf(head)
    if (index < 0) continue

    const tailLength = Math.min(80, trimmed.length - headLength)
    let end: number
    if (tailLength >= 30) {
      const tail = trimmed.slice(trimmed.length - tailLength)
      const searchZone = result.slice(index, Math.min(index + Math.floor(trimmed.length * 1.3), result.length))
      const tailIndex = searchZone.indexOf(tail)
      end = tailIndex >= 0 ? index + tailIndex + tail.length : Math.min(index + trimmed.length, result.length)
    } else {
      end = Math.min(index + trimmed.length, result.length)
    }
    result = result.slice(0, index) + result.slice(end)
  }
  return result.trimStart()
}
