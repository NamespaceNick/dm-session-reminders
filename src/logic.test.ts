import { describe, expect, it } from "vitest";
import { ReminderTimer, formatRemaining } from "./timer";
import * as C from "./checklist";
import { DEFAULT_TEXT, MAX_REMINDERS, sanitizeData, clampInterval, createReminder } from "./settings";
import { CombatWatcher, reminderMatchesCreature, reminderMatchesRound, remindersForCreature, resolveCreatureByName, CreatureSnap } from "./reminders";

const MIN = 60_000;

describe("ReminderTimer", () => {
  it("does nothing until started", () => {
    const t = new ReminderTimer();
    expect(t.tick(10 * MIN)).toBe(false);
    expect(t.remaining(0)).toBeNull();
  });
  it("fires once after the interval and never stacks", () => {
    const t = new ReminderTimer();
    t.start(0, 5 * MIN);
    expect(t.tick(4 * MIN)).toBe(false);
    expect(t.remaining(4 * MIN)).toBe(MIN);
    expect(t.tick(5 * MIN)).toBe(true);
    expect(t.tick(6 * MIN)).toBe(false);
    expect(t.tick(60 * MIN)).toBe(false);
  });
  it("snooze waits one full interval from now", () => {
    const t = new ReminderTimer();
    t.start(0, 5 * MIN);
    t.tick(5 * MIN);
    t.snooze(8 * MIN, 5 * MIN);
    expect(t.tick(12 * MIN)).toBe(false);
    expect(t.tick(13 * MIN)).toBe(true);
  });
  it("stop disables everything", () => {
    const t = new ReminderTimer();
    t.start(0, MIN);
    t.tick(MIN);
    t.stop();
    expect(t.showing).toBe(false);
    expect(t.tick(100 * MIN)).toBe(false);
  });
  it("snooze while stopped does not start the timer", () => {
    const t = new ReminderTimer();
    t.snooze(0, MIN);
    expect(t.tick(10 * MIN)).toBe(false);
  });
  it("reschedule moves the next fire from now", () => {
    const t = new ReminderTimer();
    t.start(0, 10 * MIN);
    t.reschedule(2 * MIN, 3 * MIN);
    expect(t.tick(4 * MIN)).toBe(false);
    expect(t.tick(5 * MIN)).toBe(true);
  });
  it("formats remaining time", () => {
    expect(formatRemaining(65_000)).toBe("1:05");
    expect(formatRemaining(0)).toBe("0:00");
  });
});

const SAMPLE = [
  "# Notes",
  "- [ ] Magic items",
  "  - [x] Secrets",
  "    - [ ] deep one",
  "1. [ ] numbered",
  "> - [X] in a quote",
  "- plain bullet",
  "- [ ]",
  "```",
  "- [ ] inside code fence",
  "```",
  "- [ ] after fence",
].join("\n");

describe("checklist", () => {
  it("finds tasks in order, skipping code fences and non-tasks", () => {
    const t = C.findTasks(SAMPLE);
    expect(t.map((x) => x.checked)).toEqual([false, true, false, false, true, false]);
    expect(t.map((x) => x.line)).toEqual([1, 2, 3, 4, 5, 11]);
  });
  it("sets one task without touching anything else", () => {
    const out = C.setTaskChecked(SAMPLE, 0, true);
    expect(out.split("\n")[1]).toBe("- [x] Magic items");
    expect(out.replace("- [x] Magic items", "- [ ] Magic items")).toBe(SAMPLE);
    expect(C.setTaskChecked(SAMPLE, 1, false).split("\n")[2]).toBe("  - [ ] Secrets");
    expect(C.setTaskChecked(SAMPLE, 99, true)).toBe(SAMPLE);
  });
  it("preserves CRLF line endings", () => {
    const t = "- [ ] a\r\n  - [ ] b\r\n";
    expect(C.setTaskChecked(t, 1, true)).toBe("- [ ] a\r\n  - [x] b\r\n");
    expect(C.findTasks(t)).toHaveLength(2);
  });
  it("resets all checks, stats and done flags", () => {
    const reset = C.resetAllChecks(SAMPLE);
    expect(C.anyDone(reset)).toBe(false);
    expect(C.taskStats(SAMPLE)).toEqual({ total: 6, done: 2 });
    expect(C.allDone("")).toBe(false);
    expect(C.allDone("just text")).toBe(false);
    expect(C.allDone("- [x] a\n  - [x] b")).toBe(true);
    expect(C.allDone("- [x] a\n  - [ ] b")).toBe(false);
  });
  it("migrates the legacy items list", () => {
    const t = C.legacyItemsToText([
      { id: "1", text: "  Magic   Items ", done: true },
      { text: "Secrets", done: false },
      { text: "" },
      null,
    ]);
    expect(t).toBe("- [x] Magic Items\n- [ ] Secrets\n");
    expect(C.legacyItemsToText("nope")).toBe("");
  });
  it("caps text length and rejects non-strings", () => {
    expect(C.sanitizeText("a".repeat(C.MAX_TEXT_LEN + 5))).toHaveLength(C.MAX_TEXT_LEN);
    expect(C.sanitizeText(42)).toBe("");
  });
});

describe("settings", () => {
  it("clamps interval", () => {
    expect(clampInterval(0)).toBe(1);
    expect(clampInterval(9999)).toBe(240);
    expect(clampInterval("abc")).toBe(15);
  });
  it("gives fresh installs one starter timer reminder", () => {
    const d = sanitizeData(null);
    expect(d.reminders).toHaveLength(1);
    expect(d.reminders[0]).toMatchObject({ kind: "timer", enabled: true, intervalMinutes: 15, text: DEFAULT_TEXT });
    expect(d.popupStyle).toBe("card");
    expect(d.flash).toBe(true);
  });
  it("migrates v0.1 data (text + interval) into one timer reminder", () => {
    const d = sanitizeData({ intervalMinutes: "20", popupStyle: "evil", text: "- [ ] x", flash: false });
    expect(d.reminders).toHaveLength(1);
    expect(d.reminders[0]).toMatchObject({ kind: "timer", intervalMinutes: 20, text: "- [ ] x", name: "Session checklist" });
    expect(d.popupStyle).toBe("card");
    expect(d.flash).toBe(false);
    expect(sanitizeData({ popupStyle: "modal" }).popupStyle).toBe("modal");
  });
  it("migrates the oldest items list", () => {
    expect(sanitizeData({ items: [{ text: "a", done: true }] }).reminders[0].text).toBe("- [x] a\n");
    expect(sanitizeData({ items: [] }).reminders[0].text).toBe("");
    expect(sanitizeData({ text: 5, intervalMinutes: 5 }).reminders[0].text).toBe(DEFAULT_TEXT);
  });
  it("sanitizes a reminders list: junk dropped, ids unique, fields clamped", () => {
    const d = sanitizeData({
      reminders: [
        null,
        "x",
        { id: "a", kind: "initiative", creatureName: "Goblin 2", text: "t", enabled: false },
        { id: "a", kind: "bogus", intervalMinutes: 9999, name: 5, text: 7 },
      ],
    });
    expect(d.reminders).toHaveLength(2);
    expect(d.reminders[0]).toMatchObject({ id: "a", kind: "initiative", creatureName: "Goblin 2", enabled: false });
    expect(d.reminders[1].id).not.toBe("a");
    expect(d.reminders[1]).toMatchObject({ kind: "timer", intervalMinutes: 240, name: "Timer reminder", text: "" });
  });
  it("keeps an empty list empty and caps the count", () => {
    expect(sanitizeData({ reminders: [] }).reminders).toEqual([]);
    const many = Array.from({ length: MAX_REMINDERS + 10 }, () => ({ kind: "timer" }));
    expect(sanitizeData({ reminders: many }).reminders).toHaveLength(MAX_REMINDERS);
  });
});

const snap = (id: string, name: string, active = false): CreatureSnap => ({ id, name, active });

type Ev = ReturnType<CombatWatcher["update"]>;
const turns = (ev: Ev) =>
  ev.flatMap((e) => (e.type === "turn" ? [e.creature.name] : []));
const rounds = (ev: Ev) =>
  ev.flatMap((e) => (e.type === "round" ? ["round" + e.round] : []));

describe("combat events", () => {
  it("adopts the first snapshot without firing", () => {
    const w = new CombatWatcher();
    expect(w.update(true, 1, [snap("1", "Aria", true), snap("2", "Goblin")])).toEqual([]);
  });
  it("fires a turn once when the active creature changes, and not for unrelated updates", () => {
    const w = new CombatWatcher();
    w.update(true, 1, [snap("1", "Aria", true), snap("2", "Goblin")]);
    expect(w.update(true, 1, [snap("1", "Aria", true), snap("2", "Goblin")])).toEqual([]);
    expect(turns(w.update(true, 1, [snap("1", "Aria"), snap("2", "Goblin", true)]))).toEqual(["Goblin"]);
    expect(w.update(true, 1, [snap("1", "Aria"), snap("2", "Goblin", true)])).toEqual([]);
    expect(turns(w.update(true, 1, [snap("1", "Aria", true), snap("2", "Goblin")]))).toEqual(["Aria"]);
  });
  it("starting combat fires the start of the round, then the first turn", () => {
    const w = new CombatWatcher();
    w.update(false, 1, [snap("1", "Aria"), snap("2", "Goblin")]);
    const ev = w.update(true, 1, [snap("1", "Aria", true), snap("2", "Goblin")]);
    expect(rounds(ev)).toEqual(["round1"]);
    expect(turns(ev)).toEqual(["Aria"]);
    expect(ev[0].type).toBe("round");
  });
  it("a new round fires once, before the first creature's turn", () => {
    const w = new CombatWatcher();
    w.update(true, 1, [snap("1", "Aria"), snap("2", "Goblin", true)]);
    const ev = w.update(true, 2, [snap("1", "Aria", true), snap("2", "Goblin")]);
    expect(rounds(ev)).toEqual(["round2"]);
    expect(turns(ev)).toEqual(["Aria"]);
    expect(ev.map((e) => e.type)).toEqual(["round", "turn"]);
  });
  it("gives the same events when the round counter and the active creature update separately", () => {
    const w = new CombatWatcher();
    w.update(true, 1, [snap("1", "Aria"), snap("2", "Goblin", true)]);
    expect(rounds(w.update(true, 2, [snap("1", "Aria"), snap("2", "Goblin", true)]))).toEqual(["round2"]);
    expect(turns(w.update(true, 2, [snap("1", "Aria", true), snap("2", "Goblin")]))).toEqual(["Aria"]);
  });
  it("going back a round or stopping combat fires nothing round-related", () => {
    const w = new CombatWatcher();
    w.update(true, 3, [snap("1", "Aria", true)]);
    expect(rounds(w.update(true, 2, [snap("1", "Aria", true)]))).toEqual([]);
    expect(w.update(false, 2, [snap("1", "Aria", true)])).toEqual([]);
  });
  it("does not fire while combat is stopped, and re-arms after it restarts", () => {
    const w = new CombatWatcher();
    w.update(true, 1, [snap("1", "Aria", true)]);
    expect(w.update(false, 1, [snap("1", "Aria", true)])).toEqual([]);
    expect(turns(w.update(true, 1, [snap("1", "Aria", true)]))).toEqual(["Aria"]);
  });
  it("without a round counter (-1) only turns fire", () => {
    const w = new CombatWatcher();
    w.update(false, -1, [snap("1", "Aria")]);
    const ev = w.update(true, -1, [snap("1", "Aria", true)]);
    expect(rounds(ev)).toEqual([]);
    expect(turns(ev)).toEqual(["Aria"]);
  });
});

describe("round reminders", () => {
  it("match by kind and enabled flag", () => {
    const r = createReminder("round");
    expect(reminderMatchesRound(r)).toBe(true);
    expect(reminderMatchesRound({ ...r, enabled: false })).toBe(false);
    expect(reminderMatchesRound(createReminder("initiative"))).toBe(false);
  });
  it("sanitize keeps round reminders and ignores the old start/end field", () => {
    const d = sanitizeData({ reminders: [{ kind: "round", roundPoint: "end", text: "x" }] });
    expect(d.reminders[0]).toMatchObject({ kind: "round", name: "Start of round", text: "x" });
    expect(d.reminders[0]).not.toHaveProperty("roundPoint");
  });
});

describe("initiative matching", () => {
  const rem = (over: object) => createReminder("initiative", over);
  it("matches by id first, then by name ignoring case and spacing", () => {
    expect(reminderMatchesCreature(rem({ creatureId: "7", creatureName: "x" }), snap("7", "Other"))).toBe(true);
    expect(reminderMatchesCreature(rem({ creatureName: " goblin 2 " }), snap("9", "Goblin 2"))).toBe(true);
    expect(reminderMatchesCreature(rem({ creatureName: "Goblin 1" }), snap("9", "Goblin 2"))).toBe(false);
  });
  it("ignores disabled reminders, timer reminders and blank names", () => {
    expect(reminderMatchesCreature(rem({ creatureName: "A", enabled: false }), snap("1", "A"))).toBe(false);
    expect(reminderMatchesCreature(createReminder("timer", { creatureName: "A" }), snap("1", "A"))).toBe(false);
    expect(reminderMatchesCreature(rem({ creatureName: "" }), snap("", ""))).toBe(false);
  });
  it("lists a creature's reminders including disabled ones", () => {
    const a = rem({ creatureName: "A" });
    const b = rem({ creatureName: "A", enabled: false });
    const c = rem({ creatureName: "B" });
    expect(remindersForCreature([a, b, c], snap("1", "A"))).toEqual([a, b]);
  });
  it("resolves a row name to one creature, using the row position only to break ties", () => {
    const list = [snap("1", "Aria"), snap("2", "Goblin 1"), snap("3", "Goblin 1")];
    expect(resolveCreatureByName(list, "Aria")?.id).toBe("1");
    expect(resolveCreatureByName(list, "Goblin 1")).toBeNull();
    expect(resolveCreatureByName(list, "Goblin 1", 2)?.id).toBe("3");
    expect(resolveCreatureByName(list, "Goblin 1", 0)).toBeNull();
    expect(resolveCreatureByName(list, "")).toBeNull();
    expect(resolveCreatureByName(list, "Nobody")).toBeNull();
  });
});
