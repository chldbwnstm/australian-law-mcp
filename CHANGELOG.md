# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] - 2026-09-16

### Fixed

- Aside now recognises Victorian judgment bodies headed `REASONS` or
  `HIS HONOUR:` / `HER HONOUR:` inside a publisher document container. In
  [issue #1](https://github.com/chldbwnstm/australian-law-mcp/issues/1), the
  browser could retrieve `[2024] VCAT 199` and `[1999] VSC 110`, but the parser
  rejected their genuine numbered reasons as an unavailable source. Exact
  citation checks, numbered-body checks and missing-text follow-up remain in
  place; navigation is excluded inside document containers too. Recorded
  original pages cover both retrieval routes, and the live Aside check now
  requires these two judgments to return reasons.
- CI path-rejection tests explicitly simulate a supported Windows host, and
  the Git/CLI pipeline integration suite allows its bounded worker budgets
  plus Git overhead on Windows runners.

### Changed

- New issue reports require the operating system and Aside activation status.
  Blank issue reports are disabled so these diagnostic fields are included.

## [1.0.5] - 2026-09-14

Aside shipped its Windows build on 14 September 2026 (browser 1.0.914.1, CLI
1.26.906.1630). This change makes the browser fallback and the `au-law-followup`
companion run on Windows on the same terms as macOS, and makes the desktop
extension's switch mean the same thing on both.

### Added

- **The Aside browser fallback runs on Windows 10/11 (x64).** The server's
  platform gate accepts `win32` alongside `darwin`; Linux and WSL (which reports
  `linux`) keep the fallback as a documented no-op, because Aside ships no
  browser there. On Windows the CLI is resolved in the same order as on macOS —
  `AU_LAW_ASIDE_COMMAND`, then the installer's location
  (`%ASIDE_CLI_INSTALL_DIR%\current\aside.exe` if that variable is set, else
  `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`, the junction `install.ps1`
  keeps at the active version), then `aside.exe` in each `;`-separated PATH
  entry, unwrapped from the quotes such an entry may carry and only a real
  `.exe`, since Node cannot spawn a `.cmd` shim without a shell. A relative PATH
  entry is skipped on both platforms: a command that resolves against the
  working directory is not one to spawn. A configured path is accepted in the
  host's own form (a drive-letter or UNC path, surrounding quotes tolerated);
  `%LOCALAPPDATA%` and `~` are refused with a message saying so, because neither
  this server nor Claude Desktop expands them.
- **The `au-law-followup` companion is eligible on Windows.** `plan_research_followup`,
  `setup-followup` and the installed helper's `probe` accept a local `win32`
  host whose `os.release()` major is 10 or more (Windows 10 and 11 — Windows 11
  reports `10.0.<build>`) with Aside MCP connected and `repl` listed; the OS
  floor table is a single export in `src/lib/research-followup.ts`, and the
  helper's copy — it is installed into user projects and cannot import the
  package — is held in lock-step by a test. On Windows `setup-followup` reads the
  version from `os.release()`, the NT version; macOS still reads
  `sw_vers -productVersion`, because `os.release()` there is the Darwin kernel
  version. Its `--aside-command` default now resolves the CLI in the server's own
  order on both platforms — the standard install location first, then `aside` on
  PATH — so the command it records is the one the extension switch would drive,
  and a Windows desktop app that has not seen `install.ps1`'s user-PATH edit
  still finds it. A recorded path that does not exist on the host now running the
  probe is re-derived for that host, so a matter checkpoint moved between a Mac
  and a Windows PC probes the local CLI instead of the other platform's. Every
  helper command that reads JSON from stdin also accepts `--input FILE`, for
  a stock Windows PowerShell 5.1 that re-encodes a piped payload.
- **The desktop extension's switch works on Windows.** The MCPB manifest's
  switch is titled "Finish blocked legal sources using the Aside browser" with
  no "(Mac only)" suffix, its description names both platforms, and the CLI
  path field shows both example paths. `npm run verify:mcpb` (run by
  `build:mcpb`) now starts the unpacked bundle with the switch on and a
  deliberately missing CLI path, and requires the `[UPSTREAM_BLOCKED]` note
  that names that path — proving the switch reaches the server, on whichever
  platform builds the bundle, without a browser.
- `npm run verify:aside` runs on Windows x64 as well as macOS, records the CLI
  path and version, the NT release and whether the browser was running, and
  refuses ARM64 Windows (Aside's installer does). `npm run verify:stdio` plans
  follow-up for a macOS and a Windows probe and keeps a Linux probe on standard
  research.

### Changed

- The CLI child's environment is whitelisted per platform: the POSIX keys as
  before; on Windows the system root, the AppData and profile roots, TEMP/TMP,
  PATH, PATHEXT, COMSPEC and USERNAME, matched case-insensitively because a
  Windows `process.env` is. Never this server's own configuration.
- Cancellation and timeouts on Windows kill the CLI's process tree with
  `taskkill /T /F` while the CLI is alive, then fall back to `TerminateProcess`;
  measured on 14 September 2026 the CLI's only child during a `repl` call is its
  console host and the browser is never its child (with the browser closed the
  CLI exits rather than launching it), so the tree kill cannot reach the
  user's browser. The Unix process-group kill is unchanged.
- The envelope reader strips a leading byte-order mark before looking for the
  fence, and the framing test records the Windows CLI's opening line.
- Recorded fixtures under `src/**/__fixtures__/` are marked `-text` in
  `.gitattributes`, so a Windows checkout tests the recorded bytes rather than
  a CRLF-rewritten copy. An existing clone made with `core.autocrlf=true` holds
  the rewritten copies: run `git checkout -- src` once after pulling, or the
  next `git add -A` commits them back.
- A configured CLI path is unwrapped from surrounding quotes on both platforms
  (a path pasted from Explorer's "Copy as path", or shown by a shell, arrives
  with them), and on Windows a `.cmd`, `.bat` or `.ps1` wrapper is refused up
  front with the reason naming `aside.exe`, rather than accepted and then
  failing to spawn. A synchronous spawn refusal — which is how Node reports a
  batch file without a shell — is now reported as a CLI that could not be
  started, like any other, instead of surfacing as a bare `spawn EINVAL`.
- A relative `ASIDE_CLI_INSTALL_DIR` or `LOCALAPPDATA` is treated as unset
  rather than producing a "standard" path that resolves against the working
  directory, and relative `PATH` entries are skipped on both platforms.
- **The bot-verification detector reads the challenge's markup, not its
  wording.** Cloudflare serves its challenge page in the viewer's own language,
  and the English headings the detector matched are absent from a localised one.
  It now also matches the challenge-orchestration markup (`_cf_chl_opt`,
  `cf-chl-widget`) that is identical in every language, and a real localised
  challenge page is recorded as a fixture so the rule is tested against one.

- Docs: README, INSTALL, `.env.example`, TRY-IT, DEVELOPMENT, API, ARCHITECTURE,
  VERIFICATION, the follow-up design and validation notes, NOTICE and the
  companion skill describe macOS 15+ and Windows 10/11 (x64) parity, the Windows
  install (`install.ps1`, run as a file), PowerShell forms of the registration
  and verification commands, and the Linux/WSL no-op. Superseded: the 1.0.4 note
  that enforced macOS eligibility before probing Aside.

### Fixed

- The companion helper concatenates piped stdin as bytes and decodes it once,
  and strips a leading byte-order mark. A multi-byte character that straddled
  two pipe chunks — in a saved plan, or in recorded evidence carrying a quoted
  passage — was previously replaced. It also refuses `%USERPROFILE%` as a matter
  root, not only `/` and the home directory, and retries an atomic checkpoint
  write that Windows briefly refuses rather than failing after Aside work has
  already been charged.

### Verified

A live Windows run is recorded in
[the Aside verification note](docs/ASIDE-ROBUSTNESS.md#windows-run) with its
[machine-readable report](docs/ASIDE-LIVE-REPORT-WINDOWS.json): 22 MCP calls on
Windows 11 24H2 returning nine judgments and ten scoped searches, one PDF linked
with its body pending, one empty query and one unavailable address kept
unresolved.

The ten search calls succeeded only after a person passed Cloudflare's
interactive check once in the browser: AustLII's search endpoint served that
challenge to the freshly installed profile, and a later run two hours on was
challenged again while the judgment retrievals in it still succeeded. The server
reported every challenged call as a bot-verification page, never as an empty
result, and nothing in it attempts to satisfy such a check. Judgment pages were
not challenged in either run.

## [1.0.4] - 2026-09-13

Robustness work on the browser fallback introduced in 1.0.2, after a tester
reading real judgments through it found the places where it could still hand
back something that was not the document.

### Fixed

- Harden automatic Aside case research with exact heading/citation checks,
  publisher URL validation, court and jurisdiction filtering, duplicate removal,
  and AustLII page offsets. Search redirects must preserve the requested query
  and scope; incomplete results keep a structured coverage gap.
- Wait through browser challenges and incomplete page loads in a dedicated tab,
  force `--host local`, validate the final URL, and require an unambiguous JSON
  snapshot with load and cleanup status. Error pages and CLI diagnostics cannot
  become judgment reasons; judgments may legitimately quote challenge wording.
- Serialize browser work per server process with bounded queuing, cancellation,
  deadlines, response byte accounting and subprocess cleanup. Cancellation,
  exhausted budgets, queue failures and unconfirmed cleanup stop source retries.
- Preserve AustLII paragraph numbering and older WA judgment anchors. A matching
  PDF viewer returns its original PDF link as a document-body gap. Full responses
  shortened at the renderer or transport retain their citation and source URL.
- Accept citation pinpoints written as `at [38]`, including dotted court tokens.
  Distinguish an unsuccessful browser attempt from a source never requested.

### Added

- Recorded publisher fixtures, actual child-process lifecycle tests, concurrent
  queue tests, adversarial page/protocol tests, and a complete document-to-plan-
  to-evidence regression path. Normal tests do not open Aside or use the network.
- `npm run verify:aside`, gated by `LIVE_ASIDE=1 AU_LAW_ASIDE=true`, exercises the
  built MCP server on a local Mac and saves individual JSON-RPC responses plus a
  report. See [the verification record](docs/ASIDE-ROBUSTNESS.md) for observed
  retrievals, PDF-only pages, empty queries and unresolved lookups.

### Also in this release

- Enforce macOS eligibility before probing or launching Aside, including when a
  CLI path is configured. Use macOS path rules in the probe so its simulated
  Mac fixtures also run correctly in Windows CI.
- Build Federal Court Full Court judgment links under `fca/full`, retaining
  `fcafc` in the filename. `[2020] FCAFC 130` previously went to the nonexistent
  `fcafc/single` path; ordinary FCA links still use `fca/single`.
- Reject publisher error pages, including long 404 pages full of navigation,
  before returning browser results as judgment reasons. Reject short shells
  and pages without the requested citation before trying the next permitted
  judgment URL. Unsuccessful retrieval remains `[UPSTREAM_BLOCKED]`, not a
  finding that the case does not exist.
- Extract statute content claims from leading pinpoints, markdown emphasis,
  and wording such as "Under CCA s 18, a corporation must not engage in
  misleading or deceptive conduct." A later, different claim about an already
  seen section is checked separately rather than discarded as a duplicate.
- Rank alternative headings using word coverage as well as character similarity.
  With the full CCA table of contents, a long misleading-conduct sentence could
  otherwise prefer the consumer-data offence in s 56BN over ACL sch 2 s 18.
  An unmentioned qualifier such as "offence" now reduces that candidate's rank.
- Resolve `s 82 of the Act` as well as `the Act s 82` within a paragraph,
  respecting both LF and Windows CRLF paragraph breaks. Resolving the Act does
  not itself establish the provision's application to schedule claims.
- Keep existence-only statute checks `PARTIALLY_VERIFIED` and label their scope.
  A legal proposition whose topic matches a heading remains unverified against
  the provision's body. The tool description and README now explain this scope.

### Verification correction

- The v1.0.3 release note claimed that `[2020] FCAFC 130` returned 93,916
  characters in 1.7 seconds. That claim did not establish a working
  `get_case_text(citation="[2020] FCAFC 130")` path in the released version:
  its URL builder and regression test both used the wrong Full Court directory.
  Treat that timing and character count as unsubstantiated validation of the
  released tool. The v1.0.3 installer does not contain the fixes above.

## [1.0.3] - 2026-09-12

### Fixed

- **A bot-verification page is no longer returned as though it were the
  document.** An outside tester driving Aside at AustLII got Cloudflare's
  interstitial twice, with Ray IDs, where the same URL fetched here returned the
  judgment — so a browser does not always walk through the gate, and what comes
  back has to be checked rather than assumed. The bridge checked nothing: an
  interstitial would have been handed to the caller as the reasons, which is the
  worst form of this project's oldest failure, because the result reads like a
  retrieved page and nothing downstream flags it. The snippet now waits a gate
  out in the browser — an interstitial replaces itself once its script finishes,
  so the difference is often a few seconds of patience — and a page still
  showing one is reported as a blocked source with its link, never as content.

## [1.0.2] - 2026-09-12

Adds the browser fallback, and makes it reachable from Claude Desktop Chat —
where the project's existing Aside follow-up could never run, because that lives
in a project skill and Chat loads extensions only.

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
