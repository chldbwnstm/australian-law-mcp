# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **An opt-in browser fallback for the sources whose publisher blocks this server.**
  An outside tester asked Claude Desktop Chat for recent Federal Court decisions; the
  server cannot reach `judgments.fedcourt.gov.au`, so Chat answered from its own web
  search instead and the result read as though it had come from here. The fallback the
  project already had could not run — it lives in a project skill, and Chat loads
  extensions only. This one lives in the server, so every host has it. When it is on,
  a blocked lookup is finished by driving Aside, the user's own browser on their Mac,
  and what comes back is marked as browser-retrieved rather than publisher-supplied.
  It is **off by default**, it is a no-op on a machine without Aside — the answer is
  the same `[UPSTREAM_BLOCKED]` note and deep link as before — and because it drives a
  browser carrying the user's logged-in sessions it may only be pointed at the blocked
  legal-source domains, a set derived from the blocked rows of the upstream-host table
  and not widenable by any tool argument, question or URL found in a document.
- **Settings for it that a Claude Desktop user can actually reach.** The generated
  MCPB manifest now carries a `user_config` block, so the app renders a switch
  (“Finish blocked legal sources using the Aside browser”, off) and an optional Aside
  CLI path under **Settings → Extensions → Australian Law**, and passes them to the
  server as `AU_LAW_ASIDE` and `AU_LAW_ASIDE_COMMAND`. A Chat user has no config file
  to edit, so a capability not declared there does not exist for them. Both are
  derived from one table with the `env` placeholders, and each option must declare a
  default: the app substitutes nothing for a key with neither a stored value nor a
  default, which would hand the server the literal text `${user_config.aside_command}`
  as a path. The CLI and Codex hosts set the same two variables in the environment;
  `.env.example` documents them.

### Fixed

- **A Federal Court search no longer comes back as three other courts' decisions.**
  `sourcesFor()` in `search_cases` recognised court tokens beginning `NSW` or `HCA`
  and the Queensland set, and anything else fell through to the default fan-out — so
  `court: "FCA"` searched NSW Caselaw, the High Court and Queensland and returned
  their hits as the answer to a Federal Court question, and `jurisdiction: "Cth",
  court: "FCA"` quietly became the High Court alone. A court token this server cannot
  reach is now reported as the blocked source it is, with its deep links, instead of
  being answered with a different court's material.

## [1.0.1] - 2026-09-12

First release with a downloadable installer. `au-law-mcp-1.0.1.mcpb` is attached
to the GitHub release, so installing into the Claude desktop app no longer needs
a clone, a terminal or Node.js — 1.0.0 was tagged but never distributed, and the
two install bugs below meant the routes it documented did not work.

### Added

- The desktop extension bundle is published on the Releases page. `npm run
  build:mcpb` produces the identical file, and starts the server inside the
  bundle to check its tool list before the build finishes.

### Fixed

- **The setup wizard now writes a launch command it has verified.** It wrote
  `{"command":"npx","args":["-y","au-law-mcp"]}` into every client config
  unconditionally, and that package has never been published —
  `registry.npmjs.org/au-law-mcp` answers 404 — so the client it had just
  configured failed with "server disconnected", an error naming nothing the user
  could act on. The wizard now resolves the absolute entry point it is itself
  running from (`process.execPath` plus the built `index.js` beside it), checks
  that file on disk, and writes that. `npx -y au-law-mcp` is written only when
  asked for with `au-law-mcp setup --npx` **and** the registry answers for the
  package at the moment setup runs. If neither form can be established the
  wizard writes nothing and says which step to take, rather than leaving a
  plausible-looking config behind.
- Reject malformed Federal Register collection responses with `PARSE_ERROR` before
  they can become an empty search, a cached zero count, or a false `LAW_NOT_FOUND`.
- Apply each host's minimum request interval to retry attempts as well as initial
  requests. Cancelled callers now leave the host-slot wait immediately.
- Buffer complete MCP stdio lines when verifying desktop bundles, including responses
  split across pipe chunks or UTF-8 characters. Wait for process closure before
  cleaning up on timeout or failure, and detect stray stdout logging.

### Added

- An unreleased local macOS 15+ Aside companion preview: versioned structured
  research gaps/evidence/tasks, stateless planning and evidence-check tools,
  project-local Codex/Claude Code setup, fresh Aside capability gates, matter
  budgets, resumable task/session checkpoints, and honest stop/disconnect state.
- Typed missing-original, incomplete-treatment, document-interpretation,
  truncation and chain-deadline follow-up metadata preserved through direct,
  meta-tool, aggregate, MCP transport and CLI JSON paths.
- Regression coverage for malformed upstream collections, retry spacing, cancellation,
  and the bundle verifier's child-process lifecycle and response framing.
- `npm run verify:stdio` checks the built server's handshake, version, and advertised
  schemas. CI runs it after building on both Ubuntu and Windows with Node 20.19 and 22.

### Changed

- **Install documentation is organised by host, not by tab.** It used to split
  the Claude desktop app's **Chat** and **Code** tabs into two different
  installs, so a reader who wanted both and followed the instructions precisely
  registered this server twice — once as the `.mcpb` extension (`Australian Law`,
  recorded as `local.mcpb.chldbwnstm.au-law-mcp`) and once as `australian-law` in
  `~/.claude.json`. That is the duplicate the first outside
  tester hit, and the two entries do not even run the same code: one is the build
  packed inside the bundle, the other is `build/index.js` in a checkout. The
  boundary that matters is the host. One `.mcpb` install covers the desktop app's
  ordinary chats *and* its local Code sessions; `claude` in a terminal, an IDE
  session, Codex and every other client is a separate host with one registration
  of its own. `README.md`, `docs/TRY-IT.md`, `docs/PILOT-ROLLOUT.md` and
  `docs/START-HERE.html` now say so, state what having both costs, and link
  `INSTALL.md` for removal instead of repeating the steps. `README.md` no longer
  tells a desktop-app reader to open the Code tab or to have an agent run
  `claude mcp add`.
- Dropped from the trial documents: the Streamable HTTP "hosted connection"
  walkthrough in `docs/TRY-IT.md` and the hosted-endpoint and Codex-plugin planning in
  `docs/PILOT-ROLLOUT.md`. No endpoint, OAuth service or plugin exists, and
  nothing in the tree deploys one. `docs/PILOT-ROLLOUT.md` keeps what a pilot
  actually needs: build the pack, send it, and do not ask a Claude Desktop tester
  to run a terminal command for the law server.
- `docs/handoff/NEXT-STEPS.md` records two things for the owner: that `v1.0.0`
  points at a commit **14 behind `main`** — so a release cut from it would ship the
  tree from before the install-bug fixes, and before `npm run build:mcpb` existed —
  and the tester's untested hypothesis that renaming the bundle's server to
  `australian-law` might merge the two registrations, with the argument against
  acting on it.
- Counts corrected against a run on 2026-09-12: **2,612** offline tests (was 2,498
  in `README.md`) and **83** registered tools (was 81 in the handoff note).
- **The documented install routes are now the ones that exist.** Nothing about
  this project is published: there is no `au-law-mcp` package on the npm
  registry and the repository has no releases. So the README's npm version badge
  and its "the published npm `au-law-mcp` v1.0.0" sentence are gone, INSTALL.md
  and `docs/TRY-IT.md` tell the reader to build the Claude Desktop bundle with
  `npm run build:mcpb` instead of downloading a release artefact that does not
  exist, and each file names the route that works today alongside the ones that
  do not. `docs/handoff/NEXT-STEPS.md` records what publishing would take and
  which wording then goes back.

## [1.0.0] — 2026-09-05

First stable release **of the source tree**: it was tagged `v1.0.0`, not
distributed. Nothing was pushed to the npm registry and no GitHub release was
created, so `npx -y au-law-mcp` and any `.mcpb` download link do not resolve.
Install from source — see [INSTALL.md](INSTALL.md).

The tool surface is unchanged from 0.1.0 — 81 tools
registered, 10 advertised — and everything below is a correctness fix, a rename,
or a test that keeps a fixed defect fixed. Six adversarial review rounds and two
live-verification passes closed 97 confirmed defects; the ones a user would
notice are listed here.

### Changed

- **The npm package name is now `au-law-mcp`.** The unscoped name
  `australian-law-mcp` on the npm registry belongs to an unrelated project, so
  `npx -y australian-law-mcp` installed somebody else's package. `au-law-mcp` is
  the name this project would publish under, and nothing has been published
  under it: clone the repository, `npm run build`, and run
  `node build/index.js setup`, which writes the absolute launch command it has
  just verified. The GitHub repository
  and the project title stay `australian-law-mcp`, the CLI binary stays
  `australian-law`, and the key the setup wizard writes into client configs
  stays `australian-law` — an existing install keeps working untouched.
- **The provision grammar was rebuilt against the statute book rather than
  against the examples at hand.** Every provision label in five recorded Federal
  Register tables of contents — the *Corporations Act 2001*, the *Income Tax
  Assessment Act 1997*, the *Crimes Act 1914*, the *Commonwealth of Australia
  Constitution Act* and the *Competition and Consumer Act 2010* — must now
  parse, round-trip, address its own label and no other, and survive being
  re-cited the way writers cite (plural, dashed pairs, `and`/`to`/comma joins).
  The two letter classes in the grammar are set from the population rather than
  a sample: the tables of contents of all 1,177 in-force principal Commonwealth
  Acts, 126,207 labels. The narrower class the previous release used silently
  dropped 29 real units, among them *Migration Act* Subdivisions AI, AJ and AL.
- **The compound and lettered forms the register actually prints are now
  citations, not parse failures** — `Part 2A.1`, `Part 2F.1A`,
  `Subdivision 83A-C`, `Part IAABA`, and untitled bare-number labels such as the
  Constitution's `86.`
- **The deadline tests no longer pace off the wall clock.** They virtualise the
  one timer the deadline machinery uses, so the suite is deterministic under CPU
  load and runs in about 6 seconds instead of 30. No production behaviour
  changed.

### Fixed

- **`ACL s 18` returns schedule 2 everywhere, enforced rather than promised.**
  The Australian Consumer Law is schedule 2 of the *Competition and Consumer Act
  2010*, and that Act's own body has a different s 18 (*Meetings of
  Commission*). The alias-to-schedule rewrite now sits at one choke point, and a
  registry-wide guard drives every registered tool that takes a law and a
  provision with a schedule-carrying alias and asserts what was **served**:
  a text-serving tool must return the schedule provision's words and neither
  marker of the body provision. The in-scope list is exact, so a tool the guard
  cannot drive fails the build rather than being skipped.
  `get_instrument_provisions` and `get_historical_law` really were serving the
  body's s 18 under an ACL request, and no longer do.
- **The deep links carry the schedule too, not just a warning beside them.**
  `get_external_links` sent AustLII the bare reference — a search for
  "...Act 2010 s 18", pointed at the body provision — and built
  consolidated-act section URLs such as `/s18.html`, which *is* the body
  provision's page, for schedule references. Every address now carries `sch 2`,
  no section page is built from a slug for a schedule provision, and a lettered
  section keeps its letters (`s 10AA` was building `/s10.html`, a different real
  section).
- **The citation scanner no longer invents or truncates provision numbers.**
  A match continued by more number is dropped whole rather than served as its
  front half, so `s 8AAZLGA` is no longer read as `s 8AAZL` and `Part 2D.1` no
  longer becomes `pt 2D`. Bare lettered structural units (`Subdivision C`, `CA`,
  `DA`) are recognised instead of being dropped in silence, two ranges
  fabricated out of real headings are gone, and `sub-s 5(2)` no longer collapses
  to `sub-s (5)`, which is a different provision.
- **A refused list member no longer takes the rest of the list with it.**
  `ss 51AC, 52 and 53` yielded one citation and no record of the other two, so
  `verify_citations` printed `[VERIFIED]` — "1 checked of 1 found" — over a
  sentence naming three sections. A member the scanner will not read is now
  reported as an unread span and the scan continues to the true end of the list,
  including everything past the list-length ceiling. The order of preference is
  explicit: an honest "unread" beats a silent drop, and both beat a fabricated
  citation.
- **`instrument_radar` only suggests provisions that parse.** `canonical()`
  checked that the register's own string parsed and then emitted a reformatted
  version unchecked, so `para 1020F(1)(c)` came back as the suggestion
  `para (1020F)`, which the next call rejects. A formatted reference that does
  not itself parse is never suggested.
- **`setup` resolves client-config paths for the platform it is writing for**
  rather than for the host running it, which turned a macOS path into a Windows
  one when the two disagreed.
- **An upstream that failed is never reported as an absence.** This is the rule
  the project exists to keep, and this release closes the paths that broke it: a
  blocked or silent source returns `[UPSTREAM_BLOCKED]` or `[UPSTREAM_NO_DATA]`
  — with a deep link where one exists — and only a source that authoritatively
  covers the record may answer `[NOT_FOUND]`.

### Added

- **A Claude Desktop MCP Bundle** (`npm run build:mcpb` →
  `release/au-law-mcp-<version>.mcpb`), so the server installs by opening one
  file — no terminal, no `npx` and no Node.js on the user's machine, because
  Claude for macOS and Windows ships its own runtime. The manifest is generated
  from `package.json` and from `V3_EXPOSED`, never hand-written, and the build
  fails unless the packed bundle unpacks, starts and answers `tools/list` with
  exactly the ten tools it advertises.
- **A real-corpus grammar harness** (`src/lib/section-ref.corpus.test.ts`) that
  reads recorded Federal Register tables of contents verbatim out of
  `__fixtures__/` and asserts the four properties above over every label in
  them. Dropping another recorded table of contents into that directory extends
  the corpus with no code change. Run against the previous grammar it reports
  97.13% parse, 2 labels resolving to the wrong provision and 454 scanned wrong
  — the regression class it exists to catch.
- **The release metadata npm expects** — `repository`, `homepage` and `bugs` —
  and a `prepublishOnly` script that runs the typecheck, the full test suite and
  a clean build, so a published tarball can never carry a stale or empty
  `build/`.
- The offline suite is now more than 2,400 tests across 105 files and still
  touches no network; the 18 live-gated tests run only with `LIVE=1`.

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
