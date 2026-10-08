// loop-wait core: process spawning, receipt persistence, deadline/timer arithmetic and the
// compaction-safe delivery queue. Pure Node.js, no pi imports, so it is testable in isolation
// (see core.test.ts). lane.ts and root.ts wire this into pi's tool and event API.
//
// Receipt contract (frozen in SEAMS.md / plan.md §2): <run-dir>/receipts/<watch-id>.json,
// rewritten atomically (temp + rename) after every observation, with fields
// phase, observations, last_observed_at, deadline, result, pid, command, interval_s.
// A `running` receipt older than 2x interval_s is stale/dead. Liveness witness: at least one
// observation within 2 minutes of start, regardless of a larger interval_s.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type WatchPhase = "starting" | "running" | "done" | "failed";

export interface ReceiptResult {
  exit_code: number | null;
  deadline_hit: boolean;
  signal: string | null;
}

export interface Receipt {
  phase: WatchPhase;
  observations: number;
  last_observed_at: string;
  deadline: string;
  result: ReceiptResult | null;
  pid: number | null;
  command: string;
  interval_s: number;
  /** Supplementary, non-frozen fields. */
  label?: string;
  tail?: string[];
  note?: string;
}

export const WITNESS_MAX_MS = 120_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function runDirFor(agentDir: string, sessionId: string): string {
  return join(agentDir, "loop-wait", sessionId);
}

export function receiptsDirFor(runDir: string): string {
  return join(runDir, "receipts");
}

export function logsDirFor(runDir: string): string {
  return join(runDir, "logs");
}

export function receiptPathFor(runDir: string, watchId: string): string {
  return join(receiptsDirFor(runDir), `${watchId}.json`);
}

export function logPathFor(runDir: string, watchId: string): string {
  return join(logsDirFor(runDir), `${watchId}.log`);
}

// ---------------------------------------------------------------------------
// Receipt IO (atomic write: temp file + rename)
// ---------------------------------------------------------------------------

export function writeReceiptAtomic(path: string, receipt: Receipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  renameSync(tmp, path);
}

export function readReceipt(path: string): Receipt | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Receipt;
  } catch {
    return undefined;
  }
}

export function isReceiptStale(receipt: Receipt, nowMs: number): boolean {
  if (receipt.phase !== "running" && receipt.phase !== "starting") return false;
  const last = Date.parse(receipt.last_observed_at);
  if (Number.isNaN(last)) return true;
  return nowMs - last > 2 * receipt.interval_s * 1000;
}

/** First heartbeat fires within 2 minutes even when interval_s is larger, as a liveness witness. */
export function firstHeartbeatDelayMs(intervalMs: number): number {
  return Math.max(0, Math.min(intervalMs, WITNESS_MAX_MS));
}

// ---------------------------------------------------------------------------
// Timer arithmetic
// ---------------------------------------------------------------------------

export function parseIsoOrThrow(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`loop-wait: invalid ISO timestamp: ${iso}`);
  return ms;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function computeDelayMs(atIso: string, nowMs: number): number {
  return Math.max(0, parseIsoOrThrow(atIso) - nowMs);
}

export function isOverdue(atIso: string, nowMs: number): boolean {
  return parseIsoOrThrow(atIso) <= nowMs;
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Like isProcessAlive, but for a whole process group: signal 0 to -pgid throws ESRCH once no
 * process is left in that group. Used for the SIGKILL escalation on a group kill, where checking
 * only the original leader's pid (or whether our own child-exit handler has fired) is wrong — a
 * compound command's grandchild can outlive a leader that exits quickly, and would otherwise never
 * get force-killed.
 */
/**
 * A process's start identity: its start time as `ps -o lstart=` prints it (same on macOS and
 * Linux, with LC_ALL=C for a stable format). A pid plus this identity names one process; a pid
 * alone can be reused by an unrelated one after a restart. Null when the process is gone or `ps`
 * cannot be run, which callers treat as "cannot prove it is ours".
 */
export function processStartIdentity(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const identity = out.trim().replace(/\s+/g, " ");
    return identity || null;
  } catch {
    return null;
  }
}

export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function killProcessTree(pid: number | null, opts?: { force?: boolean; group?: boolean }): void {
  if (!pid) return;
  const signal = opts?.force ? "SIGKILL" : "SIGTERM";
  const target = opts?.group ? -pid : pid;
  try {
    process.kill(target, signal);
  } catch {
    // Already gone, or not our process (EPERM) — nothing more we can do.
  }
}

// ---------------------------------------------------------------------------
// Tail buffer
// ---------------------------------------------------------------------------

export interface TailBuffer {
  push(chunk: string): void;
  lines(): string[];
}

export function makeTailBuffer(maxLines: number): TailBuffer {
  let buf: string[] = [];
  let carry = "";
  return {
    push(chunk: string) {
      const combined = carry + chunk;
      const parts = combined.split("\n");
      carry = parts.pop() ?? "";
      if (parts.length) {
        buf.push(...parts);
        if (buf.length > maxLines) buf = buf.slice(buf.length - maxLines);
      }
    },
    lines() {
      const withCarry = carry ? [...buf, carry] : buf;
      return withCarry.slice(Math.max(0, withCarry.length - maxLines));
    },
  };
}

// ---------------------------------------------------------------------------
// Process spawning (child_process, never a shell `&`)
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  cwd?: string;
  /** Unref the child handle so it never keeps the event loop alive on its own. Only for a
   *  fire-and-forget background watcher (watch_start); a blocking wait (watch_process) leaves
   *  this false so the awaiting call stays live. Independent of process-group membership below. */
  background?: boolean;
  tailLines: number;
  logPath?: string;
}

export interface SpawnedProcess {
  child: ChildProcess;
  tail: TailBuffer;
  /** Equal to child.pid. Every watched command is spawned as the leader of its own process
   *  group (Node's `detached: true`), so `killProcessTree(pgid, { group: true })` reaches every
   *  descendant of a compound `sh -c` command (e.g. `true && sleep 4321`), not just the shell
   *  itself. Node's `detached` here only affects process-group/session membership, not whether
   *  the child survives this process exiting; that is `background` above (via `unref()`). */
  pgid: number | null;
}

export function spawnWatched(command: string, opts: SpawnOptions): SpawnedProcess {
  const child = spawn(command, {
    shell: true,
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = makeTailBuffer(opts.tailLines);
  let logFd: number | undefined;
  if (opts.logPath) {
    mkdirSync(dirname(opts.logPath), { recursive: true });
    logFd = openSync(opts.logPath, "a");
  }
  const onData = (chunk: Buffer) => {
    tail.push(chunk.toString("utf8"));
    if (logFd !== undefined) {
      try {
        writeSync(logFd, chunk);
      } catch {
        // best effort; never let logging crash the watcher
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  // `close`, not `exit`: the leader can exit while a descendant still holds stdout/stderr and
  // writes more. `close` fires once every stdio stream has ended (and after `error` when the
  // spawn itself failed), so the log keeps every byte.
  child.once("close", () => {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // ignore
      }
    }
  });
  if (opts.background) child.unref();
  return { child, tail, pgid: child.pid ?? null };
}

// ---------------------------------------------------------------------------
// watch_process: blocking wait for exit or deadline, kill on abort
// ---------------------------------------------------------------------------

export interface RunWatchProcessOptions {
  command: string;
  deadlineS: number;
  tailLines: number;
  cwd?: string;
  signal?: AbortSignal;
}

export interface RunWatchProcessResult {
  exitCode: number | null;
  deadlineHit: boolean;
  signal: string | null;
  tail: string[];
}

export function runWatchProcess(opts: RunWatchProcessOptions): Promise<RunWatchProcessResult> {
  return new Promise((resolve) => {
    const { child, tail, pgid } = spawnWatched(opts.command, { cwd: opts.cwd, tailLines: opts.tailLines });
    let settled = false;
    let deadlineHit = false;
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      killProcessTree(pgid, { group: true });
      // Escalate if any member of the group ignores SIGTERM — checking group liveness, not just
      // whether our own leader's exit handler has already fired: the leader can exit quickly
      // while a grandchild that ignored SIGTERM is still alive in the same group.
      setTimeout(() => {
        if (pgid !== null && isProcessGroupAlive(pgid)) killProcessTree(pgid, { group: true, force: true });
      }, 3000).unref();
    }, Math.max(0, opts.deadlineS * 1000));
    deadlineTimer.unref();

    const onAbort = () => {
      killProcessTree(pgid, { group: true });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Resolve on `close` (every stdio holder gone) so the tail carries all output. A descendant
    // holding stdout after the leader exits keeps this pending until the deadline or abort kills
    // the group, which then closes the pipes.
    child.once("close", (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, deadlineHit, signal: sig, tail: tail.lines() });
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, deadlineHit, signal: null, tail: tail.lines() });
    });
  });
}

// ---------------------------------------------------------------------------
// WatchManager: watch_start / watch_stop, heartbeats, reconciliation, closeout
// ---------------------------------------------------------------------------

export interface WatcherSnapshot {
  id: string;
  label: string;
  pid: number | null;
  /** Process-group id, when known. Every watcher we start records it (it equals pid: the
   *  watcher is spawned as its own group leader). Absent on a snapshot persisted before this
   *  field existed; reconcileOne then falls back to pid-only termination rather than risk
   *  signalling an unrelated process group after a pid gets reused. Not a receipt field — plan
   *  §2's receipt schema is frozen; this lives only in the persisted loop-wait-state snapshot. */
  pgid?: number | null;
  /** The watcher's start identity (processStartIdentity) recorded at spawn. reconcileOne adopts
   *  a live pid only when its current identity matches; a snapshot without one (persisted before
   *  this field existed, or `ps` failed at spawn) is never adopted or signalled. Not a receipt
   *  field; it lives only in the persisted loop-wait-state snapshot, like pgid. */
  start_identity?: string | null;
  phase: WatchPhase;
  command: string;
  deadline: string;
  interval_s: number;
}

interface WatcherState {
  id: string;
  label: string;
  command: string;
  deadline: string;
  intervalS: number;
  receiptPath: string;
  spawned?: SpawnedProcess;
  adopted: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  phase: WatchPhase;
  pid: number | null;
  pgid: number | null;
  startIdentity: string | null;
}

export interface WatchManagerOptions {
  runDir: string;
  onFinal: (id: string, receipt: Receipt) => void;
  onStart?: (snapshot: WatcherSnapshot) => void;
  onPersist: () => void;
}

export class WatchManager {
  private watchers = new Map<string, WatcherState>();
  private readonly runDir: string;
  private readonly onFinal: (id: string, receipt: Receipt) => void;
  private readonly onStart?: (snapshot: WatcherSnapshot) => void;
  private readonly onPersist: () => void;

  constructor(opts: WatchManagerOptions) {
    this.runDir = opts.runDir;
    this.onFinal = opts.onFinal;
    this.onStart = opts.onStart;
    this.onPersist = opts.onPersist;
  }

  start(opts: { command: string; deadlineS: number; intervalS: number; label: string; cwd?: string; tailLines?: number }): string {
    const id = randomUUID();
    const receiptPath = receiptPathFor(this.runDir, id);
    const logPath = logPathFor(this.runDir, id);
    const deadlineIso = new Date(Date.now() + opts.deadlineS * 1000).toISOString();
    const spawned = spawnWatched(opts.command, {
      cwd: opts.cwd,
      background: true,
      tailLines: opts.tailLines ?? 200,
      logPath,
    });
    const state: WatcherState = {
      id,
      label: opts.label,
      command: opts.command,
      deadline: deadlineIso,
      intervalS: opts.intervalS,
      receiptPath,
      spawned,
      adopted: false,
      phase: "starting",
      pid: spawned.child.pid ?? null,
      pgid: spawned.pgid,
      startIdentity: spawned.child.pid ? processStartIdentity(spawned.child.pid) : null,
    };
    this.watchers.set(id, state);
    this.writeReceipt(state, "starting", null);
    this.onStart?.(this.list().find(w => w.id === id)!);

    const heartbeat = () => {
      if (!this.watchers.has(id)) return;
      this.writeReceipt(state, state.phase === "starting" ? "running" : state.phase, null);
      state.heartbeatTimer = setTimeout(heartbeat, Math.max(1, opts.intervalS) * 1000).unref();
    };
    state.heartbeatTimer = setTimeout(heartbeat, firstHeartbeatDelayMs(Math.max(1, opts.intervalS) * 1000)).unref();

    this.armDeadlineTimer(state, () =>
      this.finalize(id, { exit_code: null, deadline_hit: true, signal: null }, "failed", "deadline exceeded"),
    );

    // Finalize on `close`, not `exit`, so the receipt's tail and the log hold every line; a
    // descendant still holding stdout after the leader exits runs until the deadline kills the group.
    spawned.child.once("close", (code, sig) => {
      if (!this.watchers.has(id)) return; // already finalized (stop/deadline)
      this.finalize(id, { exit_code: code, deadline_hit: false, signal: sig }, code === 0 ? "done" : "failed");
    });
    spawned.child.once("error", (err) => {
      if (!this.watchers.has(id)) return;
      this.finalize(id, { exit_code: null, deadline_hit: false, signal: null }, "failed", String(err));
    });

    this.onPersist();
    return id;
  }

  stop(id: string, note = "stopped by watch_stop"): boolean {
    if (!this.watchers.has(id)) return false;
    this.finalize(id, { exit_code: null, deadline_hit: false, signal: null }, "failed", note);
    return true;
  }

  list(): WatcherSnapshot[] {
    return [...this.watchers.values()].map((w) => ({
      id: w.id,
      label: w.label,
      pid: w.pid,
      pgid: w.pgid,
      start_identity: w.startIdentity,
      phase: w.phase,
      command: w.command,
      deadline: w.deadline,
      interval_s: w.intervalS,
    }));
  }

  /** Adopt or report an orphan watcher recovered from a persisted snapshot after restart. */
  reconcileOne(snapshot: WatcherSnapshot): "adopted" | "orphaned" | "skipped" {
    if (snapshot.phase !== "starting" && snapshot.phase !== "running") return "skipped";
    if (this.watchers.has(snapshot.id)) return "skipped";
    const receiptPath = receiptPathFor(this.runDir, snapshot.id);
    const alive = snapshot.pid !== null && isProcessAlive(snapshot.pid);
    // A live pid is ours only if its start identity still matches the one recorded at spawn.
    // Anything else (no recorded identity, `ps` unavailable, a different process that reused the
    // pid) is reported and dropped without adopting it or ever signalling that pid.
    const currentIdentity = alive && snapshot.pid !== null ? processStartIdentity(snapshot.pid) : null;
    const ours = alive && !!snapshot.start_identity && currentIdentity === snapshot.start_identity;
    const state: WatcherState = {
      id: snapshot.id,
      label: snapshot.label,
      command: snapshot.command,
      deadline: snapshot.deadline,
      intervalS: snapshot.interval_s,
      receiptPath,
      adopted: true,
      phase: alive ? "running" : "failed",
      pid: snapshot.pid,
      pgid: snapshot.pgid ?? null,
      startIdentity: snapshot.start_identity ?? null,
    };
    if (alive && !ours) {
      const why = snapshot.start_identity
        ? `start identity changed (recorded ${JSON.stringify(snapshot.start_identity)}, now ${JSON.stringify(currentIdentity)})`
        : "no start identity was recorded";
      state.phase = "failed";
      this.writeReceipt(
        state,
        "failed",
        { exit_code: null, deadline_hit: false, signal: null },
        `orphan, not ours: pid ${snapshot.pid} is alive but ${why}; not adopted and not signalled`,
      );
      this.onFinal(state.id, readReceipt(receiptPath) as Receipt);
      return "orphaned";
    }
    if (!alive) {
      this.writeReceipt(state, "failed", { exit_code: null, deadline_hit: false, signal: null }, "orphan: process not found on reconcile");
      this.onFinal(state.id, readReceipt(receiptPath) as Receipt);
      return "orphaned";
    }
    this.watchers.set(state.id, state);
    const poll = () => {
      if (!this.watchers.has(state.id)) return;
      if (!state.pid || !isProcessAlive(state.pid)) {
        this.finalize(state.id, { exit_code: null, deadline_hit: false, signal: null }, "done", "adopted watcher no longer running (exit code unknown)");
        return;
      }
      this.writeReceipt(state, "running", null, "adopted: liveness poll only, no output tail available");
      state.heartbeatTimer = setTimeout(poll, Math.max(1, state.intervalS) * 1000).unref();
    };
    state.heartbeatTimer = setTimeout(poll, firstHeartbeatDelayMs(Math.max(1, state.intervalS) * 1000)).unref();
    this.armDeadlineTimer(state, () =>
      this.finalize(state.id, { exit_code: null, deadline_hit: true, signal: null }, "failed", "deadline exceeded (adopted)"),
    );
    this.writeReceipt(state, "running", null, "adopted on reconcile");
    return "adopted";
  }

  /** Stop and finalize every tracked watcher (session_shutdown or the closeout sweep). */
  shutdownAll(note: string): WatcherSnapshot[] {
    const stopped = this.list();
    for (const w of stopped) this.finalize(w.id, { exit_code: null, deadline_hit: false, signal: null }, "failed", note);
    return stopped;
  }

  // setTimeout fires at once for any delay above 2^31-1 ms (~24.8 days): wait in capped steps,
  // recomputing the remaining time from the wall-clock deadline each step (mirrors
  // TimerManager.schedule below). Used for both a fresh watcher's own deadline and an adopted
  // one's remaining deadline after a restart.
  private armDeadlineTimer(state: WatcherState, onDeadline: () => void): void {
    const remaining = computeDelayMs(state.deadline, Date.now());
    state.deadlineTimer = setTimeout(
      () => {
        if (remaining > MAX_TIMEOUT_MS) this.armDeadlineTimer(state, onDeadline);
        else onDeadline();
      },
      Math.min(remaining, MAX_TIMEOUT_MS),
    ).unref();
  }

  /**
   * Finalizes a watcher: kills its process if one is still running (a no-op if it already
   * exited), clears timers, writes the closing receipt, and reports through onFinal. Every path
   * that ends a watcher (natural exit, watch_stop, deadline, shutdown) goes through here so the
   * kill is never forgotten on any one path.
   *
   * Kills the whole process group when we know this watcher owns one, so a compound `sh -c`
   * command's grandchildren die too, never just the shell pid: every watcher we start ourselves
   * has one (pgid), but an adopted watcher restored after a restart only if its pgid was
   * recorded before the restart — otherwise pid-only termination, since signalling a negative
   * pid we cannot vouch for risks hitting an unrelated process group after a pid gets reused.
   */
  private finalize(id: string, result: ReceiptResult, phase: WatchPhase, note?: string): void {
    const state = this.watchers.get(id);
    if (!state) return;
    if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer);
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    if (state.pid) {
      const groupKill = state.pgid !== null;
      const killTarget = groupKill ? (state.pgid as number) : state.pid;
      killProcessTree(killTarget, { group: groupKill });
      const pid = state.pid;
      setTimeout(() => {
        // Group kill: check the whole group's liveness, not just the leader's — a leader that
        // exits quickly can leave a grandchild that ignored SIGTERM still running in the group.
        const stillAlive = groupKill ? isProcessGroupAlive(killTarget) : isProcessAlive(pid);
        if (stillAlive) killProcessTree(killTarget, { group: groupKill, force: true });
      }, 3000).unref();
    }
    state.phase = phase;
    this.writeReceipt(state, phase, result, note);
    this.watchers.delete(id);
    const receipt = readReceipt(state.receiptPath);
    if (receipt) this.onFinal(id, receipt);
    this.onPersist();
  }

  private writeReceipt(state: WatcherState, phase: WatchPhase, result: ReceiptResult | null, note?: string): void {
    state.phase = phase;
    const receipt: Receipt = {
      phase,
      observations: (readReceipt(state.receiptPath)?.observations ?? -1) + 1,
      last_observed_at: new Date().toISOString(),
      deadline: state.deadline,
      result,
      pid: state.pid,
      command: state.command,
      interval_s: state.intervalS,
      label: state.label,
      tail: state.spawned?.tail.lines(),
      note,
    };
    writeReceiptAtomic(state.receiptPath, receipt);
  }
}

// ---------------------------------------------------------------------------
// TimerManager: wake_at / wake_cancel, reconciliation
// ---------------------------------------------------------------------------

export interface TimerSnapshot {
  id: string;
  at: string;
  reason: string;
}

interface TimerState extends TimerSnapshot {
  handle?: NodeJS.Timeout;
}

export interface TimerManagerOptions {
  onFire: (id: string, reason: string) => void;
  onArm?: (snapshot: TimerSnapshot) => void;
  onEnd?: (snapshot: TimerSnapshot) => void;
  onPersist: () => void;
}

/**
 * Result of `TimerManager.cancel`. `ambiguous`/`not_found` carry enough for the caller (root.ts's
 * wake_cancel tool) to build a recovery message without a separate lookup: `not_found` is also
 * returned for an id/prefix that no longer exists because the timer already fired (root.ts is
 * responsible for also dropping that timer's queued-but-undelivered wake message; TimerManager
 * itself has no knowledge of the delivery queue).
 */
export type CancelOutcome = { status: "cancelled"; id: string } | { status: "ambiguous"; matches: string[] } | { status: "not_found" };

/** A prefix shorter than this is never partial-matched, so a short, easily-mistyped string can
 *  never accidentally cancel an unrelated timer. */
const MIN_CANCEL_PREFIX_LEN = 8;

export class TimerManager {
  private timers = new Map<string, TimerState>();
  private readonly onFire: (id: string, reason: string) => void;
  private readonly onArm?: (snapshot: TimerSnapshot) => void;
  private readonly onEnd?: (snapshot: TimerSnapshot) => void;
  private readonly onPersist: () => void;

  constructor(opts: TimerManagerOptions) {
    this.onFire = opts.onFire;
    this.onArm = opts.onArm;
    this.onEnd = opts.onEnd;
    this.onPersist = opts.onPersist;
  }

  arm(at: string, reason: string, id: string = randomUUID()): TimerSnapshot {
    parseIsoOrThrow(at);
    this.cancelInternal(id);
    const state: TimerState = { id, at, reason };
    this.schedule(state);
    this.timers.set(id, state);
    this.onArm?.({ id, at, reason });
    this.onPersist();
    return { id, at, reason };
  }

  /**
   * Cancel by exact id first; failing that, by a unique prefix of at least
   * `MIN_CANCEL_PREFIX_LEN` characters. A prefix matching more than one armed timer cancels
   * nothing and reports every match; a prefix matching none, or shorter than the minimum with no
   * exact match, reports not_found.
   */
  cancel(idOrPrefix: string): CancelOutcome {
    if (this.timers.has(idOrPrefix)) {
      this.cancelInternal(idOrPrefix);
      this.onPersist();
      return { status: "cancelled", id: idOrPrefix };
    }
    if (idOrPrefix.length >= MIN_CANCEL_PREFIX_LEN) {
      const matches = [...this.timers.keys()].filter((id) => id.startsWith(idOrPrefix));
      if (matches.length === 1) {
        const [id] = matches;
        this.cancelInternal(id);
        this.onPersist();
        return { status: "cancelled", id };
      }
      if (matches.length > 1) return { status: "ambiguous", matches };
    }
    return { status: "not_found" };
  }

  list(): TimerSnapshot[] {
    return [...this.timers.values()].map(({ id, at, reason }) => ({ id, at, reason }));
  }

  /** Re-arm future timers; fire overdue ones exactly once. Called on session_start. */
  reconcile(snapshots: TimerSnapshot[]): { rearmed: string[]; firedOverdue: string[] } {
    const now = Date.now();
    const rearmed: string[] = [];
    const firedOverdue: string[] = [];
    for (const snap of snapshots) {
      if (this.timers.has(snap.id)) continue;
      if (isOverdue(snap.at, now)) {
        firedOverdue.push(snap.id);
        this.onEnd?.(snap);
        this.onFire(snap.id, snap.reason);
      } else {
        this.arm(snap.at, snap.reason, snap.id);
        rearmed.push(snap.id);
      }
    }
    return { rearmed, firedOverdue };
  }

  /** Cancel without firing. The root persists the emptied map on orderly shutdown. */
  shutdownAll(): void {
    for (const id of this.timers.keys()) this.cancelInternal(id);
  }

  // setTimeout fires at once for any delay above 2^31-1 ms (~24.8 days): wait in capped steps.
  private schedule(state: TimerState): void {
    const remaining = computeDelayMs(state.at, Date.now());
    state.handle = setTimeout(() => {
      if (this.timers.get(state.id) !== state) return;
      if (remaining > MAX_TIMEOUT_MS) this.schedule(state);
      else this.fire(state.id);
    }, Math.min(remaining, MAX_TIMEOUT_MS)).unref();
  }

  private fire(id: string): void {
    const state = this.timers.get(id);
    if (!state) return;
    this.timers.delete(id);
    this.onEnd?.({ id: state.id, at: state.at, reason: state.reason });
    this.onPersist();
    this.onFire(id, state.reason);
  }

  private cancelInternal(id: string): void {
    const state = this.timers.get(id);
    if (state?.handle) clearTimeout(state.handle);
    this.timers.delete(id);
    if (state) this.onEnd?.({ id: state.id, at: state.at, reason: state.reason });
  }
}

// ---------------------------------------------------------------------------
// Compaction-safe delivery queue
// ---------------------------------------------------------------------------

export interface PendingDelivery<T> {
  message: T;
}

/**
 * Defers delivery of a message while the session is busy (streaming or compacting), so a
 * wake never starts a concurrent agent run. Call `flush()` from `session_compact`,
 * `session_compact_failed` and `agent_settled` handlers.
 */
export class DeliveryQueue<T> {
  private pending: T[] = [];
  private readonly isIdle: () => boolean;
  private readonly deliver: (message: T, opts: { triggerTurn: boolean }) => void;
  private readonly isHeld: () => boolean;

  /**
   * `isHeld` keeps messages queued even while idle (the owner pressed Esc and has not typed
   * again): `send()` queues and `flush()` delivers nothing until it returns false.
   */
  constructor(opts: {
    isIdle: () => boolean;
    deliver: (message: T, opts: { triggerTurn: boolean }) => void;
    isHeld?: () => boolean;
  }) {
    this.isIdle = opts.isIdle;
    this.deliver = opts.deliver;
    this.isHeld = opts.isHeld ?? (() => false);
  }

  send(message: T): void {
    if (this.isIdle() && !this.isHeld() && this.pending.length === 0) {
      this.deliver(message, { triggerTurn: true });
      return;
    }
    this.pending.push(message);
  }

  /**
   * Deliver every currently pending message in one flush, so a burst of watcher/timer events
   * that queued up during one long busy root turn opens exactly one new root turn, not one per
   * message (each such turn was previously a several-minutes-late no-op). Every message but the
   * last is delivered with `triggerTurn: false`: the caller's `deliver` is expected to pass that
   * straight through to pi's `sendMessage`, whose `triggerTurn: false` path appends the message to
   * context immediately while idle without starting a turn. The last message carries
   * `triggerTurn: true` and actually starts the turn, by which point every earlier message in this
   * batch is already in context for it to see. Delivery order matches arrival order.
   */
  flush(): void {
    if (!this.isIdle() || this.isHeld() || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    batch.forEach((message, index) => {
      this.deliver(message, { triggerTurn: index === batch.length - 1 });
    });
  }

  /**
   * Remove every pending (not yet delivered) message matching `predicate`, without delivering
   * them, and return what was removed. Used to drop a queued `loop-wake` for a timer that fired
   * while busy and was then cancelled before its wake message reached delivery.
   */
  removePending(predicate: (message: T) => boolean): T[] {
    const removed: T[] = [];
    this.pending = this.pending.filter((message) => {
      if (!predicate(message)) return true;
      removed.push(message);
      return false;
    });
    return removed;
  }

  /** Put messages back at the front of the queue (a restart restoring held wakes), in order. */
  restore(messages: T[]): void {
    this.pending = [...messages, ...this.pending];
  }

  /** The not-yet-delivered messages matching `predicate`, without removing them. */
  pendingMatching(predicate: (message: T) => boolean): T[] {
    return this.pending.filter(predicate);
  }

  get length(): number {
    return this.pending.length;
  }
}
