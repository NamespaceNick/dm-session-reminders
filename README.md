# DM Session Reminders

An Obsidian plugin that pops up a reminder checklist every X minutes while you run a game session,
so you remember to cover the things you planned to.

## Quick start

1. Enable the plugin, then open **Settings > DM Session Reminders**.
2. Replace the example text in **Reminder checklist** with your own. It is plain Markdown:
   `- [ ]` lines become checkboxes, indented lines (press Tab) nest under the line above, and anything
   else (headings, bold, links, notes) is shown as written. The preview underneath shows how it will look.
3. Set the **Reminder interval** and, if you like, the popup style and flashing bar.
4. Press **Start** in the Session row (or use the bell icon in the ribbon, the status bar item, or the
   command *Start reminders*). Use **Show** under *Preview popup* any time to see what it looks like.

## Using the popup

- **Tick** items you have covered. They stay in place, crossed out, so a misclick is easy to undo. The next
  time the popup opens, finished items are tucked away behind **Show completed items**. A ticked item is only
  hidden when everything nested under it is ticked too.
- **Snooze** closes the popup and brings it back after one full interval. Closing it with the X, Esc or by
  clicking outside (modal style) counts as Snooze.
- **Disable** ends the session. Your ticked boxes are kept.
- If every checkbox is ticked, closing the popup ends the session.

Progress lives in the text itself: ticking a box in the popup rewrites `[ ]` to `[x]` in the settings box.
Starting a session when some boxes are already ticked asks whether to keep that progress or reset.
**Untick all checkboxes** (or the command of the same name) resets everything for next game night.

Commands (assign hotkeys under Settings > Hotkeys): Start reminders, Stop reminders, Untick all checkboxes,
Show reminder now.

## Good to know

- A session ends when Obsidian closes. Nothing runs unless you start it.
- The popup only appears **inside Obsidian**. If another window covers it or Obsidian is minimised you will
  not see it, so keep Obsidian visible (a second monitor works well). System notifications are not supported.
- The status bar countdown is not shown on mobile; use the ribbon or command palette there.
- Ticking a parent item does not tick its children, and the other way round.
- Rendered with Obsidian's own Markdown renderer, so your theme styles it. All colours come from the theme,
  except the top bar, which is always red (it uses ITS Theme's red, with the same value as a fallback).

## Privacy and security

No network requests, no telemetry, no `eval`, no `innerHTML`. Your text is rendered by Obsidian's
sanitising Markdown renderer. Data is stored in the plugin's `data.json`.

## Development

`npm install`, `npm run dev` (watch), `npm run build`, `npm test`.
