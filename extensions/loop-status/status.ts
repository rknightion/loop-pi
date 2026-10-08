// Pure formatting for the root status line. No pi imports, so it is unit-testable on its own.

export interface StatusInput {
  /** Async lanes this session launched that have not completed. */
  lanes: number;
  /** Armed loop-wait timers, or null when loop-wait did not reply. */
  timers: { at: string }[] | null;
  /** Active loop-wait watchers, or null when loop-wait did not reply. */
  watchers: { deadline?: string }[] | null;
  /** Nudges sent in the current unbroken continuation chain, or null when no state is recorded. */
  nudges: number | null;
  /** The continuation chain's cap. */
  maxNudges: number;
  /** Epoch ms of the last recorded heartbeat, or null when none is readable. */
  heartbeatAt: number | null;
  now: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `45s`, `7m`, `2h05m`: the age as of `now`, never negative. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Local `HH:MM`. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The earliest valid deadline across timers and watchers, as epoch ms, or null. */
export function nextDeadline(timers: { at: string }[] | null, watchers: { deadline?: string }[] | null): number | null {
  let next: number | null = null;
  for (const raw of [...(timers ?? []).map((t) => t.at), ...(watchers ?? []).map((w) => w.deadline)]) {
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (Number.isFinite(ms) && (next === null || ms < next)) next = ms;
  }
  return next;
}

export function formatStatus(input: StatusInput): string {
  const parts = [plural(input.lanes, "lane")];
  parts.push(input.timers === null ? "timers ?" : plural(input.timers.length, "timer"));
  parts.push(input.watchers === null ? "watchers ?" : plural(input.watchers.length, "watcher"));
  const next = nextDeadline(input.timers, input.watchers);
  if (next !== null) parts.push(`next ${clock(next)}`);
  parts.push(`nudge ${input.nudges ?? 0}/${input.maxNudges}`);
  parts.push(input.heartbeatAt === null ? "hb -" : `hb ${formatAge(input.now - input.heartbeatAt)} ago`);
  return `loop: ${parts.join(" · ")}`;
}
