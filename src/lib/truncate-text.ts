/**
 * Strategy for shortening long responses at a "meaning boundary"
 * (used by the truncate* helpers in schemas.ts).
 *
 * An unconditional slice cuts through the middle of a sentence. A full judgment
 * response fills the limit to well over 90%, so the real-world cut lands in the
 * tail of a concurring or dissenting opinion, and losing half a sentence there
 * changes how the legal substance reads. The cut point therefore retreats to
 * the last completed boundary.
 *
 * That retreat is capped. In a text where one sentence runs to thousands of
 * characters, searching without limit for "the nearest boundary" throws away a
 * whole stretch that happens to contain none — a bigger loss than the problem
 * being fixed. If there is no boundary within the cap, no retreat happens: a
 * hard cut is the minimum loss, and retreating is only worth it when it beats
 * that.
 */

/** Cap (in characters) on the boundary retreat. Without a boundary inside it, keep the hard cut. */
const MAX_BOUNDARY_BACKTRACK = 400

/**
 * Hard-cut slice — if the cut lands in the middle of a surrogate pair, step
 * back one. Astral characters such as `𠮷` are two UTF-16 units; cutting after
 * a high surrogate produces a string that fails isWellFormed() and is mangled
 * into U+FFFD by JSON serialisation.
 */
export function sliceWellFormed(text: string, end: number): string {
  if (end <= 0) return ""
  if (end >= text.length) return text
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

/** Last "terminator + whitespace (or end)" in s → the index just past the terminator. */
function lastSentenceEnd(s: string): number {
  let best = -1
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i]
    if (ch !== "." && ch !== "!" && ch !== "?") continue
    const next = s[i + 1]
    if (next === undefined || /\s/.test(next)) {
      best = i + 1
      break
    }
  }
  return best
}

/**
 * Cut text to within `budget` characters, retreating the cut point to the last
 * completed boundary. Priority: line boundary > sentence terminator > no
 * retreat (hard cut).
 */
export function cutAtSafeBoundary(text: string, budget: number): string {
  if (budget <= 0) return ""
  if (text.length <= budget) return text

  const hard = text.slice(0, budget)
  const floor = Math.max(0, budget - MAX_BOUNDARY_BACKTRACK)

  // First choice: a line boundary. Responses from this server are assembled
  // line by line (one section per line, one row per table row), so a line is
  // itself a complete unit.
  const nl = hard.lastIndexOf("\n")
  if (nl >= floor && nl > 0) return hard.slice(0, nl)

  // Second choice: a sentence terminator.
  const sentence = lastSentenceEnd(hard.slice(floor))
  if (sentence > 0) return hard.slice(0, floor + sentence)

  // No boundary within the cap → do not retreat (zero gratuitous loss). Only
  // avoid splitting a surrogate pair.
  return sliceWellFormed(text, budget)
}

/**
 * Summary-mode tail — assembly (extractSummary) and re-cut-then-reattach
 * (truncateResponse) share the same source of this string.
 */
export function summaryTail(originalLength: number, keptLength: number): string {
  return `\n\n📋 Summary mode: key content extracted from ${originalLength.toLocaleString()} characters (${keptLength.toLocaleString()} characters kept)`
}

/**
 * Extract a summary of the key content (truncateResponse summary mode):
 * first line + every section header (▶ ...) + the first 2 lines of each
 * section + the closing note.
 */
export function extractSummary(text: string, maxSize: number): string {
  const lines = text.split("\n")
  const collected: string[] = []
  let budget = maxSize - 100 // headroom for the closing note

  // Always include the first line (the title)
  if (lines.length > 0) {
    collected.push(lines[0])
    budget -= lines[0].length + 1
  }

  let i = 1
  while (i < lines.length && budget > 0) {
    const line = lines[i]
    // Section header (or a separator line)
    if (/^▶|^#{1,4}\s|^=====|^-----/.test(line)) {
      collected.push("")
      collected.push(line)
      budget -= line.length + 2
      // Include up to 2 lines after the header
      let j = 1
      for (; j <= 2 && i + j < lines.length && budget > 0; j++) {
        const nextLine = lines[i + j]
        if (/^▶|^#{1,4}\s/.test(nextLine)) break // stop at the next section
        collected.push(nextLine)
        budget -= nextLine.length + 1
      }
      i += j // advance i by however much the inner loop consumed
    }
    i++
  }

  const body = collected.join("\n")
  return body + summaryTail(text.length, body.length)
}
