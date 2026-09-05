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

/**
 * ## The other half of the grammar: more than one provision at a time
 *
 * Every cite built above uses a **singular** designation and no range dash.
 * Measured over the corpus that is 4,562 cites of which 0 carry a plural
 * spelling and 0 carry a range dash — so `plural || hadRangeDash` inside
 * `parseSectionRef` was false for every single one of them, and the branch
 * behind it never executed: `RANGE_SPLIT`, `runsBackwards`,
 * `spansTooFarForAHyphen` and the `subsections.length > 0` clause were all
 * unreachable from this file. Review demonstrated the hole by reverting two of
 * the round-5 grammar fixes those rules *are* — the `ss 165-210` ceiling and
 * the "a range end never carries a subsection" clause — with all four
 * properties above still green. A corpus that cannot see a branch cannot
 * defend it.
 *
 * So the same real numbers are cited again below in the forms a writer uses
 * when there is more than one provision — `ss X and Y`, `ss X to Y`, `ss X-Y`,
 * `ss X–Y`, and the plural of every label on its own — and the question each
 * one asks is the real one: **does the grammar read what the writer meant?** A
 * range of two provisions that are both in the document has to come back as a
 * range; a dashed number that is one provision of the document has to come
 * back as one number.
 *
 * Nothing here is invented. Both ends of every pair are numbers the same table
 * of contents really prints, so a form this file builds is a form a reader of
 * that Act really writes. The shapes that cannot be decided from the text at
 * all are listed in `PLURAL_UNDECIDABLE`, counted, and printed with their
 * reason rather than dropped.
 */

/** The English plural a writer types for each designation the register prints. */
const PLURAL_WORD: Record<string, string> = {
  "": "sections",
  Chapter: "Chapters",
  Part: "Parts",
  Division: "Divisions",
  Subdivision: "Subdivisions",
  Schedule: "Schedules",
  Appendix: "Appendices",
  Order: "Orders",
}

function pluralCite(word: string, token: string): string {
  return `${PLURAL_WORD[word]} ${token}`
}

/**
 * A bare lettered unit — `Subdivision C`, `Part IVA` — has no plural form in
 * this grammar: `LETTERED_STRUCTURAL` answers before the numbered branch and
 * reports `plural: false`. That costs nothing, because a letter carries no
 * dash for the range branch to decide about; the plural forms below are built
 * from the number-carrying labels, and this is what names the rest.
 */
const BARE_LETTERED = /^[A-Za-z]{1,3}$/

/**
 * The two halves of a dashed number, read the way `RANGE_SPLIT` reads them —
 * `165-210`, `20-20`, `104-107A`. `152-A` is not one of these: its right half
 * does not start with a digit, so it can never be mistaken for a range.
 */
const CORPUS_DASHED = /^(\d{1,4}[A-Za-z]{0,6})-(\d{1,4}[A-Za-z]{0,6})$/
interface DashedPair { left: string; right: string; from: number; to: number }
function dashedPair(token: string): DashedPair | null {
  const match = CORPUS_DASHED.exec(fold(token))
  if (!match) return null
  return {
    left: match[1],
    right: match[2],
    from: Number.parseInt(match[1], 10),
    to: Number.parseInt(match[2], 10),
  }
}

/**
 * Designations this corpus has actually seen the register print with a hyphen
 * *inside* the number — `Part 2-1`, `Subdivision 152-A`, `s 165-210`. It is
 * measured rather than listed, and it is what decides which reading of a wide
 * plain-hyphen pair this file demands: under a designation whose numbering can
 * carry a dash, `ss 165-210` is one section and the hyphen ceiling has to keep
 * it whole; under one whose numbering never does — `Chapters 1-30`,
 * `Divisions 100-200` — there is nothing for the hyphen to be part of, and the
 * pair is the range the writer wrote.
 */
const HYPHENATED_WORDS = new Set(
  entries.filter((entry) => fold(entry.token).includes("-")).map((entry) => entry.word),
)

/**
 * Shapes no grammar can read off the text, each with the reason. A row here is
 * a documented hole, not a skip: it is counted and printed, and it names the
 * form a writer can use instead to say what they mean.
 */
const PLURAL_UNDECIDABLE: Array<{ reason: string; matches: (token: string) => boolean }> = [
  {
    reason:
      "a dashed number that is also a forward range no wider than the hyphen ceiling — the " +
      "Australian Consumer Law's `Part 3-4` and the ITAA 1997's `s 4-15` are spelled exactly the " +
      "way a writer spells 'Parts 3 to 4' and 'sections 4 to 15'. `runsBackwards` rescues the " +
      "descending pairs (`ss 355-25`), the equal-halves rule the degenerate ones (`ss 20-20`) " +
      "and HYPHEN_RANGE_SPAN_MAX the wide ones (`ss 165-210`); this is the residue that is left. " +
      "An en dash says 'to' unambiguously (AGLC r 1.9) and is read as a range whatever its width",
    matches: (token) => {
      const pair = dashedPair(token)
      return pair !== null && pair.to > pair.from && pair.to - pair.from <= 20
    },
  },
]

/**
 * Two consecutive provisions of the same designation in the same document —
 * `s 5` and `s 6` of the *Crimes Act 1914*, `Division 3` and `Division 4`.
 * Both ends are real, so `ss 5-6` is a range a reader of that Act writes.
 *
 * The widest pair of each group is kept as well as the adjacent ones: a range
 * only reaches the hyphen ceiling when it is wide, and adjacent numbers never
 * are.
 */
interface RealPair { file: string; word: string; low: number; high: number }
const realPairs: RealPair[] = []
{
  const groups = new Map<string, number[]>()
  for (const entry of entries) {
    if (!/^\d{1,4}$/.test(entry.token)) continue
    const key = `${entry.file} ${entry.word}`
    groups.set(key, [...(groups.get(key) ?? []), Number.parseInt(entry.token, 10)])
  }
  for (const [key, numbers] of groups) {
    const [file, word] = key.split(" ")
    const sorted = [...new Set(numbers)].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      realPairs.push({ file, word: word ?? "", low: sorted[i - 1], high: sorted[i] })
    }
    const widest = { file, word: word ?? "", low: sorted[0], high: sorted[sorted.length - 1] }
    if (sorted.length > 2 && widest.high - widest.low > 20) realPairs.push(widest)
  }
}

/** What a parse says about the shape of a number, for a message a reader can act on. */
function shapeOf(ref: SectionRef | null): string {
  if (!ref) return "null"
  return ref.rangeEnd ? `range ${printed(ref)}–${ref.rangeEnd}` : `one number ${printed(ref)}`
}

describe("provision-label corpus — the plural and range forms of the same labels", () => {
  // Guards the generator itself. If a table of contents recorded tomorrow used
  // a designation with no plural here, every form below would be built as
  // "undefined 5" and the whole block would pass while testing nothing.
  it("knows the plural of every designation the corpus prints", () => {
    const words = [...new Set(entries.map((entry) => entry.word))].sort()
    expect(words.filter((word) => !(word in PLURAL_WORD))).toEqual([])
    const numbered = entries.filter((entry) => !BARE_LETTERED.test(entry.token)).length
    console.log(
      `corpus plural forms: ${numbered} of ${entries.length} labels carry a number a plural can be ` +
        `built on (${entries.length - numbered} are bare lettered units) — ` +
        words.map((word) => `${word || "(number-led)"}→${PLURAL_WORD[word]}`).join(", "),
    )
    expect(numbered).toBeGreaterThan(3000)
  })

  // The plural is the signal that makes a hyphen mean "to". Every one of these
  // labels is a *single* provision, so the plural must not move it: this is
  // where `ss 165-210` and `ss 355-25` — real ITAA section numbers, cited with
  // the plural a list of them gets — have to survive as themselves.
  it("reads a plural designation over one real label as that same provision", () => {
    const failures: string[] = []
    const documented = new Map<string, number>()
    let checked = 0
    for (const entry of entries) {
      if (BARE_LETTERED.test(entry.token)) continue
      const singular = parseSectionRef(entry.cite)
      if (!singular) continue
      const row = PLURAL_UNDECIDABLE.find((candidate) => candidate.matches(entry.token))
      if (row) {
        documented.set(row.reason, (documented.get(row.reason) ?? 0) + 1)
        continue
      }
      checked++
      const cite = pluralCite(entry.word, entry.token)
      const ref = parseSectionRef(cite)
      if (!ref) {
        failures.push(`${entry.file} ${JSON.stringify(cite)} does not parse`)
        continue
      }
      if (!ref.plural) failures.push(`${entry.file} ${JSON.stringify(cite)} did not read as plural`)
      if (fingerprint({ ...ref, plural: false }) !== fingerprint(singular)) {
        failures.push(
          `${entry.file} ${JSON.stringify(cite)} <- ${JSON.stringify(entry.label)} moved the ` +
            `reference: ${shapeOf(singular)} -> ${shapeOf(ref)}`,
        )
      }
    }
    const dashed = entries.filter((entry) => dashedPair(entry.token) !== null).length
    console.log(
      `corpus plural designations: ${checked} labels re-cited in the plural; ${dashed} of the ` +
        `corpus carry a dashed number, the shape a plural turns into a range —\n` +
        [...documented].map(([reason, count]) => `    ${String(count).padStart(5)}  ${reason}`).join("\n"),
    )
    expect(failures.slice(0, 40), `${failures.length} plural cites moved the reference`).toEqual([])
    expect(checked).toBeGreaterThan(3000)
  })

  // The other direction, and the one the plural exists for: two provisions the
  // document really has, joined by a dash, must come back as the range between
  // them — with the en dash always, and with the plain hyphen up to the width
  // an ITAA-style section number could plausibly be.
  it("reads a dash between two real provisions of the same document as a range", () => {
    const failures: string[] = []
    const documented = new Map<string, number>()
    let checked = 0
    for (const pair of realPairs) {
      const wide = pair.high - pair.low > 20
      for (const dash of ["-", "–"]) {
        // A wide plain-hyphen pair under a designation whose numbering carries
        // dashes is the one case the ceiling deliberately reads the other way.
        if (dash === "-" && wide && HYPHENATED_WORDS.has(pair.word)) {
          const reason =
            "a plain-hyphen pair wider than the ceiling, under a designation the register really " +
            "does print dashed numbers for (`s 165-210`, `Part 2-1`): read as one number on " +
            "purpose. The en dash form of the same pair is asserted as a range"
          documented.set(reason, (documented.get(reason) ?? 0) + 1)
          continue
        }
        const cite = `${pluralCite(pair.word, String(pair.low))}${dash}${pair.high}`
        const ref = parseSectionRef(cite)
        checked++
        if (!ref || ref.number !== String(pair.low) || ref.rangeEnd !== String(pair.high)) {
          failures.push(
            `${pair.file} ${JSON.stringify(cite)} (both ends are real labels) read as ${shapeOf(ref)}`,
          )
          continue
        }
        const trip = roundTrip(ref)
        if (!trip.ok) failures.push(`${pair.file} ${JSON.stringify(cite)} does not round-trip ${trip.detail}`)
      }
    }
    console.log(
      `corpus ranges: ${checked} dashed pairs asserted as ranges, built from ${realPairs.length} ` +
        `pairs of real labels —\n` +
        [...documented].map(([reason, count]) => `    ${String(count).padStart(5)}  ${reason}`).join("\n"),
    )
    expect(failures.slice(0, 40), `${failures.length} real ranges were not read as ranges`).toEqual([])
    expect(checked).toBeGreaterThan(500)
  })

  // A pair that does not ascend is never a range, whichever dash joins it:
  // "sections 355 to 25" is a lookup that cannot succeed, and the caller
  // reports that failure as the provision not existing.
  it("never reads a pair that does not ascend as a range", () => {
    const failures: string[] = []
    let checked = 0
    for (const pair of realPairs) {
      for (const dash of ["-", "–"]) {
        const cases: Array<[string, string]> = [
          [`${pluralCite(pair.word, String(pair.high))}${dash}${pair.low}`, `${pair.high}-${pair.low}`],
          [`${pluralCite(pair.word, String(pair.low))}${dash}${pair.low}`, `${pair.low}-${pair.low}`],
        ]
        for (const [cite, expected] of cases) {
          checked++
          const ref = parseSectionRef(cite)
          if (!ref || ref.rangeEnd !== undefined || printed(ref) !== expected) {
            failures.push(`${pair.file} ${JSON.stringify(cite)} read as ${shapeOf(ref)}, not one number ${expected}`)
          }
        }
      }
    }
    console.log(`corpus non-ranges: ${checked} descending and degenerate pairs built from real labels`)
    expect(failures.slice(0, 40), `${failures.length} impossible ranges were read as ranges`).toEqual([])
  })

  // `paragraphs 230-395(2)(c)` is paragraph (c) of subsection (2) of one ITAA
  // section, not "paragraphs 230 to 395" with a stray (2)(c) hanging off the
  // end. A range end never carries a bracketed subdivision, so a subsection
  // settles even the pairs `PLURAL_UNDECIDABLE` gives up on.
  it("never reads a dashed number that carries a subsection as a range", () => {
    const failures: string[] = []
    let checked = 0
    for (const entry of entries) {
      const pair = dashedPair(entry.token)
      if (!pair) continue
      checked++
      const number = `${pair.left}-${pair.right}`
      const cite = `paragraphs ${number}(2)(c)`
      const ref = parseSectionRef(cite)
      if (!ref || ref.rangeEnd !== undefined || printed(ref) !== number) {
        failures.push(`${entry.file} ${JSON.stringify(cite)} <- ${JSON.stringify(entry.label)} read as ${shapeOf(ref)}`)
        continue
      }
      if (ref.subsections.join(",") !== "2,c") {
        failures.push(`${entry.file} ${JSON.stringify(cite)} lost its subsections: ${JSON.stringify(ref.subsections)}`)
      }
    }
    console.log(`corpus subsection guard: ${checked} real dashed numbers cited with a subsection`)
    expect(failures.slice(0, 40), `${failures.length} dashed numbers broke apart`).toEqual([])
    expect(checked).toBeGreaterThan(400)
  })

  // The worded joins. This module's scanner is anchored on a designation, so
  // the bare number after "and"/"to" is not its business — `statute-citations.ts`
  // owns the list merge ("ss 45 and 46", "ss 45 to 47 and 50"). What must never
  // happen here is the *head* being read as something else: a list is not a
  // range, and "ss 355-25, 355-30" is the form that taught us so.
  it("reads a worded list join as its head, and never as a range", () => {
    const failures: string[] = []
    let checked = 0
    for (const pair of realPairs) {
      for (const join of [" and ", " to ", ", "]) {
        const cite = `${pluralCite(pair.word, String(pair.low))}${join}${pair.high}`
        const found = extractSectionRefs(cite)
        checked++
        if (found.length === 0) {
          failures.push(`${pair.file} scanning ${JSON.stringify(cite)} found nothing`)
          continue
        }
        if (found[0].rangeEnd !== undefined || printed(found[0]) !== String(pair.low)) {
          failures.push(`${pair.file} scanning ${JSON.stringify(cite)} read the head as ${shapeOf(found[0])}`)
        }
        for (const ref of found) {
          if (!cite.includes(printed(ref))) {
            failures.push(`${pair.file} scanning ${JSON.stringify(cite)} invented ${formatRef(ref)}`)
          }
        }
      }
    }
    console.log(
      `corpus list joins: ${checked} "and"/"to"/comma joins of two real labels — the head is this ` +
        `module's, the tail is statute-citations.ts's list merge`,
    )
    expect(failures.slice(0, 40), `${failures.length} list joins were misread`).toEqual([])
  })
})
