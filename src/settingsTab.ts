import { App, ButtonComponent, Component, MarkdownRenderer, PluginSettingTab, Setting, debounce } from "obsidian";
import type DMSessionReminders from "./main";
import { MAX_TEXT_LEN, resetAllChecks } from "./checklist";
import { MAX_INTERVAL, MIN_INTERVAL, PopupStyle } from "./settings";

export class ReminderSettingTab extends PluginSettingTab {
  private textarea: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private previewOwner: Component | null = null;
  private previewChild: Component | null = null;
  private previewSeq = 0;
  private sessionSetting: Setting | null = null;
  private sessionBtn: ButtonComponent | null = null;
  private lastStatus = "";
  private renderPreviewSoon = debounce(() => void this.renderPreview(), 300, true);

  constructor(app: App, private plugin: DMSessionReminders) {
    super(app, plugin);
  }

  /** Pull in text changed elsewhere (ticking a box in the popup), unless the user is typing in it. */
  syncText(): void {
    const ta = this.textarea;
    if (!ta || !ta.isConnected) return;
    this.renderPreviewSoon();
    if (activeDocument.activeElement === ta) return;
    if (ta.value !== this.plugin.data.text) ta.value = this.plugin.data.text;
  }

  /** Keep the Session row in step with the timer (called by the plugin once a second while it runs). */
  refreshStatus(): void {
    const row = this.sessionSetting;
    if (!row || !row.settingEl.isConnected) return;
    const text = this.plugin.statusText();
    if (text !== this.lastStatus) {
      this.lastStatus = text;
      row.setDesc(text);
    }
    if (this.plugin.isRunning()) this.sessionBtn?.setButtonText("Stop").removeCta();
    else this.sessionBtn?.setButtonText("Start").setCta();
  }

  hide(): void {
    this.textarea = null;
    this.previewEl = null;
    this.sessionSetting = null;
    this.sessionBtn = null;
    this.previewSeq++;
    this.previewOwner?.unload();
    this.previewOwner = null;
    this.previewChild = null;
  }

  display(): void {
    const { containerEl } = this;
    this.hide();
    containerEl.empty();
    containerEl.addClass("dmsr-settings");
    this.previewOwner = new Component();
    this.previewOwner.load();

    // ---- Session control ----
    this.sessionSetting = new Setting(containerEl).setName("Session").addButton((b) => {
      this.sessionBtn = b;
      b.onClick(() => this.plugin.toggleSession());
    });
    this.lastStatus = "";
    this.refreshStatus();

    // ---- Checklist (the main thing, so it comes first) ----
    new Setting(containerEl).setName("Reminder checklist").setHeading();
    const help = containerEl.createEl("p", { cls: "setting-item-description" });
    help.appendText("Write whatever you like in Markdown. Lines starting with ");
    help.createEl("code", { text: "- [ ]" });
    help.appendText(
      " become checkboxes in the popup; press Tab to indent a line and nest it under another. Ticking a box in the popup changes it to ",
    );
    help.createEl("code", { text: "- [x]" });
    help.appendText(" here.");

    const ta = containerEl.createEl("textarea", { cls: "dmsr-textarea" });
    ta.value = this.plugin.data.text;
    ta.rows = 14;
    ta.maxLength = MAX_TEXT_LEN;
    ta.spellcheck = false;
    ta.placeholder = "- [ ] Something to remember\n  - [ ] A nested detail\n\nAny other notes, **bold**, headings, links...";
    ta.addEventListener("input", () => {
      this.plugin.onTextTyped(ta.value);
      this.renderPreviewSoon();
    });
    ta.addEventListener("keydown", (e) => this.handleTab(e, ta));
    this.textarea = ta;

    containerEl.createDiv({ cls: "dmsr-subtitle", text: "Preview (ticked items are greyed out and crossed out)" });
    this.previewEl = containerEl.createDiv({ cls: "dmsr-md markdown-rendered dmsr-preview" });
    void this.renderPreview();

    new Setting(containerEl)
      .setName("Untick all checkboxes")
      .setDesc("Resets every [x] to [ ], e.g. before the next game night.")
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          await this.plugin.updateText(resetAllChecks(this.plugin.data.text));
          this.syncText();
        }),
      );

    // ---- Popup options ----
    new Setting(containerEl).setName("Popup").setHeading();

    const intervalSetting = new Setting(containerEl)
      .setName("Reminder interval (minutes)")
      .setDesc(`How often the popup appears while a session is running (${MIN_INTERVAL}-${MAX_INTERVAL}).`);
    const intervalError = intervalSetting.infoEl.createDiv({ cls: "dmsr-error dmsr-hidden" });
    intervalSetting.addText((t) => {
      t.setPlaceholder("15")
        .setValue(String(this.plugin.data.intervalMinutes))
        .onChange(async (v) => {
          const n = Number(v);
          if (v.trim() === "" || !Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
            intervalError.setText(
              `Enter a whole number from ${MIN_INTERVAL} to ${MAX_INTERVAL}. The previous value is still in use.`,
            );
            intervalError.removeClass("dmsr-hidden");
            return;
          }
          intervalError.addClass("dmsr-hidden");
          await this.plugin.setIntervalMinutes(n);
        });
      // Leaving the field with something invalid puts the real value back.
      t.inputEl.addEventListener("blur", () => {
        t.setValue(String(this.plugin.data.intervalMinutes));
        intervalError.addClass("dmsr-hidden");
      });
    });

    new Setting(containerEl)
      .setName("Popup style")
      .setDesc("Floating card keeps working while it is visible. Modal blocks Obsidian until dismissed.")
      .addDropdown((d) =>
        d
          .addOption("card", "Floating card")
          .addOption("modal", "Blocking modal")
          .setValue(this.plugin.data.popupStyle)
          .onChange(async (v) => {
            this.plugin.data.popupStyle = v === "modal" ? "modal" : ("card" as PopupStyle);
            await this.plugin.saveData(this.plugin.data);
          }),
      );

    new Setting(containerEl)
      .setName("Flash the top bar")
      .setDesc("The red bar at the top of the popup blinks to catch your eye. Turn off to keep it solid red. Applies from the next popup.")
      .addToggle((t) =>
        t.setValue(this.plugin.data.flash).onChange(async (v) => {
          this.plugin.data.flash = v;
          await this.plugin.saveData(this.plugin.data);
        }),
      );

    new Setting(containerEl)
      .setName("Preview popup")
      .setDesc("Show the popup now to see how it looks. This does not affect a running session.")
      .addButton((b) => b.setButtonText("Show").onClick(() => this.plugin.previewPopup()));

    // ---- Help ----
    new Setting(containerEl).setName("How it works").setHeading();
    const list = containerEl.createEl("ul", { cls: "dmsr-help" });
    const tips = [
      "Start a session with the Start button above, the bell icon in the ribbon, or the command palette (\"Start reminders\"). You can give the commands hotkeys under Settings > Hotkeys.",
      "While a session runs, the popup appears at the interval you set. Tick what you have covered; ticked items stay put (crossed out) until the next popup, then they are tucked away behind \"Show completed items\".",
      "Snooze closes the popup and brings it back after one full interval. Disable ends the session. Your ticked boxes are kept either way.",
      "Closing the popup with the X or Esc counts as Snooze. If every box is ticked, closing it ends the session.",
      "A session ends when Obsidian closes, and the popup only appears inside Obsidian, so keep the window visible (a second monitor works well). The status bar countdown is not shown on mobile.",
    ];
    for (const t of tips) list.createEl("li", { text: t });
  }

  private async renderPreview(): Promise<void> {
    const el = this.previewEl;
    const owner = this.previewOwner;
    if (!el || !owner || !el.isConnected) return;
    const mine = ++this.previewSeq;
    const text = this.plugin.data.text;
    const child = new Component();
    owner.addChild(child);

    const tmp = createDiv();
    if (text.trim() === "") tmp.createDiv({ cls: "dmsr-empty", text: "Nothing to preview yet." });
    else await MarkdownRenderer.render(this.app, text, tmp, "", child);

    if (mine !== this.previewSeq || !el.isConnected) {
      owner.removeChild(child);
      return;
    }
    tmp.querySelectorAll("input").forEach((i) => (i.disabled = true));
    el.empty();
    el.append(...Array.from(tmp.childNodes));
    if (this.previewChild) owner.removeChild(this.previewChild);
    this.previewChild = child;
  }

  /** Tab indents the current line by two spaces and Shift+Tab outdents it, so nesting is easy to type. */
  private handleTab(e: KeyboardEvent, ta: HTMLTextAreaElement): void {
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const start = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
    if (e.shiftKey) {
      const m = /^ {1,2}/.exec(ta.value.slice(lineStart));
      if (!m) return;
      ta.setRangeText("", lineStart, lineStart + m[0].length, "preserve");
      ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start - m[0].length);
    } else {
      ta.setRangeText("  ", lineStart, lineStart, "preserve");
      ta.selectionStart = ta.selectionEnd = start + 2;
    }
    ta.dispatchEvent(new Event("input"));
  }
}
