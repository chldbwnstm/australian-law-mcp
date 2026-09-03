import { describe, expect, it } from "vitest"
import { ID_LINE, REGISTER_ID_LINE, extractHitIds, extractHits, hasHits } from "./search-hits.js"

/** What `statute-helpers/format.ts` prints. */
const STATUTE = `Federal Register search: "competition"
2 matching title(s); showing 2, principal Acts ranked first.

1. Competition and Consumer Act 2010
   id: C2004A00109 | Act | InForce | principal | No 51 of 1974

2. Competition and Consumer Regulations 2010
   id: F2010L02522 | Legislative instrument | InForce | No 241 of 2010
`

/** What `lib/sources/render.ts` prints for a merged fan-out. */
const DECISIONS = `Case law — "misleading conduct"
2 results returned

1. Smith v Jones [2020] NSWSC 41
   id: nsw:5f2c19d3e4b0a1b2c3d4e5f6  ·  source: nswCaselaw
   court: NSWSC
   url: https://www.caselaw.nsw.gov.au/decision/5f2c19d3e4b0a1b2c3d4e5f6

2. Re Application [2026] AICmr 40
   id: [2026] AICmr 40  ·  source: oaic
   url: https://www.oaic.gov.au/x
`

const EMPTY = `Case law — "zzz"
0 results returned

No rows came back from this source for that query. That is a search result, not proof of
absence — do not tell the user the decision does not exist.
Browse the source directly: https://example.invalid
`

describe("reading ids out of a rendered result", () => {
  it("stops at the ' | ' the statute renderer appends", () => {
    expect(extractHitIds(STATUTE)).toEqual(["C2004A00109", "F2010L02522"])
  })

  it("stops at the '·' source label and keeps ids that contain spaces", () => {
    // `[2026] AICmr 40` is the id `get_decision_text` takes. Splitting on
    // whitespace would hand it `[2026]`, which resolves to nothing.
    expect(extractHitIds(DECISIONS)).toEqual(["nsw:5f2c19d3e4b0a1b2c3d4e5f6", "[2026] AICmr 40"])
  })

  it("finds nothing in the empty-result paragraph", () => {
    // That paragraph says in so many words that it is not proof of absence;
    // treating its prose as content is how it gets reported as a finding.
    expect(extractHitIds(EMPTY)).toEqual([])
    expect(hasHits(EMPTY)).toBe(false)
    expect(hasHits(DECISIONS)).toBe(true)
  })

  it("de-duplicates before applying the limit", () => {
    const repeated = `1. A\n   id: X\n\n2. A again\n   id: X\n\n3. B\n   id: Y\n`
    // A source that repeats its top hit must not consume the whole allowance.
    expect(extractHitIds(repeated, ID_LINE, 2)).toEqual(["X", "Y"])
  })

  it("reads compilation lines with the registerId pattern", () => {
    const versions = `1. 2015-01-01 → 2016-06-30 — registerId: C2015C00019 | compilation 12
2. 2016-07-01 → current — registerId: C2016C00087 | in force now`
    expect(extractHitIds(versions, REGISTER_ID_LINE)).toEqual(["C2015C00019", "C2016C00087"])
  })

  it("keeps the numbered heading with each id", () => {
    expect(extractHits(DECISIONS)).toEqual([
      { id: "nsw:5f2c19d3e4b0a1b2c3d4e5f6", title: "Smith v Jones [2020] NSWSC 41" },
      { id: "[2026] AICmr 40", title: "Re Application [2026] AICmr 40" },
    ])
  })

  it("does not mutate a caller's regex between calls", () => {
    // A `g` regex carries `lastIndex`; reusing the exported constant without
    // copying it would make the second call start mid-document.
    expect(extractHitIds(STATUTE, ID_LINE)).toEqual(extractHitIds(STATUTE, ID_LINE))
  })
})
