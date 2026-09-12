# Private lawyer trial

## Ready now: Claude Desktop

Send each tester a pack containing the locally verified `.mcpb` installer and a
short browser-readable guide. No npm publication or app-directory listing is
necessary for this route. Recipients extract the pack and install the `.mcpb`
inside.

Assemble the pack yourself — there is no script that builds it, and no
`release/australian-law-pilot.zip` in the repository:

```bash
npm ci --ignore-scripts && npm run build:mcpb   # → release/au-law-mcp-<version>.mcpb
mkdir -p /tmp/australian-law-pilot
cp release/au-law-mcp-*.mcpb docs/START-HERE.html /tmp/australian-law-pilot/
cd /tmp && zip -r australian-law-pilot.zip australian-law-pilot
```

`build:mcpb` starts the server inside the bundle and checks its tool list before
it finishes, so the installer you send has been proved to run on your machine.

Suggested invitation:

> I've put together a small Australian legal research extension for Claude Desktop.
> Would you try one question you already know the answer to?
>
> Unzip the attached pack, open START-HERE.html, then install Australian Law. There
> are no terminal commands or API keys to set up. The guide includes a first question
> that retrieves ACL section 18 and its official source.
>
> I'd especially like to know whether installation was straightforward, whether the
> source links were useful, and where you got stuck. This is a private preview with
> limited case-law coverage. Please start with public material.

Suggested first round: a few testers, one familiar question each, then one task
from their usual research workflow. Collect the app, OS, installation outcome,
prompt, expected result and observed limitation, without client information.

## Codex: let the local agent install it

The simplest trial for someone already using a local Codex session is to send the
repository URL and the copy-and-paste request in [INSTALL.md](../INSTALL.md).
The agent can install dependencies, build the server and register local STDIO on
the user's behalf. This requires repository access and local installation permissions,
but does not require the lawyer to run terminal commands or the owner to host a service.
Claude Code desktop local sessions can also assist; ordinary Claude Chat should use
the desktop extension route above.

## Optional hosted connection

The project already has Streamable HTTP transport and bearer-token checking, but
there is no hosted trial endpoint, OAuth service or Codex plugin in this checkout.
Do not send a placeholder URL or imply that a plugin is already listed.

For a simple Codex trial, prepare an HTTPS MCP endpoint and a tested way to supply
its access credentials through the desktop app. The recipient's intended flow is
Settings → MCP servers → Add server → Streamable HTTP → enter connection details
→ Save → Restart. Test that exact flow in the recipient's app version before
calling it ready. The current shared-token implementation is a pilot mechanism;
individual sign-in and revocation require additional authentication work.

A plugin can later package the connection with guided research tasks. Local
marketplaces require setup and workspace-only publication does not make a plugin
available to friends in unrelated organisations. Packaging a plugin alone does
not remove a local MCP server's runtime requirements.

Before distributing a hosted option, decide who operates it, how access is issued
and revoked, what request data is retained, and how outages and updates are handled.
Hosted tool requests pass through the operator's infrastructure; describe that
accurately to testers. The local Claude pack does not require that infrastructure.

## References

- [Claude private desktop extensions and updates](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Codex MCP desktop setup and transports](https://learn.chatgpt.com/docs/extend/mcp)
- [Plugin distribution and workspace boundaries](https://developers.openai.com/plugins/build/plugins)
