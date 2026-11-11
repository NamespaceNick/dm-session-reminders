import { Notice, Plugin, debounce } from "obsidian";
import { ReminderTimer, formatRemaining } from "./timer";
import { allDone, anyDone, resetAllChecks, setTaskChecked } from "./checklist";
import {
  MAX_NAME_LEN,
  MAX_REMINDERS,
  PluginData,
  Reminder,
  ReminderKind,
  clampInterval,
  createReminder,
  sanitizeData,
} from "./settings";
import { PopupHandlers, ReminderCard, ReminderModal, ReminderView } from "./popup";
import { ReminderSettingTab } from "./settingsTab";
import { StartPrompt } from "./startPrompt";
import { InitiativeLink, InitiativeReminderModal, LinkStatus, RoundReminderModal } from "./initiative";
import { CombatEvent, CreatureSnap, reminderMatchesCreature, reminderMatchesRound } from "./reminders";

interface Shown {
  id: string;
  /** Opened by hand (preview) rather than by a timer or a turn: leaves the schedule alone. */
  preview: boolean;
  view: ReminderView;
}

export default class DMSessionReminders extends Plugin {
  data: PluginData = sanitizeData(null);
  /** Whether a session is running. Timer reminders only count down during a session; initiative reminders don't need one. */
  private session = false;
  private timers = new Map<string, ReminderTimer>();
  /** Reminders waiting for the popup slot (one popup is shown at a time). */
  private queue: Array<{ id: string; preview: boolean }> = [];
  private shown: Shown | null = null;
  private statusEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private settingTab: ReminderSettingTab | null = null;
  private link: InitiativeLink | null = null;
  /** Disk save + popup refresh after typing in a settings text box. */
  private persistSoon = debounce(
    () => {
      void this.saveData(this.data);
      this.shown?.view.refresh();
    },
    600,
    true,
  );

  async onload() {
    this.data = sanitizeData(await this.loadData());

    this.settingTab = new ReminderSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.ribbonEl = this.addRibbonIcon("bell", "Start or stop DM Reminders", () => this.toggleSession());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("dmsr-status");
    this.statusEl.addEventListener("click", () => this.toggleSession());

    this.addCommand({ id: "start", name: "Start reminders", callback: () => this.startSession() });
    this.addCommand({ id: "stop", name: "Stop reminders", callback: () => this.stopSession() });
    this.addCommand({
      id: "reset-items",
      name: "Untick all checkboxes",
      callback: () => void this.resetEverything(),
    });
    this.addCommand({
      id: "show-now",
      name: "Show reminders now",
      callback: () => {
        const rs = this.data.reminders.filter((r) => r.text.trim() !== "");
        if (rs.length === 0) new Notice("No reminders to show yet.");
        for (const r of rs) this.enqueue(r.id, true);
      },
    });

    this.link = new InitiativeLink(
      this.app,
      (e) => this.onCombatEvent(e),
      (c) => this.openSetReminder(c),
      () => this.openSetRoundReminder(),
    );
    // Wait for every plugin (including Initiative Tracker) to finish loading before looking for it.
    this.app.workspace.onLayoutReady(() => {
      this.link?.start();
      // Synced data can hold initiative/round reminders on a device that lacks Initiative Tracker: say so once.
      window.setTimeout(() => this.warnIfTrackerMissing(), 3000);
    });

    // One tick per second compares against wall-clock deadlines, so sleep/throttling can't drift or stack timers.
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.updateStatus();
  }

  onunload() {
    this.link?.dispose();
    this.link = null;
    this.timers.clear();
    this.queue = [];
    this.closeShown();
  }

  /**
   * Obsidian calls this when data.json is changed by something other than us, which is how Obsidian Sync
   * delivers edits made on another device. Adopt them, or our next save would overwrite them with stale data.
   */
  async onExternalSettingsChange() {
    const incoming = sanitizeData(await this.loadData());
    if (JSON.stringify(incoming) === JSON.stringify(this.data)) return;
    const oldIntervals = new Map(this.data.reminders.map((r) => [r.id, r.intervalMinutes]));
    this.data = incoming;
    const live = new Set(incoming.reminders.map((r) => r.id));
    for (const id of Array.from(this.timers.keys())) if (!live.has(id)) this.timers.delete(id);
    this.queue = this.queue.filter((q) => live.has(q.id));
    for (const r of incoming.reminders) {
      if (r.kind !== "timer") continue;
      const t = this.timerFor(r.id);
      if (!r.enabled) t.stop();
      else if (oldIntervals.has(r.id) && oldIntervals.get(r.id) !== r.intervalMinutes) {
        t.reschedule(Date.now(), this.ms(r));
      }
    }
    const cur = this.shown ? this.reminder(this.shown.id) : undefined;
    if (this.shown && (!cur || !cur.enabled)) {
      this.closeShown();
      this.pump();
    } else {
      this.shown?.view.refresh();
    }
    this.updateStatus();
    this.settingTab?.refreshList();
  }

  // ---- lookups ----

  reminder(id: string): Reminder | undefined {
    return this.data.reminders.find((r) => r.id === id);
  }

  private timerFor(id: string): ReminderTimer {
    let t = this.timers.get(id);
    if (!t) {
      t = new ReminderTimer();
      this.timers.set(id, t);
    }
    return t;
  }

  private ms(r: Reminder) {
    return r.intervalMinutes * 60_000;
  }

  private save() {
    return this.saveData(this.data);
  }

  linkStatus(): LinkStatus {
    return this.link?.status() ?? "not-found";
  }

  combatRunning(): boolean {
    return this.link?.combatRunning() ?? false;
  }

  // ---- editing reminders (used by the settings tab) ----

  async addReminder(kind: ReminderKind, init: Partial<Reminder> = {}): Promise<Reminder | null> {
    if (this.data.reminders.length >= MAX_REMINDERS) {
      new Notice(`That's the limit (${MAX_REMINDERS} reminders).`);
      return null;
    }
    const r = createReminder(kind, init);
    this.data.reminders.push(r);
    await this.save();
    if (kind !== "timer" && this.linkStatus() !== "connected") this.noTrackerNotice(true);
    return r;
  }

  async deleteReminder(id: string) {
    this.removeFromPopups(id);
    this.timers.delete(id);
    this.data.reminders = this.data.reminders.filter((r) => r.id !== id);
    await this.save();
    this.updateStatus();
  }

  async deleteInitiativeReminders() {
    for (const r of this.data.reminders.filter((x) => x.kind === "initiative")) this.removeFromPopups(r.id);
    this.data.reminders = this.data.reminders.filter((r) => r.kind !== "initiative");
    await this.save();
  }

  async renameReminder(id: string, name: string) {
    const r = this.reminder(id);
    if (!r) return;
    r.name = name.trim().slice(0, MAX_NAME_LEN) || r.name;
    await this.save();
  }

  async setCreature(id: string, name: string) {
    const r = this.reminder(id);
    if (!r) return;
    r.creatureName = name.trim().slice(0, MAX_NAME_LEN);
    r.creatureId = ""; // a typed name is matched by name; the old id may belong to someone else
    await this.save();
  }

  async setEnabled(id: string, enabled: boolean) {
    const r = this.reminder(id);
    if (!r) return;
    r.enabled = enabled;
    await this.save();
    if (r.kind === "timer") {
      if (enabled && this.session) this.armTimer(r);
      else this.timerFor(id).stop();
    }
    if (!enabled) this.removeFromPopups(id);
    this.updateStatus();
  }

  async setIntervalMinutes(id: string, minutes: number) {
    const r = this.reminder(id);
    if (!r) return;
    r.intervalMinutes = clampInterval(minutes);
    await this.save();
    this.timerFor(id).reschedule(Date.now(), this.ms(r));
    if (this.shown?.id === id) this.shown.view.updateSnoozeLabel();
  }

  /** Replace a reminder's text (after a tick, say) and save. */
  async updateText(id: string, text: string, refreshPopup = true) {
    const r = this.reminder(id);
    if (!r) return;
    r.text = text;
    await this.save();
    if (refreshPopup && this.shown?.id === id) this.shown.view.refresh();
    this.settingTab?.syncText(id);
  }

  /** Called on every keystroke in a settings text box. */
  onTextTyped(id: string, text: string) {
    const r = this.reminder(id);
    if (!r) return;
    r.text = text;
    this.persistSoon();
  }

  /** Untick every checkbox in every reminder. */
  async resetEverything() {
    for (const r of this.data.reminders) r.text = resetAllChecks(r.text);
    await this.save();
    this.shown?.view.refresh();
    this.settingTab?.syncAllText();
    new Notice("All checkboxes reset.");
  }

  /** Show one reminder's popup without touching any schedule (the settings Preview button). */
  previewPopup(id: string) {
    this.enqueue(id, true);
  }

  async resetAll(id: string) {
    const r = this.reminder(id);
    if (r) await this.updateText(id, resetAllChecks(r.text));
  }

  // ---- session control ----

  toggleSession() {
    if (this.session) this.stopSession();
    else this.startSession();
  }

  isRunning(): boolean {
    return this.session;
  }

  /** One-line session status for the settings page. */
  statusText(): string {
    if (!this.session) return "Off. Start a session to run the timer reminders. Initiative reminders work without one.";
    const next = this.nextTimer();
    if (!next) return "Running. No timer reminder is counting down.";
    return `Running. Next: "${next.r.name}" in ${formatRemaining(next.rem)}.`;
  }

  /** Status line for one reminder's row in settings. */
  reminderStatus(id: string): string {
    const r = this.reminder(id);
    if (!r) return "";
    if (!r.enabled) return "Off.";
    if (r.kind !== "timer") {
      if (this.linkStatus() !== "connected") return "On, but Initiative Tracker is not available here, so this will not fire.";
      if (r.kind === "round") return "On. Shows at the start of every round.";
      if (r.creatureName.trim() === "") return "Type the creature's name above.";
      return "On. Shows when this creature's turn starts.";
    }
    if (r.text.trim() === "") return "On, but there is no text yet.";
    if (allDone(r.text)) return "Every box is ticked. Untick some (or Reset) to run it.";
    if (!this.session) return "On. Waiting for a session to start.";
    const rem = this.timerFor(id).remaining(Date.now());
    return rem === null ? "Showing now (or waiting for the popup slot)." : `Next in ${formatRemaining(rem)}.`;
  }

  /** Soonest counting-down timer reminder, plus how many are counting. */
  private nextTimer(): { r: Reminder; rem: number; count: number } | null {
    let best: { r: Reminder; rem: number } | null = null;
    let count = 0;
    const now = Date.now();
    for (const r of this.data.reminders) {
      if (r.kind !== "timer" || !r.enabled) continue;
      const rem = this.timerFor(r.id).remaining(now);
      if (rem === null) continue;
      count++;
      if (!best || rem < best.rem) best = { r, rem };
    }
    return best ? { ...best, count } : null;
  }

  private armTimer(r: Reminder) {
    if (r.text.trim() === "" || allDone(r.text)) return; // nothing (left) to remind about
    this.timerFor(r.id).start(Date.now(), this.ms(r));
  }

  private startSession() {
    if (this.session) {
      new Notice("Reminders are already running.");
      return;
    }
    const timers = this.data.reminders.filter((r) => r.kind === "timer" && r.enabled && r.text.trim() !== "");
    if (timers.length === 0) {
      new Notice("Turn on a timer reminder (with some text) in the plugin settings first.");
      return;
    }
    if (timers.some((r) => anyDone(r.text))) {
      new StartPrompt(this.app, async (choice) => {
        if (choice === "cancel") return;
        if (choice === "reset") {
          for (const r of timers) r.text = resetAllChecks(r.text);
          await this.save();
          this.settingTab?.syncAllText();
        }
        this.begin();
      }).open();
    } else {
      this.begin();
    }
  }

  private begin() {
    const runnable = this.data.reminders.filter(
      (r) => r.kind === "timer" && r.enabled && r.text.trim() !== "" && !allDone(r.text),
    );
    if (runnable.length === 0) {
      new Notice("All checkboxes are already ticked. Reset them to start.");
      return;
    }
    this.session = true;
    for (const r of runnable) this.armTimer(r);
    new Notice(
      runnable.length === 1
        ? `Reminders started: every ${runnable[0].intervalMinutes} min.`
        : `Reminders started: ${runnable.length} timers running.`,
    );
    this.updateStatus();
  }

  private stopSession() {
    const was = this.session;
    this.session = false;
    for (const t of this.timers.values()) t.stop();
    // Timer popups go away with the session; initiative reminders are independent of it.
    for (const r of this.data.reminders.filter((x) => x.kind === "timer")) this.removeFromPopups(r.id);
    this.updateStatus();
    if (was) new Notice("Reminders stopped.");
  }

  // ---- initiative ----

  private onCombatEvent(e: CombatEvent) {
    for (const r of this.data.reminders) {
      const hit = e.type === "turn" ? reminderMatchesCreature(r, e.creature) : reminderMatchesRound(r);
      if (!hit || r.text.trim() === "") continue;
      // Each time starts with a fresh checklist.
      if (anyDone(r.text)) {
        r.text = resetAllChecks(r.text);
        void this.save();
        this.settingTab?.syncText(r.id);
      }
      this.enqueue(r.id, false);
    }
  }

  private warnedMissing = false;

  /** One message per launch (not nagging) when reminders need Initiative Tracker and it is not usable. */
  private warnIfTrackerMissing() {
    if (this.warnedMissing || this.linkStatus() === "connected") return;
    if (!this.data.reminders.some((r) => r.kind !== "timer" && r.enabled)) return;
    this.warnedMissing = true;
    this.noTrackerNotice(false);
  }

  private noTrackerNotice(justAdded: boolean) {
    const why =
      this.linkStatus() === "unsupported"
        ? "this version of Initiative Tracker is not supported"
        : "Initiative Tracker is not installed or not enabled on this device";
    const lead = justAdded ? "Reminder saved, but " : "You have initiative/round reminders, but ";
    new Notice(
      `DM Session Reminders: ${lead}${why}. Those reminders stay inactive until it is available. Timer reminders are not affected.`,
      12000,
    );
  }

  /** "Set DM Round Reminder" in Initiative Tracker's top menu. */
  private openSetRoundReminder() {
    new RoundReminderModal(
      this.app,
      () => this.data.reminders,
      async (text: string) => {
        const r = await this.addReminder("round", { text });
        if (r) new Notice("Reminder set for the start of each round.");
        this.settingTab?.refreshList();
      },
      async (id) => {
        await this.deleteReminder(id);
        this.settingTab?.refreshList();
      },
    ).open();
  }

  /** "Set DM Reminder" in Initiative Tracker's creature menu. */
  private openSetReminder(creature: CreatureSnap | null) {
    const creatures = this.link?.currentCreatures() ?? [];
    if (creatures.length === 0) {
      new Notice("Initiative Tracker has no creatures to attach a reminder to.");
      return;
    }
    new InitiativeReminderModal(
      this.app,
      creatures,
      creature ? (creatures.find((c) => c.id === creature.id && c.name === creature.name) ?? null) : null,
      () => this.data.reminders,
      async (c, text) => {
        const r = await this.addReminder("initiative", { name: c.name, creatureName: c.name, creatureId: c.id, text });
        if (r) new Notice(`Reminder set for ${c.name}.`);
        this.settingTab?.refreshList();
      },
      async (id) => {
        await this.deleteReminder(id);
        this.settingTab?.refreshList();
      },
    ).open();
  }

  // ---- popups (one at a time; the rest wait in a queue) ----

  private tick() {
    this.link?.rebind();
    if (this.session) {
      for (const r of this.data.reminders) {
        if (r.kind !== "timer" || !r.enabled) continue;
        const t = this.timerFor(r.id);
        if (!t.running) {
          this.armTimer(r); // text added or unticked since the session began
          continue;
        }
        if (!t.tick(Date.now())) continue;
        if (allDone(r.text)) void this.finishReminder(r);
        else this.enqueue(r.id, false);
      }
    }
    this.updateStatus();
  }

  private enqueue(id: string, preview: boolean) {
    if (this.shown?.id === id || this.queue.some((q) => q.id === id)) return;
    this.queue.push({ id, preview });
    this.pump();
  }

  private pump() {
    while (!this.shown && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const r = this.reminder(next.id);
      if (r) this.show(r, next.preview);
    }
  }

  private show(r: Reminder, preview: boolean) {
    const id = r.id;
    const isTimer = r.kind === "timer";
    const handlers: PopupHandlers = {
      title: r.name,
      allDoneNote: isTimer ? "All items done. Closing this will turn this reminder off." : "",
      onToggle: (i, done) => void this.toggleTask(id, i, done),
      onSnooze: () => this.dismiss(id),
      onStop: () => void this.setEnabled(id, false),
      getSnoozeLabel: () => {
        const cur = this.reminder(id);
        return cur && cur.kind === "timer" ? `⏰ Snooze (${cur.intervalMinutes}m)` : "✓ Dismiss";
      },
      getSnoozeTip: () => {
        const cur = this.reminder(id);
        return cur && cur.kind === "timer"
          ? `Close this and remind me again in ${cur.intervalMinutes} min`
          : cur?.kind === "round"
            ? "Close this. It shows again at the start of the next round."
            : `Close this. It shows again the next time ${cur?.creatureName || "that creature"}'s turn starts.`;
      },
      getDisableTip: () => "Turn this reminder off. Your ticked boxes are kept.",
    };
    const getText = () => this.reminder(id)?.text ?? "";
    const view: ReminderView =
      this.data.popupStyle === "modal"
        ? new ReminderModal(this.app, getText, handlers, this.data.flash)
        : new ReminderCard(this.app, getText, handlers, this.data.flash);
    this.shown = { id, preview, view };
  }

  /** The user closed the popup (Snooze / Dismiss button, modal X, Esc, backdrop). */
  private dismiss(id: string) {
    this.closeShown();
    const r = this.reminder(id);
    if (r && r.kind === "timer" && this.session && r.enabled) {
      const t = this.timerFor(id);
      // Only a popup the timer itself raised reschedules it. A preview leaves a running countdown alone.
      if (t.showing) {
        if (allDone(r.text)) void this.finishReminder(r);
        else t.snooze(Date.now(), this.ms(r));
      }
    }
    this.updateStatus();
    this.pump();
  }

  /** Every box on a timer reminder is ticked: switch it off (the session keeps running for the others). */
  private async finishReminder(r: Reminder) {
    this.timerFor(r.id).stop();
    this.removeFromPopups(r.id);
    r.enabled = false;
    await this.save();
    new Notice(`"${r.name}" is complete and turned off.`);
    this.settingTab?.refreshList();
    this.updateStatus();
  }

  /** Close this reminder's popup and drop it from the queue, without touching any schedule. */
  private removeFromPopups(id: string) {
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.shown?.id === id) {
      this.closeShown();
      this.pump();
    }
  }

  /** The popup updates its own checkbox in place, so don't re-render it (keeps focus and layout steady). */
  private async toggleTask(id: string, taskIndex: number, done: boolean) {
    const r = this.reminder(id);
    if (r) await this.updateText(id, setTaskChecked(r.text, taskIndex, done), false);
  }

  private closeShown() {
    const s = this.shown;
    this.shown = null;
    s?.view.dispose();
  }

  // ---- status bar / ribbon ----

  private updateStatus() {
    if (!this.statusEl) return;
    let text = "DM Reminders: off";
    if (this.session) {
      const next = this.nextTimer();
      if (!next) text = this.shown ? "DM Reminders: showing" : "DM Reminders: on";
      else text = `DM Reminders: ${formatRemaining(next.rem)}` + (next.count > 1 ? ` (+${next.count - 1})` : "");
    }
    if (this.statusEl.textContent !== text) this.statusEl.setText(text);
    this.ribbonEl?.toggleClass("is-active", this.session);
    this.settingTab?.refreshStatus();
  }
}
