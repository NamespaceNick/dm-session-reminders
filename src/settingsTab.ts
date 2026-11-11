import { App, ButtonComponent, Component, MarkdownRenderer, PluginSettingTab, Setting, debounce } from "obsidian";
import type DMSessionReminders from "./main";
import { MAX_TEXT_LEN } from "./checklist";
import { MAX_INTERVAL, MAX_NAME_LEN, MIN_INTERVAL, PopupStyle, Reminder } from "./settings";

/** One reminder's block in the settings: name, switch, kind-specific field, text box with live preview. */
class ReminderEditor {
  private textarea: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private owner = new Component();
  private child: Component | null = null;
  private seq = 0;
  private statusEl: HTMLElement | null = null;
  private lastStatus = "";
  private renderPreviewSoon = debounce(() => void this.renderPreview(), 300, true);

  constructor(
    private app: App,
    private plugin: DMSessionReminders,
    private tab: ReminderSettingTab,
    private id: string,
    private container: HTMLElement,
  ) {
    this.owner.load();
  }

  private get r(): Reminder | undefined {
    return this.plugin.reminder(this.id);
  }

  destroy(): void {
    this.seq++;
    this.owner.unload();
    this.textarea = null;
    this.previewEl = null;
    this.statusEl = null;
  }

  /** Pull in text changed elsewhere (ticking a box in the popup), unless the user is typing in it. */
  syncText(): void {
    const ta = this.textarea;
    const r = this.r;
    if (!ta || !r || !ta.isConnected) return;
    this.renderPreviewSoon();
    if (activeDocument.activeElement === ta) return;
    if (ta.value !== r.text) ta.value = r.text;
  }

  refreshStatus(): void {
    const el = this.statusEl;
    if (!el || !el.isConnected) return;
    const text = this.plugin.reminderStatus(this.id);
    if (text !== this.lastStatus) {
      this.lastStatus = text;
      el.setText(text);
    }
  }

  render(open: boolean, onToggleOpen: (open: boolean) => void): void {
    const r = this.r;
    if (!r) return;
    const card = this.container.createDiv({ cls: "dmsr-reminder" });

    // Header: name, on/off, delete.
    new Setting(card)
      .setClass("dmsr-rem-head")
      .addText((t) => {
        t.setPlaceholder("Reminder name").setValue(r.name);
        t.inputEl.maxLength = MAX_NAME_LEN;
        t.inputEl.addClass("dmsr-name-input");
        t.onChange((v) => void this.plugin.renameReminder(this.id, v));
        t.inputEl.addEventListener("blur", () => t.setValue(this.r?.name ?? ""));
      })
      .addToggle((t) =>
        t
          .setValue(r.enabled)
          .setTooltip("Turn this reminder on or off")
          .onChange(async (v) => {
            await this.plugin.setEnabled(this.id, v);
            this.refreshStatus();
          }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Delete this reminder")
          .onClick(async () => {
            await this.plugin.deleteReminder(this.id);
            this.tab.refreshList();
          }),
      );

    // Kind-specific field.
    if (r.kind === "timer") {
      const s = new Setting(card).setName("Every (minutes)").setDesc(`While a session runs (${MIN_INTERVAL}-${MAX_INTERVAL}).`);
      const err = s.infoEl.createDiv({ cls: "dmsr-error dmsr-hidden" });
      s.addText((t) => {
        t.setPlaceholder("15").setValue(String(r.intervalMinutes));
        t.onChange(async (v) => {
          const n = Number(v);
          if (v.trim() === "" || !Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
            err.setText(`Enter a whole number from ${MIN_INTERVAL} to ${MAX_INTERVAL}. The previous value is still in use.`);
            err.removeClass("dmsr-hidden");
            return;
          }
          err.addClass("dmsr-hidden");
          await this.plugin.setIntervalMinutes(this.id, n);
          this.refreshStatus();
        });
        t.inputEl.addEventListener("blur", () => {
          t.setValue(String(this.r?.intervalMinutes ?? ""));
          err.addClass("dmsr-hidden");
        });
      });
    } else if (r.kind === "round") {
      new Setting(card)
        .setName("When")
        .setDesc("At the start of every round while combat is running in Initiative Tracker (including round 1).");
    } else {
      new Setting(card)
        .setName("Creature")
        .setDesc("Shows when this creature's turn starts in Initiative Tracker. Match the name as the tracker shows it, e.g. Goblin 2.")
        .addText((t) => {
          t.setPlaceholder("Creature name").setValue(r.creatureName);
          t.inputEl.maxLength = MAX_NAME_LEN;
          t.onChange(async (v) => {
            await this.plugin.setCreature(this.id, v);
            this.refreshStatus();
          });
        });
    }

    // Text box and preview, collapsed by default when there are several reminders.
    const details = card.createEl("details", { cls: "dmsr-details" });
    details.open = open;
    details.addEventListener("toggle", () => onToggleOpen(details.open));
    details.createEl("summary", { text: "Message / checklist" });
    const ta = details.createEl("textarea", { cls: "dmsr-textarea" });
    ta.value = r.text;
    ta.rows = 10;
    ta.maxLength = MAX_TEXT_LEN;
    ta.spellcheck = false;
    ta.placeholder = "- [ ] Something to remember\n  - [ ] A nested detail\n\nAny other notes, **bold**, headings, links...";
    ta.addEventListener("input", () => {
      this.plugin.onTextTyped(this.id, ta.value);
      this.renderPreviewSoon();
    });
    ta.addEventListener("keydown", (e) => handleTab(e, ta));
    this.textarea = ta;
    details.createDiv({ cls: "dmsr-subtitle", text: "Preview (ticked items are greyed out and crossed out)" });
    this.previewEl = details.createDiv({ cls: "dmsr-md markdown-rendered dmsr-preview" });
    void this.renderPreview();

    new Setting(details)
      .setName("Untick all checkboxes")
      .addButton((b) => b.setButtonText("Reset").onClick(() => void this.plugin.resetAll(this.id)));

    // Status and preview button.
    const foot = new Setting(card).setName("Status");
    this.statusEl = foot.descEl;
    this.lastStatus = "";
    this.refreshStatus();
    foot.addButton((b) =>
      b.setButtonText("Preview popup").onClick(() => {
        if ((this.r?.text ?? "").trim() === "") return;
        this.plugin.previewPopup(this.id);
      }),
    );
  }

  private async renderPreview(): Promise<void> {
    const el = this.previewEl;
    const r = this.r;
    if (!el || !r || !el.isConnected) return;
    const mine = ++this.seq;
    const child = new Component();
    this.owner.addChild(child);

    const tmp = createDiv();
    if (r.text.trim() === "") tmp.createDiv({ cls: "dmsr-empty", text: "Nothing to preview yet." });
    else await MarkdownRenderer.render(this.app, r.text, tmp, "", child);

    if (mine !== this.seq || !el.isConnected) {
      this.owner.removeChild(child);
      return;
    }
    tmp.querySelectorAll("input").forEach((i) => (i.disabled = true));
    el.empty();
    el.append(...Array.from(tmp.childNodes));
    if (this.child) this.owner.removeChild(this.child);
    this.child = child;
  }
}

export class ReminderSettingTab extends PluginSettingTab {
  private editors = new Map<string, ReminderEditor>();
  private listEl: HTMLElement | null = null;
  private openIds = new Set<string>();
  private sessionSetting: Setting | null = null;
  private sessionBtn: ButtonComponent | null = null;
  private linkSetting: Setting | null = null;
  private lastStatus = "";

  constructor(app: App, private plugin: DMSessionReminders) {
    super(app, plugin);
  }

  /** Pull in text changed elsewhere (ticking a box in the popup). */
  syncText(id: string): void {
    this.editors.get(id)?.syncText();
  }

  syncAllText(): void {
    for (const e of this.editors.values()) e.syncText();
  }

  /** Keep the status rows in step with the timers (called by the plugin once a second). */
  refreshStatus(): void {
    for (const e of this.editors.values()) e.refreshStatus();
    const row = this.sessionSetting;
    if (!row || !row.settingEl.isConnected) return;
    const text = this.plugin.statusText();
    if (text !== this.lastStatus) {
      this.lastStatus = text;
      row.setDesc(text);
    }
    if (this.plugin.isRunning()) this.sessionBtn?.setButtonText("Stop").removeCta();
    else this.sessionBtn?.setButtonText("Start").setCta();
    this.linkSetting?.setDesc(this.linkText());
  }

  private linkText(): string {
    switch (this.plugin.linkStatus()) {
      case "connected":
        return this.plugin.combatRunning()
          ? "Connected. Combat is running."
          : "Connected. Reminders fire once you start combat in the tracker.";
      case "unsupported":
        return "Initiative Tracker is installed but this version is not supported. Initiative reminders will not fire.";
      default:
        return "Initiative Tracker not found. Install and enable it to use initiative reminders.";
    }
  }

  hide(): void {
    for (const e of this.editors.values()) e.destroy();
    this.editors.clear();
    this.listEl = null;
    this.sessionSetting = null;
    this.sessionBtn = null;
    this.linkSetting = null;
  }

  /** Re-draw just the reminder list (after adding or deleting). */
  refreshList(): void {
    if (!this.listEl || !this.listEl.isConnected) return;
    this.renderList();
  }

  display(): void {
    const { containerEl } = this;
    this.hide();
    containerEl.empty();
    containerEl.addClass("dmsr-settings");

    // ---- Session control ----
    this.sessionSetting = new Setting(containerEl).setName("Session").addButton((b) => {
      this.sessionBtn = b;
      b.onClick(() => this.plugin.toggleSession());
    });
    this.lastStatus = "";

    this.linkSetting = new Setting(containerEl).setName("Initiative Tracker");

    // ---- Reminders ----
    new Setting(containerEl)
      .setName("Reminders")
      .setHeading()
      .addButton((b) =>
        b.setButtonText("Add timer reminder").onClick(async () => {
          const r = await this.plugin.addReminder("timer", { text: "" });
          if (r) this.openIds.add(r.id);
          this.refreshList();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Add initiative reminder").onClick(async () => {
          const r = await this.plugin.addReminder("initiative");
          if (r) this.openIds.add(r.id);
          this.refreshList();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Add round reminder").onClick(async () => {
          const r = await this.plugin.addReminder("round");
          if (r) this.openIds.add(r.id);
          this.refreshList();
        }),
      );
    const help = containerEl.createEl("p", { cls: "setting-item-description" });
    help.appendText("Each reminder has its own message, on/off switch and trigger. A ");
    help.createEl("strong", { text: "timer" });
    help.appendText(" reminder pops up every N minutes while a session runs. An ");
    help.createEl("strong", { text: "initiative" });
    help.appendText(
      " reminder pops up each time a creature's turn starts in Initiative Tracker (also available from the three-dot menu next to a creature there: Set DM Reminder). A ",
    );
    help.createEl("strong", { text: "round" });
    help.appendText(
      " reminder pops up at the start of every combat round (from the three-dot menu at the top of the tracker: Set DM Round Reminder). Message lines starting with ",
    );
    help.createEl("code", { text: "- [ ]" });
    help.appendText(" become checkboxes; press Tab in a text box to indent.");

    this.listEl = containerEl.createDiv({ cls: "dmsr-reminder-list" });
    this.renderList();

    // ---- Popup options ----
    new Setting(containerEl).setName("Popup").setHeading();

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
      .setName("Untick all checkboxes")
      .setDesc("Resets every [x] to [ ] in every reminder, e.g. before the next game night.")
      .addButton((b) => b.setButtonText("Reset all").onClick(() => void this.plugin.resetEverything()));

    new Setting(containerEl)
      .setName("Remove all initiative reminders")
      .setDesc("Handy between combats: they are tied to specific creatures and would otherwise fire for same-named creatures later.")
      .addButton((b) =>
        b.setWarning().setButtonText("Remove").onClick(async () => {
          await this.plugin.deleteInitiativeReminders();
          this.refreshList();
        }),
      );

    // ---- Help ----
    new Setting(containerEl).setName("How it works").setHeading();
    const list = containerEl.createEl("ul", { cls: "dmsr-help" });
    const tips = [
      "Start a session with the Start button above, the bell icon in the ribbon, or the command palette (\"Start reminders\"). Every turned-on timer reminder then counts down on its own clock. You can give the commands hotkeys under Settings > Hotkeys.",
      "Initiative and round reminders do not need a session. They fire while combat is running in Initiative Tracker, each time that creature's turn starts or each round starts, with a fresh unticked checklist. They need the Initiative Tracker plugin; without it they stay inactive and everything else still works.",
      "Only one popup shows at a time. If several are due together, the others wait their turn.",
      "Snooze closes a timer popup and brings it back after that reminder's full interval. Dismiss closes an initiative popup. Disable turns that one reminder off. Ticked boxes are kept either way.",
      "Closing a timer popup with the X or Esc counts as Snooze. If every box in it is ticked, closing it turns that reminder off.",
      "A session ends when Obsidian closes, and the popup only appears inside Obsidian, so keep the window visible (a second monitor works well). The status bar countdown is not shown on mobile.",
    ];
    for (const t of tips) list.createEl("li", { text: t });

    this.refreshStatus();
  }

  private renderList(): void {
    const el = this.listEl;
    if (!el) return;
    for (const e of this.editors.values()) e.destroy();
    this.editors.clear();
    el.empty();
    const rs = this.plugin.data.reminders;
    if (rs.length === 0) {
      el.createDiv({ cls: "dmsr-empty", text: "No reminders yet. Add one with the buttons above." });
      return;
    }
    for (const r of rs) {
      const ed = new ReminderEditor(this.app, this.plugin, this, r.id, el);
      this.editors.set(r.id, ed);
      ed.render(rs.length === 1 || this.openIds.has(r.id), (open) => {
        if (open) this.openIds.add(r.id);
        else this.openIds.delete(r.id);
      });
    }
  }
}

/** Tab indents the current line by two spaces and Shift+Tab outdents it, so nesting is easy to type. */
function handleTab(e: KeyboardEvent, ta: HTMLTextAreaElement): void {
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
