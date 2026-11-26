// Automatic root recovery (SEAMS.md "Automatic root recovery"). Pure decision logic: no pi runtime
// imports beyond pi-ai's context-overflow classifier, so the table below is unit-testable.
//
// A loop-pi root with a run folder whose run settles idle on a failed model request is resumed by
// loop-continuation after an exponential backoff, at most `maxResumes` times in any rolling
// `windowMs`, unless the failure is one an owner must act on. pi's native retry and the request
// ceiling (extensions/request-ceiling/) run first and are unchanged; this only replaces the owner's
// "continue" once they have given up.

import { isContextOverflow } from "@earendil-works/pi-ai";
import { EMPTY_LENGTH_ERROR } from "../request-ceiling/core.ts";
import { hardStopFor, providerError } from "../request-ceiling/hard-stop.ts";

export const RESUME_CUSTOM_TYPE = "loop-root-recovery";
export const RECOVERY_STOPPED_CLASS = "loop-root-recovery-stopped";
/** Run-folder judgement log for a root without a v3 state log. */
export const RECOVERY_LOG = "root-recovery.jsonl";

export const DEFAULT_BASE_DELAY_MS = 60_000;
export const DEFAULT_MAX_DELAY_MS = 900_000;
export const DEFAULT_MAX_RESUMES = 6;
export const DEFAULT_WINDOW_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface RootRecoveryConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Resumes allowed in any rolling `windowMs`; one more is a stop. */
  maxResumes: number;
  windowMs: number;
}

/** `loopPi.rootRecovery: {enabled, baseDelayMs, maxDelayMs, maxResumes, windowMs}`; invalid values use their defaults. */
export function rootRecoveryConfig(settings: unknown): RootRecoveryConfig {
  const raw = ((settings as { loopPi?: { rootRecovery?: Record<string, unknown> } } | null)?.loopPi?.rootRecovery ?? {}) as Record<string, unknown>;
  const ms = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : fallback;
  const baseDelayMs = ms(raw.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxResumes = typeof raw.maxResumes === "number" && Number.isInteger(raw.maxResumes) && raw.maxResumes >= 0 && raw.maxResumes <= 1000
    ? raw.maxResumes : DEFAULT_MAX_RESUMES;
  return { enabled: raw.enabled !== false, baseDelayMs, maxDelayMs: Math.max(baseDelayMs, ms(raw.maxDelayMs, DEFAULT_MAX_DELAY_MS)),
    maxResumes, windowMs: ms(raw.windowMs, DEFAULT_WINDOW_MS) };
}

/** When each automatic resume on the session branch was sent (`details.at`), so a reload keeps the cap. */
export function resumeTimesFromBranch(branch: readonly unknown[]): number[] {
  const times: number[] = [];
  for (const raw of branch) {
    const entry = raw as { type?: unknown; customType?: unknown; details?: { at?: unknown } } | null;
    if (entry?.type !== "custom_message" || entry.customType !== RESUME_CUSTOM_TYPE) continue;
    const at = entry.details?.at;
    if (typeof at === "number" && Number.isFinite(at)) times.push(at);
  }
  return times;
}

/** Resumes among `times` inside the rolling window that ends at `now`. */
export function resumesInWindow(times: readonly number[], now: number, windowMs: number): number {
  return times.filter((at) => at > now - windowMs && at <= now).length;
}

/** The wait before resume `attempt` (1-based): base * 2^(attempt-1), capped at maxDelayMs. */
export function resumeDelayMs(attempt: number, config: RootRecoveryConfig): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 40));
  return Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** exponent);
}

export type ResumeCause = "provider-error" | "stalled-request" | "request-ceiling" | "quota";
export type StopCause = "authentication" | "quota" | "policy" | "context-length" | "encrypted-history" | "resume-cap";

export type RootRecoveryDecision =
  | { action: "none"; why: "healthy" | "operator-cancelled" }
  | { action: "resume"; cause: ResumeCause; detail: string }
  | { action: "stop"; cause: StopCause; detail: string };

/** The settled run's last assistant message, as persisted (after request-ceiling's rewrites). */
export interface SettledMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
  /** request-ceiling's hard stop (hard-stop.ts): a bounded category, code, type and status. */
  loopPiHardStop?: unknown;
}

export interface SettleEvidence {
  /** What attributed an abort in this run to the harness, not the operator. */
  harnessAbort: "request-timeout" | null;
  /** The request ceiling's limit, when its timeout fired in this run. */
  ceilingLimit?: "inactivity" | "absolute" | null;
  contextWindow?: number;
}

const HARD_STOP_CAUSE = { authentication: "authentication", policy: "policy", "encrypted-content": "encrypted-history" } as const;
const QUOTA_TEXT = /insufficient_quota|quota|usage.?limit|out of budget|available balance|billing|UsageLimitError/i;

/**
 * Classify the run a root just settled on (see SEAMS.md for the table). The detail names only
 * classification metadata (a safe-token upstream code and the status), never an error body:
 * provider text can carry request content or credentials.
 */
export function classifyRootStop(message: SettledMessage | null, evidence: SettleEvidence): RootRecoveryDecision {
  if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) return { action: "none", why: "healthy" };
  if (message.stopReason === "aborted" && evidence.harnessAbort === null) return { action: "none", why: "operator-cancelled" };

  const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
  const stop = hardStopFor(message);
  const parsed = stop ?? providerError(text);
  const detail = [parsed.code ? `upstream=${parsed.code}` : null, parsed.status !== null ? `status=${parsed.status}` : null]
    .filter(Boolean).join(" ") || String(message.stopReason);

  // Owner-actionable failures first, so a timeout label never hides them.
  if (stop) return { action: "stop", cause: HARD_STOP_CAUSE[stop.category], detail };
  if (message.stopReason === "error" && (parsed.code === "insufficient_quota" || QUOTA_TEXT.test(text))) return { action: "stop", cause: "quota", detail };
  if (message.stopReason === "error" && (parsed.code === "context_length_exceeded" || isContextOverflow(message as never, evidence.contextWindow))) {
    return { action: "stop", cause: "context-length", detail };
  }
  if (evidence.harnessAbort === "request-timeout") {
    return { action: "resume", cause: evidence.ceilingLimit === "absolute" ? "request-ceiling" : "stalled-request", detail };
  }
  if (text === EMPTY_LENGTH_ERROR) return { action: "resume", cause: "request-ceiling", detail: "empty-output-budget" };
  return { action: "resume", cause: "provider-error", detail };
}

export const QUOTA_RETRY_ENTRY = "loop-root-quota-recovery";
export const QUOTA_RETRY_LIMIT = 2;

/** Quota retries survive reload/compaction. Invalid persisted state fails closed. */
export function quotaRetriesFromBranch(branch: readonly unknown[]): number {
  let attempts = 0;
  for (const raw of branch) {
    const entry = raw as { type?: unknown; customType?: unknown; data?: { v?: unknown; attempts?: unknown } } | null;
    if (entry?.type !== "custom" || entry.customType !== QUOTA_RETRY_ENTRY) continue;
    const n = entry.data?.attempts;
    attempts = entry.data?.v === 1 && typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= QUOTA_RETRY_LIMIT ? n : QUOTA_RETRY_LIMIT;
  }
  return attempts;
}

export function boundedQuotaRecovery(decision: RootRecoveryDecision, attempts: number): RootRecoveryDecision {
  return decision.action === "stop" && decision.cause === "quota" && attempts < QUOTA_RETRY_LIMIT
    ? { action: "resume", cause: "quota", detail: decision.detail }
    : decision;
}

/** The last assistant message on a session branch (`{type: "message", message}` entries), or null. */
export function lastAssistantMessage(branch: readonly unknown[]): (SettledMessage & { timestamp?: unknown }) | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: unknown; message?: { role?: unknown } } | null;
    if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message as SettledMessage;
  }
  return null;
}

/** Seconds for a notice: `0.4 s`, `60 s`. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
}

export function resumeText(attempt: number, cause: ResumeCause, detail: string, delayMs: number): string {
  return [
    `## Automatic recovery ${attempt}`,
    "",
    `Your last model request failed (${cause}: ${detail}) and the session stopped. loop-continuation resumed it ` +
      `after a ${seconds(delayMs)} backoff; nobody needs to type continue, and you must not relaunch.`,
    "Recover in this session: re-read QUEUE.md, LANES.md, DECISIONS.md and the live subagent listing, reconcile, then " +
      "continue the run. Tool calls from the failed request never ran; completed tool results above did run, so do " +
      "not repeat them.",
  ].join("\n");
}

export function judgementText(kind: "resume" | "stop", attempt: number, cause: string, detail: string, delayMs?: number): string {
  return kind === "resume"
    ? `loop-pi auto-resume ${attempt}: ${cause} (${detail}) after ${seconds(delayMs ?? 0)} backoff`
    : `loop-pi recovery stopped: ${cause} (${detail}); the root waits for its owner`;
}
