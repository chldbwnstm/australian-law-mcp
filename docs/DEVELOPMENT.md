# Australian Law MCP — Developer Guide

> **v1.0.0** | Build, test and extension conventions for contributors and coding agents

The behavioural rules in [CLAUDE.md](../CLAUDE.md) are canonical. This document is how
you build, test and extend the thing without breaking them.

---

## Environment

### Requirements

- **Node ≥ 20.19.0.** Pinned in `engines`, and used by the `node:22-alpine` Dockerfile.
  The floor is 20.19 because the MCP SDK and Express 5 both need it; the container runs
  22 because it is the current LTS.
- **npm 10+.** Regenerate `package-lock.json` with the same major version you install
  with — a lockfile written by a newer npm can break `npm ci` on an older one.
- **No API key.** Every upstream is a keyless public endpoint. There is nothing to
  configure before the server will run.

### Setup

```bash
git clone <repo> && cd Australian-Law-MCP
npm ci --ignore-scripts
npm run build
node build/index.js --help
```

---

## Project structure

```
src/
├── index.ts                     # process entry: stdio | --mode http | setup
├── cli.ts                       # the australian-law binary; NL router + per-tool subcommands
├── setup.ts                     # MCP client config wizard (7 clients, 3 config shapes)
├── tool-registry.ts             # allTools (81) + V3_EXPOSED filter (10) + the request boundary
├── version.ts                   # VERSION/SERVER_NAME read from package.json at runtime
│
├── lib/                         # source-agnostic core — no tool imports this in reverse
│   ├── api-client.ts            # AuApiClient: the multi-host facade. Frozen interface
│   ├── upstream-hosts.ts        # SINGLE SOURCE of base URLs, timeouts, intervals, blocked flags
│   ├── frl-criteria.ts          # SINGLE SOURCE of the Federal Register criteria DSL
│   ├── section-ref.ts           # SINGLE SOURCE of provision-reference grammar (sch 2 s 18)
│   ├── section-ref-vocab.ts     #   its vocabulary: kinds, spellings, roman numbers
│   ├── case-citation.ts         # SINGLE SOURCE of MNC + report-series grammar
│   ├── court-codes.ts           #   the court token table
│   ├── report-series.ts         #   the reported-series table
│   ├── law-alias.ts             # SINGLE SOURCE of law-name aliasing (CCA, ACL, TPA→CCA)
│   ├── law-alias-data.ts        #   the alias table itself
│   ├── citation-content-matcher.ts  # exact LCS + bigram Jaccard, ported from the reference
│   ├── execution-limits.ts      # DEFAULT_EXECUTION_LIMITS + the per-request budget object
│   ├── session-state.ts         # AsyncLocalStorage: budget, cancellation signal, api key
│   ├── fetch-with-retry.ts      # budget-charged fetch, per-host UA/Referer/timeout
│   ├── response-body.ts         # body reading under the per-response byte cap
│   ├── body-shape.ts / upstream-miss.ts  # "a 200 that is really a miss"
│   ├── errors.ts                # SINGLE SOURCE of the bracket-label taxonomy
│   ├── cache.ts                 # LRU; search 1h / text 24h
│   ├── rate-limit.ts            # token bucket for the shared upstream allowance
│   ├── query-router.ts          # the CLI's natural-language routing
│   ├── tool-profiles.ts         # V3_EXPOSED + TOOL_CATEGORIES + TOOL_ALIASES
│   ├── external-links-map.ts    # deep-link builders for the blocked hosts
│   └── sources/                 # one module per upstream site: request + parse
│       └── __fixtures__/        # recorded upstream responses
│
├── tools/                       # one file per tool cluster; each exports Schema + handler + description
│   ├── unified-decisions.ts     # the 18-domain dispatcher
│   ├── legal-research.ts        # the 8 chains behind `task`
│   ├── legal-analysis.ts        # the 4 analysis features behind `mode`
│   ├── meta-tools.ts            # discover_tools / execute_tool
│   ├── analysis-helpers/        # statute-check, case-check, content-claims, heading-index…
│   ├── statute-helpers/         # toc, title-lookup, endnotes, diff, instruments, format
│   ├── decision-domains.live.test.ts   # the ONLY live-gated suite
│   └── __fixtures__/
│
└── server/
    ├── http-config.ts           # env parsing and validation for the HTTP transport
    └── http-server.ts           # stateless Streamable HTTP
```

Every file called out as **SINGLE SOURCE** owns a grammar or a table that appears in more
than one tool. Copying a regex or a host URL out of one of them is the mistake that makes
two tools disagree about the same fact, and the disagreement will not fail a test — it
will produce two plausible answers.

---

## Commands

```bash
npm run build          # clean + tsc
npm run watch          # tsc --watch
npm run typecheck      # tsc --noEmit
npm test               # vitest run   — 105 files / 2,477 tests, no network (2026-09 measured)
npm run test:watch     # vitest
npm start              # stdio server
npm run start:http     # HTTP server
npm run cli -- "..."   # the CLI without installing
npm run setup          # the client-config wizard

# before committing
npm run typecheck && npm test
```

Test counts drift upward with every change; the figure above is a measurement, not a
target.

---

## Testing

### The rule

**`npm test` must never touch the network.** A suite that silently depends on twenty
government websites is a suite that fails for reasons unrelated to the code, and a
contributor learns to ignore it. Every parser test runs against a recorded fixture.

### The exception, and why it exists

`src/tools/decision-domains.live.test.ts` is the only live suite, and it is skipped
unless `LIVE=1`:

```bash
LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts
```

Fixtures can check the *response* half of a source. They cannot check the *request* half
— the literal-bracket High Court facet that must not be percent-encoded, the ATO's
form-encoded POST, Queensland's 90-second content search, the redirect chase on Western
Australia's document links. That is what these 18 tests cover, so they assert on
**shape, never on content** the upstream is free to change, and they issue one request
per assertion with the client's own per-host interval between them.

Run them before a release and whenever an upstream parser changes. A failure here is
usually the site, not the code — check the site in a browser before rewriting a parser.

### Fixture provenance

Fixtures live in `src/lib/__fixtures__/`, `src/lib/sources/__fixtures__/` and
`src/tools/__fixtures__/`, named `<source>-<what>.<ext>`:
`cca-document.ncx`, `frl-titles-search.json`, `qld-case-qsc-2020-100.html`.

Recording one:

1. Fetch the **real** URL, with the same headers `fetch-with-retry` sends. A fixture
   captured with a different user agent can be a different page.
2. Save the body **verbatim**. Do not tidy the markup, do not reformat the JSON, do not
   trim the whitespace. Every one of those is something a parser has to survive in
   production, and a cleaned fixture tests a page that does not exist.
3. Trim only for **size**, and only by removing whole repeated records — a search page
   with 3 result rows instead of 50 is still the real shape. Name a trimmed fixture
   `-slice` (`cca-vol1-slice.html`).
4. **Compress rather than trim when the fixture has to stay complete.** The grammar
   corpus in `src/lib/__fixtures__/` needs *every* navLabel of an Act's table of
   contents, so a slice would defeat it: `corporations-document.ncx.gz` (5,569
   navPoints, 1.7 MB inflated) and `itaa97-document.ncx.gz` (6,772, 2.1 MB) are stored
   `gzip -n -9` — `-n` so the archive carries no timestamp and is reproducible from the
   capture — and the bytes inside are exactly what the register served. Compression is
   not a trim, so rule 2 still holds. `section-ref.corpus.test.ts` picks up `*.ncx` and
   `*.ncx.gz` alike from that directory and inflates with `node:zlib`:

   ```bash
   gzip -n -9 corporations-document.ncx          # record
   gzip -dc src/lib/__fixtures__/corporations-document.ncx.gz | less   # read one back
   ```

   Provenance for all five corpus captures — register ids, navPoint counts, capture
   date — is in `src/lib/__fixtures__/PROVENANCE.txt`.
5. Note the URL and the date it was captured in the test that loads it, so the next
   person can tell a stale fixture from a changed parser.
6. **Never hand-write a fixture.** A fixture that was invented tests the parser against
   your idea of the page, which is exactly the belief the fixture was supposed to check.

### What a test should pin

Pin the **behaviour that matters**, and say in a comment why it matters. The tests in
this repo that earn their keep look like:

```ts
it("REJECTS the flagship trap: misleading conduct vs the real CCA s 18 heading", () => {
  const result = matchCitationContent("misleading or deceptive conduct", "Meetings of Commission")
  expect(result.matched).toBe(false)
})
```

not `expect(result).toMatchSnapshot()`. A snapshot records what the code did; it does not
record what the code is for, and it will be blessed away the first time it fails.

Do not pin a shipped constant from a test that is really about a mechanism. When
`response-body.limits.test.ts` needed a 2 MiB cap to exercise the over-limit path, it got
its own `LIMITS` object rather than reading `DEFAULT_EXECUTION_LIMITS` — so retuning the
default for a bigger upstream volume does not break a test about hang-versus-error.

---

## Adding a tool

### Step 1 — the tool file

One file per cluster, in `src/tools/`. Export a Zod schema, an inferred input type, a
description and an async handler.

```ts
import { z } from "zod"
import type { AuApiClient } from "../lib/api-client.js"
import { formatToolError } from "../lib/errors.js"
import type { ToolResponse } from "../lib/types.js"

export const GetWidgetSchema = z.object({
  registerId: z.string().describe("FRL register id from search_law, e.g. C2004A00109."),
  provision: z
    .string()
    .optional()
    .describe('Provision reference: "s 18", "sch 2 s 18" (the ACL), "pt IVA".'),
})

export type GetWidgetInput = z.infer<typeof GetWidgetSchema>

// The description is the model's only instruction manual. Say what it does, give a
// concrete Australian example, and name the trap.
export const getWidgetDescription =
  "Fetch the widget for a Commonwealth Act. Give registerId (from search_law), e.g. " +
  "{registerId:'C2004A00109', provision:'sch 2 s 18'} for Australian Consumer Law s 18. " +
  "A source that is blocked comes back as a deep link, never as an absence."

export async function getWidget(apiClient: AuApiClient, input: GetWidgetInput): Promise<ToolResponse> {
  try {
    const widget = await apiClient.fetchJson("frlApi", `/widgets/${input.registerId}`)
    return { content: [{ type: "text", text: render(widget) }] }
  } catch (error) {
    // Never let a raw exception reach the transport: formatted, it carries a
    // bracket label the caller can branch on.
    return formatToolError(error, "get_widget")
  }
}
```

### Step 2 — register it

In `src/tool-registry.ts`, add it to `allTools` under the right `═══` heading:

```ts
{ name: "get_widget", description: getWidgetDescription, schema: GetWidgetSchema, handler: getWidget },
```

Then put its name in the right category in `TOOL_CATEGORIES`
(`src/lib/tool-profiles.ts`), or `discover_tools` will never surface it and the CLI's
`list --category` will not find it. Add practitioner vocabulary to `TOOL_ALIASES` if
people would search for it by a word that is not in its name.

**Do not add it to `V3_EXPOSED`** unless the two-hop `discover_tools` → `execute_tool`
round trip is genuinely not worth its latency for that tool. Ten is the budget. Every
advertised entry is context every client pays for on every request, forever.

### Step 3 — test and build

```bash
npx vitest run src/tools/get-widget.test.ts
npm run typecheck
npm test
npm run build && node build/cli.js get_widget --registerId C2004A00109
```

The registry has its own tests (`src/tool-registry.docs.test.ts`) that check every tool
advertises a usable JSON Schema and that the categories resolve — a tool wired in wrong
fails there rather than in production.

---

## Adding a decision domain

1. **Add the source module** in `src/lib/sources/`: one file, request builders and
   parsers, with a recorded fixture and its own test.
2. **Add the host** to `UPSTREAM_HOSTS` in `src/lib/upstream-hosts.ts` with a measured
   `timeoutMs` and `minIntervalMs` (≥1000 ms for anything scraped), and a `notes` line
   naming the quirk you had to work around. A blocked host is a row in the *same* table
   with `blocked: true` and a `blockedReason` — never a separate list, or a host can end
   up blocked in one file and fetched from another.
3. **Add the tool pair** (`search_*` / `get_*_text`) in `src/tools/`.
4. **Wire the domain** in `src/tools/unified-decisions.ts`: add the name to
   `DECISION_DOMAINS`, a sentence to `DOMAIN_LABELS`, and entries in `SEARCH_HANDLERS`
   and `GET_HANDLERS`. If the get handler shortens its own body, add it to
   `SELF_COMPACTING` or the gap markers nest.
5. **Add a live smoke test** to `decision-domains.live.test.ts` asserting on shape.
6. **Update the grade tables** in `README.md` and `docs/TOOL-MAPPING.md` from a real run,
   not from intent.

---

## Code rules

The consequences, not just the rules:

- **No `console.log` on the stdio path.** A stray write corrupts the JSON-RPC framing and
  the client reports a protocol error that points nowhere near its cause. `index.ts`
  rebinds `log`/`warn`/`info`/`debug` to stderr before connecting the transport. The CLI
  (`cli.ts`, `cli-executor.ts`, `cli-format.ts`) is a separate binary and is exempt.
- **Never claim absence you did not establish.** `[NOT_FOUND]` means a source that
  authoritatively covers the record says it is not there. Everything else is
  `[UPSTREAM_NO_DATA]` or `[UPSTREAM_BLOCKED]`. This is the rule the whole project exists
  to keep: reporting a Cloudflare block as "no such case" advises a real authority out of
  existence.
- **Bracket labels come from `ErrorCodes`.** A label built ad hoc leaves machine readers
  unable to tell which set it belongs to.
- **A tool never throws to the transport.** Wrap in `formatToolError`. The one exception
  is cancellation, which is re-thrown so the SDK can suppress a withdrawn response.
- **Every upstream fetch goes through the client.** It holds the per-host politeness
  clock and charges the request budget. A bare `fetch` bypasses both.
- **Fetch a volume only after a provision inside it is named.** `get_law_text` without a
  `provision` returns the table of contents, deliberately — Act volumes are megabytes.
- **Single-source vocabulary.** Section references, case citations, court codes, report
  series, law aliases, host config and error labels each have exactly one owning module.
  Do not re-derive them locally.
- **Australian English and Australian legal vocabulary** in every user-facing string —
  "medium-neutral citation", "penalty units", "catchwords", "AGLC", "commencement". The
  descriptions are what a model reads to decide which tool to call.
- **~200 lines per file.** Split by concern (`analysis-helpers/`, `statute-helpers/`,
  `lib/sources/`) rather than by size.
- **TypeScript strict.** No `any` reaching an exported signature.

---

## Release

```bash
npm run typecheck && npm test
LIVE=1 npx vitest run src/tools/decision-domains.live.test.ts
npm run build
npm pack --dry-run          # confirm build/ + README + LICENSE + NOTICE + CHANGELOG, nothing else
npm publish
```

Check the packed layout before publishing, not after — install the tarball into an empty
directory and run both bins:

```bash
npm pack --pack-destination /tmp/packtest
cd /tmp/packtest && npm init -y && npm install ./au-law-mcp-*.tgz
./node_modules/.bin/au-law-mcp --version
./node_modules/.bin/australian-law list --category treaties
```

`files` in `package.json` is an allowlist. Anything not listed there does not ship, which
is why no fixture, test or source map is in the tarball — and also why a new runtime data
file would silently be missing until someone installs the package.

---

## Related documents

- [README.md](../README.md) — the product surface and the honest-limitations tables
- [API.md](API.md) — identifiers, error taxonomy, every tool's parameters
- [ARCHITECTURE.md](ARCHITECTURE.md) — sources, layering, the `AuApiClient` contract
- [TOOL-MAPPING.md](TOOL-MAPPING.md) — the registry by category, and the mapping onto sources
- [VERIFICATION.md](VERIFICATION.md) — the live verification log
- [CLAUDE.md](../CLAUDE.md) — canonical behavioural rules
