/**
 * The provision grammar, executed against every provision label of five real
 * Acts.
 *
 * ## Why this file exists
 *
 * `section-ref.test.ts` is a list of examples somebody thought of. Five rounds
 * of review have now shown that the examples nobody thought of are where the
 * damage is: a regex tuned to admit `Part IVBA` stopped admitting
 * `Subdivision C`; one tuned to keep `s 355-25` whole could not express
 * `Part 2D.1`; one tuned to reject the phantom `pt IES` also rejected the real
 * `Part IAABA`. Every one of those changes passed the example list.
 *
 * So this file is not a list of examples. It is the table of contents of five
 * compilations — thousands of recorded navLabels, every Chapter, Part,
 * Division, Subdivision, Schedule and section heading they contain — and it
 * asserts four properties of each one:
 *
 *   a. **it parses** — `parseSectionRef` reads the provision the label names;
 *   b. **it round-trips** — parse → `formatRef` → parse is the same reference,
 *      so the canonical form this module emits is one it can read back;
 *   c. **it addresses itself and nothing else** — `refToNcxLabelPattern`
 *      matches its own label and matches no label in the same document that
 *      names a *different* provision (this is what catches `Subdiv 152-C`
 *      resolving to `Subdivision 152-A`, and `pt 5` to `Part 5.1`);
 *   d. **the scanner does not invent or truncate** — `extractSectionRefs` over
 *      the label's own text reports the provision the label names, and never a
 *      number the text does not contain.
 *
 * A regex change that breaks a real citation form now fails here, naming the
 * labels it broke, instead of shipping.
 *
 * ## Every label is accounted for
 *
 * A label that is not a provision reference is matched by a row of
 * `EXCLUSIONS` and counted under that row's reason; a label that matches
 * nothing at all fails the test rather than being skipped, so a shape the
 * register starts emitting tomorrow cannot slip past unnoticed. A provision
 * label the grammar cannot read needs a row in `KNOWN_UNPARSABLE` — which is
 * empty, and is meant to stay empty.
 *
 * ## Fixture provenance
 *
 * All four new captures: **2026-09-05**, by `curl` with the user agent
 * `fetch-with-retry.ts` sends, from
 * `https://www.legislation.gov.au/{id}/latest/latest/text/latest/epub/OEBPS/document.ncx`.
 * Element markup, ids, playOrder values and label text are byte-identical to
 * what the register served; nothing was reformatted.
 *
 *  - `corporations-act-toc-slice.ncx` — C2004A00818, *Corporations Act 2001*.
 *    5,570 labels / 1.7 MB served, 1,718 kept. Holds all 125 Part labels whose
 *    number carries a letter (`2A.1`…`2N.5`, `2F.1A`, `5C.10`) — the shape
 *    `parseSectionRef` rejected outright and the scanner answered `pt 2D` for
 *    — and all 390 bare-lettered `Subdivision A`…`H`/`CA`/`DA` labels.
 *  - `itaa1997-toc-slice.ncx` — C2004A05138, *Income Tax Assessment Act 1997*.
 *    6,773 labels / 2.1 MB served, 2,543 kept. Dashed numbering throughout:
 *    `Subdivision 83A-A`…`E`, `Subdivision 152-A`…`D`, and 392 dashed section
 *    numbers (`165-210`, `355-25`) — the shape a plural designation reads as a
 *    range.
 *  - `crimes-act-toc.ncx` — C1914A00012, *Crimes Act 1914*. 1,064 labels,
 *    kept whole. Roman Parts with lettered tails up to the widest in the
 *    statute book, `Part IAABA`.
 *  - `constitution-toc.ncx` — C2004Q00685, *Commonwealth of Australia
 *    Constitution Act*. 157 labels, kept whole. 1900 typography —
 *    `51. Legislative powers of the Parliament.` — and the two labels that are
 *    nothing but `86.` and `87.`, with no heading text at all.
 *
 * The two big ones are trimmed the way `CLAUDE.md` requires — **only for size,
 * only by dropping whole navPoint records**, never by editing one. The dropped
 * records are leaf (section) navPoints past the fortieth of their number
 * *shape*: every distinct shape survives with up to forty real examples of it,
 * and every structural navPoint survives, so the depth and ordering are the
 * register's own.
 *
 * The `.ncx` fixtures are read straight out of `__fixtures__/`, so recording
 * another table of contents into that directory extends this corpus with no
 * change here.
 */

import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  extractSectionRefs,
  formatRef,
  parseSectionRef,
  refToNcxLabelPattern,
  type SectionRef,
} from "./section-ref.js"

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url))

/**
 * The label reader.
 *
 * Deliberately hand-rolled and deliberately dumb. If this file split labels
 * with the module's own patterns it would only ever prove that the grammar
 * agrees with itself; `ncx-parser.ts` is avoided for the same reason — a
 * corpus that shares its reader with the code under test cannot fail.
 */
function labelsOf(xml: string): string[] {
  return [...xml.matchAll(/<navLabel>\s*<text>([\s\S]*?)<\/text>/g)].map((m) =>
    m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  )
}

interface NcxDocument {
  file: string
  labels: string[]
}

const DOCUMENTS: NcxDocument[] = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".ncx"))
  .sort()
  .map((file) => ({ file, labels: labelsOf(readFileSync(FIXTURES + file, "utf8")) }))

const STRUCTURAL_WORD = "(?:Chapter|Part|Division|Subdivision|Schedule|Appendix|Order)"
/** The register sets the gap after a designation as U+00A0, and the heading separator as an em dash. */
const GAP = "[\\s\\u00a0]"
const HEADING_DASH = "\\u2014\\u2015"

/**
 * The two label shapes the vocabulary table describes, read without the
 * module's grammar.
 *
 * `worded` — an English designation, the gap, the number, then the heading
 * behind an em dash (or, in the ITAA's guides, a colon).
 * `number` — the number, an optional 1900-typography stop, then **two** spaces
 * and the heading, or nothing at all. Two spaces, because that is what the
 * register prints and because one space cannot tell `95% services indirect
 * value shifts` — an ITAA guide heading — from a numbered provision.
 */
const WORDED_LABEL = new RegExp(`^(${STRUCTURAL_WORD})${GAP}+([^\\s\\u00a0${HEADING_DASH}:]+)`)
const NUMBER_LABEL = new RegExp(`^([0-9][^\\s\\u00a0${HEADING_DASH}]*?)\\.?(?=${GAP}{2}|$)`)
const STARTS_STRUCTURAL = new RegExp(`^${STRUCTURAL_WORD}\\b`)

/**
 * Labels that are navPoints but not provisions, each with the reason it is not
 * one. Order matters: the first matching row claims the label.
 *
 * These are exclusions, not skips — every one is counted and printed with its
 * reason, and a label matching none of them fails the test.
 */
const EXCLUSIONS: Array<{ reason: string; matches: (label: string) => boolean }> = [
  {
    reason: "the epub's own docTitle, repeated as a navLabel",
    matches: (l) => /^Title$/.test(l) || /^Commonwealth of Australia Constitution Act\b/.test(l),
  },
  {
    reason: "a volume boundary the register inserts between epub files",
    matches: (l) => /^Volume\s+\d+$/.test(l),
  },
  {
    reason: "endnote apparatus (legislation history, abbreviation key) — not enacted text",
    matches: (l) => /^Endnotes?\b/.test(l),
  },
  {
    reason: "an ITAA guide navPoint: it names a provision rather than being one",
    matches: (l) => /^Guide to\b/.test(l),
  },
  {
    reason: "an unnumbered Schedule: the label carries no number for a reference to hold",
    matches: (l) => STARTS_STRUCTURAL.test(l) && !WORDED_LABEL.test(l),
  },
  {
    reason: "an unnumbered heading inside a Guide or Subdivision — prose, no designation, no number",
    matches: (l) => !STARTS_STRUCTURAL.test(l) && !/^[0-9]/.test(l),
  },
  {
    reason: "a heading that opens with a figure rather than a provision number (`95% services…`)",
    matches: (l) => /^[0-9]/.test(l) && !NUMBER_LABEL.test(l),
  },
]

/**
 * Provision label shapes this grammar is known not to read.
 *
 * A row here is a documented hole, not a skip: it names the shape, says why it
 * is not read, and still counts against the pass rate printed below. Empty
 * today, and lowering the threshold without adding one is how a silent
 * regression gets in.
 */
const KNOWN_UNPARSABLE: Array<{ reason: string; matches: (label: string) => boolean }> = []

interface Entry {
  file: string
  label: string
  /** The reference text this label names, as a reader would write it. */
  cite: string
  /** `Part`/`Division`/… for a worded label, `""` for a number-led one. */
  word: string
  /** The number token exactly as the label prints it, trailing stop removed. */
  token: string
}

const entries: Entry[] = []
const excluded = new Map<string, number>()
const unclassified: string[] = []

for (const doc of DOCUMENTS) {
  for (const label of doc.labels) {
    const exclusion = EXCLUSIONS.find((row) => row.matches(label))
    const worded = exclusion ? null : WORDED_LABEL.exec(label)
    const numbered = exclusion ? null : NUMBER_LABEL.exec(label)
    if (worded) {
      const token = worded[2].replace(/\.$/, "")
      entries.push({ file: doc.file, label, cite: `${worded[1]} ${token}`, word: worded[1], token })
    } else if (numbered) {
      const token = numbered[1].replace(/\.$/, "")
      entries.push({ file: doc.file, label, cite: `s ${token}`, word: "", token })
    } else if (exclusion) {
      excluded.set(exclusion.reason, (excluded.get(exclusion.reason) ?? 0) + 1)
    } else {
      unclassified.push(`${doc.file}: ${JSON.stringify(label)}`)
    }
  }
}

/**
 * Everything a label pattern can match starts with the first character of the
 * label it was built from — `^Part…` for a worded one, `^18…` for a
 * number-led one — so property (c) only has to look inside that bucket.
 */
function bucketKey(label: string): string {
  return label.charAt(0).toLowerCase()
}

const byDocument = new Map<string, Map<string, Entry[]>>()
for (const entry of entries) {
  const buckets = byDocument.get(entry.file) ?? new Map<string, Entry[]>()
  const key = bucketKey(entry.label)
  buckets.set(key, [...(buckets.get(key) ?? []), entry])
  byDocument.set(entry.file, buckets)
}

/**
 * Two labels name the same provision when their designation word and their
 * number token agree, with the register's typographic hyphen folded.
 *
 * Real compilations repeat a number — the *Corporations Act 2001* has a
 * section 9 and a Small Business Guide paragraph 9, and 89 separate
 * `Subdivision C` labels — and one pattern matching all of those is the honest
 * answer, not a bug (`provision-slicer.ts` is what tells them apart). What
 * must never happen is a pattern matching a label that names something *else*.
 */
function provisionKey(entry: Entry): string {
  return `${entry.word}|${entry.token.replace(/[‐‑]/g, "-").toUpperCase()}`
}

/** The register's typographic hyphen, folded the way `htmlToText` folds it. */
function fold(text: string): string {
  return text.replace(/[‐‑]/g, "-")
}

function printed(ref: SectionRef): string {
  return `${ref.number}${ref.letterSuffix ?? ""}`
}

/** Field-by-field, in a fixed order: two parses may build their keys in different orders. */
function fingerprint(ref: SectionRef): string {
  return JSON.stringify([
    ref.kind,
    ref.number,
    ref.letterSuffix ?? null,
    ref.subsections,
    ref.schedule ?? null,
    ref.item ?? null,
    ref.rangeEnd ?? null,
    ref.plural,
  ])
}

/** parse → format → parse, ignoring `raw` (which records the input, by design). */
function roundTrip(ref: SectionRef): { ok: boolean; detail: string } {
  const canonical = formatRef(ref)
  const reparsed = parseSectionRef(canonical)
  if (!reparsed) {
    return { ok: false, detail: `formatRef gave ${JSON.stringify(canonical)}, which does not parse` }
  }
  return {
    ok: fingerprint(ref) === fingerprint(reparsed),
    detail: `via ${JSON.stringify(canonical)}: ${fingerprint(ref)} -> ${fingerprint(reparsed)}`,
  }
}

describe("provision-label corpus", () => {
  // Named rather than counted, so deleting one of them is a decision somebody
  // has to make on purpose. Adding a sixth needs no change here.
  it("reads five real tables of contents", () => {
    expect(DOCUMENTS.map((d) => d.file)).toEqual(
      expect.arrayContaining([
        "cca-document.ncx",
        "constitution-toc.ncx",
        "corporations-act-toc-slice.ncx",
        "crimes-act-toc.ncx",
        "itaa1997-toc-slice.ncx",
      ]),
    )
    // Thousands, not dozens: a regression that breaks 40 real labels has to
    // fail this file, and it cannot do that if the corpus is a handful.
    expect(entries.length).toBeGreaterThan(4000)
  })

  it("accounts for every label — as a provision, or as a named exclusion", () => {
    expect(unclassified.slice(0, 20), `${unclassified.length} labels matched no rule`).toEqual([])
    const total = entries.length + [...excluded.values()].reduce((a, b) => a + b, 0)
    expect(total).toBe(DOCUMENTS.reduce((sum, d) => sum + d.labels.length, 0))
    console.log(
      `corpus: ${entries.length} provision labels across ${DOCUMENTS.length} documents, ` +
        `${total - entries.length} excluded —\n` +
        [...excluded].map(([reason, count]) => `    ${String(count).padStart(5)}  ${reason}`).join("\n"),
    )
  })

  // (a) and (b). Reported together because a shape that parses but cannot be
  // re-read is the same class of bug as one that never parsed: `subsection
  // 5(2)` parsed correctly and printed as `sub-s (5)`, a different provision.
  it("parses and round-trips every provision label", () => {
    const failures: string[] = []
    const documented: string[] = []
    for (const entry of entries) {
      const known = KNOWN_UNPARSABLE.find((row) => row.matches(entry.label))
      const ref = parseSectionRef(entry.cite)
      if (!ref) {
        const line = `${entry.file} ${JSON.stringify(entry.cite)} <- ${JSON.stringify(entry.label)}`
        if (known) documented.push(`${line} — ${known.reason}`)
        else failures.push(line)
        continue
      }
      const trip = roundTrip(ref)
      if (!trip.ok) {
        failures.push(`${entry.file} ${JSON.stringify(entry.cite)} does not round-trip ${trip.detail}`)
      }
    }
    const rate = ((entries.length - failures.length - documented.length) / entries.length) * 100
    console.log(
      `corpus parse + round-trip: ${rate.toFixed(2)}% of ${entries.length} real provision labels ` +
        `(${failures.length} unexpected, ${documented.length} documented as unparsable)`,
    )
    expect(failures.slice(0, 40), `${failures.length} labels failed`).toEqual([])
    // The threshold is what the grammar actually achieves. Lower it only
    // together with a row in KNOWN_UNPARSABLE saying which shape was given up
    // on and why.
    expect(rate).toBe(100)
  })

  // (c). The bug this catches is not "no match" but "the wrong match": a
  // pattern that answers a request for one provision with another's text.
  it("addresses its own label and no other provision in the same document", () => {
    const failures: string[] = []
    for (const entry of entries) {
      const ref = parseSectionRef(entry.cite)
      if (!ref) continue
      const pattern = refToNcxLabelPattern(ref)
      if (!pattern.test(entry.label)) {
        failures.push(`${entry.file} ${formatRef(ref)} does not match its own label ${JSON.stringify(entry.label)}`)
        continue
      }
      const own = provisionKey(entry)
      for (const other of byDocument.get(entry.file)?.get(bucketKey(entry.label)) ?? []) {
        if (provisionKey(other) === own) continue
        if (pattern.test(other.label)) {
          failures.push(
            `${entry.file} ${formatRef(ref)} (from ${JSON.stringify(entry.label)}) ` +
              `also matches ${JSON.stringify(other.label)}`,
          )
          break
        }
      }
    }
    expect(failures.slice(0, 40), `${failures.length} labels resolved to the wrong provision`).toEqual([])
  })

  // (d). The scanner runs over documents, so the question is not only whether
  // it finds the reference but whether it makes one up: reading the heading
  // separator of `Schedule 1—2019 measures` as a range gave `sch 1-2019`, and
  // stopping the number early in `Part 2D.1` gave `pt 2D`. Both are provisions
  // the document never cited, reported as though it had.
  it("scans each label without inventing or truncating a reference", () => {
    const failures: string[] = []
    for (const entry of entries) {
      const ref = parseSectionRef(entry.cite)
      const scanned = extractSectionRefs(entry.label)
      const haystack = fold(entry.label)
      for (const found of scanned) {
        const number = printed(found)
        const whole = found.rangeEnd ? `${number}-${found.rangeEnd}` : number
        if (!haystack.includes(whole)) {
          failures.push(`${entry.file} scanning ${JSON.stringify(entry.label)} invented ${formatRef(found)}`)
        }
      }
      // A worded label leads with its own designation, so the scanner's first
      // hit is that provision — or the scanner read the number short.
      if (!ref || !entry.word) continue
      if (scanned.length === 0) {
        failures.push(`${entry.file} scanning ${JSON.stringify(entry.label)} found nothing (expected ${formatRef(ref)})`)
      } else if (formatRef(scanned[0]) !== formatRef(ref)) {
        failures.push(
          `${entry.file} scanning ${JSON.stringify(entry.label)} gave ${formatRef(scanned[0])}, not ${formatRef(ref)}`,
        )
      }
    }
    expect(failures.slice(0, 40), `${failures.length} labels scanned wrong`).toEqual([])
  })
})
