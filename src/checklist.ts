/**
 * Pure helpers for the free-form Markdown checklist. The text is the single source of truth:
 * ticking a box rewrites "[ ]" to "[x]" in the text itself. No `obsidian` import.
 */

export const MAX_TEXT_LEN = 20000;

// A task line: optional blockquote markers, indentation, a bullet or number, then "[ ]" / "[x]".
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s)/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

export interface TaskRef {
  /** Zero-based line number in the text. */
  line: number;
  checked: boolean;
}

/** Task lines in document order, skipping fenced code blocks (which Markdown does not render as tasks). */
export function findTasks(text: string): TaskRef[] {
  const out: TaskRef[] = [];
  let fence: string | null = null;
  text.split("\n").forEach((ln, i) => {
    const f = FENCE_RE.exec(ln);
    if (f) {
      const ch = f[1][0];
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = TASK_RE.exec(ln);
    if (m) out.push({ line: i, checked: m[2] !== " " });
  });
  return out;
}

function withMark(line: string, checked: boolean): string {
  return line.replace(TASK_RE, (_all, a: string, _mark: string, c: string) => a + (checked ? "x" : " ") + c);
}

/** Set the nth task (document order) checked or unchecked. Other text, including line endings, is untouched. */
export function setTaskChecked(text: string, taskIndex: number, checked: boolean): string {
  const task = findTasks(text)[taskIndex];
  if (!task) return text;
  const lines = text.split("\n");
  lines[task.line] = withMark(lines[task.line], checked);
  return lines.join("\n");
}

export function resetAllChecks(text: string): string {
  const tasks = findTasks(text).filter((t) => t.checked);
  if (tasks.length === 0) return text;
  const lines = text.split("\n");
  for (const t of tasks) lines[t.line] = withMark(lines[t.line], false);
  return lines.join("\n");
}

export function taskStats(text: string): { total: number; done: number } {
  const tasks = findTasks(text);
  return { total: tasks.length, done: tasks.filter((t) => t.checked).length };
}

export const anyDone = (text: string) => taskStats(text).done > 0;
/** True only when there is at least one checkbox and all are ticked. */
export const allDone = (text: string) => {
  const s = taskStats(text);
  return s.total > 0 && s.done === s.total;
};

export function sanitizeText(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_TEXT_LEN) : "";
}

/** One-time migration of the old list-of-items format (v0.1 data.json) into checklist text. */
export function legacyItemsToText(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const lines: string[] = [];
  for (const r of raw.slice(0, 50)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const t = o.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (t) lines.push(`- [${o.done === true ? "x" : " "}] ${t}`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
