// Content-free request progress (SEAMS.md "Request progress seam"). Pure state plus a bounded
// checkpoint writer; index.ts wires it to pi's hooks. Nothing here reads, keeps or writes a
// prompt, reasoning text, encrypted reasoning, tool arguments or results, or any header value
// other than the provider's opaque request id.
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RequestPolicy } from "./writer.ts";

export const PROGRESS_VERSION = 1;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
export const MIN_CHECKPOINT_INTERVAL_MS = 250;
export const MAX_CHECKPOINT_INTERVAL_MS = 60_000;
/** A checkpoint is expired only when both its own `writtenAt` and its file mtime are older than this. */
export const CHECKPOINT_RETENTION_MS = 14 * 86_400_000;
/** Per process and directory: the sweep runs on a checkpoint write at most once per interval. */
export const CHECKPOINT_SWEEP_INTERVAL_MS = 3_600_000;
/** Files one sweep may open; the rest wait for a later sweep. */
export const CHECKPOINT_SWEEP_MAX_EXAMINED = 100;
/** A real checkpoint is about 1 KB; a larger file is not one and is kept. */
const CHECKPOINT_MAX_BYTES = 16_384;

/**
 * The keepalive event `type` each pi API family can deliver to the raw stream hook. An API not
 * listed here has no recognisable keepalive, so its keepalive counters stay null (unknown).
 */
const KEEPALIVE_TYPE_BY_API: Record<string, string> = {
  "openai-responses": "keepalive",
  "azure-openai-responses": "keepalive",
  "openai-codex-responses": "keepalive",
  "anthropic-messages": "ping",
};
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CHECKPOINT_NAME = /^([A-Za-z0-9._-]{1,128})\.json$/;
// Current randomUUID writer or the exact positive-PID suffix used by the legacy writer.
const TEMP_SUFFIX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[1-9][0-9]*)\.tmp$/;

export interface ProgressCounters {
  started: number;
  deltas: number;
  completed: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface RequestProgress {
  v: typeof PROGRESS_VERSION;
  session: string | null;
  request: string;
  turn: number;
  pid: number;
  provider: string | null;
  model: string | null;
  api: string | null;
  state: "active" | "ended" | "abandoned";
  stopReason: string | null;
  startedAt: number;
  endedAt: number | null;
  writtenAt: number | null;
  ageMs: number;
  providerResponses: number;
  firstResponseAt: number | null;
  providerRequestId: string | null;
  modelEvents: number;
  firstModelEventAt: number | null;
  lastModelEventAt: number | null;
  reasoning: ProgressCounters;
  text: ProgressCounters;
  toolCalls: ProgressCounters;
  providerEvents: number | null;
  lastProviderEventAt: number | null;
  keepalives: number | null;
  lastKeepaliveAt: number | null;
  /** Additive: epoch ms the writing process began (writer.ts). Absent or null is unknown. */
  pidStartedAt?: number | null;
  /** Additive: the limits this process loaded (writer.ts). Absent, or a null limit, is unknown. */
  policy?: RequestPolicy | null;
}

export interface RequestIdentity {
  session: string | null;
  request: string;
  turn: number;
  provider: string | null;
  model: string | null;
  api: string | null;
}

const counters = (): ProgressCounters => ({ started: 0, deltas: 0, completed: 0, firstAt: null, lastAt: null });

export function newProgress(identity: RequestIdentity, now: number, pid = process.pid): RequestProgress {
  return {
    v: PROGRESS_VERSION, ...identity, pid, state: "active", stopReason: null,
    startedAt: now, endedAt: null, writtenAt: null, ageMs: 0,
    providerResponses: 0, firstResponseAt: null, providerRequestId: null,
    modelEvents: 0, firstModelEventAt: null, lastModelEventAt: null,
    reasoning: counters(), text: counters(), toolCalls: counters(),
    providerEvents: null, lastProviderEventAt: null, keepalives: null, lastKeepaliveAt: null,
  };
}

/** One `after_provider_response`: headers arrived. Not model progress. */
export function observeResponse(p: RequestProgress, requestId: string | undefined, now: number): void {
  p.providerResponses++;
  p.firstResponseAt ??= now;
  p.providerRequestId = requestId ?? null;
}

/**
 * One raw `provider_stream_event`. Counts transport activity only; a recognised keepalive is
 * counted separately. Neither is ever model progress. Only the event's `type` is compared, never
 * stored. Counters stay null until the first raw event, because raw events are provider-optional.
 */
export function observeProviderEvent(p: RequestProgress, data: unknown, now: number): void {
  p.providerEvents = (p.providerEvents ?? 0) + 1;
  p.lastProviderEventAt = now;
  const keepalive = p.api !== null && Object.hasOwn(KEEPALIVE_TYPE_BY_API, p.api)
    ? KEEPALIVE_TYPE_BY_API[p.api] : undefined;
  if (keepalive === undefined) return;
  p.keepalives ??= 0;
  const type = data !== null && typeof data === "object" ? (data as { type?: unknown }).type : undefined;
  if (type === keepalive) {
    p.keepalives++;
    p.lastKeepaliveAt = now;
  }
}

/**
 * One normalized assistant stream event (`message_update`). Returns true when it is a model
 * event: a start or end of a reasoning, text or tool-call block, or a nonempty delta. Only a
 * delta's length is read.
 */
export function observeAssistantEvent(p: RequestProgress, event: { type: string; delta?: unknown }, now: number): boolean {
  const [kind, phase] = event.type.split("_");
  const group = kind === "thinking" ? p.reasoning : kind === "text" ? p.text : kind === "toolcall" ? p.toolCalls : undefined;
  if (!group) return false;
  if (phase === "delta") {
    if (typeof event.delta !== "string" || event.delta.length === 0) return false;
    group.deltas++;
  } else if (phase === "start") group.started++;
  else if (phase === "end") group.completed++;
  else return false;
  group.firstAt ??= now;
  group.lastAt = now;
  p.modelEvents++;
  p.firstModelEventAt ??= now;
  p.lastModelEventAt = now;
  return true;
}

export function endProgress(p: RequestProgress, state: "ended" | "abandoned", stopReason: string | null, now: number): void {
  p.state = state;
  p.stopReason = stopReason;
  p.endedAt = now;
  p.ageMs = now - p.startedAt;
}

/** A detached copy stamped with its write time, safe to persist or put on a message. */
export function snapshot(p: RequestProgress, now: number): RequestProgress {
  const copy: RequestProgress = structuredClone(p);
  copy.writtenAt = now;
  copy.ageMs = (copy.endedAt ?? now) - copy.startedAt;
  return copy;
}

export function checkpointIntervalMs(settings: unknown): number {
  const value = (settings as { loopPi?: { progress?: { checkpointIntervalMs?: unknown } } } | null)
    ?.loopPi?.progress?.checkpointIntervalMs;
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_CHECKPOINT_INTERVAL_MS && value <= MAX_CHECKPOINT_INTERVAL_MS
    ? value : DEFAULT_CHECKPOINT_INTERVAL_MS;
}

export function checkpointPath(agentDir: string, session: string | null): string | null {
  return session !== null && SESSION_ID.test(session) ? join(agentDir, "progress", `${session}.json`) : null;
}

/**
 * Atomic replace: an unpredictable temp name in the same directory, created exclusively (`wx`, so
 * a planted file or symlink at that name is refused, never followed), then renamed over the
 * checkpoint. A failure removes the temp file and is swallowed so a request is never disturbed.
 * After a successful write the directory is swept for expired checkpoints of other sessions, at
 * most once per CHECKPOINT_SWEEP_INTERVAL_MS (`now` is the injectable clock).
 */
export function writeCheckpoint(path: string, value: RequestProgress, now: number = Date.now()): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* never created */ }
    return false;
  }
  try { sweepIfDue(dirname(path), basename(path), now); } catch { /* retention never disturbs a request */ }
  return true;
}

export interface SweepState { cursor: number }
const sweeps = new Map<string, { lastAt: number; state: SweepState }>();

function sweepIfDue(dir: string, current: string, now: number): void {
  const entry = sweeps.get(dir);
  if (entry !== undefined && now >= entry.lastAt && now - entry.lastAt < CHECKPOINT_SWEEP_INTERVAL_MS) return;
  const state = entry?.state ?? { cursor: 0 };
  sweeps.set(dir, { lastAt: now, state });
  sweepExpiredCheckpoints(dir, current, now, state);
}

/**
 * Retention: deletes (no archive) checkpoints of OTHER sessions that are provably dead, in the one
 * directory the producer owns. A file is removed only if all hold:
 *  - its name is exactly `<session id>.json` (the producer's own pattern) and it is not `current`;
 *  - it is not listed as a FIFO, socket, device or directory, and opens with O_NOFOLLOW|O_NONBLOCK
 *    (a symlink is refused, never followed; a FIFO cannot block) as a regular file of at most
 *    CHECKPOINT_MAX_BYTES;
 *  - it parses as a v1 record whose `session` equals the file's stem and whose `writtenAt` is a
 *    finite number (identity and age established from the record itself);
 *  - the record's `pid` is a positive integer and `process.kill(pid, 0)` reports no such process
 *    (a live pid, EPERM included, or a missing or malformed pid keeps the file; a reused pid is a
 *    false keep, never a false delete);
 *  - `writtenAt` AND the file's mtime are both more than CHECKPOINT_RETENTION_MS before `now`
 *    (a recently touched file is a live writer whatever it recorded; a future stamp is no age);
 *  - the entry is unchanged (same inode, size and mtime) just before the unlink.
 * Anything that fails or cannot be established is kept: unknown is never treated as expired.
 * A symlinked directory is not swept. Cost: at most CHECKPOINT_SWEEP_MAX_EXAMINED files opened per
 * call; `state.cursor` rotates the start so repeated sweeps cover a large directory (entry names
 * are still iterated, which is cheap). The window between the last check and the unlink is not
 * closed: a writer renaming a fresh checkpoint over a 14-day-old file in that instant would lose
 * it, and its next write recreates it.
 */
export function sweepExpiredCheckpoints(
  dir: string, current: string, now: number, state: SweepState = { cursor: 0 },
): { examined: number; removed: number } {
  const result = { examined: 0, removed: 0 };
  try {
    if (!lstatSync(dir).isDirectory()) return result;
    const handle = opendirSync(dir);
    try {
      let passed = 0;
      let finished = true;
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (passed++ < state.cursor) continue;
        const match = CHECKPOINT_NAME.exec(entry.name);
        if (match === null || entry.name === current) continue;
        // Never open a FIFO, socket or device (a symlink is left to O_NOFOLLOW below).
        if (entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice() || entry.isDirectory()) continue;
        if (result.examined >= CHECKPOINT_SWEEP_MAX_EXAMINED) { passed--; finished = false; break; }
        result.examined++;
        if (removeIfExpired(join(dir, entry.name), match[1], now)) result.removed++;
      }
      state.cursor = finished ? 0 : Math.max(0, passed - result.removed);
    } finally { handle.closeSync(); }
  } catch { /* unreadable or vanished directory: nothing more is swept */ }
  return result;
}

/**
 * True unless the pid is provably gone (ESRCH). A live pid (even one we may not signal, EPERM) or
 * any other outcome keeps the file. A reused pid can only cause a false keep, never a false delete.
 */
function writerMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeIfExpired(path: string, session: string, now: number): boolean {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: opening a FIFO named like a checkpoint must not block the request that swept.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > CHECKPOINT_MAX_BYTES) return false;
    const record = JSON.parse(readFileSync(fd, "utf8")) as
      { v?: unknown; session?: unknown; writtenAt?: unknown; pid?: unknown } | null;
    if (record === null || typeof record !== "object" || record.v !== PROGRESS_VERSION
      || record.session !== session || typeof record.writtenAt !== "number" || !Number.isFinite(record.writtenAt)) return false;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0 || writerMayBeAlive(record.pid)) return false;
    if (now - record.writtenAt <= CHECKPOINT_RETENTION_MS || now - before.mtimeMs <= CHECKPOINT_RETENTION_MS) return false;
    const after = lstatSync(path);
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Removes only this session's current UUID or legacy PID writer temps, not prefixed neighbours. */
export function removeOrphanTemps(path: string): void {
  const prefix = `${basename(path)}.`;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (name.startsWith(prefix) && name.endsWith(".tmp") && TEMP_SUFFIX.test(name.slice(prefix.length))) {
        try { unlinkSync(join(dirname(path), name)); } catch { /* already gone */ }
      }
    }
  } catch { /* no directory yet */ }
}
