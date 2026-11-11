import { legacyItemsToText, sanitizeText } from "./checklist";

export type PopupStyle = "card" | "modal";
/**
 * "timer" pops up every N minutes during a session; "initiative" when a creature's turn starts;
 * "round" at the start of every combat round. The last two need the Initiative Tracker plugin.
 */
export type ReminderKind = "timer" | "initiative" | "round";

export interface Reminder {
  id: string;
  name: string;
  /** Persisted on/off switch. A timer reminder only counts down while a session is also running. */
  enabled: boolean;
  kind: ReminderKind;
  /** Timer reminders only. */
  intervalMinutes: number;
  /** Initiative reminders only: the creature's display name (e.g. "Goblin 2") and Initiative Tracker's id for it. */
  creatureName: string;
  creatureId: string;
  /** Free-form Markdown shown in the popup; "- [ ]" lines are interactive checkboxes. */
  text: string;
}

export interface PluginData {
  reminders: Reminder[];
  popupStyle: PopupStyle;
  /** Whether the red bar at the top of the popup flashes (otherwise it stays solid). */
  flash: boolean;
}

export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 240;
export const MAX_REMINDERS = 50;
export const MAX_NAME_LEN = 80;

export const DEFAULT_TEXT =
  "- [ ] Example: ask each player what their character wants this session\n" +
  "  - [ ] Press Tab in this box to indent a line and nest it like this\n" +
  "- [ ] Example: remind the table about the open quest\n";

export const DEFAULT_INTERVAL = 15;

export function clampInterval(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
}

export function newId(): string {
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function defaultName(kind: ReminderKind): string {
  if (kind === "timer") return "Timer reminder";
  if (kind === "initiative") return "Initiative reminder";
  return "Start of round";
}

export function createReminder(kind: ReminderKind, init: Partial<Reminder> = {}): Reminder {
  return {
    id: newId(),
    name: defaultName(kind),
    enabled: true,
    kind,
    intervalMinutes: DEFAULT_INTERVAL,
    creatureName: "",
    creatureId: "",
    text: kind === "timer" ? DEFAULT_TEXT : "",
    ...init,
  };
}

export function defaultData(): PluginData {
  return {
    reminders: [createReminder("timer", { name: "Session checklist" })],
    popupStyle: "card",
    flash: true,
  };
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function sanitizeReminder(raw: unknown, used: Set<string>): Reminder | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind: ReminderKind = o.kind === "initiative" || o.kind === "round" ? o.kind : "timer";
  let id = str(o.id, 64);
  if (id === "" || used.has(id)) id = newId();
  used.add(id);
  return {
    id,
    name: str(o.name, MAX_NAME_LEN) || defaultName(kind),
    enabled: o.enabled !== false,
    kind,
    intervalMinutes: clampInterval(o.intervalMinutes ?? DEFAULT_INTERVAL),
    creatureName: str(o.creatureName, MAX_NAME_LEN),
    creatureId: str(o.creatureId, 64),
    text: sanitizeText(o.text),
  };
}

/**
 * Validate untrusted loaded data into safe settings. Data from v0.1 (a single `text` + `intervalMinutes`,
 * or the even older `items` list) becomes one timer reminder.
 */
export function sanitizeData(raw: unknown): PluginData {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const popupStyle: PopupStyle = o.popupStyle === "modal" ? "modal" : "card";
  const flash = o.flash !== false;

  if (Array.isArray(o.reminders)) {
    const used = new Set<string>();
    const reminders: Reminder[] = [];
    for (const r of o.reminders.slice(0, MAX_REMINDERS)) {
      const clean = sanitizeReminder(r, used);
      if (clean) reminders.push(clean);
    }
    return { reminders, popupStyle, flash };
  }

  if (o.text === undefined && o.items === undefined && o.intervalMinutes === undefined) {
    return { ...defaultData(), popupStyle, flash };
  }
  let text = DEFAULT_TEXT;
  if (typeof o.text === "string") text = sanitizeText(o.text);
  else if (Array.isArray(o.items)) text = legacyItemsToText(o.items);
  return {
    reminders: [
      createReminder("timer", {
        name: "Session checklist",
        intervalMinutes: clampInterval(o.intervalMinutes ?? DEFAULT_INTERVAL),
        text,
      }),
    ],
    popupStyle,
    flash,
  };
}
