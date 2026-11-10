import { describe, expect, it } from "vitest";
import { ReminderTimer, formatRemaining } from "./timer";
import * as C from "./checklist";
import { DEFAULT_TEXT, sanitizeData, clampInterval } from "./settings";

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
  it("clamps interval and enums style", () => {
    expect(clampInterval(0)).toBe(1);
    expect(clampInterval(9999)).toBe(240);
    expect(clampInterval("abc")).toBe(15);
    const d = sanitizeData({ intervalMinutes: "20", popupStyle: "evil", text: "- [ ] x" });
    expect(d).toEqual({ intervalMinutes: 20, popupStyle: "card", flash: true, text: "- [ ] x" });
    expect(sanitizeData({ flash: false }).flash).toBe(false);
    expect(sanitizeData({ flash: "no" }).flash).toBe(true);
    expect(sanitizeData({ popupStyle: "modal" }).popupStyle).toBe("modal");
  });
  it("uses starter text for fresh installs and migrates old items", () => {
    expect(sanitizeData(null).text).toBe(DEFAULT_TEXT);
    expect(sanitizeData({ items: [{ text: "a", done: true }] }).text).toBe("- [x] a\n");
    expect(sanitizeData({ items: [] }).text).toBe("");
    expect(sanitizeData({ text: 5 }).text).toBe(DEFAULT_TEXT);
  });
});
