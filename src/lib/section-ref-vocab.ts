/**
 * AGLC4 pinpoint vocabulary (r 3.1.4) — the data half of `section-ref.ts`.
 *
 * The table is the only place that knows how a designation is spelled, so
 * teaching the parser a new one (say `sub-div`) never means editing a regex
 * by hand in two files. Order inside `spellings` matters: the matcher tries
 * longer spellings first, otherwise `s` swallows the `s` of `sch` and
 * `Schedule 2` parses as section "chedule".
 */

export type RefKind =
  | "section"
  | "subsection"
  | "paragraph"
  | "subparagraph"
  | "part"
  | "division"
  | "subdivision"
  | "chapter"
  | "schedule"
  | "clause"
  | "subclause"
  | "regulation"
  | "subregulation"
  | "rule"
  | "subrule"
  | "article"
  | "item"
  | "appendix"
  | "order"

export interface KindVocab {
  kind: RefKind
  /** Every accepted spelling, longest-first. Matched case-insensitively. */
  spellings: string[]
  /** AGLC singular abbreviation used when formatting. */
  singular: string
  /** AGLC plural abbreviation (r 3.1.4: pluralise the highest level only). */
  plural: string
  /**
   * How this designation appears in an FRL epub NCX navLabel.
   *
   *  - `number`  → "18  Meetings of Commission" (bare number, then the heading)
   *  - `worded`  → "Part IVA—News media…" (English word, then the number)
   *  - `none`    → never a navPoint of its own (subsections, paragraphs)
   */
  ncxLabel: "number" | "worded" | "none"
  /** The English word used in a `worded` navLabel. */
  ncxWord?: string
}

/**
 * Longest spellings first *within* each entry, and the whole table is sorted
 * longest-first at match time — see `SPELLING_ALTERNATION`.
 */
export const KIND_VOCAB: readonly KindVocab[] = [
  // Sub-designations come before their parents so "sub-s" is not read as "s".
  { kind: "subsection", spellings: ["subsections", "subsection", "sub-ss", "sub-s"], singular: "sub-s", plural: "sub-ss", ncxLabel: "none" },
  { kind: "subparagraph", spellings: ["sub-paragraphs", "sub-paragraph", "subparagraph", "sub-paras", "sub-para"], singular: "sub-para", plural: "sub-paras", ncxLabel: "none" },
  { kind: "paragraph", spellings: ["paragraphs", "paragraph", "paras", "para"], singular: "para", plural: "paras", ncxLabel: "none" },
  { kind: "subdivision", spellings: ["subdivisions", "subdivision", "sub-divs", "sub-div", "subdivs", "subdiv"], singular: "sub-div", plural: "sub-divs", ncxLabel: "worded", ncxWord: "Subdivision" },
  { kind: "division", spellings: ["divisions", "division", "divs", "div"], singular: "div", plural: "divs", ncxLabel: "worded", ncxWord: "Division" },
  { kind: "subclause", spellings: ["sub-clauses", "sub-clause", "sub-cls", "sub-cl"], singular: "sub-cl", plural: "sub-cls", ncxLabel: "none" },
  { kind: "clause", spellings: ["clauses", "clause", "cls", "cl"], singular: "cl", plural: "cls", ncxLabel: "number" },
  { kind: "subregulation", spellings: ["sub-regulations", "sub-regulation", "sub-regs", "sub-reg"], singular: "sub-reg", plural: "sub-regs", ncxLabel: "none" },
  { kind: "regulation", spellings: ["regulations", "regulation", "regs", "reg"], singular: "reg", plural: "regs", ncxLabel: "number" },
  { kind: "subrule", spellings: ["sub-rules", "sub-rule", "sub-rr", "sub-r"], singular: "sub-r", plural: "sub-rr", ncxLabel: "none" },
  { kind: "schedule", spellings: ["schedules", "schedule", "schs", "sch"], singular: "sch", plural: "schs", ncxLabel: "worded", ncxWord: "Schedule" },
  { kind: "chapter", spellings: ["chapters", "chapter", "chs", "ch"], singular: "ch", plural: "chs", ncxLabel: "worded", ncxWord: "Chapter" },
  { kind: "part", spellings: ["parts", "part", "pts", "pt"], singular: "pt", plural: "pts", ncxLabel: "worded", ncxWord: "Part" },
  { kind: "article", spellings: ["articles", "article", "arts", "art"], singular: "art", plural: "arts", ncxLabel: "number" },
  { kind: "appendix", spellings: ["appendices", "appendix", "apps", "app"], singular: "app", plural: "apps", ncxLabel: "worded", ncxWord: "Appendix" },
  { kind: "item", spellings: ["items", "item"], singular: "item", plural: "items", ncxLabel: "number" },
  { kind: "order", spellings: ["orders", "order", "ords", "ord"], singular: "ord", plural: "ords", ncxLabel: "worded", ncxWord: "Order" },
  { kind: "rule", spellings: ["rules", "rule", "rr", "r"], singular: "r", plural: "rr", ncxLabel: "number" },
  { kind: "section", spellings: ["sections", "section", "ss", "s"], singular: "s", plural: "ss", ncxLabel: "number" },
]

/** Spellings that mean "more than one" — the only signal that a dash is a range. */
export const PLURAL_SPELLINGS: ReadonlySet<string> = new Set([
  "ss", "sections", "sub-ss", "subsections", "paras", "paragraphs", "sub-paras",
  "sub-paragraphs", "subparagraphs", "pts", "parts", "divs", "divisions",
  "sub-divs", "subdivs", "subdivisions", "chs", "chapters", "schs", "schedules",
  "cls", "clauses", "sub-cls", "sub-clauses", "regs", "regulations", "sub-regs",
  "sub-regulations", "rr", "rules", "sub-rr", "sub-rules", "arts", "articles",
  "items", "apps", "appendices", "ords", "orders",
])

const byKind = new Map<RefKind, KindVocab>(KIND_VOCAB.map((entry) => [entry.kind, entry]))
export function vocabFor(kind: RefKind): KindVocab {
  const entry = byKind.get(kind)
  if (!entry) throw new Error(`Unknown provision kind: ${String(kind)}`)
  return entry
}

const spellingToKind = new Map<string, KindVocab>()
for (const entry of KIND_VOCAB) {
  for (const spelling of entry.spellings) {
    // First writer wins: the table is ordered so sub-designations register
    // their spellings before the parent kind can claim a prefix of them.
    if (!spellingToKind.has(spelling)) spellingToKind.set(spelling, entry)
  }
}

export function kindForSpelling(spelling: string): KindVocab | undefined {
  return spellingToKind.get(spelling.toLowerCase())
}

/**
 * Alternation of every spelling, longest first.
 *
 * JavaScript alternation is leftmost-first rather than longest-match, so
 * without the length sort `s` matches the start of `sch` and every schedule
 * reference silently becomes a section reference — the one confusion this
 * whole module exists to prevent.
 */
export const SPELLING_ALTERNATION = [...spellingToKind.keys()]
  .sort((a, b) => b.length - a.length)
  .map((spelling) => spelling.replace(/-/g, "\\-"))
  .join("|")

/**
 * A roman structural number: the numeral, then up to four letters of tail —
 * `IV`, `IVA`, `XI`, `IIIAA`, `IVBA`, `XICA`, `IABA`, `IAABA`.
 *
 * Both bounds are load-bearing.
 *
 * **The tail runs to four letters, not one.** The Commonwealth really does go
 * that far: the *Competition and Consumer Act 2010* has Parts IIIAA, IVBA,
 * IVBB, XIAA, XICA and XICB (they are navLabels in this repo's own
 * `__fixtures__/cca-document.ncx`), and the *Crimes Act 1914* has Parts IABA
 * and IAABA — the four-letter one is a navLabel in
 * `__fixtures__/crimes1914-document.ncx.gz`, and a three-letter cap rejected
 * it outright. A one-letter tail did not merely reject `pt IVBA` —
 * `section-ref.ts`'s right-edge guard then dropped it out of a scanned
 * document *silently*, so a citation checker reported on the rest of the
 * document as though that citation had been checked.
 *
 * **The numeral is a real numeral (I–XXXIX), not "letters drawn from
 * IVXLCDM".** The loose spelling is what made the tail dangerous to widen:
 * `section-ref.ts` scans documents case-insensitively, so `[IVXLCDM]+[A-Z]{0,3}`
 * reads `can`, `did`, `made`, `civil` and `dill` as roman numbers, and "the
 * rules can be amended" yields a pinpoint `rr CAN` that the caller then
 * reports as a provision the Act does not contain. No Part, Division or
 * Chapter is numbered L, C, D or M (they would be 50, 100, 500 and 1000), so
 * dropping those letters costs nothing real and removes every one of those
 * readings: measured against `/usr/share/dict/words`, `[IVXLCDM]+[A-Z]{0,3}`
 * matches 2,005 ordinary English words where the three-letter-tail form of
 * this pattern matched 237. The tail's growth to four letters widens the raw
 * word count again (`vista`, `ideas`), which is why the *case gate*
 * (`romanNumbersAreCapitalised` in `section-ref.ts`) is the load-bearing
 * defence: prose is lowercase, numerals are not, and every reading this
 * pattern admits still dies there unless the writer capitalised it.
 *
 * A bare lettered unit (`pt C`, `sub-div B`) is not this pattern's business:
 * `LETTERED_STRUCTURAL` in `section-ref.ts` reads those — and the document
 * scanner runs its own lettered pass for them, because this pattern
 * deliberately cannot say `C` or `D`.
 *
 * Wrapped in its own group and free of capturing groups: callers interpolate
 * it into alternations and read their own match indices.
 */
export const ROMAN_NUMBER = "(?:(?:X{1,3}(?:IX|IV|V?I{0,3})|IX|IV|V?I{1,3}|V)[A-Z]{0,4})"

/**
 * One bracketed subdivision token: `(2)`, `(a)`, `(ii)` — or a longer roman
 * numeral.
 *
 * Four characters used to be the whole rule, which silently deleted the
 * Constitution's longer heads of power from any citation that named one: s 51
 * runs to placitum (xxxix) and (xxxvii), the referral power, is seven
 * characters. The long branch is a real roman-numeral shape rather than
 * `[ivxlcdm]{5,8}`, so bracketed prose whose letters happen to be roman
 * ("(civil)", "(mild)") still cannot become a subsection.
 */
export const SUBDIVISION_TOKEN =
  "(?:[A-Za-z0-9]{1,4}|[lL]?[xX]{1,3}(?:[iI][xX]|[iI][vV]|[vV]?[iI]{0,3}))"

export function isRomanNumber(value: string): boolean {
  return new RegExp(`^${ROMAN_NUMBER}$`).test(value)
}
