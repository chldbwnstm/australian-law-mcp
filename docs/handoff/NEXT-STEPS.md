# Handoff — where the work stands and what is left

First written 2026-09-05 when the project moved machines; **updated the same
day, on the new machine (Windows 11, Node 22), after round 6**. Everything
described here is committed; nothing is in flight.

## State

| | |
|---|---|
| Last round | Round 6: all 12 round-5 defects fixed, all 3 hardening items built |
| Tests | 2,309 passing, 18 live-gated (all 18 pass live, run 2026-09-05) |
| Typecheck | clean |
| Suite time | ~8 s of test time (was ~37 s; the deadline suite no longer sleeps) |
| Tools | 81 registered, 10 advertised |

The round-5 findings (`round5-outstanding-findings.json` in this folder) are
**all resolved**; the file stays as the record of what was adjudicated. Every
fix was pinned by a test proven to fail first, most of them against the new
real-corpus fixtures rather than hand-picked examples.

## What round 6 built

1. **The real-corpus grammar harness** (`src/lib/section-ref.corpus.test.ts`).
   Four byte-verbatim NCX captures — Corporations Act, ITAA 1997, Crimes Act
   1914, the Constitution; 13,562 navPoints, gzipped under
   `src/lib/__fixtures__/` — and, for every provision label: parses,
   round-trips, addresses its own navLabel and no other identity, scanner
   invents/truncates/misses nothing. **Run it whenever you touch
   `section-ref*.ts`**; it is in the ordinary `npm test` run. Its first
   execution reproduced every round-5 grammar finding at once.

2. **The registry guard asserts outcomes** (`src/lib/query-extract.test.ts`).
   Every (law, provision) tool is driven with `ACL` + `s 18` and judged on
   what it *served* (schedule text present, body text absent, subject named,
   URLs schedule-qualified), against markers the fixtures prove
   distinguishable. The in-scope set is an exact-equality table — a new tool
   fails until it gets a contract; there is no skip path and KNOWN_GAPS is
   gone. This caught and fixed real body-for-schedule substitution in
   `get_instrument_provisions`, `get_historical_law` and
   `get_external_links`' URLs, and found `legal_research` sitting outside the
   old guard's scope entirely (z.preprocess hid its schema fields).

3. **The deadline suite is deterministic** (`src/tools/chains.deadline.test.ts`).
   Vitest fake timers virtualise the one primitive under test; every
   assertion is verbatim what it was; production code untouched.

## Residual soft spots, in judgment order

1. **`PINPOINT_SHAPE` in `src/tools/analysis-helpers/statute-citations.ts`
   hard-codes its own roman branch** (`[IVX][A-Z]{0,9}`) instead of deriving
   from `ROMAN_NUMBER` in `section-ref-vocab.ts` — a single-source violation
   that is only cosmetic until the two drift. The next person in that file
   should re-derive it.

2. **An ASCII plural hyphen pair still *parses* as a range** (`ss 165-210`
   typed or from a non-FRL source). This is now harmless at lookup —
   `refToNcxLabelPattern` asks the TOC for the joined ITAA-style name first,
   so the real section is found — but `formatRef` still displays the range
   form (`ss 165–210`). Nothing in the scanned bytes can distinguish the two
   readings (FRL's NCX uses a plain ASCII hyphen and `htmlToText` folds
   U+2011), so any "fix" here would be a guess; the display is the accepted
   residue. The U+2011/U+2010 form is decided correctly on the anchored path.

3. **The guard's second sweep** (tools with a law-ish field and no provision
   field) still `catch → continue`s for tools other than its exemplar; full
   hardening needs per-tool input tables like the first class has.

4. **`src/tools/chain-deadline.test.ts`** (the unit suite) still uses real
   30–60 ms timers. Wide margins, never seen flaking — but it is the same
   pattern the deadline suite had, in miniature.

5. **Two unnumbered schedules are documented grammar exclusions** (Crimes Act
   "Schedule—Form of explanation…", Constitution "SCHEDULE."): the citation
   for a sole unnumbered schedule is "the Schedule", an Act-relative phrase
   the number grammar cannot carry. `KNOWN_UNPARSABLE` in the corpus test
   enumerates them and fails if they go stale.

## How the work has been run

Reviews are adversarial: several finder agents on distinct dimensions, then
three independent verifiers per finding (reproduce-by-execution,
check-against-project-conventions, materiality), majority required to
confirm. Fixes go out in clusters with disjoint file ownership so parallel
agents cannot collide, and every agent must prove its test failed before the
fix. Round 6 added the discipline the harness now enforces mechanically:
grammar changes are checked against every provision label of four real
compilations, not the examples at hand.
