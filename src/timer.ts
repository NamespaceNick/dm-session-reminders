/** Pure scheduler state machine. Time is injected so it can be tested without real timers. */
export class ReminderTimer {
  running = false;
  showing = false;
  private nextFireAt = 0;

  start(now: number, intervalMs: number): void {
    this.running = true;
    this.showing = false;
    this.nextFireAt = now + intervalMs;
  }

  stop(): void {
    this.running = false;
    this.showing = false;
  }

  /** Dismiss the popup and wait one full interval. */
  snooze(now: number, intervalMs: number): void {
    this.showing = false;
    if (this.running) this.nextFireAt = now + intervalMs;
  }

  /** Reschedule from now (e.g. interval setting changed). */
  reschedule(now: number, intervalMs: number): void {
    if (this.running && !this.showing) this.nextFireAt = now + intervalMs;
  }

  /** Returns true exactly once when a popup should be shown. Never stacks a second popup. */
  tick(now: number): boolean {
    if (!this.running || this.showing) return false;
    if (now >= this.nextFireAt) {
      this.showing = true;
      return true;
    }
    return false;
  }

  /** Milliseconds until the next popup, or null if not counting down. */
  remaining(now: number): number | null {
    if (!this.running || this.showing) return null;
    return Math.max(0, this.nextFireAt - now);
  }
}

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
