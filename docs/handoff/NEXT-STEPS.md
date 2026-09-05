# Handoff — where the work stands

Updated 2026-09-05. Everything described here is committed and pushed; nothing is in flight.

## State

| | |
|---|---|
| Remote | `github.com/chldbwnstm/australian-law-mcp` (private) |
| Last commit | `d94830c` Round-5 fixes + corpus harness |
| Tests | 2,360 passing, 18 live-gated (skipped offline), suite runs in ~6s |
| Typecheck | clean |
| Tools | 81 registered, 10 advertised — the same surface shape as korean-law-mcp |
| Live matrix | `docs/VERIFICATION.md` — MCP stdio, all 18 decision domains, CLI, HTTP, packaging |

Five adversarial review rounds and two live-verification passes fixed **92 confirmed
defects**. Every finding was reproduced by execution before it was fixed, and every fix
is pinned by a test proven to fail beforehand. The round-5 list that this file previously
described as outstanding is now closed; `round5-outstanding-findings.json` is kept as the
record of what was fixed and why.

## The three hardening items are built

1. **Real-corpus round-trip harness** — `src/lib/section-ref.corpus.test.ts` runs the
   provision grammar over 4,562 real labels from five recorded Federal Register tables of
   contents and asserts each parses, round-trips, addresses its own navLabel and no other,
   and is neither invented nor truncated by the scanner. Non-provision labels are claimed
   by exclusion rules with stated reasons; a label matching none fails rather than being
   skipped. Against the pre-fix grammar it reported 97.13% parse, 2 labels resolving to the
   wrong provision and 454 scanned wrong — the exact regression class it exists to catch.
   Recording a sixth table of contents extends the corpus with no code change.
2. **A registry guard that asserts outcomes** — it now drives each registered tool with a
   schedule-carrying alias and checks which provision came back, enumerating tools from the
   live registry so a new one is included automatically and failing (not skipping) on any it
   cannot drive.
3. **Deadline tests no longer pace off the wall clock** — the intermittent failure is gone
   and the suite dropped from ~30s to ~6s.

## Why this mattered

The defects worth knowing about were not crashes. They were confident wrong answers:
citations resolved to a *different real provision* (`s 8AAZLGA` truncated to `s 8AAZL`,
`Subdiv 152-C` answered with Subdivision 152-A), upstream failures laundered into "this law
does not exist", a hallucination guard printing `[VERIFIED]` over text it had silently
skipped, and the ACL trap — `ACL s 18` answered with the Competition and Consumer Act's
body s 18 ("Meetings of Commission") instead of sch 2 s 18 ("Misleading or deceptive
conduct"). That last one recurred for three rounds because it was patched site by site;
it is now behind one choke point with the registry guard above.

## How the work has been run

Reviews are adversarial: several finder agents on distinct dimensions, then three
independent verifiers per finding (reproduce-by-execution, check-against-project-conventions,
materiality), majority required to confirm. Fixes go out in clusters with disjoint file
ownership so parallel agents cannot collide, and every agent must prove its test failed
before the fix. Keep that discipline for further work — it is what surfaced the defects
above, none of which a passing test suite would have revealed on its own.

## If you pick this up again

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp && npm install
npm test          # 2,360 passing
LIVE=1 npx vitest run src/lib/sources   # 18 live-gated tests against real upstreams
npm run build && node build/index.js    # stdio MCP server
node build/cli.js "what does s 18 of the ACL say"
```

Known limitations are documented, not hidden: `README.md` has the blocked-source and
degraded-domain tables (AustLII, LawCite, Federal Court, NSW/SA legislation registers and
the ACCC refuse automated clients, so those paths return `[UPSTREAM_BLOCKED]` with deep
links rather than pretending the record is absent), and `docs/VERIFICATION.md` records what
each domain actually returned when last driven against live upstreams.
