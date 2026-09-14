# AI-native follow-up implementation validation

Date: 2026-09-10

Status: source-preview implementation ready for review; not a released capability
or a completed lawyer pilot.

## Implemented contract

- Versioned gap, policy, eligibility, task and evidence schemas with stable legal
  target identities and URL normalization that preserves case-sensitive paths and
  query values.
- `plan_research_followup` and `check_research_evidence`, bringing the registry to
  83 tools while retaining the same ten-tool advertised surface.
- Typed source gaps for blocked/missing originals, reported citations, accessible
  and restricted treatment work, partial coverage, amendments, interpretation,
  truncation and chain deadlines. Key successful source-document coverage includes
  HCA, NSW, Queensland, FWC, OAIC, NACC and State-register paths.
- One response-level serialized bounder across registry success/error, direct and
  `execute_tool`, HTTP, CLI and STDIO boundaries. Omitted gaps, tasks or evidence
  force `pending: true`, carry counts, and direct callers to narrower source reruns.
- A project-local Claude Code/Codex companion skill and helper with fresh local
  macOS 15+ / Windows 10/11 (x64) gates (local execution, platform, OS version,
  Aside connection and `repl`), actual Aside capability checks, persistent matter
  policy, budgets, evidence and host-assessment manifests, serial task dispatch,
  immediate session persistence, honest disconnect/stop behavior, explicit matter
  resume, and same-session continuation.
- A preserving `setup-followup` installer for project MCP settings and skills. It
  records an absolute Aside command for desktop PATH differences, resolved in the
  server's own order — the installer's location first
  (`~/.aside/cli/Aside CLI.app/Contents/MacOS/aside` on macOS;
  `%ASIDE_CLI_INSTALL_DIR%\current\aside.exe` if that variable is set, else
  `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`, on Windows), then `aside`
  (`aside.exe` on Windows) on PATH — reads the Windows OS
  version from `os.release()`, writes `.mcp.json` through `JSON.stringify` and
  `.codex/config.toml` as an escaped TOML basic string so a drive-letter path is
  correct on disk, and refuses unsupported/ambiguous config shapes rather than
  rewriting them. The 0600 mode it sets on `.au-law-followup-host.json` has no
  effect on Windows, where NTFS inherits the folder's permissions. The installed
  helper also recognises direct execution when macOS canonicalises `/var` to
  `/private/var` (or another directory symlink) without running on module import.

## Automated validation

All commands completed successfully in the shared worktree:

```text
npm run typecheck
npm test
  109 test files passed, 1 skipped
  2528 tests passed, 18 skipped
npm run build
npm run verify:stdio
  PASS: 10 advertised tools and structured follow-up metadata preserved
python3 .../skill-creator/scripts/quick_validate.py companion/au-law-followup
  Skill is valid
npm pack --dry-run --json
  272 entries; companion skill/helper and built follow-up modules included
git diff --check
  clean
```

The final installed-CLI correction was validated separately without rerunning
the already completed full suite:

```text
npm run typecheck
npx vitest run src/setup.test.ts src/followup-companion.test.ts
  2 test files passed; 15 tests passed
npm run build
npm run verify:stdio
  PASS: 10 advertised tools and structured follow-up metadata preserved
python3 .../skill-creator/scripts/quick_validate.py companion/au-law-followup
  Skill is valid
git diff --check
  clean
```

An exact built-entrypoint smoke installed both project-local clients into a
fresh `au-law-root-review-*` directory under the macOS temporary path. Existing
`.mcp.json` and `.codex/config.toml` entries were preserved, representative
global config hashes were unchanged, and the installed helper returned
`eligible: true` with Aside `repl`, `memory_search`, and `exec`. Its
`init -> status -> stop -> resume-matter -> status` JSON sequence completed with
the remaining budget unchanged at 10 pages, 3 documents, and 300 active seconds.

Regression cases include the Windows x64 eligibility gate and the Linux, WSL,
remote, old-macOS and old-Windows refusal gates; malformed OS versions; stable
and case-sensitive gap identity; oversized single gaps; evidence-only
overflow; combined escaped text/structured omission bounds; direct and
`execute_tool` HTTP paths; chain omission propagation; STDIO propagation; wrong
citation/register/provision/jurisdiction/date/task association; missing body and
locator; OCR and incomplete coverage; seed-versus-later-case citation identity;
typed PDF-summary versus full-HTML source coverage; serial dispatch; route
capability loss; waiting-for-user authorised resume; policy-off rejection;
page/document/active-time charging; idempotent finish; disconnect ownership;
budget exhaustion; stop and explicit same-session matter resume; and preserving
existing Codex/Claude project configuration. The install regression executes the
copied helper through a directory symlink, parses its probe/init/stop/resume/status
JSON, confirms stop/resume preserves the matter budget, and verifies project-local
setup leaves representative global Claude and Codex configuration untouched.

## Live Aside smoke

The local companion probe successfully completed Aside MCP initialize and
`tools/list`; the installed server exposed the observed
`repl(title, code)`, `exec(prompt, session_id?)`, and `memory_search` schemas.
The workflow does not use `memory_search`.

Two authorised benign public reads used only
`https://www.legislation.gov.au/`:

- REPL opened a new dedicated tab, observed title
  `Home Page - Federal Register of Legislation` and the same final URL, and closed
  the tab.
- Exec returned after about 13 seconds with a session id, an explicit `Done`, the
  same observed title, and the same final URL.

No login, private account, unrelated tab, form, download, access challenge or site
mutation was used. The exec result documents this installed build and one call; it
does not establish a general completion or cancellation guarantee. The companion
therefore retains serial ownership for progress-only/session-only responses and
for disconnects until the saved session is explicitly resumed and rechecked.

### Windows, 14 September 2026

On local Windows 11 24H2 (`os.release()` `10.0.26200`, x64) with Aside browser
`1.0.914.1` and CLI `1.26.906.1630`, `setup-followup` resolved the CLI at
`%LOCALAPPDATA%\Aside\CLI\current\aside.exe` with no `--aside-command` given and
recorded that absolute path; the installed helper's probe completed Aside's
`initialize` and `tools/list` and returned `eligible: true`, `platform: "win32"`,
`execution: "local"` with `repl` and `exec`. It accepted the path with Explorer's
"Copy as path" quotes and refused a drive-less path, an unexpanded
`%LOCALAPPDATA%` and a bare name before spawning anything. A matter ran
init → status → stop → resume-matter with its budget preserved. Retrieval on the
same machine, including the publisher's own challenge on AustLII's search
endpoint being reported as a bot-verification page rather than as absence, is
recorded in [the Aside verification note](ASIDE-ROBUSTNESS.md#windows-run).
Document downloads, permission handling and client resume/cancellation on
Windows remain on the pilot list, not recorded here.

## Remaining limitations

- The macOS and Windows lawyer pilots, client restart/reconnection matrix, and
  broad legal-source acceptance set remain outstanding; README and installation
  docs label the feature an unreleased source preview.
- The checker assesses only supplied text and metadata. It does not certify source
  authenticity, publisher provenance, legal validity or the correctness of an AI
  interpretation; treatment, commencement and interpretation remain host-owned
  semantic work.
- Typed successful-response body/truncation gaps cover the key sources named above,
  but not every legacy full-text adapter has been migrated. Those adapters retain
  existing honest text/error output and links.
- WSL, Linux, remote/unknown hosts, macOS before 15 and Windows before 10 remain
  ineligible for every companion route, including host-model tasks; Windows 10/11
  (x64) with Aside 1.0.914.1 or later is eligible on the same terms as macOS 15+.
  Aside ships no Linux browser build, so the fallback is a no-op on Linux and WSL,
  and its Windows installer refuses on ARM64, so there the CLI is not found and
  the probe reports Aside MCP as not connected. Existing law tools remain
  available everywhere and no alternate browser or remote-machine workaround is
  provided.
