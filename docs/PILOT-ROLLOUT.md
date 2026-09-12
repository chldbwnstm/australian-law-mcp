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

`START-HERE.html` names the file `au-law-mcp-1.0.0.mcpb` in its install button.
After a version bump, update that filename there and in `docs/TRY-IT.md`, or the
button in the pack points at a file that is not in it.

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

## One tester, one route per host

The extension is the whole Claude Desktop install. It serves ordinary chats and
the app's local **Code** sessions, so do not ask a Claude Desktop tester to also
run `claude mcp add`, the setup wizard or any terminal command for the law server
— that registers the same server a second time, and it then appears as both
`Australian Law` (the extension) and `australian-law` (the CLI entry). That is
what the first outside tester hit. Send the pack and nothing else.

Ask in the feedback round whether the tester had Australian Law set up anywhere
before the pack arrived; that is the case where a duplicate appears, and
[INSTALL.md](../INSTALL.md) carries the removal step.

## Codex: let the local agent install it

Codex is a separate host, so a Codex tester needs the agent route rather than the
pack: send the repository URL and the copy-and-paste request in
[INSTALL.md](../INSTALL.md). The agent can install dependencies, build the server
and register local STDIO on the user's behalf. This requires repository access and
local installation permissions, but does not require the lawyer to run terminal
commands or the owner to host a service. The same applies to a tester who works in
`claude` from a terminal — one entry in their `~/.claude.json`, and no pack.

## There is no hosted connection

The project has Streamable HTTP transport and bearer-token checking in the code,
but this checkout contains no hosted endpoint, no OAuth service and no Codex
plugin, and nothing in the tree deploys one. Do not send a URL, and do not imply
a plugin is listed.

Standing one up is a project, not a step: someone has to own the deployment,
decide how access is issued and revoked, decide what request data is retained,
and handle outages and updates. The shared-token implementation in the tree is a
pilot mechanism — individual sign-in and revocation need further authentication
work. Hosted tool requests would pass through the operator's infrastructure, and
testers would have to be told so. The local Claude pack needs none of it, which is
why it is the route above.

## References

- [Claude private desktop extensions and updates](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Codex MCP desktop setup and transports](https://learn.chatgpt.com/docs/extend/mcp)
- [Plugin distribution and workspace boundaries](https://developers.openai.com/plugins/build/plugins)
