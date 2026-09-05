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
 * The letters a structural *series* is lettered with — the tail of a roman
 * Part, and the whole of a bare lettered unit.
 *
 * Both classes are **measured, not guessed**, and the measurement below is the
 * whole thing rather than a sample: the `document.ncx` table of contents of
 * every one of the **1,177 in-force principal Commonwealth Acts**, fetched
 * from the Federal Register on 2026-09-05 — 126,207 navLabels. Round 5 set
 * these from five Acts (13,861 labels) and both classes came out too narrow,
 * which is a mistake a wider sample cannot make twice.
 *
 * `SERIES_LETTER` governs only the **four**-letter roman tail (see
 * `ROMAN_NUMBER`); tails of one to three letters are `[A-Z]`. Across the
 * statute book the tail letters actually used run A–K (the *Veterans'
 * Entitlements Act 1986* has Parts IIIG, IIIH, IIIJ and IIIK — the drafter
 * skips I, which would read as another numeral), but there is exactly **one**
 * four-letter tail in the whole of it: the *Crimes Act 1914*'s Part IAABA,
 * whose tail is AABA. `[A-F]` covers it with room to spare, and every letter
 * added here is an ordinary English word admitted as a pinpoint.
 */
export const SERIES_LETTER = "[A-F]"

/**
 * The bare lettered structural units: `Subdivision C`, `Subdivision AL`,
 * `Part B`. Used as `SERIES_UNIT_LETTER{1,SERIES_UNIT_LETTER_MAX}`.
 *
 * A series letter is an insertion marker, so it is drawn from the front of the
 * alphabet — but the front runs further than five Acts showed. Measured over
 * all 126,207 labels, the bare lettered units that are **not** roman numerals
 * are single letters A–N and two- or three-letter runs AA…AL, BA…BC, CA, CB,
 * DA…DF, EA…EC, FA, FB, GA…GC, HA, HB, JA, AGA, BAA, DAA, FAA. So the class is
 * `[A-N]` and the run is three:
 *
 *  - `[A-H]{1,2}` — round 5's value — silently dropped 29 real labels,
 *    including the *Competition and Consumer Act 2010*'s own Subdivisions J
 *    ("Adverse publicity orders"), K and L, the *Migration Act 1958*'s
 *    Subdivisions AI ("Safe third countries"), AJ, AL and AGA, the *Customs
 *    Act 1901*'s J, JA and K, the *Bankruptcy Act 1966*'s J and K, the
 *    *Veterans' Entitlements Act 1986*'s L, M and N, and the three-letter BAA
 *    (*Taxation Administration Act 1953*, ASIC Act), DAA and FAA (*Social
 *    Security (Administration) Act 1999*). They did not come back unreadable —
 *    they were not there at all, which is the failure the second pass in
 *    `section-ref.ts` exists to prevent.
 *  - `[A-Z]{1,3}` is the other mistake. Run over the same 126,207 labels it
 *    matches 59 things this class does not, and they are not units: `PT FWC`
 *    out of a Fair Work heading, and — from this repo's own recorded ITAA
 *    table of contents, where one navLabel ends "…object of this Subdivision"
 *    and the next begins "CGT consequences" — `sub-div CGT` and `sub-div IMR`.
 *    Against `/usr/share/dict/words`, `[A-Z]{1,3}` spells 1,465 ordinary
 *    English words and `[A-N]{1,3}` spells 315.
 *
 * `[A-N]{1,3}` matched **nothing that was not a real structural unit** in any
 * of the 126,207 labels. Two further rules keep it out of prose and both are
 * load-bearing: the letters are matched case-**sensitively** (so "part of" and
 * "division and control" are words), and they must be separated from the
 * designation (so `PARTIES` is a word) — see `section-ref.ts`.
 *
 * What it costs, stated rather than left to be rediscovered: `AND`, `ALL`,
 * `END` and `MAN` are spellable in this class, so an all-**capitals** heading
 * like "SCHEDULES AND ANNEXURES" reads as `sch AND`. That is the same trade
 * `ROMAN_NUMBER` already makes one line down — `PART IS`, `PART IN` and
 * `PART IF` have always been readable as roman Parts, for the same reason and
 * with the same capitals guard — and it is the cheaper of the two errors: a
 * pinpoint nobody cited comes back as a visible `[NOT_FOUND]`, whereas the
 * `Subdivision M` this class used to drop came back as nothing at all.
 *
 * `section-ref.corpus.test.ts` re-runs the grammar over the recorded labels in
 * `__fixtures__`, so narrowing this needs a real label to justify it just as
 * much as widening it did.
 */
export const SERIES_UNIT_LETTER = "[A-N]"
/** `Subdivision AGA`, `Subdivision BAA` — the widest bare unit in the statute book. */
export const SERIES_UNIT_LETTER_MAX = 3

/**
 * A roman structural number: the numeral, then a bounded tail —
 * `IV`, `IVA`, `XI`, `IIIAA`, `IVBA`, `XICA`, `IABA`, `IAABA`.
 *
 * Every bound is load-bearing.
 *
 * **The tail runs to three letters, not one.** The Commonwealth really does go
 * that far: the *Competition and Consumer Act 2010* has Parts IIIAA, IVBA,
 * IVBB, XIAA, XICA and XICB (they are navLabels in this repo's own
 * `__fixtures__/cca-document.ncx`), and the *Crimes Act 1914* has Part IABA.
 * A one-letter tail did not merely reject `pt IVBA` — `section-ref.ts`'s
 * right-edge guard then dropped it out of a scanned document *silently*, so a
 * citation checker reported on the rest of the document as though that
 * citation had been checked.
 *
 * **A fourth letter is admitted only when the whole tail is a series letter.**
 * The widest real tail is the *Crimes Act 1914*'s Part IAABA (in force since
 * 8 December 2023, ss 3ZZUHA–3ZZUHC), which a three-letter tail rejected
 * outright — and the same right-edge guard then dropped it from a scanned
 * document without a word. An unrestricted fourth letter is not the way to
 * reach it: measured against `/usr/share/dict/words`, the numeral with
 * `[A-Z]{0,4}` matches 709 ordinary English words against this pattern's 324
 * and the three-letter tail's 322 — the two it adds are `Vedda` and `xebec`,
 * and both would still have to be written in capitals after a spaced
 * designation to become a pinpoint.
 *
 * **The numeral is a real numeral (I–XXXIX), not "letters drawn from
 * IVXLCDM".** The loose spelling is what made the tail dangerous to widen:
 * `section-ref.ts` scans documents case-insensitively, so `[IVXLCDM]+[A-Z]{0,3}`
 * reads `can`, `did`, `made`, `civil` and `dill` as roman numbers, and "the
 * rules can be amended" yields a pinpoint `rr CAN` that the caller then
 * reports as a provision the Act does not contain. No Part, Division or
 * Chapter is numbered L, C, D or M (they would be 50, 100, 500 and 1000), so
 * dropping those letters costs nothing real and removes every one of those
 * readings: `[IVXLCDM]+[A-Z]{0,3}` matches 2,490 words of the same dictionary.
 *
 * A bare lettered unit (`pt C`, `sub-div B`) is not this pattern's business:
 * `LETTERED_STRUCTURAL` in `section-ref.ts` reads those, and only for the
 * structural kinds that really are lettered.
 *
 * Wrapped in its own group and free of capturing groups: callers interpolate
 * it into alternations and read their own match indices.
 */
export const ROMAN_NUMBER =
  `(?:(?:X{1,3}(?:IX|IV|V?I{0,3})|IX|IV|V?I{1,3}|V)(?:${SERIES_LETTER}{4}|[A-Z]{0,3}))`

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
