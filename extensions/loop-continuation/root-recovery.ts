// Automatic root recovery (SEAMS.md "Automatic root recovery"). Pure decision logic: no pi runtime
// imports beyond pi-ai's context-overflow classifier, so the table below is unit-testable.
//
// An armed root whose run settles idle on a failed model request is resumed by loop-continuation
// after an exponential backoff, with no attempt limit, unless the failure is one an owner must act
// on. The per-request machinery (pi's native retry, the request ceiling and the retry recovery
// episode in extensions/request-ceiling/) runs first and is unchanged; this only replaces the
// owner's "continue" once that machinery has given up.

import { isContextOverflow } from "@earendil-works/pi-ai";
import { EMPTY_LENGTH_ERROR } from "../request-ceiling/core.ts";
import { httpProxyError } from "../request-ceiling/recovery.ts";

export const RESUME_CUSTOM_TYPE = "loop-root-recovery";
export const RECOVERY_STOPPED_CLASS = "loop-root-recovery-stopped";
/** Emitted (synchronously, `{}`) just before a resume turn: the recovery episode resets as it would
 *  for an owner's idle input. Nothing else emits it; ordinary wakes never reset the episode. */
export const RESUME_EVENT = "loop-recovery:resume";

export const DEFAULT_BASE_DELAY_MS = 60_000;
export const DEFAULT_MAX_DELAY_MS = 900_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface RootRecoveryConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** `loopPi.rootRecovery: {enabled, baseDelayMs, maxDelayMs}`; invalid values use their defaults. */
export function rootRecoveryConfig(settings: unknown): RootRecoveryConfig {
  const raw = ((settings as { loopPi?: { rootRecovery?: Record<string, unknown> } } | null)?.loopPi?.rootRecovery ?? {}) as Record<string, unknown>;
  const ms = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : fallback;
  const baseDelayMs = ms(raw.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  return { enabled: raw.enabled !== false, baseDelayMs, maxDelayMs: Math.max(baseDelayMs, ms(raw.maxDelayMs, DEFAULT_MAX_DELAY_MS)) };
}

/** The wait before resume `attempt` (1-based): base * 2^(attempt-1), capped at maxDelayMs. */
export function resumeDelayMs(attempt: number, config: RootRecoveryConfig): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 40));
  return Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** exponent);
}

export type ResumeCause = "provider-error" | "stalled-request" | "request-ceiling";
export type StopCause = "authentication" | "quota" | "policy" | "context-length" | "configuration";

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
  loopPiRecovery?: {
    reason?: unknown;
    code?: unknown;
    status?: unknown;
    upstream?: { code?: unknown; type?: unknown; status?: unknown } | null;
  } | null;
}

export interface SettleEvidence {
  /** What attributed an abort in this run to the harness, not the operator. */
  harnessAbort: "request-timeout" | "recovery-abort" | null;
  /** The request ceiling's limit, when its timeout fired in this run. */
  ceilingLimit?: "inactivity" | "absolute" | null;
  contextWindow?: number;
}

const AUTH_CODES = new Set(["invalid_api_key", "authentication_error", "permission_denied", "insufficient_permissions"]);
const POLICY_CODES = new Set(["cyber_policy", "content_policy_violation", "content_filter", "policy_violation", "safety_violation"]);
// Retry-recovery stop reasons that come from native compaction for a context overflow.
const CONTEXT_REASONS = new Set([
  "summary-route-not-established", "summary-original-request-not-safe", "two-call-summary-not-authorized",
  "opaque-summary-retry-not-authorized", "opaque-summary-failure-not-replayable",
]);
const AUTH_TEXT = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]api[_ ]key|authentication|permission[_ ]denied|insufficient_permissions/i;
const POLICY_TEXT = /cyber_policy|content_policy|content_filter|policy_violation|safety_violation|\bpolicy\b|\brefus/i;
const QUOTA_TEXT = /insufficient_quota|quota|usage.?limit|out of budget|available balance|billing|UsageLimitError/i;

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

/**
 * Classify the run an armed root just settled on (see SEAMS.md for the table). The detail names
 * only classification metadata (stop reason, allowlisted upstream code, status), never an error
 * body: provider text can carry request content or credentials.
 */
export function classifyRootStop(message: SettledMessage | null, evidence: SettleEvidence): RootRecoveryDecision {
  if (!message || (message.stopReason !== "error" && message.stopReason !== "aborted")) return { action: "none", why: "healthy" };
  const recovery = message.loopPiRecovery ?? null;
  const reason = str(recovery?.reason);
  if (reason === "operator-cancelled") return { action: "none", why: "operator-cancelled" };
  if (message.stopReason === "aborted" && evidence.harnessAbort === null) return { action: "none", why: "operator-cancelled" };

  const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
  const parsed = httpProxyError(text);
  const code = str(recovery?.code) ?? str(recovery?.upstream?.code) ?? (parsed && parsed.code !== "unrecognized" ? parsed.code : null);
  const type = str(recovery?.upstream?.type) ?? str(parsed?.type);
  const status = num(recovery?.status) ?? num(recovery?.upstream?.status) ?? num(parsed?.status);
  const detail = [reason, code && code !== "unrecognized" ? `upstream=${code}` : null, status !== null ? `status=${status}` : null]
    .filter(Boolean).join(" ") || String(message.stopReason);

  // Owner-actionable failures first, so a budget or timeout label never hides them.
  if (reason === "upstream-auth-refusal" || (code && AUTH_CODES.has(code)) || type === "authentication_error" ||
    type === "permission_error" || status === 401 || status === 403 || (!reason && AUTH_TEXT.test(text))) {
    return { action: "stop", cause: "authentication", detail };
  }
  if (reason === "upstream-policy-refusal" || (code && POLICY_CODES.has(code)) || type === "policy_error" ||
    (!reason && POLICY_TEXT.test(text))) {
    return { action: "stop", cause: "policy", detail };
  }
  if (code === "insufficient_quota" || (!reason && QUOTA_TEXT.test(text))) return { action: "stop", cause: "quota", detail };
  if (code === "context_length_exceeded" || (reason && CONTEXT_REASONS.has(reason)) ||
    (message.stopReason === "error" && isContextOverflow(message as never, evidence.contextWindow))) {
    return { action: "stop", cause: "context-length", detail };
  }
  if (reason === "unobservable-provider-retries") return { action: "stop", cause: "configuration", detail };

  if (evidence.harnessAbort === "request-timeout" || reason === "safe-local-timeout" || reason === "timeout-not-replayable") {
    return { action: "resume", cause: evidence.ceilingLimit === "absolute" ? "request-ceiling" : "stalled-request", detail };
  }
  if (text === EMPTY_LENGTH_ERROR) return { action: "resume", cause: "request-ceiling", detail: detail === "error" ? "empty-output-budget" : detail };
  return { action: "resume", cause: "provider-error", detail };
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
