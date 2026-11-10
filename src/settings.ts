import { legacyItemsToText, sanitizeText } from "./checklist";

export type PopupStyle = "card" | "modal";

export interface PluginData {
  intervalMinutes: number;
  popupStyle: PopupStyle;
  /** Whether the red bar at the top of the popup flashes (otherwise it stays solid). */
  flash: boolean;
  /** Free-form Markdown shown in the popup; "- [ ]" lines are interactive checkboxes. */
  text: string;
}

export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 240;

export const DEFAULT_TEXT =
  "- [ ] Example: ask each player what their character wants this session\n" +
  "  - [ ] Press Tab in this box to indent a line and nest it like this\n" +
  "- [ ] Example: remind the table about the open quest\n";

export const DEFAULTS: PluginData = {
  intervalMinutes: 15,
  popupStyle: "card",
  flash: true,
  text: DEFAULT_TEXT,
};

export function clampInterval(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return DEFAULTS.intervalMinutes;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
}

/** Validate untrusted loaded data into safe settings (migrating the old `items` list if present). */
export function sanitizeData(raw: unknown): PluginData {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let text = DEFAULT_TEXT;
  if (typeof o.text === "string") text = sanitizeText(o.text);
  else if (Array.isArray(o.items)) text = legacyItemsToText(o.items);
  return {
    intervalMinutes: clampInterval(o.intervalMinutes ?? DEFAULTS.intervalMinutes),
    popupStyle: o.popupStyle === "modal" ? "modal" : "card",
    flash: o.flash !== false,
    text,
  };
}
