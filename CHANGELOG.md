# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-04

Initial release.

### The tool surface

- **81 tools registered, 10 advertised.** `ListTools` returns ten entries;
  every other tool is dispatchable by name through `CallTool` and discoverable
  through `discover_tools` → `execute_tool`. Nothing is ever removed from the
  registry to shrink the advertised list, so a client that learned a tool name
  from an earlier version keeps working.
- The ten advertised tools: `legal_research`, `legal_analysis`, `search_law`,
  `get_law_text`, `get_schedules`, `instrument_radar`, `search_decisions`,
  `get_decision_text`, `discover_tools`, `execute_tool`.
- `legal_research` carries the eight chains behind a `task` parameter;
  `legal_analysis` carries the four analysis features behind a `mode`
  parameter. Both are also registered under their own names.

### Commonwealth legislation (Federal Register)

- Name and alias resolution — `CCA`, `ACL`, `FW Act` and `TPA` all resolve —
  with rename annotations that distinguish a renamed Act from a repealed one:
  the *Trade Practices Act 1974* and the *Competition and Consumer Act 2010*
  are the same register id, `C2004A00109`.
- Provision text addressed by AGLC-style references, including the schedule
  prefix Australian law needs: ACL s 18 is `sch 2 s 18` of the CCA, and CCA
  `s 18` is a different provision ("Meetings of Commission").
- Structure (`get_law_tree`, `get_law_system_tree`, `get_schedules`), delegated
  legislation and enabling provisions (`get_three_tier`,
  `get_enabled_instruments`, `get_enabling_acts`, `get_instrument_provisions`),
  batch provision fetch, full-text and faceted search, statistics.
- Point-in-time: compilation lists, historical text by date or compilation id,
  compilation-to-compilation diffs, and per-provision amendment history read
  from the Act's own endnotes.

### Decisions — 18 domains

- One `search_decisions` / `get_decision_text` pair over: cases, constitutional,
  admin_appeals, tax_tribunal, tax_rulings, interpretations, customs,
  competition, workplace, privacy, integrity, public_service, university_rules,
  agency_rules, gazettes, treaties, explanatory and state_law.
- Case law merges NSW Caselaw, the High Court and Queensland Judgments in one
  query; a medium-neutral citation is routed to an exact lookup.
- State and Territory legislation for QLD, TAS, WA, VIC, NT and ACT.

### Analysis

- `verify_citations` — the citation hallucination guard. Checks existence *and*
  content: a real section cited for a proposition it does not contain is
  reported as `CONTENT_MISMATCH`, with the provision the writer actually meant.
- `cite_check` — a citator. Finds later judgments that mention a case and gives
  an honest verdict about what was scanned.
- `applicable_law` — which version of an Act governed conduct on a date, the
  text as it stood then, a diff against today, and the amending Acts'
  application and transitional headings.
- `impact_map` — what an amending Act touched.

### Interfaces

- **stdio MCP server** (`australian-law-mcp`) — the default. Console writers are
  rebound to stderr before the transport connects, so no diagnostic can corrupt
  the JSON-RPC framing.
- **Stateless Streamable HTTP** (`--mode http`) — origin allowlisting, optional
  bearer token, per-IP rate limiting, batch caps and body limits. A non-loopback
  bind requires a token unless unauthenticated remote access is set explicitly.
- **Natural-language CLI** (`australian-law`) — a query router that maps plain
  English to a tool call, one subcommand per tool generated from its schema, an
  interactive REPL, and `explain` to show routing without executing.
- **Setup wizard** (`australian-law-mcp setup`) — writes the server into MCP
  client configs.

### Honesty rules, enforced in code

- A source that could not be reached is never reported as an absence. Blocked
  hosts return `[UPSTREAM_BLOCKED]` with a deep link.
- Every tool result carries a bracket label a caller can branch on:
  `[NOT_FOUND]`, `[UPSTREAM_NO_DATA]`, `[UPSTREAM_BLOCKED]`,
  `[EXTERNAL_API_ERROR]`, `[INVALID_PARAMETER]`, `[CITATION_ERRORS_FOUND]`,
  `[PARTIALLY_VERIFIED]`, `[VERIFIED]`, `[NO_CITATIONS_FOUND]`.
- Chains that run out of deadline return what arrived and mark the rest, rather
  than losing everything to a client timeout.

### Tests

- 1,708 offline tests against recorded fixtures, plus 18 live-gated tests that
  run only with `LIVE=1` and check the real upstreams still answer the shapes
  the parsers expect.
