import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { findTasks } from "./checklist";

export interface PopupHandlers {
  /** `taskIndex` is the position of the checkbox among all checkboxes in the text. */
  onToggle(taskIndex: number, done: boolean): void;
  onSnooze(): void;
  onStop(): void;
  /** Heading of the popup (the reminder's name). */
  title: string;
  /** Shown when every box is ticked (empty string hides it). */
  allDoneNote: string;
  /** Label and tooltip of the main dismiss button ("Snooze (15m)" for a timer, "Dismiss" for an initiative reminder). */
  getSnoozeLabel(): string;
  getSnoozeTip(): string;
  getDisableTip(): string;
}

export interface ReminderView {
  refresh(): void;
  /** Re-label the Snooze button (the interval setting changed) without re-rendering the list. */
  updateSnoozeLabel(): void;
  /** Programmatic teardown by the plugin. Never reports back through the handlers. */
  dispose(): void;
}

/**
 * Renders the reminder text as Markdown (through Obsidian's own sanitising renderer) and wires up the
 * checkboxes. Ticked items stay visible, crossed out, and can be unticked again.
 */
class ReminderRenderer {
  private seq = 0;
  private owner = new Component();
  private current: Component | null = null;
  /** Whether the "completed" section is expanded. Survives re-renders while this popup is open. */
  private showCompleted = false;
  private snoozeBtn: HTMLButtonElement | null = null;

  constructor(
    private app: App,
    private root: HTMLElement,
    private getText: () => string,
    private h: PopupHandlers,
    private titleId?: string,
  ) {
    this.owner.load();
  }

  refresh(): void {
    void this.render();
  }

  updateSnoozeLabel(): void {
    this.snoozeBtn?.setText(this.h.getSnoozeLabel());
    if (this.snoozeBtn) setTip(this.snoozeBtn, this.h.getSnoozeTip());
  }

  destroy(): void {
    this.seq++;
    this.owner.unload();
  }

  private async render(): Promise<void> {
    const mine = ++this.seq;
    const text = this.getText();
    const child = new Component();
    this.owner.addChild(child);

    // Build off-screen, then swap in, so a re-render never flashes or collapses the popup.
    const frag = createDiv();
    const title = frag.createDiv({ cls: "dmsr-title", text: this.h.title });
    if (this.titleId) title.id = this.titleId;
    const md = frag.createDiv({ cls: "dmsr-md markdown-rendered" });
    if (text.trim() === "") {
      md.createDiv({ cls: "dmsr-empty", text: "Nothing to show yet. Add your text in the plugin settings." });
    } else {
      await MarkdownRenderer.render(this.app, text, md, "", child);
    }
    if (mine !== this.seq) {
      this.owner.removeChild(child);
      return;
    }

    // Order: open items, then the completed section, then the toggle button. The card is anchored to the
    // bottom of the screen, so expanding the section grows it upward and the button stays where it is.
    const completed = frag.createDiv({ cls: "dmsr-completed dmsr-md markdown-rendered dmsr-hidden" });
    completed.createDiv({ cls: "dmsr-subtitle", text: "Completed" });
    const completedList = completed.createEl("ul", { cls: "contains-task-list" });
    const toggleRow = frag.createDiv({ cls: "dmsr-toggle-row dmsr-hidden" });
    const toggleBtn = toggleRow.createEl("button", { cls: "dmsr-toggle-done" });

    const note = frag.createDiv({
      cls: "dmsr-empty dmsr-hidden",
      text: this.h.allDoneNote,
    });
    const boxes = Array.from(md.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox"));
    const updateNote = () => note.toggleClass("dmsr-hidden", this.h.allDoneNote === "" || boxes.length === 0 || boxes.some((b) => !b.checked));

    // The rendered boxes map to the text's task lines by order. If the counts disagree (an unusual
    // construct we don't parse), make the boxes read-only rather than risk editing the wrong line.
    const mapped = boxes.length === findTasks(text).length;
    boxes.forEach((box, i) => {
      box.disabled = !mapped;
      if (!mapped) return;
      box.addEventListener("change", () => {
        const state = box.checked ? "x" : " ";
        box.setAttribute("data-task", state);
        const li = box.closest("li");
        if (li) {
          li.setAttribute("data-task", state);
          li.toggleClass("is-checked", box.checked);
        }
        updateNote();
        this.h.onToggle(i, box.checked);
      });
    });
    updateNote();

    // Hide what was already complete when the popup opened (boxes ticked from now on stay in place).
    // Done after wiring so each box keeps its index into the text.
    const moved = moveCompleted(md, completedList);
    if (moved > 0) {
      toggleRow.removeClass("dmsr-hidden");
      const sync = () => {
        completed.toggleClass("dmsr-hidden", !this.showCompleted);
        toggleBtn.setText(this.showCompleted ? "Hide completed items" : "Show completed items");
        toggleBtn.setAttribute("aria-expanded", String(this.showCompleted));
      };
      toggleBtn.addEventListener("click", () => {
        this.showCompleted = !this.showCompleted;
        sync();
      });
      sync();
    }

    const buttons = frag.createDiv({ cls: "dmsr-buttons" });
    const snooze = buttons.createEl("button", { text: this.h.getSnoozeLabel(), cls: "mod-cta" });
    this.snoozeBtn = snooze;
    setTip(snooze, this.h.getSnoozeTip());
    snooze.addEventListener("click", () => this.h.onSnooze());
    const stop = buttons.createEl("button", { text: "🔕 Disable", cls: "dmsr-stop" });
    setTip(stop, this.h.getDisableTip());
    stop.addEventListener("click", () => this.h.onStop());

    this.root.empty();
    this.root.append(...Array.from(frag.childNodes));
    if (this.current) this.owner.removeChild(this.current);
    this.current = child;
  }
}

/**
 * Tooltip via Obsidian's aria-label mechanism, forced to open ABOVE the element. The popup sits in a
 * screen corner, where the default placement would flip over the button and the mouse.
 */
function setTip(el: HTMLElement, text: string): void {
  el.setAttribute("aria-label", text);
  el.setAttribute("data-tooltip-position", "top");
}

/** The checkbox that belongs to this list item itself (not to a nested item). */
function ownBox(li: HTMLElement): HTMLInputElement | null {
  for (const b of Array.from(li.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox"))) {
    if (b.closest("li") === li) return b;
  }
  return null;
}

/**
 * Moves every fully completed checklist item (ticked, with everything nested under it ticked too) out of
 * the rendered list into `target`. A ticked parent with open children stays put so its context is kept.
 * Returns how many top-level items were moved.
 */
function moveCompleted(md: HTMLElement, target: HTMLElement): number {
  const isComplete = (li: HTMLElement) => {
    const own = ownBox(li);
    return !!own && own.checked && li.querySelector("input.task-list-item-checkbox:not(:checked)") === null;
  };
  const complete = new Set<HTMLElement>();
  md.querySelectorAll<HTMLElement>("li.task-list-item").forEach((li) => {
    if (isComplete(li)) complete.add(li);
  });
  const top = Array.from(complete).filter((li) => {
    const parent = li.parentElement?.closest("li");
    return !(parent && complete.has(parent as HTMLElement));
  });
  for (const li of top) target.append(li);
  // Lists emptied by the move would leave stray indentation.
  md.querySelectorAll("ul, ol").forEach((l) => {
    if (!l.querySelector(":scope > li")) l.addClass("dmsr-hidden");
  });
  return top.length;
}

/** Non-blocking card pinned to a screen corner. Does not take focus. */
export class ReminderCard implements ReminderView {
  private el: HTMLElement;
  private renderer: ReminderRenderer;

  constructor(app: App, getText: () => string, handlers: PopupHandlers, flash = true) {
    // Appear in whichever window is active (main window or a pop-out), like the modal does.
    this.el = activeDocument.body.createDiv({ cls: "dmsr-card" });
    const titleId = "dmsr-title-" + Math.random().toString(36).slice(2, 8);
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-labelledby", titleId); // not aria-label: Obsidian would show it as a tooltip
    this.el.createDiv({ cls: flash ? "dmsr-flash-bar" : "dmsr-flash-bar dmsr-steady" });
    const body = this.el.createDiv({ cls: "dmsr-body" });
    this.renderer = new ReminderRenderer(app, body, getText, handlers, titleId);
    this.renderer.refresh();
  }

  refresh(): void {
    this.renderer.refresh();
  }

  updateSnoozeLabel(): void {
    this.renderer.updateSnoozeLabel();
  }

  dispose(): void {
    this.renderer.destroy();
    this.el.remove();
  }
}

/** Blocking Obsidian modal. Dismissing it (Esc / the X) counts as a snooze. */
export class ReminderModal extends Modal implements ReminderView {
  private silent = false;
  private closed = false;
  private renderer: ReminderRenderer;

  constructor(app: App, getText: () => string, private handlers: PopupHandlers, flash = true) {
    super(app);
    this.modalEl.addClass("dmsr-modal");
    this.modalEl.prepend(createDiv({ cls: flash ? "dmsr-flash-bar" : "dmsr-flash-bar dmsr-steady" }));
    this.renderer = new ReminderRenderer(app, this.contentEl, getText, handlers);
    this.open();
  }

  onOpen(): void {
    this.renderer.refresh();
  }

  refresh(): void {
    this.renderer.refresh();
  }

  updateSnoozeLabel(): void {
    this.renderer.updateSnoozeLabel();
  }

  /**
   * Plugin-initiated close (silent). Do NOT override close(): Obsidian calls it for the X button, Esc and
   * clicks on the backdrop, and those user dismissals must reach onClose() as a snooze.
   */
  dispose(): void {
    if (this.closed) return;
    this.silent = true;
    this.close();
  }

  onClose(): void {
    this.closed = true;
    this.renderer.destroy();
    this.contentEl.empty();
    if (!this.silent) {
      this.silent = true;
      this.handlers.onSnooze();
    }
  }
}
