# DM Session Reminders

An Obsidian plugin that pops up reminders while you run a game session, so you remember to cover the
things you planned to. Reminders can fire on a timer (every X minutes) or when a creature's turn starts in the
[Initiative Tracker](https://github.com/Obsidian-TTRPG-Community/initiative-tracker) plugin (optional), or at the
start of every combat round. You can have as many as you like, each with its own message, trigger and
on/off switch.

## Quick start

1. Enable the plugin, then open **Settings > DM Session Reminders**.
2. Use **Add timer reminder**, **Add initiative reminder** or **Add round reminder**. Each reminder has a name, an on/off switch and a
   message. The message is plain Markdown: `- [ ]` lines become checkboxes, indented lines (press Tab) nest
   under the line above, and anything else (headings, bold, links, notes) is shown as written. Open
   **Message / checklist** to edit it and see a live preview.
3. For a timer reminder, set **Every (minutes)**. Press **Start** in the Session row (or use the bell icon in
   the ribbon, the status bar item, or the command *Start reminders*) and every turned-on timer reminder counts
   down on its own clock.
4. Set the popup style and flashing bar if you like. **Preview popup** on any reminder shows what it looks like.

## Initiative Tracker reminders

Click the three-dot menu next to a creature in Initiative Tracker and choose **Set DM Reminder**. Write the
message and save. From then on the popup appears **every time that creature's turn starts**, with a fresh
unticked checklist each time. Initiative reminders do not need a session, but they only fire while combat is
running in the tracker. You can also add one in settings and type the creature's name as the tracker shows it
(e.g. `Goblin 2`).

They stay until you delete or switch them off, and they match by creature, so clear them between combats
(**Remove all initiative reminders**) or a same-named creature in a later fight will trigger them.

### Round reminders

Click the three-dot menu at the **top** of the Initiative Tracker pane and choose **Set DM Round Reminder**.
Write the message and save. The popup then appears at the **start of every round**: when combat begins (round 1)
and each time the round counter goes up, just before the first creature's own reminder. Stopping combat fires
nothing. There is no separate "end of round" option, since it would fire at the same moment as the next start. Round reminders are not tied to a creature, so you can keep them between combats.

### Initiative Tracker is optional

Timer reminders work on their own. If a device has reminders that need Initiative Tracker but it is not
installed or enabled, the plugin does not error: it shows a short message once at startup (and when you add such
a reminder), the settings page says so, and those reminders simply stay inactive until the plugin is available.

This works by reading Initiative Tracker's internals (it has no public API for it), tested with v13.0.21.
If an Initiative Tracker update changes them, the link stops working quietly and the settings page says so;
timer reminders are unaffected.

## Using the popup

Only one popup shows at a time; if several are due together the others wait their turn.

- **Tick** items you have covered. They stay in place, crossed out, so a misclick is easy to undo. The next
  time that reminder opens, finished items are tucked away behind **Show completed items**. A ticked item is
  only hidden when everything nested under it is ticked too.
- **Snooze** (timer reminders) closes the popup and brings it back after that reminder's full interval. Closing
  it with the X, Esc or by clicking outside (modal style) counts as Snooze. **Dismiss** (initiative reminders)
  just closes it until that creature's next turn.
- **Disable** turns that one reminder off. Your ticked boxes are kept.
- If every checkbox in a timer reminder is ticked, closing its popup turns that reminder off.

Progress lives in the text itself: ticking a box in the popup rewrites `[ ]` to `[x]` in the settings box.
Starting a session when some boxes are already ticked asks whether to keep that progress or reset.
**Untick all checkboxes** (or the command of the same name) resets everything for next game night.

Commands (assign hotkeys under Settings > Hotkeys): Start reminders, Stop reminders, Untick all checkboxes,
Show reminders now.

## Obsidian Sync

Reminders and their on/off switches are stored in the plugin's `data.json`, so they follow you between devices
when Obsidian Sync is set up for them. In **Settings > Sync** (Vault configuration sync) turn on **Active
community plugin list** (which plugins are enabled) and **Installed community plugins** (the plugin files and
their settings). That covers both this plugin and Initiative Tracker, so installing and enabling them on one
device carries them to the others. The plugin picks up changes that arrive from another device while Obsidian
is open. A session is per device and is never synced: starting one on a laptop does not start it on a phone.
If two devices edit reminders at nearly the same time, the most recent save wins.

## Good to know

- A session ends when Obsidian closes. Timer reminders do not run unless you start a session. (Your reminders and their on/off switches are saved.)
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
