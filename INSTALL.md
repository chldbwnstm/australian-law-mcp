# Install Australian Law

## Pick one route per machine

Choose by the **host** you run the tools in, not by the surface you use them on.
Chat and the desktop Code tab are one host; the terminal `claude` CLI is another.

| You use… | Install via | Covers |
|---|---|---|
| Claude **Desktop app** (Chat and/or Code) | the `.mcpb` bundle → **Settings → Extensions** | Chat **and** the local Code tab |
| Claude Code **CLI / IDE**, no desktop app | `claude mcp add --transport stdio --scope user …` | terminal and IDE sessions |
| **Codex** | `codex mcp add …` | Codex |

The desktop app injects installed extensions into local Code sessions. So
installing the `.mcpb` **and** running `claude mcp add` on the same machine
registers the same server twice — it turns up as both `Australian Law` (the
extension) and `australian-law` (the CLI entry). The terminal `claude` CLI and
IDE sessions read `~/.claude.json` and do not see installed extensions, which is
why a machine with no desktop app needs the second row.

Pick one row and stop there. The `.mcpb` route is the one that has worked most
reliably in practice, and it needs no agent and no terminal once you have the
file.

## Route 1 — Claude Desktop app: install the `.mcpb` bundle

### Get the file

Download `au-law-mcp-1.0.6.mcpb` (about 4 MB) from the
[latest release](https://github.com/chldbwnstm/australian-law-mcp/releases/latest).
That is the whole step — no clone, no terminal, no Node.

Someone may have sent you the file already; it is the same bundle.

To build it yourself instead:

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp
npm ci --ignore-scripts
npm run build:mcpb          # → release/au-law-mcp-1.0.6.mcpb
```

The build unpacks the bundle, starts the server inside it and checks that it
advertises the expected tools before it finishes, so a file that appears has
already been proved to run. The released file is built the same way.

### Install it

Open the `.mcpb`; Claude Desktop installs it by double-click. If that shows no
dialog, use **Settings → Extensions → Advanced settings → Install Extension…**
and select the same file. Restart the app.

It installs under the display name **Australian Law** and covers both Chat and
local Code sessions. Do not also run `claude mcp add` on this machine.

Handing the file to someone who is not going to build it is covered in
[TRY-IT.md](docs/TRY-IT.md).

### Aside browser settings

Open **Settings → Extensions → Australian Law**. There is a switch,
**“Finish blocked legal sources using the Aside browser”**, and an optional
**Aside CLI path** beside it.

It is **off**, and leaving it off is the supported default. Turned on, on a Mac
(macOS 15 or later) or a Windows PC (Windows 10/11, x64) with
[Aside](https://docs.aside.com/help/get-started) and its command-line tool
installed, the server may finish a lookup a publisher blocks it from making —
the Federal Court's judgment site, AustLII — by driving that browser and the
sessions it is already signed in to. It is confined to those blocked
legal-source domains, and it does nothing at all on a machine without Aside.
Aside ships no Linux browser build, so on Linux and WSL the switch is a no-op.
The trade is set out in the
[README](README.md#optional-finishing-a-blocked-source-in-your-own-browser);
read it before switching this on for someone else.

The command-line tool is a separate install on both platforms. On macOS:
`curl -fsSL https://releases.aside.com/install.sh | bash`. On Windows, install
the browser from <https://aside.com/api/download/windows> (x64; the installer
is signed by AT YOUR SIDE INC), then download
<https://releases.aside.com/install.ps1> and run it as a file — it refuses to
run piped. It places `aside.exe` at `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`
and adds that folder to your user PATH; apps started before it ran — Claude
Desktop, an open terminal — must be restarted to see the PATH change, although
the server finds that standard location without it.

Fill in the path only if Aside is at neither the standard location —
`~/.aside/cli/Aside CLI.app/Contents/MacOS/aside` on macOS;
`%LOCALAPPDATA%\Aside\CLI\current\aside.exe` on Windows, or
`%ASIDE_CLI_INSTALL_DIR%\current\aside.exe` if you set that variable when
installing — nor on PATH; blank means "find it". If you do fill it in, type the
full path in your OS's own form, with the drive letter on Windows:
`C:\Users\you\AppData\Local\Aside\CLI\current\aside.exe`. Neither the extension
nor the server expands `%LOCALAPPDATA%` or `~`, and a path that does not exist
is reported as exactly that — "points at …, which does not exist" — never as
Aside being uninstalled.

The CLI and Codex hosts (Routes 2 and 3) have no settings UI. There the same two
settings are the environment variables `AU_LAW_ASIDE` and
`AU_LAW_ASIDE_COMMAND` — see [`.env.example`](.env.example).

### Jev settings (unreleased)

These settings are available in a bundle built from the current checkout;
the published **1.0.6** bundle does not include them yet.

In **Settings → Extensions → Australian Law**:

- **Use Jev** — off by default. Turn on to order case-law keyword search results
  by estimated relevance, including result links retrieved through Aside.
- **TypeSafe API key** — optional, masked input. Get your own key from the
  [TypeSafe dashboard](https://console.typesafe.ai/). The key is used only while
  **Use Jev** is on; the host handles it as a sensitive extension setting.

The local MCP process sends the search query and displayed results' metadata
(titles, citations, court/date, catchwords and snippets) directly to TypeSafe.
This uses your TypeSafe account's allowance. It sends no judgment bodies or
conversation history. Jev only reorders the displayed page: all its results,
identifiers, source links and coverage limitations are retained. Exact-citation
lookups and source verification are unchanged.

If the key is missing or invalid, the service fails, or evaluation takes more
than five seconds, the search returns its original order with a short note.
Turning the switch off stops evaluations even when a key is saved.
Save the settings and restart the extension if the host requests it.

For a Claude Code CLI or other client registered from a checkout, pass
`AU_LAW_JEV=true` and `TYPESAFE_API_KEY` in the MCP server's environment.
These settings do not require Aside; Aside is needed only for browser retrieval.

## Route 2 — Claude Code CLI or IDE, no desktop app

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp
npm ci --ignore-scripts
npm run build
npm run verify:stdio
claude mcp add --transport stdio --scope user australian-law -- "$(command -v node)" "$PWD/build/index.js"
```

On Windows run the same steps from PowerShell; the last line becomes:

```powershell
claude mcp add --transport stdio --scope user australian-law -- "$((Get-Command node).Source)" "$PWD\build\index.js"
```

Keep the checkout somewhere permanent — the registered entry points at
`build/index.js` by absolute path. User scope makes it available across projects.
No legal-data API key is needed.

## Route 3 — Codex

Codex is a separate host with its own configuration, so it needs its own
registration even if you have already installed the extension.

```bash
codex mcp add australian-law -- "$(command -v node)" "$PWD/build/index.js"
```

```powershell
codex mcp add australian-law -- "$((Get-Command node).Source)" "$PWD\build\index.js"
```

Run it from the same built checkout as route 2, and respect `CODEX_HOME` if you
have it set.

## Install by asking an agent

These routes need an agent that can run commands and change local configuration.
For ordinary Claude Chat, install the bundle yourself as in route 1.

### Claude Desktop app

In a **local** session, paste:

> Install https://github.com/chldbwnstm/australian-law-mcp in my Claude Desktop
> app using the .mcpb bundle so it works in both Chat and Code. Follow INSTALL.md.
> Do not also register it with `claude mcp add`. Preserve my settings and verify
> it works.

### Codex

In a **local session**, paste:

> Install https://github.com/chldbwnstm/australian-law-mcp as a local MCP server
> in my Codex desktop app. Follow INSTALL.md in that repository. Handle the setup
> for me, preserve my existing settings, and verify that the server works. Tell me
> if I need to restart the app. I do not want to run terminal commands myself.

The repository must be accessible to your account. If it is private, the owner
must grant access first. The app may ask for permission to perform installation.

## What is and is not available

The desktop bundle is a download; everything else starts from a checkout:

| Route | Status |
|---|---|
| `au-law-mcp-1.0.6.mcpb` from [Releases](https://github.com/chldbwnstm/australian-law-mcp/releases/latest), installed through **Settings → Extensions** | **Works.** Download it, or rebuild it with `npm run build:mcpb`. Route 1. |
| Clone, `npm ci --ignore-scripts`, `npm run build`, register `build/index.js` with `claude mcp add` or `codex mcp add` | **Works.** Routes 2 and 3. |
| `npx -y au-law-mcp` | **Does not resolve.** `registry.npmjs.org/au-law-mcp` answers 404 — the package has never been published. A client config naming it fails with "server disconnected", so do not write it into anyone's configuration. |

The npm route turns on the day the package is published. Until then every route
above starts either from the released bundle or from a checkout.

## Instructions for the installing agent

1. Check repository access, operating system, which host you are installing into
   and available runtimes. Read `package.json` for the required Node.js version.
   Do not assume Node or npm is installed just because the desktop app is
   installed. If a runtime is missing, arrange its installation using a supported
   method for that operating system, respecting machine policy and any required
   OS approval.
2. Keep the server in a persistent user-owned directory. Do not register a path
   inside a temporary folder or an agent worktree that may be removed. Clone or
   copy the project there without replacing unrelated user files. Record the revision.
3. Run `npm ci --ignore-scripts`, then `npm run build` in that directory. Dependencies
   are supplied by the lockfile. No legal-data API key is needed.
4. Run `npm run verify:stdio`. Verify the version and advertised tools before
   changing app configuration.
5. When you write a STDIO entry — routes 2 and 3, not the bundle — call it
   `australian-law` and use absolute paths to the Node executable and
   `build/index.js`, so the app does not depend on a shell PATH or a working
   directory. Keep every unrelated MCP server and setting intact. Back up an
   existing configuration file before editing it.

   `<absolute-node> <absolute-build/index.js> setup` writes exactly that entry
   into whichever detected client configs you pick from its list, merging rather
   than replacing. It resolves the absolute entry point it is itself running from
   and checks it on disk before writing, and it writes nothing if that check
   fails. It uses `npx -y au-law-mcp` only when asked with `--npx` **and** the
   registry answers for the package, which it does not today. Do not pick its
   **Claude Desktop** target on a machine where the extension is installed: that
   is a second registration of the same server.
6. For Codex, use its available MCP management command when possible:

   ```text
   codex mcp add australian-law -- <absolute-node-executable> <absolute-build/index.js>
   ```

   If that command is unavailable, merge the equivalent `mcp_servers.australian-law`
   entry into the active Codex host's configuration. Respect `CODEX_HOME` if configured.
   Do not create duplicate TOML tables or accidentally register the server in a cloud
   environment instead of the user's local desktop host.
7. Before registering with any Claude host, check both locations:

   - `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows) →
     `mcpServers["australian-law"]`
   - `~/Library/Application Support/Claude/extensions-installations.json` →
     `extensions["local.mcpb.chldbwnstm.au-law-mcp"]` (macOS; other platforms: the
     app's data directory)

   If the extension is installed, do **not** run `claude mcp add`. If both exist,
   remove the `~/.claude.json` entry with
   `claude mcp remove --scope user australian-law` — the extension is app-managed
   and runs on the app's own Node. Use `claude mcp add` only when there is no
   desktop app on the machine.
8. For the Claude Desktop app, install the bundle. Prefer the released file —
   `au-law-mcp-<version>.mcpb`, attached to the
   [latest release](https://github.com/chldbwnstm/australian-law-mcp/releases/latest)
   — which needs no checkout at all. If the machine cannot reach it, or you want
   the code at this revision, `npm run build:mcpb` writes the identical file to
   `release/` (the script builds `build/` fresh, stages production dependencies,
   generates the manifest and fails unless the packed bundle starts and answers
   `tools/list`). Either way the app installs it through **Settings →
   Extensions**. That one install covers Chat and local Code sessions; do not
   follow it with `claude mcp add`.

   If the bundle cannot be installed — managed extensions are blocked, say —
   merge a `mcpServers.australian-law` command/args entry (absolute node, absolute
   `build/index.js`) into the desktop client's configuration instead;
   `src/setup.ts` documents the supported platform paths and merge shapes. Use one
   or the other, never both.
9. For Claude Code CLI or IDE sessions on a machine with **no** desktop app,
   register at **user scope** so it is available across projects:

   ```text
   claude mcp add --transport stdio --scope user australian-law -- <absolute-node-executable> <absolute-build/index.js>
   ```

   Otherwise merge the equivalent user-scoped MCP entry into `~/.claude.json`,
   preserving existing data. Verify the effective connection.
10. Tell the user the server is registered and whether a restart or new session is
    needed. Do not claim it is connected in the app solely because a config file was
    written. After reload, use the app's connected tools to retrieve ACL schedule 2
    section 18 with a source link. Report configuration and in-app verification
    separately if you cannot complete the latter in the current session.

Do not deploy an HTTP service, publish the repository, or request a legal-data API
key for this installation. Local STDIO is sufficient.

## Optional Aside follow-up preview

**Not the same thing as the extension switch above.** Both close the same gap —
sources whose publisher refuses this server — and they are different tools:

| | Extension switch (`AU_LAW_ASIDE`) | `au-law-followup` skill |
|---|---|---|
| Lives in | the server, so every host has it, **including desktop Chat** | a project skill in this checkout |
| Hosts | Claude Desktop (Chat and Code), CLI, Codex | local macOS or Windows Codex or Claude Code opened on the checkout — Chat loads extensions only and never loads a project skill |
| Scope | one blocked lookup, finished inside the answer being written | a research session: per-matter opt-in, page/document/minute budgets, saved evidence, checkpoints, stop and resume |
| Turned on by | a switch in **Settings → Extensions** | `setup-followup`, then a per-matter mode |

Install the skill when someone needs the budgets and the evidence trail. Leave
the switch to cover the ordinary case. Installing both on one machine is fine —
they are separate paths and neither reconfigures the other.

Only offer this after the ordinary law server works and only in a local macOS
15.0+ or Windows 10/11 (x64) Claude Code or Codex session. WSL, Linux, older
macOS, remote and unknown execution hosts remain on standard research — Aside
ships no Linux browser build, and WSL reports itself as linux — so do not
install Aside there or substitute another browser. Aside for Windows is x64
only: on an ARM64 machine its CLI installer refuses, Aside is never connected,
and the probe says so.

On an eligible Mac or Windows PC, obtain the concrete Aside executable path from
Aside's Developer settings — on Windows, after Aside's `install.ps1`, it is
`C:\Users\you\AppData\Local\Aside\CLI\current\aside.exe`, typed with the drive
letter because `%LOCALAPPDATA%` and `~` are not expanded — then run the built
source checkout's opt-in installer:

```text
<absolute-node> <absolute-build/index.js> setup-followup --client codex|claude-code|both --project <project> --aside-command <absolute-aside>
```

`--aside-command` may be omitted on either platform: the installer then looks
first at the standard install location — `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`
on macOS, the path above on Windows — and then for `aside` (`aside.exe` on
Windows) on PATH, the same order the server itself uses, so the command it
records is the one the extension switch would drive. The installer adds only a
missing `aside` sibling MCP entry, preserves existing
settings, installs the host skill inside the project, and records the absolute
executable path in `.au-law-followup-host.json` for desktop processes with a
restricted PATH. That path is written verbatim into `.mcp.json` (JSON, so each
backslash is doubled on disk) and `.codex/config.toml` (a TOML basic string,
backslashes escaped the same way) — both are correct as written and need no
editing. The 0600 mode the installer sets on the host file has no effect on
Windows, where NTFS inherits the folder's permissions. Restart the client. In
the new local session, invoke `au-law-followup`, run its probe, initialise a
dedicated matter folder, and say “Use Aside to finish missing source checks for
this matter.” The skill performs a fresh handshake before dispatch/resume and
keeps policy, task state, Aside session IDs and evidence in that matter folder.
A matter checkpoint made on one host can be resumed on another, but browser
tasks run only if the fresh probe on the resuming host is eligible, and never
with the other platform's recorded executable path — a Mac `.app` path does not
exist on Windows — because the probe re-derives the executable.

The preview uses only Aside's observed `repl(title, code)` and
`exec(prompt, session_id?)` tools. It never uses `memory_search`, claims a running
exec was cancelled without proof, defeats access challenges, or certifies the
legal validity/authenticity of supplied evidence. A successful setup or handshake
is not the still-pending lawyer pilot.

References:
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[Claude Code desktop local sessions](https://code.claude.com/docs/en/desktop),
[Claude Code MCP installation and user scope](https://code.claude.com/docs/en/mcp),
[Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
