/**
 * Real-corpus round-trip harness for the provision-reference grammar.
 *
 * Five review rounds of regex tuning on `section-ref.ts` produced a grammar
 * regression in every round, because each change was checked against the
 * handful of examples the round happened to look at. This suite checks every
 * change against **every provision label of four real compilations** — the
 * ones whose numbering is famously hard:
 *
 *  - Corporations Act 2001 (C2004A00818): `Part 2D.1`, `Chapter 2E`,
 *    lettered `Subdivision C`/`DA`, a Small Business Guide whose paragraphs
 *    restart at 1, and an ITAA-numbered Insolvency Practice Schedule.
 *  - ITAA 1997 (C2004A05138): `Subdivision 83A-A`, `s 165-212E`, headings
 *    that cite sections whose serial exceeds their division (`165-210`).
 *  - Crimes Act 1914 (C1914A00012): `Part IAABA` (a four-letter roman tail),
 *    `s 3ZZUHA`, an unnumbered Schedule.
 *  - Constitution (C2004Q00685): covering clauses and body sections sharing
 *    numbers, 1900 typography (`51. Legislative powers…`), and the bare
 *    number-only labels `86.` / `87.`.
 *
 * The fixtures are byte-verbatim NCX captures (see __fixtures__/PROVENANCE.txt),
 * gzipped only for storage. For each label that names a provision the suite
 * asserts:
 *
 *  1. the citation a lawyer would write for it **parses**;
 *  2. parse → format → parse **round-trips** to the same reference;
 *  3. `refToNcxLabelPattern` **matches the label itself**;
 *  4. the pattern matches **no label of a different identity** in the same
 *     document (same-identity duplicates are legal — the Constitution's
 *     covering clauses, `Subdivision A` under every second Division — and are
 *     `resolveNavPoint`'s problem, not the grammar's);
 *  5. the scanner **invents nothing**: every ref `extractSectionRefs` harvests
 *     from any label is grounded in the label's text at a token boundary
 *     (no truncation like `pt 2D` out of "Part 2D.1"), and no harvested range
 *     names a start–end pair that is itself a single section of the same
 *     document (no "ss 165–210" out of a heading citing s 165-210);
 *  6. the scanner **misses nothing it should read**: a worded structural
 *     label's own reference is harvested from the label.
 *
 * Labels the grammar deliberately cannot express are enumerated in
 * `KNOWN_UNPARSABLE` with the reason, and the suite fails if an exclusion
 * goes stale. Everything else must pass — so "did that regex change break a
 * real citation form?" is a failing test, not guesswork.
 */

import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { parseNcx, ancestorsOf, type NcxEntry } from "./ncx-parser.js"
import {
  extractSectionRefs,
  formatRef,
  parseSectionRef,
  refToNcxLabelPattern,
  type SectionRef,
} from "./section-ref.js"

interface CorpusDoc {
  name: string
  registerId: string
  file: string
  /** Capture date + URL: PROVENANCE.txt is the authority; this pins the test's claim. */
  captured: string
  /** Lower bounds on classified labels — fails if the classifier silently lapses. */
  atLeast: { worded: number; numberLed: number }
}

const CORPUS: readonly CorpusDoc[] = [
  {
    name: "Corporations Act 2001",
    registerId: "C2004A00818",
    file: "corporations-document.ncx.gz",
    captured: "2026-09-05",
    atLeast: { worded: 1150, numberLed: 4100 },
  },
  {
    name: "Income Tax Assessment Act 1997",
    registerId: "C2004A05138",
    file: "itaa97-document.ncx.gz",
    captured: "2026-09-05",
    atLeast: { worded: 900, numberLed: 3000 },
  },
  {
    name: "Crimes Act 1914",
    registerId: "C1914A00012",
    file: "crimes1914-document.ncx.gz",
    captured: "2026-09-05",
    atLeast: { worded: 190, numberLed: 750 },
  },
  {
    name: "Commonwealth of Australia Constitution Act",
    registerId: "C2004Q00685",
    file: "constitution-document.ncx.gz",
    captured: "2026-09-05",
    atLeast: { worded: 13, numberLed: 130 },
  },
]

/**
 * Labels the grammar deliberately does not express, by document. Each entry
 * must still match at least one label (a stale exclusion is a failure), and
 * carries the reason it is out of scope rather than a bug.
 */
const KNOWN_UNPARSABLE: Record<string, Array<{ pattern: RegExp; reason: string }>> = {
  C1914A00012: [
    {
      pattern: /^Schedule—Form of explanation/,
      reason:
        "an unnumbered sole Schedule; the citation is 'the Schedule', which is an " +
        "Act-relative phrase, not a reference the number grammar can carry",
    },
  ],
  C2004Q00685: [
    {
      pattern: /^SCHEDULE\.$/,
      reason: "the Constitution's unnumbered Schedule (the oath) — same as above",
    },
  ],
}

// ── classification ─────────────────────────────────────────────────────────

/** Word-led structural label: designation word, then its number token. */
const WORDED_LABEL =
  /^(subdivisions?|divisions?|chapters?|parts?|schedules?|appendix|appendices|orders?)[\s]+(\S.*)$/i

/** A schedule label with no number at all: `Schedule—Form…`, `SCHEDULE.`. */
const UNNUMBERED_SCHEDULE = /^schedules?\s*(?:$|\.$|[—―])/i

/** Leading number of a number-led label: `"105A. Agreements…"` → `105A`. */
const NUMBER_LED = /^(\d[0-9A-Za-z.‐‑-]*?)\.?(?=[\s]|$)/

/** What a worded label's number token may look like once dashes are folded. */
const TOKEN_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/

const foldHyphens = (value: string) => value.replace(/[‐‑]/g, "-")

interface Classified {
  entry: NcxEntry
  /** `part|2D.1` for worded labels, `#|165-212E` for number-led ones. */
  identity: string
  /** The citation a lawyer would write: `Part 2D.1`, `s 165-212E`. */
  citation: string
  /** The number token as it must appear (dash-folded): `2D.1`, `165-212E`. */
  token: string
  word?: string
}

interface Classification {
  provisions: Classified[]
  headings: NcxEntry[]
  excluded: Array<{ entry: NcxEntry; reason: string }>
}

function isUnderEndnotes(entry: NcxEntry): boolean {
  return ancestorsOf(entry).some((a) => /^endnotes?\b/i.test(a.label))
}

function classify(entries: readonly NcxEntry[], registerId: string): Classification {
  const provisions: Classified[] = []
  const headings: NcxEntry[] = []
  const excluded: Classification["excluded"] = []
  const exclusions = KNOWN_UNPARSABLE[registerId] ?? []

  for (const entry of entries) {
    const label = entry.label
    if (!label) continue
    if (/^volume\s+\d/i.test(label) || /^endnotes?\b/i.test(label) || isUnderEndnotes(entry)) continue

    const known = exclusions.find((x) => x.pattern.test(label))
    if (known) {
      excluded.push({ entry, reason: known.reason })
      continue
    }

    const worded = WORDED_LABEL.exec(label)
    if (worded) {
      const rawToken = /^([^\s—―]+)/.exec(worded[2])?.[1] ?? ""
      const token = foldHyphens(rawToken.replace(/\.$/, ""))
      if (TOKEN_SHAPE.test(token)) {
        const word = worded[1].toLowerCase().replace(/s$/, "").replace(/appendice$/, "appendix")
        provisions.push({
          entry,
          identity: `${word}|${token}`,
          citation: `${worded[1]} ${token}`,
          token,
          word,
        })
        continue
      }
    }
    if (UNNUMBERED_SCHEDULE.test(label)) {
      // Reaching here means the label is NOT in KNOWN_UNPARSABLE — flag it by
      // classifying as a provision with an unparsable citation.
      provisions.push({ entry, identity: `schedule|?`, citation: label, token: "?" })
      continue
    }

    const numberLed = NUMBER_LED.exec(label)
    if (numberLed) {
      const token = foldHyphens(numberLed[1])
      provisions.push({ entry, identity: `#|${token}`, citation: `s ${token}`, token })
      continue
    }

    headings.push(entry)
  }

  return { provisions, headings, excluded }
}

// ── scanner grounding ───────────────────────────────────────────────────────

const ALNUM = /[0-9A-Za-z]/
const NUMBER_CONTINUER = /[.\-‐‑]/

/**
 * True when `raw` (a scanner match, dash-folded by `parseSectionRef`) sits in
 * `label` at a real token boundary — i.e. the scanner consumed a whole
 * reference, not the front half of a longer number.
 */
function groundedIn(label: string, raw: string): boolean {
  const folded = label.replace(/[‐‑‒–—―−]/g, "-")
  for (let at = folded.indexOf(raw); at !== -1; at = folded.indexOf(raw, at + 1)) {
    const before = at === 0 ? "" : label[at - 1]
    const after = label.slice(at + raw.length, at + raw.length + 2)
    const beforeOk = before === "" || !ALNUM.test(before)
    const afterOk =
      after === "" ||
      (!ALNUM.test(after[0]) && !(NUMBER_CONTINUER.test(after[0]) && after[1] !== undefined && ALNUM.test(after[1])))
    if (beforeOk && afterOk) return true
  }
  return false
}

/** Cap a failure list for readable output without hiding the count. */
function report(failures: string[]): string[] {
  if (failures.length <= 50) return failures
  return [...failures.slice(0, 50), `…and ${failures.length - 50} more`]
}

// ── the suite ───────────────────────────────────────────────────────────────

for (const doc of CORPUS) {
  describe(`${doc.name} [${doc.registerId}] (captured ${doc.captured})`, () => {
    const xml = gunzipSync(
      readFileSync(new URL(`./__fixtures__/${doc.file}`, import.meta.url)),
    ).toString("utf-8")
    const entries = parseNcx(xml)
    const { provisions, headings, excluded } = classify(entries, doc.registerId)

    // Identity → parsed refs, computed once and shared across the checks.
    const parsed = new Map<string, { ref: SectionRef | null; sample: Classified }>()
    for (const p of provisions) {
      if (!parsed.has(p.identity)) parsed.set(p.identity, { ref: parseSectionRef(p.citation), sample: p })
    }

    it("classifies the corpus (coverage guard)", () => {
      // The floors are the whole guard: if a classifier edit ever lapses into
      // filing provisions under "headings", these counts collapse and fail.
      // (There is no complementary shape check on `headings` — it would just
      // re-run the classifier's own regexes, and real headings can start with
      // a digit: the ITAA's "95% services indirect value shifts…".)
      const worded = provisions.filter((p) => p.word).length
      const numberLed = provisions.length - worded
      expect(worded).toBeGreaterThanOrEqual(doc.atLeast.worded)
      expect(numberLed).toBeGreaterThanOrEqual(doc.atLeast.numberLed)
      // `headings` is intentionally unasserted: the Crimes Act and the
      // Corporations Act legitimately have none outside their endnotes.
      void headings
    })

    it("known exclusions are still present in the corpus", () => {
      for (const exclusion of KNOWN_UNPARSABLE[doc.registerId] ?? []) {
        expect(
          excluded.some((x) => exclusion.pattern.test(x.entry.label)),
          `stale exclusion: ${exclusion.pattern}`,
        ).toBe(true)
      }
    })

    it("every provision label parses and round-trips", () => {
      const failures: string[] = []
      for (const [identity, { ref, sample }] of parsed) {
        if (!ref) {
          failures.push(`${identity} :: parseSectionRef(${JSON.stringify(sample.citation)}) = null (label: ${sample.entry.label})`)
          continue
        }
        const formatted = formatRef(ref)
        const reparsed = parseSectionRef(formatted)
        if (!reparsed) {
          failures.push(`${identity} :: formatRef → ${JSON.stringify(formatted)} does not re-parse`)
          continue
        }
        for (const field of ["kind", "number", "letterSuffix", "schedule", "item", "rangeEnd"] as const) {
          if (reparsed[field] !== ref[field]) {
            failures.push(
              `${identity} :: round-trip drifted on ${field}: ${JSON.stringify(ref[field])} → ${JSON.stringify(reparsed[field])} (via ${JSON.stringify(formatted)})`,
            )
          }
        }
        if (formatRef(reparsed) !== formatted) {
          failures.push(`${identity} :: formatRef is not stable: ${JSON.stringify(formatted)} → ${JSON.stringify(formatRef(reparsed))}`)
        }
      }
      expect(report(failures)).toEqual([])
    })

    it("every provision label's NCX pattern matches its own label and no other identity", () => {
      const failures: string[] = []

      // Bleeding can only happen into a label whose token starts with the
      // ref's number text, so bucket tokens by identity class for candidates.
      const byClass = new Map<string, Classified[]>()
      for (const p of provisions) {
        const key = p.word ?? "#"
        const list = byClass.get(key)
        if (list) list.push(p)
        else byClass.set(key, [p])
      }

      for (const [identity, { ref, sample }] of parsed) {
        if (!ref) continue // reported by the parse check
        const pattern = refToNcxLabelPattern(ref)
        if (!pattern.test(sample.entry.label)) {
          failures.push(`${identity} :: ${pattern} does not match own label ${JSON.stringify(sample.entry.label)}`)
        }
        const candidates = byClass.get(sample.word ?? "#") ?? []
        for (const other of candidates) {
          if (other.identity === identity || !other.token.startsWith(sample.token)) continue
          if (pattern.test(other.entry.label)) {
            failures.push(
              `${identity} :: pattern for ${JSON.stringify(sample.citation)} also matches ${JSON.stringify(other.entry.label)}`,
            )
          }
        }
      }
      expect(report(failures)).toEqual([])
    })

    it("the scanner invents nothing, and reads worded labels whole", () => {
      // One list so a failure reports every class at once, not just the first.
      const failures: string[] = []

      // Single sections whose name a range misreading would fabricate.
      const sectionTokens = new Set(provisions.filter((p) => !p.word).map((p) => p.token))

      for (const entry of entries) {
        if (!entry.label || isUnderEndnotes(entry)) continue
        const refs = extractSectionRefs(entry.label)

        for (const ref of refs) {
          if (!groundedIn(entry.label, ref.raw)) {
            failures.push(`${JSON.stringify(entry.label)} :: harvested ${JSON.stringify(ref.raw)} at no token boundary`)
          }
          if (ref.rangeEnd) {
            // "…for the purposes of sections 165-210 and 165-211" names two
            // real ITAA sections, and nothing in the scanned bytes
            // distinguishes that from a range. The invariant is the outcome:
            // when the joined pair IS a section of this Act, the harvested
            // ref's label pattern must land on it — never on nothing.
            const joined = `${ref.number}${ref.letterSuffix ?? ""}-${ref.rangeEnd}`
            if (sectionTokens.has(joined)) {
              const pattern = refToNcxLabelPattern(ref)
              const landsRight = provisions.some(
                (p) => !p.word && p.token === joined && pattern.test(p.entry.label),
              )
              if (!landsRight) {
                failures.push(
                  `${JSON.stringify(entry.label)} :: read s ${joined} (a real section of this Act) as ${formatRef(ref)}, and ${pattern} cannot find the section it names`,
                )
              }
            }
          }
        }
      }

      for (const p of provisions) {
        if (!p.word) continue
        const want = parsed.get(p.identity)?.ref
        if (!want) continue // reported by the parse check
        const wanted = formatRef(want)
        const got = extractSectionRefs(p.entry.label).map((r) => formatRef(r))
        if (!got.includes(wanted)) {
          failures.push(`${JSON.stringify(p.entry.label)} :: scanner returned [${got.join(", ")}], not ${wanted}`)
        }
      }

      expect(report(failures)).toEqual([])
    })
  })
}
