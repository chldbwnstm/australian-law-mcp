# Handoff — where the work stands and what is left

Written 2026-09-05, when the project moved to another machine. Everything described
here is committed; nothing is in flight.

## State

| | |
|---|---|
| Last commit | `fed3baf` Live verification round 2 |
| Tests | 2,256 passing, 18 live-gated (skipped offline) |
| Typecheck | clean |
| Tools | 81 registered, 10 advertised (same surface shape as korean-law-mcp) |
| Live matrix | `docs/VERIFICATION.md` — MCP stdio, all 18 decision domains, CLI, HTTP, packaging |

Five adversarial review rounds plus two live-verification passes have fixed **80
confirmed defects**. Every finding was reproduced by execution before it was fixed,
and each fix is pinned by a test that was proven to fail beforehand.

## What is left (12 confirmed defects, not yet fixed)

The full list with failure scenarios is `round5-outstanding-findings.json` in this
folder. They were confirmed by three-lens verification against commit `e92abd2`;
re-verify against current code before fixing, since `fed3baf` moved some of it.

High severity, all in the provision-reference grammar:

1. `src/lib/section-ref.ts` — `NUMBER_PATTERN` cannot express a compound number whose
   first component carries a letter, so `Part 2D.1` (125 real Corporations Act Parts)
   and `Subdivision 83A-C` are rejected outright and silently truncated by the scanner
   to a different provision.
2. `src/lib/section-ref.ts` — `formatRef` discards `ref.subsections` for bracketed
   kinds, so `subsection 5(2)` normalises to `sub-s (5)`: section 5's subsection (2)
   becomes subsection (5).
3. `src/lib/section-ref.ts` — a plural designation before a forward-running ITAA
   number reads as a range, so `ss 165-210` (one real ITAA 1997 section) becomes
   "sections 165 to 210".
4. `src/lib/section-ref-vocab.ts` — round 4 narrowed `ROMAN_NUMBER` and dropped
   L/C/D/M, so real units like `Subdivision C` are no longer extracted; its
   three-letter tail is also one short of the real maximum (`Part IAABA`).

The remaining eight (medium/low) cover citation-list truncation, the slicer's
over-eager ambiguity note, an instrument_radar follow-up call that its own parser
rejects, and the vacuous registry guard described below.

## Three pieces of hardening that were specified but not built

These matter more than the individual fixes, because five rounds of regex tuning on
the provision grammar have produced a regression in every round.

1. **A real-corpus round-trip harness** (`src/lib/section-ref.corpus.test.ts`).
   Pull every provision label out of real Federal Register NCX documents — the
   Corporations Act (`C2004A00818`), ITAA 1997 (`C2004A05138`), Crimes Act 1914 and
   the Constitution (`C2004Q00685`) are the hard cases — and assert for each label
   that it parses, that parse → format → parse round-trips, that its NCX pattern
   matches its own label and no other in the same document, and that the scanner
   invents nothing. Record the pass rate and list known-unparsable shapes as explicit
   documented exclusions. This turns "did that regex change break a real citation
   form?" from guesswork into a failing test.

2. **A registry guard that actually guarantees something.** The one added in round 4
   (`src/lib/query-extract.test.ts`) only inspects `apiClient.getProvision` calls, so
   any tool that slices volumes itself passes as long as the string `sch 2 s 18`
   appears somewhere — it can fetch the wrong provision and still pass. Rebuild it to
   assert the *outcome*: drive each registered tool with a schedule-carrying alias
   (`ACL`, `National Credit Code`) plus a bare provision against fixtures that make the
   schedule and body provisions distinguishable, enumerate tools from the live registry
   so a new tool is included automatically, and fail — not skip — on any tool the
   harness cannot drive.

3. **Deflake `src/tools/chains.deadline.test.ts`.** It passes 8/8 in isolation but
   fails intermittently under full-suite load, a different case each run, because it
   paces itself off the wall clock against the 5-second `MIN_DEADLINE_MS` floor.
   Inject the clock rather than weakening the assertions or raising the floor; the
   behaviours it protects (a finished branch keeps its section, an unfinished one is
   marked `[NOT RETRIEVED]`, a partial result is never `isError`) are ones this project
   cares about.

## How the work has been run

Reviews are adversarial: several finder agents on distinct dimensions, then three
independent verifiers per finding (reproduce-by-execution, check-against-project-
conventions, materiality), majority required to confirm. Fixes go out in clusters with
disjoint file ownership so parallel agents cannot collide, and every agent must prove
its test failed before the fix. That discipline is what surfaced the defects that
mattered — citations answered with a different real provision, upstream failures
laundered into "this law does not exist", and a verification banner printed over text
that was never checked.
