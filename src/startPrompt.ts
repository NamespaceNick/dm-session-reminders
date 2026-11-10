import { App, Modal } from "obsidian";

export type StartChoice = "keep" | "reset" | "cancel";

/** Asked when starting a session while some items are already ticked off. */
export class StartPrompt extends Modal {
  private chosen = false;

  constructor(app: App, private onChoice: (c: StartChoice) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Start reminders");
    this.contentEl.createEl("p", {
      text: "Some items are already ticked off from before. Keep that progress or reset everything?",
    });
    const row = this.contentEl.createDiv({ cls: "dmsr-buttons" });
    const keep = row.createEl("button", { text: "Keep progress", cls: "mod-cta" });
    keep.addEventListener("click", () => this.choose("keep"));
    const reset = row.createEl("button", { text: "Reset all items" });
    reset.addEventListener("click", () => this.choose("reset"));
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.choose("cancel"));
  }

  private choose(c: StartChoice): void {
    this.chosen = true;
    this.close();
    this.onChoice(c);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.onChoice("cancel");
  }
}
