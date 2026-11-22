// The root's program status (OSC 7501), as Orca and other supporting terminals read it.
//
// pi's interactive mode reports its own state through `terminal.setProgramStatus`: `working` during
// a run, then `done` (or `error`, or `idle` after an abort) once the run settles. A loop root
// settles every time it goes back to waiting on lanes, timers or watchers, so the terminal would see
// a finished task, and raise its "task complete" notice, on every wake cycle. This module wraps that
// one method on pi's terminal and decides what an armed root's resting report means; it never writes
// a root report of its own, so nothing pi sends in between can flash `done` (SEAMS.md "Loop status
// line"). Each live lane is also reported as a child record so the terminal can list it.
//
// A rebuild between pi's reports sends a `working` decision (a new note) at once, but one that
// leaves `working` only after REBUILD_HOLD_MS with no report from pi: when the last lane finishes,
// pi-subagents holds its completion notice for up to a second before it wakes the root, and a
// rebuild in that gap must not tell the owner the loop stopped. Something that ends without waking
// the root (a run below a lane, say) still reaches the owner once the hold has passed.
import type { ProgramStatus, Terminal, TUI } from "@earendil-works/pi-tui";
import { clock, nextDeadline } from "./status.ts";

/** What the root's loop is waiting on, read when pi reports and again whenever the status line is rebuilt. */
export interface LoopFacts {
  /** A launch is armed in this session (loop-continuation answered a `reportPath`). */
  armed: boolean;
  /** The launch's closeout report counts: the loop is finished. */
  closed: boolean;
  /** This session's live async lanes. */
  lanes: number;
  /** Live runs below those lanes. */
  nested: number;
  timers: { at: string }[] | null;
  watchers: { deadline?: string }[] | null;
  /** Epoch ms of loop-continuation's pending automatic resume, or null. */
  resumeDueAt: number | null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line naming what the loop waits on, or null when it waits on nothing. */
export function waitingNote(facts: LoopFacts): string | null {
  const parts: string[] = [];
  if (facts.lanes > 0) parts.push(plural(facts.lanes, "lane") + (facts.nested > 0 ? ` (+${facts.nested} nested)` : ""));
  else if (facts.nested > 0) parts.push(plural(facts.nested, "nested run"));
  if (facts.timers?.length) parts.push(plural(facts.timers.length, "timer"));
  if (facts.watchers?.length) parts.push(plural(facts.watchers.length, "watcher"));
  if (parts.length === 0) return null;
  const next = nextDeadline(facts.timers, facts.watchers);
  return `Loop waiting on ${parts.join(", ")}${next === null ? "" : `, next ${clock(next)}`}`;
}

export const OWNER_NEEDED_MESSAGE = "Loop stopped: waiting for the owner";
/** How long after a due automatic resume the root's report is decided again; a resume due longer ago than this is stale. */
export const RESUME_RECHECK_GRACE_MS = 5_000;
/** How long a rebuild that would leave `working` waits for pi's own report first (pi-subagents batches wakes for up to 1 s). */
export const REBUILD_HOLD_MS = 3_000;

/** A resume loop-continuation still means to send, as epoch ms, or null. */
function liveResume(facts: LoopFacts): number | null {
  const due = facts.resumeDueAt;
  return due !== null && due + RESUME_RECHECK_GRACE_MS > Date.now() ? due : null;
}

/**
 * The report an armed loop root sends in place of pi's own. Only a resting `done`, and an `error` or
 * `idle` that loop-continuation will retry, is changed: `working` and `blocked` are pi's to report,
 * any other `idle` follows an owner's abort, and a closed loop's `done` is the real finish.
 */
export function loopProgramStatus(raw: ProgramStatus, facts: LoopFacts): ProgramStatus {
  if (!facts.armed || facts.closed) return raw;
  const app = raw.app === undefined ? {} : { app: raw.app };
  if (raw.state === "error" || raw.state === "idle") {
    const due = liveResume(facts);
    if (due === null) return raw;
    return { state: "working", ...app, message: `Loop retrying at ${clock(due)}` };
  }
  if (raw.state !== "done") return raw;
  const note = waitingNote(facts);
  if (note) return { state: "working", ...app, message: note };
  return { state: "blocked", kind: "question", ...app, message: OWNER_NEEDED_MESSAGE };
}

const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;

/** A child record id the protocol accepts (one segment, `[A-Za-z0-9_.+-]{1,32}`), stable for a run id. */
export function childId(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9_.+-]/g, "_");
  if (SEGMENT_RE.test(clean)) return clean;
  let hash = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) hash = Math.imul(hash ^ runId.charCodeAt(i), 0x01000193) >>> 0;
  return `${hash.toString(16).padStart(8, "0")}-${clean.slice(-23)}`;
}

const TITLE_MAX_BYTES = 192;
// C0, DEL and C1 controls: the protocol discards a report whose decoded text holds any.
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

function encodeText(text: string, maxBytes: number): string {
  let out = "";
  for (const char of text.replace(CONTROL_RE, " ").trim()) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return out ? Buffer.from(out, "utf8").toString("base64") : "";
}

/** A child record: `working` while the lane runs, `clear` once it has ended. */
export function formatChildStatus(runId: string, state: "working" | "clear", title?: string): string {
  const pairs = [`id=${childId(runId)}`, `state=${state}`];
  const encoded = state === "working" && title ? encodeText(title, TITLE_MAX_BYTES) : "";
  if (encoded) pairs.push(`title=${encoded}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

type ReportingTerminal = Terminal & { programStatusSupported?: unknown; writeProgramStatus?: unknown };
const WRAPPED = Symbol.for("loop-pi.loop-status.program-status");
type Wrapped = ReportingTerminal & { [WRAPPED]?: ProgramStatusWrapper };

/** Owns the wrap on one pi terminal. `facts` is read synchronously, inside pi's own report. */
export class ProgramStatusWrapper {
  private raw: ProgramStatus | null = null;
  private lastSent: string | null = null;
  private readonly children = new Map<string, string | undefined>();
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly terminal: Wrapped;
  private readonly original: (status: ProgramStatus) => void;
  private facts: () => LoopFacts;

  constructor(terminal: Wrapped, original: (status: ProgramStatus) => void, facts: () => LoopFacts) {
    this.terminal = terminal;
    this.original = original;
    this.facts = facts;
  }

  /** A reloaded extension instance takes over the wrap that outlived its predecessor. */
  setFacts(facts: () => LoopFacts): void {
    this.facts = facts;
  }

  /** pi's reporter calls this through the wrapped method. */
  report(status: ProgramStatus): void {
    this.raw = status;
    this.recheck();
  }

  /**
   * Re-decide pi's last report after a status-line rebuild. A `working` decision is sent at once;
   * one that leaves `working` is sent after REBUILD_HOLD_MS unless pi reports first.
   */
  refresh(): void {
    const raw = this.raw;
    if (!raw) return;
    const status = this.decide(raw);
    if (status.state === "working") {
      this.clearHold();
      this.send(status);
      return;
    }
    if (JSON.stringify(status) === this.lastSent || this.holdTimer) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.raw === raw) this.recheck();
    }, REBUILD_HOLD_MS);
    this.holdTimer.unref?.();
  }

  /** Re-decide pi's last report with every outcome allowed, and arm the check after a due resume. */
  private recheck(): void {
    if (!this.raw) return;
    this.clearRecheck();
    const facts = this.readFacts(this.raw);
    this.send(facts ? loopProgramStatus(this.raw, facts) : this.raw);
    // A due resume that never runs (dropped, cancelled) starts no turn: decide again once it is due.
    const due = facts && (this.raw.state === "error" || this.raw.state === "idle") ? liveResume(facts) : null;
    if (due !== null) {
      this.recheckTimer = setTimeout(() => {
        this.recheckTimer = null;
        this.recheck();
      }, Math.max(0, due - Date.now()) + RESUME_RECHECK_GRACE_MS);
      this.recheckTimer.unref?.();
    }
  }

  /** Report each lane as a child record; ended lanes are cleared, never left as unread `done`. */
  laneStarted(runId: string, title?: string): void {
    if (this.children.has(runId)) return;
    this.children.set(runId, title);
    this.writeChild(runId, "working", title);
  }

  laneEnded(runId: string): void {
    if (!this.children.delete(runId)) return;
    this.writeChild(runId, "clear");
  }

  /** Match the child records to the live lanes: start the missing ones, clear the ended ones. */
  syncLanes(live: Map<string, string | undefined>): void {
    for (const [runId, title] of live) this.laneStarted(runId, title);
    for (const runId of [...this.children.keys()]) if (!live.has(runId)) this.laneEnded(runId);
  }

  /** Drop every child record this wrapper reported, and the pending check, for session shutdown. */
  clearLanes(): void {
    this.clearRecheck();
    for (const runId of this.children.keys()) this.writeChild(runId, "clear");
    this.children.clear();
  }

  private clearRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    this.clearHold();
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /**
   * Send the running lanes again. pi-tui re-sends its root report through `writeProgramStatus` when the
   * terminal confirms support and when it restarts after a suspend or an external editor; the wrap
   * calls this right after, so the child records follow the root's.
   */
  resendLanes(): void {
    for (const [runId, title] of this.children) this.writeChild(runId, "working", title);
  }

  private decide(status: ProgramStatus): ProgramStatus {
    const facts = this.readFacts(status);
    return facts ? loopProgramStatus(status, facts) : status;
  }

  /** Only a resting report can change, so the facts (file reads) are read only then. */
  private readFacts(status: ProgramStatus): LoopFacts | null {
    if (status.state !== "done" && status.state !== "error" && status.state !== "idle") return null;
    try {
      return this.facts();
    } catch {
      // A fact that cannot be read leaves pi's own report untouched.
      return null;
    }
  }

  private send(status: ProgramStatus): void {
    const key = JSON.stringify(status);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.original(status);
  }

  private writeChild(runId: string, state: "working" | "clear", title?: string): void {
    // Only once the terminal confirmed the protocol (or PI_PROGRAM_STATUS=1): pi's own rule for its reports.
    if (this.terminal.programStatusSupported !== true) return;
    try {
      this.terminal.write(formatChildStatus(runId, state, title));
    } catch {
      // A terminal write failure must never trap the session.
    }
  }
}

/**
 * Wrap `setProgramStatus` on the terminal of `tui`, once per terminal. Returns the wrapper, or null when
 * the terminal has no such method (a pi without OSC 7501 reporting).
 */
export function wrapProgramStatus(tui: Pick<TUI, "terminal"> | null | undefined, facts: () => LoopFacts): ProgramStatusWrapper | null {
  const terminal = tui?.terminal as Wrapped | undefined;
  if (!terminal || typeof terminal.setProgramStatus !== "function") return null;
  const existing = terminal[WRAPPED];
  if (existing) {
    existing.setFacts(facts);
    return existing;
  }
  const original = terminal.setProgramStatus.bind(terminal);
  const wrapper = new ProgramStatusWrapper(terminal, original, facts);
  terminal[WRAPPED] = wrapper;
  terminal.setProgramStatus = (status: ProgramStatus) => wrapper.report(status);
  const rewrite = terminal.writeProgramStatus;
  if (typeof rewrite === "function") {
    terminal.writeProgramStatus = (...args: unknown[]) => {
      const result = rewrite.apply(terminal, args);
      wrapper.resendLanes();
      return result;
    };
  }
  return wrapper;
}

const CAPTURE_WIDGET_KEY = "loop-status-program-status";

/**
 * pi gives an extension its TUI only through a component factory. Set an empty widget, keep the TUI the
 * factory receives, and remove the widget in the same call. Modes without a TUI (RPC, print) ignore
 * factories, so this returns null there.
 */
export function captureTui(ui: { setWidget: (key: string, content: unknown) => void }): TUI | null {
  let captured: TUI | null = null;
  try {
    ui.setWidget(CAPTURE_WIDGET_KEY, (tui: TUI) => {
      captured = tui;
      return { render: () => [], invalidate: () => {} };
    });
    ui.setWidget(CAPTURE_WIDGET_KEY, undefined);
  } catch {
    return null;
  }
  return captured;
}
