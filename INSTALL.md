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

Download `au-law-mcp-1.0.1.mcpb` (about 4 MB) from the
[latest release](https://github.com/chldbwnstm/australian-law-mcp/releases/latest).
That is the whole step — no clone, no terminal, no Node.

Someone may have sent you the file already; it is the same bundle.

To build it yourself instead:

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp
npm ci --ignore-scripts
npm run build:mcpb          # → release/au-law-mcp-1.0.1.mcpb
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

## Route 2 — Claude Code CLI or IDE, no desktop app

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp
npm ci --ignore-scripts
npm run build
npm run verify:stdio
claude mcp add --transport stdio --scope user australian-law -- "$(command -v node)" "$PWD/build/index.js"
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
| `au-law-mcp-1.0.1.mcpb` from [Releases](https://github.com/chldbwnstm/australian-law-mcp/releases/latest), installed through **Settings → Extensions** | **Works.** Download it, or rebuild it with `npm run build:mcpb`. Route 1. |
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

   - `~/.claude.json` → `mcpServers["australian-law"]`
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

Only offer this after the ordinary law server works and only in a local macOS
15.0+ Claude Code or Codex session. Windows, WSL, Linux, older macOS, remote and
unknown execution hosts remain on standard research; do not install Aside there
or substitute another browser.

On an eligible Mac, obtain the concrete Aside executable path from Aside's
Developer settings, then run the built source checkout's opt-in installer:

```text
<absolute-node> <absolute-build/index.js> setup-followup --client codex|claude-code|both --project <project> --aside-command <absolute-aside>
```

The installer adds only a missing `aside` sibling MCP entry, preserves existing
settings, installs the host skill inside the project, and records the executable
path for desktop processes with a restricted PATH. Restart the client. In the
new local session, invoke `au-law-followup`, run its probe, initialise a dedicated
matter folder, and say “Use Aside to finish missing source checks for this
matter.” The skill performs a fresh handshake before dispatch/resume and keeps
policy, task state, Aside session IDs and evidence in that matter folder.

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
