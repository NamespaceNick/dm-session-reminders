# Security policy

## Reporting a vulnerability

Please report security issues privately using GitHub's
[private vulnerability reporting](https://github.com/NamespaceNick/dm-session-reminders/security/advisories/new)
rather than opening a public issue. I'll respond as soon as I can.

## What this plugin does and doesn't do

- Shows a reminder popup on a timer while you have started a session.
- Makes **no network requests**, sends no telemetry, uses no `eval`, and loads no external code at runtime.
- Has **zero runtime dependencies**; development dependencies are used only to build and test.
- Stores only its own settings and your checklist text in the plugin's `data.json`. It never reads or
  writes your notes or any other vault file.
- Renders your checklist with Obsidian's own Markdown renderer (which sanitises HTML). The plugin's own
  interface is built with DOM APIs and text content only (no `innerHTML`).
- Validates everything loaded from `data.json` (length limits, allowed values) before using it.
