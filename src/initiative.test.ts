import { describe, expect, it, vi } from "vitest";

// A minimal stand-in for the obsidian module (it is types-only when running under vitest).
vi.mock("obsidian", () => {
  class Menu {
    items: Array<{ titleEl: { textContent: string } }> = [];
    shown = false;
    addItem(cb: (i: unknown) => void) {
      const item = {
        titleEl: { textContent: "" },
        setTitle(t: string) {
          this.titleEl.textContent = t;
          return this;
        },
        setIcon() {
          return this;
        },
        onClick() {
          return this;
        },
      };
      this.items.push(item);
      cb(item);
      return this;
    }
    addSeparator() {
      this.items.push({ titleEl: { textContent: "" } });
      return this;
    }
    showAtPosition() {
      this.shown = true;
      return this;
    }
  }
  class Modal {}
  class Setting {}
  return { Menu, Modal, Setting };
});

import { Menu } from "obsidian";
import { InitiativeLink } from "./initiative";
import type { CombatEvent } from "./reminders";

type Fake = {
  items: Array<{ titleEl: { textContent: string } }>;
  addItem: (cb: (i: unknown) => void) => unknown;
  showAtPosition: (p: unknown) => unknown;
  shown: boolean;
};

function store<T>(initial: T) {
  let v = initial;
  const subs = new Set<(x: T) => void>();
  return {
    subscribe(fn: (x: T) => void) {
      subs.add(fn);
      fn(v);
      return () => subs.delete(fn);
    },
    set(x: T) {
      v = x;
      subs.forEach((f) => f(v));
    },
    count: () => subs.size,
  };
}

function menuWith(titles: string[]): Fake {
  const m = new (Menu as unknown as new () => Fake)();
  for (const t of titles) m.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle(t));
  return m;
}
const titlesOf = (m: Fake) => m.items.map((i) => i.titleEl.textContent);
const noop = () => undefined;
const label = (e: CombatEvent) => (e.type === "turn" ? "turn:" + e.creature.name : "round" + e.round);

describe("InitiativeLink without Initiative Tracker", () => {
  it("does not throw and reports not-found for every app shape", () => {
    const shapes = [{}, { plugins: {} }, { plugins: { plugins: {} } }, { plugins: { plugins: { "initiative-tracker": {} } } }];
    for (const app of shapes) {
      const link = new InitiativeLink(app as never, noop, noop, noop);
      expect(() => {
        link.start();
        link.rebind();
      }).not.toThrow();
      expect(link.status()).toBe("not-found");
      expect(link.currentCreatures()).toEqual([]);
      expect(link.combatRunning()).toBe(false);
      link.dispose();
    }
  });
  it("reports unsupported when the tracker has a different shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    const app = { plugins: { plugins: { "initiative-tracker": { tracker: { ordered: {} } } } } };
    const link = new InitiativeLink(app as never, noop, noop, noop);
    link.start();
    expect(link.status()).toBe("unsupported");
    link.dispose();
    warn.mockRestore();
  });
});

describe("InitiativeLink with a fake tracker", () => {
  const creature = (id: string, name: string, active = false) => ({ id, name, active, getName: () => name });
  const make = () => {
    const ordered = store<unknown[]>([]);
    const state = store(false);
    const round = store(1);
    const app = { plugins: { plugins: { "initiative-tracker": { tracker: { ordered, state, round } } } } };
    const events: CombatEvent[] = [];
    const link = new InitiativeLink(app as never, (e) => events.push(e), noop, noop);
    link.start();
    return { ordered, state, round, link, events, app };
  };

  it("connects and emits round and turn events from the stores", () => {
    const { ordered, state, round, link, events } = make();
    expect(link.status()).toBe("connected");
    ordered.set([creature("1", "Aria"), creature("2", "Goblin")]);
    state.set(true);
    ordered.set([creature("1", "Aria", true), creature("2", "Goblin")]);
    expect(events.map(label)).toEqual(["round1", "turn:Aria"]);
    events.length = 0;
    ordered.set([creature("1", "Aria"), creature("2", "Goblin", true)]);
    round.set(2);
    ordered.set([creature("1", "Aria", true), creature("2", "Goblin")]);
    expect(events.map(label)).toEqual(["turn:Goblin", "round2", "turn:Aria"]);
    link.dispose();
  });
  it("unsubscribes on dispose", () => {
    const { ordered, link } = make();
    expect(ordered.count()).toBe(1);
    link.dispose();
    expect(ordered.count()).toBe(0);
  });
  it("rebinds when Initiative Tracker is reloaded (new tracker object)", () => {
    const { link, app, ordered } = make();
    const fresh = { ordered: store<unknown[]>([]), state: store(false) };
    (app.plugins.plugins["initiative-tracker"] as { tracker: unknown }).tracker = fresh;
    link.rebind();
    expect(link.status()).toBe("connected");
    expect(ordered.count()).toBe(0);
    expect(fresh.ordered.count()).toBe(1);
    link.dispose();
  });
  it("works when the tracker has no round counter (round reminders just never fire)", () => {
    const ordered = store<unknown[]>([]);
    const state = store(false);
    const app = { plugins: { plugins: { "initiative-tracker": { tracker: { ordered, state } } } } };
    const events: CombatEvent[] = [];
    const link = new InitiativeLink(app as never, (e) => events.push(e), noop, noop);
    link.start();
    ordered.set([creature("1", "Aria")]);
    state.set(true);
    ordered.set([creature("1", "Aria", true)]);
    expect(events.map((e) => e.type)).toEqual(["turn"]);
    link.dispose();
  });
});

describe("InitiativeLink menu patch", () => {
  it("adds our items only to Initiative Tracker's menus, and restores the method on dispose", () => {
    const proto = (Menu as unknown as { prototype: { showAtPosition: unknown } }).prototype;
    const before = proto.showAtPosition;
    const link = new InitiativeLink({} as never, noop, noop, noop);
    (globalThis as { activeDocument?: unknown }).activeDocument = { elementFromPoint: () => null };
    link.start();
    expect(proto.showAtPosition).not.toBe(before);

    const creatureMenu = menuWith(["Set Health/Status", "Edit", "Remove"]);
    creatureMenu.showAtPosition({ x: 1, y: 1 });
    expect(titlesOf(creatureMenu)).toContain("Set DM Reminder");
    creatureMenu.showAtPosition({ x: 1, y: 1 }); // shown twice: no duplicate
    expect(titlesOf(creatureMenu).filter((t) => t === "Set DM Reminder")).toHaveLength(1);

    const topMenu = menuWith(["New Encounter", "Add Creatures", "Reset HP / Status", "Re-roll Initiatives"]);
    topMenu.showAtPosition({ x: 1, y: 1 });
    expect(titlesOf(topMenu)).toContain("Set DM Round Reminder");
    expect(titlesOf(topMenu)).not.toContain("Set DM Reminder");

    const other = menuWith(["Open in new tab", "Delete"]);
    other.showAtPosition({ x: 1, y: 1 });
    expect(titlesOf(other)).toEqual(["Open in new tab", "Delete"]);

    link.dispose();
    expect(proto.showAtPosition).toBe(before);
    const after = menuWith(["Set Health/Status", "Remove"]);
    after.showAtPosition({ x: 1, y: 1 });
    expect(titlesOf(after)).not.toContain("Set DM Reminder");
  });
  it("never breaks the menu if our code throws", () => {
    const link = new InitiativeLink({} as never, noop, noop, noop);
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    link.start();
    const weird = menuWith(["Set Health/Status", "Remove"]);
    weird.addItem = () => {
      throw new Error("boom");
    };
    expect(() => weird.showAtPosition({ x: 1, y: 1 })).not.toThrow();
    expect(weird.shown).toBe(true);
    link.dispose();
    warn.mockRestore();
  });
});
