import { Notice, Plugin, debounce } from "obsidian";
import { ReminderTimer, formatRemaining } from "./timer";
import { allDone, anyDone, resetAllChecks, setTaskChecked } from "./checklist";
import { DEFAULTS, PluginData, sanitizeData } from "./settings";
import { PopupHandlers, ReminderCard, ReminderModal, ReminderView } from "./popup";
import { ReminderSettingTab } from "./settingsTab";
import { StartPrompt } from "./startPrompt";

export default class DMSessionReminders extends Plugin {
  data: PluginData = { ...DEFAULTS };
  private timer = new ReminderTimer();
  private popup: ReminderView | null = null;
  private statusEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private settingTab: ReminderSettingTab | null = null;
  /** Disk save + popup refresh after typing in the settings text box. */
  private persistSoon = debounce(
    () => {
      void this.saveData(this.data);
      this.popup?.refresh();
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

    this.addCommand({ id: "start", name: "Start reminders", callback: () => this.start() });
    this.addCommand({ id: "stop", name: "Stop reminders", callback: () => this.stop() });
    this.addCommand({
      id: "reset-items",
      name: "Untick all checkboxes",
      callback: async () => {
        await this.updateText(resetAllChecks(this.data.text));
        new Notice("All checkboxes reset.");
      },
    });
    this.addCommand({ id: "show-now", name: "Show reminder now", callback: () => this.showPopup(true) });

    // One tick per second compares against a wall-clock deadline, so sleep/throttling can't drift or stack timers.
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.updateStatus();
  }

  onunload() {
    this.timer.stop();
    this.closePopup();
  }

  // ---- state shared with the settings tab ----

  /** Replace the checklist text (e.g. after a tick or reset) and save. */
  async updateText(text: string, refreshPopup = true) {
    this.data.text = text;
    await this.saveData(this.data);
    if (refreshPopup) this.popup?.refresh();
    this.settingTab?.syncText();
  }

  /** Called on every keystroke in the settings text box. */
  onTextTyped(text: string) {
    this.data.text = text;
    this.persistSoon();
  }

  async setIntervalMinutes(minutes: number) {
    this.data.intervalMinutes = minutes;
    await this.saveData(this.data);
    this.timer.reschedule(Date.now(), this.intervalMs());
    this.popup?.updateSnoozeLabel();
  }

  // ---- session control ----

  private intervalMs() {
    return this.data.intervalMinutes * 60_000;
  }

  toggleSession() {
    if (this.timer.running) this.stop();
    else this.start();
  }

  isRunning(): boolean {
    return this.timer.running;
  }

  /** One-line session status for the settings page. */
  statusText(): string {
    if (!this.timer.running) return `Off. Start a session to get a reminder every ${this.data.intervalMinutes} min.`;
    const rem = this.timer.remaining(Date.now());
    return rem === null ? "Running. A reminder is showing now." : `Running. Next reminder in ${formatRemaining(rem)}.`;
  }

  /** Show the popup without touching the timer (used by the settings button and "Show reminder now"). */
  previewPopup() {
    this.showPopup(true);
  }

  private start() {
    if (this.timer.running) {
      new Notice("Reminders are already running.");
      return;
    }
    if (this.data.text.trim() === "") {
      new Notice("Add your checklist in the plugin settings first.");
      return;
    }
    if (anyDone(this.data.text)) {
      new StartPrompt(this.app, async (choice) => {
        if (choice === "cancel") return;
        if (choice === "reset") await this.updateText(resetAllChecks(this.data.text));
        this.begin();
      }).open();
    } else {
      this.begin();
    }
  }

  private begin() {
    if (allDone(this.data.text)) {
      new Notice("All checkboxes are already ticked. Reset them to start.");
      return;
    }
    this.timer.start(Date.now(), this.intervalMs());
    new Notice(`Reminders started: every ${this.data.intervalMinutes} min.`);
    this.updateStatus();
  }

  private stop() {
    const was = this.timer.running;
    this.timer.stop();
    this.closePopup();
    this.updateStatus();
    if (was) new Notice("Reminders stopped.");
  }

  private snooze() {
    // Dismissing (Snooze button, modal X, Esc) with everything ticked ends the session.
    if (this.timer.running && allDone(this.data.text)) {
      this.stopBecauseAllDone();
      return;
    }
    this.timer.snooze(Date.now(), this.intervalMs());
    this.closePopup();
    this.updateStatus();
  }

  private stopBecauseAllDone() {
    this.timer.stop();
    this.closePopup();
    this.updateStatus();
    new Notice("All items complete. Reminders stopped.");
  }

  /** The popup updates its own checkbox in place, so don't re-render it (keeps focus and layout steady). */
  private async toggleTask(taskIndex: number, done: boolean) {
    await this.updateText(setTaskChecked(this.data.text, taskIndex, done), false);
  }

  // ---- popup ----

  private tick() {
    if (this.timer.tick(Date.now())) {
      if (allDone(this.data.text)) this.stopBecauseAllDone();
      else this.showPopup();
    }
    this.updateStatus();
  }

  /** `preview` popups leave a running session alone unless the user explicitly disables it. */
  private showPopup(preview = false) {
    if (this.popup) return;
    const handlers: PopupHandlers = {
      onToggle: (i, done) => void this.toggleTask(i, done),
      onSnooze: () => (preview && !this.timer.showing ? this.closePopup() : this.snooze()),
      onStop: () => this.stop(),
      getIntervalMinutes: () => this.data.intervalMinutes,
    };
    const getText = () => this.data.text;
    this.popup =
      this.data.popupStyle === "modal"
        ? new ReminderModal(this.app, getText, handlers, this.data.flash)
        : new ReminderCard(this.app, getText, handlers, this.data.flash);
  }

  private closePopup() {
    const p = this.popup;
    this.popup = null;
    p?.dispose();
  }

  // ---- status bar / ribbon ----

  private updateStatus() {
    if (!this.statusEl) return;
    const rem = this.timer.remaining(Date.now());
    let text = "DM Reminders: off";
    if (this.timer.running) text = rem === null ? "DM Reminders: showing" : `DM Reminders: ${formatRemaining(rem)}`;
    if (this.statusEl.textContent !== text) this.statusEl.setText(text);
    this.ribbonEl?.toggleClass("is-active", this.timer.running);
    this.settingTab?.refreshStatus();
  }
}
