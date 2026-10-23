// The root's model-time share (SEAMS.md "Loop status line"): how much of the wall time since the
// loop launched the root spent inside its own model requests. Pure and read-only. The only source
// is what call-timing already persists on every root assistant message, `loopPiProgress`
// (`startedAt`, `endedAt`, `state`), so the figure survives a reload and a compaction exactly as
// the session file does, and there is nothing to drift. Nothing here wraps a request or changes a
// retry; a lane's requests live in the lane's own session and are never counted.
import { formatAge } from "./status.ts";
import { SUBAGENT_WAKE_TYPES } from "../loop-continuation/state.ts";

export type ModelTime =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "known"; modelMs: number; wallMs: number; share: number; requests: number };

/** The wake notice fires when the share is strictly above this fraction of wall time. */
export const ROOT_MODEL_TIME_NOTICE_SHARE = 0.6;
/** ...and only once this much wall time has elapsed, so a young loop is not told off for one slow turn. */
export const ROOT_MODEL_TIME_NOTICE_MIN_WALL_MS = 30 * 60_000;
/** After the first notice, repeat it only when the share reaches a higher 10-point band or this many wakes later. */
export const ROOT_MODEL_TIME_NOTICE_EVERY_WAKES = 10;
/** Custom message type of the one-line wake notice. */
export const MODEL_TIME_NOTICE_TYPE = "loop-model-time-notice";
/** Custom messages that wake an idle root (the lane return, watch exit and timer wakes). */
export const WAKE_CUSTOM_TYPES: ReadonlySet<string> = new Set([...SUBAGENT_WAKE_TYPES, "loop-watch", "loop-wake"]);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The share of `[sinceMs, now]` the root spent in model requests, from session entries.
 * `none`: readable and no root request yet. `unknown`: entries or the start time unreadable, or
 * assistant messages exist but none carries a finished timing record (call-timing absent). A
 * request is clipped to the window, so one that began before the launch counts only from it.
 */
export function rootModelTime(entries: unknown, sinceMs: number | null, now: number): ModelTime {
  if (!Array.isArray(entries) || !finite(sinceMs) || !finite(now) || now <= sinceMs) return { state: "unknown" };
  let assistants = 0;
  let observed = 0;
  let requests = 0;
  let modelMs = 0;
  for (const raw of entries) {
    const message = (raw as { type?: unknown; message?: { role?: unknown; loopPiProgress?: unknown } } | null);
    if (message?.type !== "message" || message.message?.role !== "assistant") continue;
    assistants++;
    const p = message.message.loopPiProgress as { state?: unknown; startedAt?: unknown; endedAt?: unknown } | null | undefined;
    if (p?.state !== "ended" || !finite(p.startedAt) || !finite(p.endedAt) || p.endedAt < p.startedAt) continue;
    observed++;
    const from = Math.max(p.startedAt, sinceMs);
    const to = Math.min(p.endedAt, now);
    if (to > from) {
      modelMs += to - from;
      requests++;
    }
  }
  if (assistants === 0) return { state: "none" };
  if (observed === 0) return { state: "unknown" };
  const wallMs = now - sinceMs;
  return { state: "known", modelMs, wallMs, share: Math.min(1, modelMs / wallMs), requests };
}

/** `root model time 62% of 3h10m`, `root model time ?`, or null when there is nothing to show yet. */
export function formatModelTime(time: ModelTime): string | null {
  if (time.state === "none") return null;
  if (time.state === "unknown") return "root model time ?";
  return `root model time ${Math.round(time.share * 100)}% of ${formatAge(time.wallMs)}`;
}

/** The one-line wake notice, or null at or below the threshold, under the minimum wall time or when unknown. */
export function wakeNotice(time: ModelTime): string | null {
  if (time.state !== "known") return null;
  if (time.wallMs < ROOT_MODEL_TIME_NOTICE_MIN_WALL_MS || !(time.share > ROOT_MODEL_TIME_NOTICE_SHARE)) return null;
  return `Root model time is above ${Math.round(ROOT_MODEL_TIME_NOTICE_SHARE * 100)}% of wall time `
    + `(${Math.round(time.share * 100)}% of ${formatAge(time.wallMs)}): combine reviews and keep ledgers to one-line appends.`;
}

/** Repetition state of the wake notice: the band (floor of share x 10) last noticed and wakes since. */
export interface NoticeGate { band: number; wakes: number }
export const NOTICE_GATE_START: NoticeGate = { band: -1, wakes: 0 };

/** Whether a wake whose notice is due should carry it, and the next gate. Repeats stay rare. */
export function gateNotice(gate: NoticeGate, share: number): { send: boolean; gate: NoticeGate } {
  const band = Math.floor(share * 10);
  const wakes = gate.wakes + 1;
  if (band > gate.band || wakes >= ROOT_MODEL_TIME_NOTICE_EVERY_WAKES) return { send: true, gate: { band, wakes: 0 } };
  return { send: false, gate: { band: gate.band, wakes } };
}
