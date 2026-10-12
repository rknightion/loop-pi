// Content-free request progress (SEAMS.md "Request progress seam"). Pure state plus a bounded
// checkpoint writer; index.ts wires it to pi's hooks. Nothing here reads, keeps or writes a
// prompt, reasoning text, encrypted reasoning, tool arguments or results, or any header value
// other than the provider's opaque request id.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PROGRESS_VERSION = 1;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
export const MIN_CHECKPOINT_INTERVAL_MS = 250;
export const MAX_CHECKPOINT_INTERVAL_MS = 60_000;

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
 */
export function writeCheckpoint(path: string, value: RequestProgress): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* never created */ }
    return false;
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
