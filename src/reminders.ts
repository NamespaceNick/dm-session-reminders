/**
 * Pure helpers for initiative reminders. No `obsidian` import, unit-tested.
 */
import type { Reminder } from "./settings";

/** The few things we read from an Initiative Tracker creature. */
export interface CreatureSnap {
  id: string;
  /** Display name as Initiative Tracker shows it (includes the number for duplicates, e.g. "Goblin 2"). */
  name: string;
  active: boolean;
}

export type CombatEvent =
  | { type: "turn"; creature: CreatureSnap }
  | { type: "round"; round: number };

/**
 * Turns successive snapshots of the tracker into combat events: a creature's turn starting, and a round
 * starting. The first snapshot is only adopted (binding to a combat already in progress must not
 * fire popups). `round` is -1 when the tracker's round counter is unavailable, which disables round events.
 *
 * Starting combat counts as the start of its round, and so does the round counter ticking up. The round event
 * comes out before the turn event of the creature who goes first. Stopping fires nothing.
 */
export class CombatWatcher {
  private seen = false;
  private prevRunning = false;
  private prevRound = -1;
  private prevActive: string | null = null;

  update(running: boolean, round: number, creatures: CreatureSnap[]): CombatEvent[] {
    const events: CombatEvent[] = [];
    const active = running ? (creatures.find((c) => c.active) ?? null) : null;
    const key = active ? active.id || active.name : null;
    if (this.seen) {
      if (running && round >= 0) {
        if (!this.prevRunning) events.push({ type: "round", round });
        else if (this.prevRound >= 0 && round > this.prevRound) events.push({ type: "round", round });
      }
      if (active && key !== this.prevActive) events.push({ type: "turn", creature: active });
    }
    this.seen = true;
    this.prevRunning = running;
    this.prevRound = round;
    this.prevActive = key;
    return events;
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Does this initiative reminder belong to this creature? Id wins; the name is the fallback (saved encounters get new ids). */
export function reminderMatchesCreature(r: Reminder, c: CreatureSnap): boolean {
  if (r.kind !== "initiative" || !r.enabled) return false;
  if (r.creatureId !== "" && c.id !== "" && r.creatureId === c.id) return true;
  return r.creatureName.trim() !== "" && norm(r.creatureName) === norm(c.name);
}

/** Is this an enabled round reminder? */
export function reminderMatchesRound(r: Reminder): boolean {
  return r.kind === "round" && r.enabled;
}

/** Reminders (enabled or not) attached to a creature, for listing in the "Set DM Reminder" dialog. */
export function remindersForCreature(all: Reminder[], c: CreatureSnap): Reminder[] {
  return all.filter(
    (r) =>
      r.kind === "initiative" &&
      ((r.creatureId !== "" && c.id !== "" && r.creatureId === c.id) ||
        (r.creatureName.trim() !== "" && norm(r.creatureName) === norm(c.name))),
  );
}

/**
 * Work out which creature a row's name text refers to. `rowIndex` is the row's position among the visible rows,
 * used only to break a tie between creatures that share a name.
 */
export function resolveCreatureByName(
  creatures: CreatureSnap[],
  text: string,
  rowIndex = -1,
): CreatureSnap | null {
  const t = norm(text);
  if (t === "") return null;
  const hits = creatures.filter((c) => norm(c.name) === t);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && rowIndex >= 0 && norm(creatures[rowIndex]?.name ?? "") === t) return creatures[rowIndex];
  return null;
}
