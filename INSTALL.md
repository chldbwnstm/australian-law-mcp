# Install Australian Law

## Recommended: the `.mcpb` installer

This is the route that has worked most reliably in practice, and it needs no
agent and no terminal once you have the file. Claude Desktop installs a `.mcpb`
by double-click.

Someone may have sent you the file already — if so, open it and skip the rest of
this section. To build it yourself:

```bash
git clone https://github.com/chldbwnstm/australian-law-mcp
cd australian-law-mcp
npm ci --ignore-scripts
npm run build:mcpb          # → release/au-law-mcp-<version>.mcpb
```

The build unpacks the bundle, starts the server inside it and checks that it
advertises the expected tools before it finishes, so a file that appears has
already been proved to run. Open it in Claude Desktop and restart the app.

The one-click route — downloading the same file from this repository's Releases
page — is not available yet; see the table below.

## Install by asking an agent

These routes need an agent that can run commands and change local
configuration. For ordinary Claude Chat, use the `.mcpb` installer above.

### Codex desktop

In a **local session**, paste:

> Install https://github.com/chldbwnstm/australian-law-mcp as a local MCP server
> in my Codex desktop app. Follow INSTALL.md in that repository. Handle the setup
> for me, preserve my existing settings, and verify that the server works. Tell me
> if I need to restart the app. I do not want to run terminal commands myself.

### Claude Code desktop

In Claude Desktop, select **Code**, choose **Local** as the environment, select
a folder if prompted, and paste:

> Install https://github.com/chldbwnstm/australian-law-mcp as a local MCP server
> for Claude Code in this desktop app, available across my projects. Follow
> INSTALL.md in that repository. Handle the setup for me, preserve my existing
> settings, and verify that the server works. Tell me if I need to restart the app.
> I do not want to run terminal commands myself.

The repository must be accessible to your account. If it is private, the owner
must grant access first. The app may ask for permission to perform installation.

Handing the file to someone who is not going to build it is covered in
[TRY-IT.md](docs/TRY-IT.md).

## What is and is not available

Install from this repository. There is no other route today:

| Route | Status |
|---|---|
| Clone, `npm ci --ignore-scripts`, `npm run build`, register `build/index.js` | **Works.** The rest of this file. |
| `npm run build:mcpb` → `release/au-law-mcp-1.0.0.mcpb`, opened in Claude Desktop | **Works.** You build the file yourself. |
| `npx -y au-law-mcp` | **Does not resolve.** `registry.npmjs.org/au-law-mcp` answers 404 — the package has never been published. A client config naming it fails with "server disconnected". |
| Downloading a `.mcpb` from the repository's Releases page | **Nothing to download.** The repository has no releases. |

Both unavailable routes turn on the day the owner publishes; until then, do not
write `npx -y au-law-mcp` into anyone's configuration.

## Instructions for the installing agent

1. Check repository access, operating system, the target app and available runtimes.
   Read `package.json` for the required Node.js version. Do not assume Node or npm
   is installed just because the desktop app is installed. If a runtime is missing,
   arrange its installation using a supported method for that operating system,
   respecting machine policy and any required OS approval.
2. Keep the server in a persistent user-owned directory. Do not register a path
   inside a temporary folder or an agent worktree that may be removed. Clone or
   copy the project there without replacing unrelated user files. Record the revision.
3. Run `npm ci --ignore-scripts`, then `npm run build` in that directory. Dependencies
   are supplied by the lockfile. No legal-data API key is needed.
4. Run `npm run verify:stdio`. Verify the version and advertised tools before
   changing app configuration.
5. Register a local STDIO server called `australian-law`. Use absolute paths to the
   Node executable and `build/index.js` so the app does not depend on a shell PATH
   or a working directory. Keep every unrelated MCP server and setting intact.
   Back up an existing configuration file before editing it.

   `<absolute-node> <absolute-build/index.js> setup` writes exactly that entry
   into whichever detected client configs you choose, merging rather than
   replacing. It resolves the absolute entry point it is itself running from and
   checks it on disk before writing, and it writes nothing if that check fails.
   It uses `npx -y au-law-mcp` only when asked with `--npx` **and** the registry
   answers for the package, which it does not today.
6. For Codex, use its available MCP management command when possible:

   ```text
   codex mcp add australian-law -- <absolute-node-executable> <absolute-build/index.js>
   ```

   If that command is unavailable, merge the equivalent `mcp_servers.australian-law`
   entry into the active Codex host's configuration. Respect `CODEX_HOME` if configured.
   Do not create duplicate TOML tables or accidentally register the server in a cloud
   environment instead of the user's local desktop host.
7. For Claude Code desktop, register the server at **user scope** so it is available
   across projects. When the Claude Code CLI is available, use:

   ```text
   claude mcp add --transport stdio --scope user australian-law -- <absolute-node-executable> <absolute-build/index.js>
   ```

   Otherwise merge the equivalent user-scoped MCP entry into the active Claude Code
   configuration (normally `~/.claude.json`), preserving existing data. The Code tab
   and CLI share this configuration. Check for an existing `australian-law` entry
   in the desktop chat configuration too: current local Code sessions can load it,
   and a conflicting definition can take precedence. Verify the effective connection.
8. For Claude Desktop Chat, build the bundle and install it: `npm run build:mcpb`
   writes `release/au-law-mcp-<version>.mcpb` (the script builds `build/` fresh,
   stages production dependencies, generates the manifest and fails unless the
   packed bundle starts and answers `tools/list`), and Claude Desktop installs
   that file through **Settings → Extensions**. There is no release to download —
   the repository has none — so nothing arrives by URL. If a bundle is not wanted,
   merge a `mcpServers.australian-law` command/args entry (absolute node,
   absolute `build/index.js`) into the desktop client's configuration instead;
   `src/setup.ts` documents the supported platform paths and merge shapes.
   Configuring Claude Code's user scope alone does not register the server for
   ordinary Desktop Chat.
9. Tell the user the server is registered and whether a restart or new session is
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
