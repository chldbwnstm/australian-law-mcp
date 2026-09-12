# Try Australian Law in Claude Desktop

A private preview for Australian lawyers. Ask ordinary questions and get public
legal material with links back to its sources.

## First, get the installer file

Everything below needs one file, `au-law-mcp-1.0.3.mcpb`. There is nowhere to
download it from: this project has no npm package and the repository has no
releases. It reaches you one of two ways.

- **The person who invited you sends it**, as a trial pack. Unzip the pack; the
  `.mcpb` is inside it.
- **You download it** from the
  [latest release](https://github.com/chldbwnstm/australian-law-mcp/releases/latest)
  — `au-law-mcp-1.0.3.mcpb`, about 4 MB. No terminal, no Node.js.

- **You build it**, if you would rather not download it. This one does need a
  terminal and Node.js 20.19 or later, once:

  ```bash
  git clone https://github.com/chldbwnstm/australian-law-mcp
  cd australian-law-mcp
  npm ci --ignore-scripts
  npm run build:mcpb          # writes release/au-law-mcp-1.0.3.mcpb
  ```

  The build refuses to finish unless the packed bundle starts and answers with
  the ten tools it advertises, so a file that appears is a file that ran.

## Install once

1. Open `au-law-mcp-1.0.3.mcpb`.
2. Choose **Install** in Claude Desktop.
3. Restart Claude Desktop, then start a new chat. If Claude asks to use Australian
   Law, review and allow the request.

If opening the file does not show an install dialog, open Claude Desktop and go to
**Settings → Extensions → Advanced settings → Install Extension…**, then select
the same file. If your firm manages extensions, ask its administrator to make
Australian Law available to you.

That single install is the whole setup for this app. The tools appear in ordinary
chats and in the app's local **Code** sessions; there is nothing separate to
install for Code, and nothing to add in a terminal. If you also use `claude` from
a terminal, do not add it there as well — a second registration on the same
machine is the one thing to avoid, and [INSTALL.md](../INSTALL.md) explains why.

Once you have that file, no terminal commands, separate Node.js installation or
legal-data API key are needed — the bundle carries its own runtime dependencies
and Claude supplies Node. You need Claude Desktop, an account you can use there,
and internet access; your usual Claude plan and usage limits still apply.

## Optional: the one setting, and what it is for

Some publishers refuse this extension outright — the Federal Court's judgment
site and AustLII among them — so questions that depend on them come back saying
the source was blocked, with a link for you to open yourself.

If you are on a Mac and have [Aside](https://docs.aside.com/help/get-started)
installed, you can let the extension finish those lookups in your own browser.
Open **Settings → Extensions → Australian Law** and turn on **“Finish blocked
legal sources using the Aside browser”**. Leave the path field blank unless you
moved Aside somewhere unusual.

It is off until you turn it on, it only works on a Mac with Aside installed —
with Aside absent it does nothing — and it is restricted to the legal sites
listed in the
[README](../README.md#optional-finishing-a-blocked-source-in-your-own-browser),
because it is driving the real browser you are signed in to. Read that before
turning it on. Nothing else in this page needs it.

If you work in a local **Codex or Claude Code** session on a checkout of the
repository instead, there is a second, larger tool for the same gap: the
`au-law-followup` skill, with per-matter budgets, saved evidence and resumable
checkpoints. It is not a duplicate of the switch and it cannot be used from
Chat, which loads extensions only. See
[INSTALL.md](../INSTALL.md#optional-aside-follow-up-preview).

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

**Watch for answers that did not come from here.** When the extension reports a
source as blocked, Claude may go on and answer from its own web search instead.
That answer can look the same in the chat and is not this extension's work — it
carried no source link from here and was not checked against these sources. If
it matters which one you are reading, ask: *“Did that come from the Australian
Law tools, and what is the source link?”*

The extension runs locally and sends lookup terms to public sources. Your chat and
any documents you provide are still handled by your AI app under its own settings;
local installation does not make the conversation offline.

## If it does not work

- Restart Claude Desktop, open a new chat and check that Australian Law is enabled
  under Extensions. Ask it to use Australian Law explicitly.
- If installation is restricted, your firm's administrator may need to allow it.
- If the same law tools appear twice, this server is registered twice — usually the
  extension plus an older entry someone added from a terminal. Keep the extension
  and remove the terminal entry; [INSTALL.md](../INSTALL.md) has the command.
- Tell the person who sent you the trial pack — or, if you built the file
  yourself, open an issue on the repository — which app and operating system you
  use, the prompt you tried, and what happened. Please omit client information.
- Private trial updates arrive as a new installation file.

## Using Codex instead

This pack installs into **Claude Desktop**. It is not a Codex installation file,
and it supplies no hosted connection for Codex to point at. Codex is a separate
host and needs its own registration, even if you have the extension installed
already. In a local Codex session, paste the repository URL and ask
the agent to install it for you, following [INSTALL.md](../INSTALL.md). The agent
handles the commands and configuration; repository access and local permissions
are required.

Installation references, checked 12 September 2026:
[Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
and [Codex desktop MCP setup](https://learn.chatgpt.com/docs/extend/mcp).
