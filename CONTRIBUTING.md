# Contributing

Build, test, fixture and extension conventions live in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Read that first; this page is only the
short version of what a change has to clear.

## The gate

```bash
npm run typecheck && npm test
```

Both must be green before a commit. CI runs the same two commands plus `npm run build`
and `npm pack --dry-run` on Node 20.19 and 22.

## Two rules that are not negotiable

Both are stated in full in [`CLAUDE.md`](CLAUDE.md), which is the repo guide for humans
and coding agents alike.

1. **Never report an absence you did not establish.** Several Australian sources refuse
   automated clients, so "not found", "the source did not answer" and "this server does
   not fetch that host" are three different labels — `[NOT_FOUND]`,
   `[UPSTREAM_NO_DATA]`, `[UPSTREAM_BLOCKED]` — and only the first may be read as
   absence. Labels come from `ErrorCodes` in `src/lib/errors.ts`, never written by hand.

2. **Fixtures are recorded, never hand-written.** A fixture is a real upstream response,
   saved verbatim. An invented one tests the parser against your idea of the page, which
   is exactly the belief the fixture existed to check. Trim only for size, only by
   dropping whole repeated records, and record the URL and capture date.

## The suite stays offline

`npm test` must never touch the network — every parser test runs against a recorded
fixture, and a suite that reaches a live site turns someone else's outage into a red
build. The one exception is the live smoke suite, which is gated and not run in CI:

```bash
LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts
```

It asserts on **shape** only, never on content an upstream is free to change.
