/**
 * A small line diff, implemented locally rather than pulled in as a dependency.
 *
 * Legal text diffs are read by a human deciding whether an amendment matters,
 * so the output is a unified diff with context: an unlabelled list of changed
 * lines loses the "which subsection" that makes the change legible.
 *
 * Myers is overkill for two compilations of one provision (tens of lines), so
 * this is a plain LCS table with a size guard — above the guard the tool says
 * the texts are too large to diff instead of quietly diffing a prefix.
 */

/** Above this line count the LCS table is refused (cells = a×b). */
export const MAX_DIFF_LINES = 1200

export type DiffOp = { kind: "same" | "add" | "remove"; text: string }

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

/** Longest-common-subsequence diff over lines. Throws when either side is too long. */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    throw new RangeError(
      `Text too large to diff (${a.length} vs ${b.length} lines, limit ${MAX_DIFF_LINES}). ` +
        "Diff a single provision rather than a whole part.",
    )
  }

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "remove", text: a[i] })
      i++
    } else {
      ops.push({ kind: "add", text: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ kind: "remove", text: a[i++] })
  while (j < b.length) ops.push({ kind: "add", text: b[j++] })
  return ops
}

const MARK: Record<DiffOp["kind"], string> = { same: "  ", add: "+ ", remove: "- " }

/**
 * Unified rendering with `context` unchanged lines around each change. Runs of
 * skipped lines are marked, so nothing is silently dropped.
 */
export function unifiedDiff(oldText: string, newText: string, context = 2): string {
  const ops = diffLines(oldText, newText)
  const changed = ops.map((op) => op.kind !== "same")
  if (!changed.some(Boolean)) return "(no textual difference)"

  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true
  }

  const lines: string[] = []
  let skipped = 0
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        lines.push(`  … ${skipped} unchanged line${skipped === 1 ? "" : "s"}`)
        skipped = 0
      }
      lines.push(`${MARK[ops[i].kind]}${ops[i].text}`)
    } else {
      skipped++
    }
  }
  if (skipped > 0) lines.push(`  … ${skipped} unchanged line${skipped === 1 ? "" : "s"}`)
  return lines.join("\n")
}

/** Counts for a one-line summary above the diff body. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number; unchanged: number } {
  const ops = diffLines(oldText, newText)
  return {
    added: ops.filter((op) => op.kind === "add").length,
    removed: ops.filter((op) => op.kind === "remove").length,
    unchanged: ops.filter((op) => op.kind === "same").length,
  }
}
