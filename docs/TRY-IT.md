# Try Australian Law in Claude Desktop

A private preview for Australian lawyers. Ask ordinary questions and get public
legal material with links back to its sources.

## Install once

1. Download and unzip the trial pack, then open `au-law-mcp-1.0.0.mcpb`.
2. Choose **Install** in Claude Desktop.
3. Start a new chat. If Claude asks to use Australian Law, review and allow the request.

If opening the file does not show an install dialog, open Claude Desktop and go to
**Settings → Extensions → Advanced settings → Install Extension…**, then select
the same file. If your firm manages extensions, ask its administrator to make
Australian Law available to you.

No terminal commands, separate Node.js installation, or legal-data API key are
needed. You need Claude Desktop, an account you can use there, and internet access;
your usual Claude plan and usage limits still apply.

## Ask your first question

Copy this into a new chat:

> Use Australian Law to retrieve section 18 of the Australian Consumer Law. Show
> the provision, identify its Act and schedule, and include the official source link.

The result should identify **schedule 2, section 18** of the Competition and
Consumer Act 2010. Open the source link and compare it with the returned text.

Then try:

> Use Australian Law to show section 52 of the Trade Practices Act as at
> 30 June 2010. Identify the version used and link to the source.

> Use Australian Law to find Fair Work Commission decisions about genuine
> redundancy. Include decision identifiers, source links, and any search limitations.

You can write normally; you do not need to know tool names. Include the State or
Territory and the relevant date whenever they matter.

## What to expect

This preview is strongest at retrieving Commonwealth provisions, historical
legislation and material from supported public decision sources. It is not a
complete case-law database or an editorial citator. An inaccessible source should
be described as unavailable, not as proof that no authority exists.

The extension runs locally and sends lookup terms to public sources. Your chat and
any documents you provide are still handled by your AI app under its own settings;
local installation does not make the conversation offline.

## If it does not work

- Restart Claude Desktop, open a new chat and check that Australian Law is enabled
  under Extensions. Ask it to use Australian Law explicitly.
- If installation is restricted, your firm's administrator may need to allow it.
- Tell the person who sent you the trial pack which app and operating system you
  use, the prompt you tried, and what happened. Please omit client information.
- Private trial updates arrive as a new installation file.

## Using Codex instead

This pack installs into **Claude Desktop**. It is not a Codex installation file.
In a local Codex session, you can instead paste the repository URL and ask the agent
to install it for you, following [INSTALL.md](../INSTALL.md). The agent handles the
commands and configuration; repository access and local permissions are required.
Hosting is optional. No hosted service is supplied in this pack.

If the sender provides a hosted connection, Codex's desktop MCP settings support
**Add server → Streamable HTTP**, followed by
the supplied URL, authentication, **Save**, and **Restart**. Once connected, the
same example prompts apply. A hosted connection processes tool requests on the
operator's server as well as the AI app and public sources.

Installation references, checked 9 September 2026:
[Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
and [Codex desktop MCP setup](https://learn.chatgpt.com/docs/extend/mcp).
