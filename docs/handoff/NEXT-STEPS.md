# Handoff — where the work stands

Updated 2026-09-05, after the two round-6 branches were reconciled into one `main`.

## State

| | |
|---|---|
| Last commit | `a0048ba` Close the three round-6 soft spots |
| Tests | 2,477 passing, 18 live-gated (skipped offline), 105 files, suite runs in ~5 s |
| Typecheck | clean (`tsc --noEmit`) |
| Build | clean (`npm run build`) |
| Tools | 81 registered, 10 advertised — `TOOL_COUNTS`, derived, never written down twice |
| Package | `au-law-mcp` v1.0.0 (bins: `au-law-mcp`, `australian-law`) |
| Remote | `github.com/chldbwnstm/australian-law-mcp` — **still private, not yet tagged** |
| Live matrix | `docs/VERIFICATION.md` — MCP stdio, all 18 decision domains, CLI, HTTP, packaging |

Six adversarial review rounds and two live-verification passes fixed **97 confirmed
defects** before round 6. Every finding was reproduced by execution before it was fixed,
and every fix is pinned by a test proven to fail beforehand.
`round5-outstanding-findings.json` beside this file is kept as the record of what was
fixed and why; its findings are all closed.

## What 1.0.0 contains

A rename (the unscoped `australian-law-mcp` on npm belongs to an unrelated project), the
round-6 correctness fixes, and the reconciliation below. No tool was added or removed —
the surface is the same 81/10 it was at 0.1.0. `CHANGELOG.md` is the itemised list; it is
not repeated here.

## What was reconciled

Round 6 was done **twice, independently, on two machines**, and both sides fixed the same
twelve round-5 defects and built the same three hardening items. Neither was a superset of
the other, so `9cd5b13` is a real merge with both parents, resolved on one policy:

- **Origin's grammar code** wherever both sides fixed the same defect — `section-ref.ts`,
  `section-ref-vocab.ts` (whose two letter constants are measured over all 1,177 in-force
  principal Commonwealth Acts, 126,207 labels, not a sample), `provision-slicer.ts`,
  `statute-citations.ts`, `instrument-radar.ts`, `chain-deadline.ts`.
- **The union of both sides' tests**, run against that code. Six local tests failed
  against it: two were real defects in origin's grammar and were fixed (a scanner that
  truncated `r 1.2.3.4.5` to `r 1.2.3.4`, a lowercase guard that only read letters behind
  a dash), one was a deleted duplicate fixture, three encoded the weaker of the two
  designs and were restated against the stronger one with their invariants intact.
- **The full-corpus fixtures.** Origin's harness auto-discovers captures and names its
  exclusions; local's captures are the *whole* tables of contents of the Corporations Act
  and the ITAA 1997, byte-verbatim and gzipped rather than sliced. The harness learned to
  inflate `.ncx.gz`, and the corpus went from 4,562 provision labels to **12,642 across
  five compilations** (1,214 non-provision labels excluded, each under a stated reason).
- **Local's registry guard** — an exact-equality contract table with no skip path that
  sees through `z.preprocess` — driving origin's outcome machinery (two collisions, two
  aliases, three evidence channels). Origin's `KNOWN_GAPS` ledger was deleted rather than
  carried: every tool it named is fixed on this side.

## Residual soft spots

Two remain, and both are accepted rather than open:

1. **A narrow ascending plain-hyphen pair cannot be decided from the text.** `ss 4-15` and
   `Part 3-4` are spelled exactly the way a writer spells "sections 4 to 15" and "Parts 3
   to 4", and nothing in the scanned bytes separates the readings. The decidable cases are
   decided — descending pairs (`ss 355-25`), equal halves (`ss 20-20`) and pairs past the
   hyphen ceiling (`ss 165-210`) come back as one number, and an en dash is always a range
   (AGLC r 1.9) — which leaves **217 of the corpus's 4,869 dashed numbers** genuinely
   ambiguous. They are counted and printed by `PLURAL_UNDECIDABLE` in
   `section-ref.corpus.test.ts` with the reason and the workaround, not skipped. Note also
   that a whole number canonicalises back to `ss 165-210`, which *reads* like a range: the
   printed form does not disclose which reading was taken.
2. **Labels that carry no number are grammar exclusions, not failures.** One unnumbered
   `Schedule` label and 704 unnumbered headings inside Guides and Subdivisions carry
   nothing for a reference to hold. Each is claimed by an `EXCLUSIONS` row with a stated
   reason and counted; a label matching no rule fails the test rather than being skipped.

## How the work has been run

Reviews are adversarial: several finder agents on distinct dimensions, then three
independent verifiers per finding (reproduce-by-execution, check-against-project-conventions,
materiality), majority required to confirm. Fixes go out in clusters with disjoint file
ownership so parallel agents cannot collide, and every agent must prove its test failed
before the fix. Keep that discipline for further work — it is what surfaced the defects
above, none of which a passing test suite would have revealed on its own.

## If you pick this up

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp && npm install
npm run typecheck && npm test            # the gate: 2,477 passing, no network
npm run build && node build/index.js     # stdio MCP server
node build/cli.js "what does s 18 of the ACL say"

# the one live suite, gated, asserts on shape only
LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts
```

Installed from npm the package is `au-law-mcp` (`npx -y --ignore-scripts au-law-mcp setup`
runs the client-config wizard), and the natural-language CLI is `australian-law`.

Known limitations are documented, not hidden: `README.md` has the blocked-source and
degraded-domain tables (AustLII, LawCite, the Federal Court, the NSW and SA registers, the
ACCC and the Competition Tribunal and the Ombudsman refuse automated clients, so those
paths return `[UPSTREAM_BLOCKED]` with deep links rather than pretending the record is
absent), and `docs/VERIFICATION.md` records what each domain actually returned when last
driven against live upstreams.

## Before flipping the repo public

`CONTRIBUTING.md`, `.github/workflows/ci.yml` and the `.gitignore` entry for local MCP
state are in place, and the docs carry no absolute paths from a contributor's machine. Two
things are left for a human: the repository is **private and untagged** — `v1.0.0` has to
be tagged — and the commit history carries two personal email addresses across 37 commits,
which becomes permanently public along with it.
