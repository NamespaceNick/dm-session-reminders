/**
 * Link to the Initiative Tracker plugin (Obsidian-TTRPG-Community/initiative-tracker).
 *
 * Initiative Tracker has no public API for this, so this file is the ONE place that touches its internals:
 *  - `plugin.tracker.ordered` / `.state` / `.round` are Svelte stores (they have `subscribe`). We watch them to
 *    notice a creature's turn starting and rounds starting or ending.
 *  - Its menus are bare `new Menu()` objects shown with `showAtPosition`. We wrap that method once, recognise
 *    the creature menu and the tracker's top menu by their items, and append our own item.
 * Everything is defensive: if Initiative Tracker is missing, disabled or changes shape, this link quietly does
 * nothing and the rest of the plugin keeps working. No Initiative Tracker data is ever written, only read.
 */
import { App, Menu, Modal, Setting } from "obsidian";
import { CombatEvent, CombatWatcher, CreatureSnap, remindersForCreature, resolveCreatureByName } from "./reminders";
import type { Reminder } from "./settings";
import { MAX_TEXT_LEN } from "./checklist";

const IT_ID = "initiative-tracker";
export const CREATURE_MENU_TITLE = "Set DM Reminder";
export const ROUND_MENU_TITLE = "Set DM Round Reminder";

interface Store<T> {
  subscribe(run: (v: T) => void): () => void;
}
interface ITCreature {
  id?: unknown;
  name?: unknown;
  active?: unknown;
  getName?: () => unknown;
}
interface ITTracker {
  ordered?: Store<ITCreature[]>;
  state?: Store<boolean>;
  round?: Store<number>;
}

export type LinkStatus = "connected" | "not-found" | "unsupported";

export class InitiativeLink {
  private tracker: ITTracker | null = null;
  private unsubs: Array<() => void> = [];
  private creatures: CreatureSnap[] = [];
  private running = false;
  private round = -1;
  private watcher = new CombatWatcher();
  private disposed = false;
  private warned = false;
  private restoreMenu: (() => void) | null = null;
  private unsupported = false;

  constructor(
    private app: App,
    /** A creature's turn started, or a round started/ended. */
    private onEvent: (e: CombatEvent) => void,
    /** The user chose "Set DM Reminder" (creature is null when we could not tell which row it was). */
    private onSetReminder: (c: CreatureSnap | null) => void,
    /** The user chose "Set DM Round Reminder" in the tracker's top menu. */
    private onSetRoundReminder: () => void,
  ) {}

  // ---- lifecycle ----

  start(): void {
    this.patchMenu();
    this.rebind();
  }

  dispose(): void {
    this.disposed = true;
    this.unbind();
    this.restoreMenu?.();
    this.restoreMenu = null;
  }

  status(): LinkStatus {
    if (this.tracker) return "connected";
    return this.unsupported ? "unsupported" : "not-found";
  }

  /** Whether combat is currently running in the tracker. */
  combatRunning(): boolean {
    return this.tracker !== null && this.running;
  }

  /** Creatures currently in the tracker (empty when not connected). */
  currentCreatures(): CreatureSnap[] {
    return this.tracker ? this.creatures : [];
  }

  /**
   * Called about once a second. Initiative Tracker may load after us or be reloaded, and each load creates a
   * new tracker object, so we re-check instead of binding once.
   */
  rebind(): void {
    if (this.disposed) return;
    let found: ITTracker | null = null;
    try {
      const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, { tracker?: ITTracker }> } })
        .plugins?.plugins;
      found = plugins?.[IT_ID]?.tracker ?? null;
    } catch {
      found = null;
    }
    if (found === this.tracker) return;
    this.unbind();
    if (!found) return;
    if (typeof found.ordered?.subscribe !== "function" || typeof found.state?.subscribe !== "function") {
      this.unsupported = true;
      this.warnOnce("Initiative Tracker is installed but its internals look different from what this version expects.");
      return;
    }
    this.unsupported = false;
    this.tracker = found;
    this.watcher = new CombatWatcher();
    this.creatures = [];
    this.running = false;
    this.round = -1;
    try {
      this.unsubs.push(
        found.state.subscribe((v) => {
          this.running = v === true;
          this.check();
        }),
        found.ordered.subscribe((list) => {
          this.creatures = snapshot(list);
          this.check();
        }),
      );
      // The round counter is optional: without it only round reminders are unavailable.
      if (typeof found.round?.subscribe === "function") {
        this.unsubs.push(
          found.round.subscribe((n) => {
            this.round = typeof n === "number" && Number.isFinite(n) ? n : -1;
            this.check();
          }),
        );
      }
    } catch (e) {
      this.unbind();
      this.unsupported = true;
      this.warnOnce("Could not subscribe to Initiative Tracker: " + String(e));
    }
  }

  private unbind(): void {
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* the tracker is already gone */
      }
    }
    this.unsubs = [];
    this.tracker = null;
    this.creatures = [];
    this.running = false;
    this.round = -1;
  }

  private check(): void {
    if (this.disposed) return;
    for (const e of this.watcher.update(this.running, this.round, this.creatures)) {
      try {
        this.onEvent(e);
      } catch (err) {
        console.error("DM Session Reminders: reminder failed to show", err);
      }
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("DM Session Reminders: " + msg);
  }

  // ---- our items in Initiative Tracker's menus ----

  private patchMenu(): void {
    const proto = Menu.prototype as unknown as {
      showAtPosition: (this: Menu, position: unknown, doc?: Document) => Menu;
    };
    const original = proto.showAtPosition;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const patched = function (this: Menu, position: unknown, doc?: Document): Menu {
      try {
        if (!self.disposed) self.augment(this, position);
      } catch (e) {
        self.warnOnce("could not add the menu item: " + String(e));
      }
      return original.call(this, position, doc);
    };
    proto.showAtPosition = patched;
    this.restoreMenu = () => {
      // If something else wrapped us after we installed, leave the chain alone: `disposed` makes us a no-op.
      if (proto.showAtPosition === patched) proto.showAtPosition = original;
    };
  }

  private augment(menu: Menu, position: unknown): void {
    const items = (menu as unknown as { items?: unknown }).items;
    if (!Array.isArray(items)) return;
    const titles = items.map(itemTitle);
    // Fingerprints of Initiative Tracker's own menus. Every other menu is left alone.
    if (titles.includes("Set Health/Status") && titles.includes("Remove")) {
      if (titles.includes(CREATURE_MENU_TITLE)) return;
      const creature = this.creatureForPosition(position);
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle(CREATURE_MENU_TITLE).setIcon("bell").onClick(() => this.onSetReminder(creature)),
      );
    } else if (titles.includes("New Encounter") && titles.includes("Add Creatures") && titles.includes("Re-roll Initiatives")) {
      if (titles.includes(ROUND_MENU_TITLE)) return;
      menu.addSeparator();
      menu.addItem((item) => item.setTitle(ROUND_MENU_TITLE).setIcon("bell").onClick(() => this.onSetRoundReminder()));
    }
  }

  /** The three-dot button's row tells us which creature the menu is for. */
  private creatureForPosition(position: unknown): CreatureSnap | null {
    // Never let a lookup problem stop the menu item from appearing: with null the dialog just asks which creature.
    try {
      let el: Element | null = null;
      const t = (position as { target?: unknown } | null)?.target;
      // Duck-typed: `instanceof Element` fails for elements that live in a pop-out window.
      if (t && typeof (t as Element).closest === "function") el = t as Element;
      else {
        const p = position as { x?: unknown; y?: unknown } | null;
        if (p && typeof p.x === "number" && typeof p.y === "number") el = activeDocument.elementFromPoint(p.x, p.y);
      }
      const row = el?.closest(".initiative-tracker-creature") ?? null;
      if (!row) return null;
      const nameText = row.querySelector(".name-container .name")?.textContent ?? "";
      const rows = row.parentElement
        ? Array.from(row.parentElement.querySelectorAll(":scope > .initiative-tracker-creature"))
        : [];
      return resolveCreatureByName(this.currentCreatures(), nameText, rows.indexOf(row));
    } catch {
      return null;
    }
  }
}

function snapshot(list: unknown): CreatureSnap[] {
  if (!Array.isArray(list)) return [];
  const out: CreatureSnap[] = [];
  for (const c of list as ITCreature[]) {
    if (!c || typeof c !== "object") continue;
    let name = "";
    try {
      const n = typeof c.getName === "function" ? c.getName() : c.name;
      if (typeof n === "string") name = n;
    } catch {
      /* ignore */
    }
    out.push({ id: typeof c.id === "string" ? c.id : "", name, active: c.active === true });
  }
  return out;
}

function itemTitle(item: unknown): string {
  const o = item as { titleEl?: { textContent?: string | null }; dom?: { textContent?: string | null } } | null;
  return (o?.titleEl?.textContent ?? o?.dom?.textContent ?? "").trim();
}

// ---- dialogs ----

/** The message box shared by both dialogs. Returns the textarea; Ctrl/Cmd+Enter triggers `submit`. */
function messageBox(parent: HTMLElement, submit: () => void): HTMLTextAreaElement {
  const ta = parent.createEl("textarea", { cls: "dmsr-textarea" });
  ta.rows = 6;
  ta.maxLength = MAX_TEXT_LEN;
  ta.spellcheck = false;
  ta.placeholder = "What should you remember? Markdown works; '- [ ]' lines become checkboxes.\ne.g. - [ ] Use the lair action";
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
  return ta;
}

function existingList(el: HTMLElement, heading: string, rows: Reminder[], onRemove: (id: string) => void): void {
  el.empty();
  if (rows.length === 0) return;
  el.createDiv({ cls: "dmsr-subtitle", text: heading });
  for (const r of rows) {
    new Setting(el)
      .setName(r.name)
      .setDesc(r.enabled ? "On" : "Off")
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove this reminder").onClick(() => onRemove(r.id)),
      );
  }
}

function buttonRow(parent: HTMLElement, onSave: () => void, onCancel: () => void): void {
  const row = parent.createDiv({ cls: "dmsr-buttons" });
  row.createEl("button", { text: "Save reminder", cls: "mod-cta" }).addEventListener("click", onSave);
  row.createEl("button", { text: "Cancel" }).addEventListener("click", onCancel);
}

/** Dialog behind "Set DM Reminder": write the message, pick the creature, list what already exists for them. */
export class InitiativeReminderModal extends Modal {
  private selected: CreatureSnap | null;
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private creatures: CreatureSnap[],
    preselected: CreatureSnap | null,
    private getReminders: () => Reminder[],
    private onSave: (creature: CreatureSnap, text: string) => void,
    private onRemove: (id: string) => void,
  ) {
    super(app);
    this.selected = preselected ?? creatures[0] ?? null;
  }

  onOpen(): void {
    this.titleEl.setText("Set DM Reminder");
    const { contentEl } = this;
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "This pops up every time the chosen creature's turn starts in Initiative Tracker, until you remove or disable it.",
    });

    new Setting(contentEl).setName("Creature").addDropdown((d) => {
      this.creatures.forEach((c, i) => d.addOption(String(i), c.name || "(unnamed)"));
      const idx = this.selected ? this.creatures.indexOf(this.selected) : -1;
      if (idx >= 0) d.setValue(String(idx));
      d.onChange((v) => {
        this.selected = this.creatures[Number(v)] ?? null;
        this.renderExisting();
      });
    });

    const save = () => {
      if (!this.selected) return;
      if (ta.value.trim() === "") {
        ta.focus();
        return;
      }
      this.onSave(this.selected, ta.value);
      this.close();
    };
    const ta = messageBox(contentEl, save);
    this.listEl = contentEl.createDiv();
    this.renderExisting();
    buttonRow(contentEl, save, () => this.close());
    ta.focus();
  }

  private renderExisting(): void {
    if (!this.listEl || !this.selected) return;
    existingList(
      this.listEl,
      `Already set for ${this.selected.name}`,
      remindersForCreature(this.getReminders(), this.selected),
      (id) => {
        this.onRemove(id);
        this.renderExisting();
      },
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Dialog behind "Set DM Round Reminder": the message that shows at the start of every round. */
export class RoundReminderModal extends Modal {
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private getReminders: () => Reminder[],
    private onSave: (text: string) => void,
    private onRemove: (id: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Set DM Round Reminder");
    const { contentEl } = this;
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "This pops up at the start of every round while combat is running in Initiative Tracker, until you remove or disable it.",
    });

    const save = () => {
      if (ta.value.trim() === "") {
        ta.focus();
        return;
      }
      this.onSave(ta.value);
      this.close();
    };
    const ta = messageBox(contentEl, save);
    this.listEl = contentEl.createDiv();
    this.renderExisting();
    buttonRow(contentEl, save, () => this.close());
    ta.focus();
  }

  private renderExisting(): void {
    if (!this.listEl) return;
    existingList(
      this.listEl,
      "Already set for the start of each round",
      this.getReminders().filter((r) => r.kind === "round"),
      (id) => {
        this.onRemove(id);
        this.renderExisting();
      },
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
