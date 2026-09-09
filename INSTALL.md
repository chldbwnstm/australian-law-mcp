# Install Australian Law from a chat

## Codex desktop

In a **local session**, paste:

> Install https://github.com/chldbwnstm/australian-law-mcp as a local MCP server
> in my Codex desktop app. Follow INSTALL.md in that repository. Handle the setup
> for me, preserve my existing settings, and verify that the server works. Tell me
> if I need to restart the app. I do not want to run terminal commands myself.

## Claude Code desktop

In Claude Desktop, select **Code**, choose **Local** as the environment, select
a folder if prompted, and paste:

> Install https://github.com/chldbwnstm/australian-law-mcp as a local MCP server
> for Claude Code in this desktop app, available across my projects. Follow
> INSTALL.md in that repository. Handle the setup for me, preserve my existing
> settings, and verify that the server works. Tell me if I need to restart the app.
> I do not want to run terminal commands myself.

The repository must be accessible to your account. If it is private, the owner
must grant access first. The app may ask for permission to perform installation.

This route requires an agent that can run commands and change local configuration.
For ordinary Claude Chat, use the `.mcpb` installer described in
[TRY-IT.md](docs/TRY-IT.md).

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
8. For Claude Desktop Chat, prefer the provided `.mcpb` when an accessible release
   artifact is available. Otherwise merge a `mcpServers.australian-law` command/args
   entry into the desktop client's configuration. `src/setup.ts` documents the
   supported platform paths and merge shapes. Configuring Claude Code's user scope
   alone does not register the server for ordinary Desktop Chat.
9. Tell the user the server is registered and whether a restart or new session is
   needed. Do not claim it is connected in the app solely because a config file was
   written. After reload, use the app's connected tools to retrieve ACL schedule 2
   section 18 with a source link. Report configuration and in-app verification
   separately if you cannot complete the latter in the current session.

Do not deploy an HTTP service, publish the repository, or request a legal-data API
key for this installation. Local STDIO is sufficient.

References:
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp),
[Claude Code desktop local sessions](https://code.claude.com/docs/en/desktop),
[Claude Code MCP installation and user scope](https://code.claude.com/docs/en/mcp),
[Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
