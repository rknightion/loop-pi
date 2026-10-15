// Per-request ceiling (SEAMS.md "Request ceiling"). Installed by both loop-guard entries, so the
// root and every lane get it. pi's own bounds do not cover a request that keeps streaming
// reasoning: `httpIdleTimeoutMs` is an idle timer that every streamed event resets, and the
// provider `timeoutMs` stops at the response headers. This adds inactivity and absolute bounds per model
// request, and turns an empty output-budget stop into an incident instead of a silent stop.
//
// - A timer starts at `turn_start` (pi's agent loop sends exactly one model request per turn, and
//   a retry is a new turn) and ends at the assistant `message_end`. `before_provider_request` is
//   not used: only providers that call `onPayload` emit it. When the timer fires first, the run is
//   aborted (`ctx.abort()`, the supported way to stop the in-flight request).
// - An assistant `length` stop with no text and no tool call is rewritten at `message_end` as an
//   error whose text pi neither retries nor compacts for.
// - At `agent_settled` either case sends one `loop-request-incident` custom message that starts a
//   new turn, up to `maxFollowUps` in a row; a request that completes resets the chain. After
//   that, the message is appended without starting a turn and an `-exhausted` incident is written.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { newProgress, observeAssistantEvent, type RequestProgress } from "../call-timing/progress.ts";
import { installRecovery } from "./recovery.ts";
import { backoffConfig, classifyRetryError, extraRetryDelayMs, retryPolicy } from "./backoff.ts";
import {
  type CeilingConfig,
  EMPTY_LENGTH_ERROR,
  INCIDENT_CUSTOM_TYPE,
  type Incident,
  ceilingConfig,
  incidentText,
  isEmptyLengthStop,
  writeRequestIncident,
} from "./core.ts";

function readSettings(ctx?: ExtensionContext): unknown {
  if (ctx) {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
    // Unknown effective retry configuration cannot authorize unobservable HTTP retries.
    if (settings.drainErrors().length) return { ...settings.getGlobalSettings(), retry: { provider: { maxRetries: "unknown" } } };
    return settings.getSettings();
  }
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function loadConfig(): CeilingConfig {
  return ceilingConfig(readSettings());
}

export function installRequestCeiling(pi: ExtensionAPI, supplied: CeilingConfig = loadConfig()): void {
  const config = ceilingConfig({loopPi: {requestCeiling: supplied}});
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let progress: RequestProgress | undefined;
  let active = false;
  let pending: Incident | undefined;
  let consecutive = 0;
  let sessionId = "";

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // A new or switched session starts a fresh chain; nothing carries over from the last one.
    stopTimer();
    generation++;
    pending = undefined;
    active = false;
    progress = undefined;
    consecutive = 0;
    sessionId = ctx.sessionManager.getSessionId();
  });

  const expiredLimit = (now: number): "inactivity" | "absolute" | undefined => {
    if (now - startedAt >= config.absoluteMs) return "absolute";
    if (now - (progress?.lastModelEventAt ?? startedAt) >= config.inactivityMs) return "inactivity";
    return undefined;
  };
  const expire = (ctx: ExtensionContext, kind: "inactivity" | "absolute", now: number) => {
    stopTimer(); active = false;
    pending = {kind: "wall-clock", model: ctx.model?.id ?? "unknown", elapsedMs: now - startedAt,
      wallClockMs: kind === "absolute" ? config.absoluteMs : config.inactivityMs,
      limitType: kind, absoluteMs: config.absoluteMs, inactivityMs: config.inactivityMs,
      idleMs: now - (progress?.lastModelEventAt ?? startedAt), lastModelEventAt: progress?.lastModelEventAt ?? null};
    pi.events.emit("loop-recovery:request-timeout", { limitType: kind });
    ctx.abort();
  };
  const arm = (ctx: ExtensionContext) => {
    stopTimer();
    if (!active) return;
    const mine = generation;
    const now = Date.now(); const kind = expiredLimit(now);
    if (kind) { expire(ctx, kind, now); return; }
    const next = Math.min(startedAt + config.absoluteMs, (progress?.lastModelEventAt ?? startedAt) + config.inactivityMs);
    timer = setTimeout(() => { if (active && mine === generation) arm(ctx); }, Math.max(1, next - now));
    timer.unref?.();
  };
  pi.on("turn_start", (_event, ctx: ExtensionContext) => {
    stopTimer(); generation++; active = true; startedAt = Date.now();
    progress = newProgress({session: sessionId || null, request: "ceiling", turn: 1,
      provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, api: ctx.model?.api ?? null}, startedAt);
    arm(ctx);
  });
  pi.on("message_update", (event, ctx: ExtensionContext) => {
    if (!active || !progress || event.message.role !== "assistant") return;
    const now = Date.now(); const kind = expiredLimit(now);
    if (kind) { expire(ctx, kind, now); return; }
    if (observeAssistantEvent(progress, event.assistantMessageEvent, now)) arm(ctx);
  });

  pi.on("message_end", (event, ctx: ExtensionContext) => {
    const message = event.message as { role?: string; stopReason?: string; model?: string; content?: unknown };
    if (message.role !== "assistant") return;
    // The SDK emits terminal done directly as message_end, without a progress update.
    // A delayed timer must not let terminal success execute tools after its deadline.
    const overdue = active && (message.stopReason === "stop" || message.stopReason === "toolUse")
      ? expiredLimit(Date.now()) : undefined;
    if (overdue) {
      expire(ctx, overdue, Date.now());
      generation++;
      return {message: {...event.message, stopReason: "aborted", errorMessage: "Request was aborted at the loop-pi request deadline"} as typeof event.message};
    }
    stopTimer();
    active = false;
    generation++;
    if (message.stopReason === "stop" || message.stopReason === "toolUse") {
      consecutive = 0;
      return;
    }
    if (isEmptyLengthStop(message)) {
      pending = {
        kind: "empty-length",
        model: message.model ?? ctx.model?.id ?? "unknown",
        elapsedMs: startedAt ? Date.now() - startedAt : 0,
        wallClockMs: config.wallClockMs,
      };
      return { message: { ...event.message, stopReason: "error", errorMessage: EMPTY_LENGTH_ERROR } as typeof event.message };
    }
    return;
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    active = false;
    stopTimer();
    const incident = pending;
    pending = undefined;
    if (!incident) return;
    consecutive++;
    let recoveryAllowsFollowUp = true;
    pi.events.emit("loop-recovery:may-follow-up", { reply: (allowed: boolean) => { recoveryAllowsFollowUp = allowed; } });
    let decision = { managed: false, allowed: recoveryAllowsFollowUp, attempts: 0, maxAttempts: 0 };
    pi.events.emit("loop-recovery:ceiling-decision", {
      consecutive, maxFollowUps: config.maxFollowUps,
      reply: (value: typeof decision) => { decision = value; },
    });
    const continuing = recoveryAllowsFollowUp && decision.allowed && consecutive <= config.maxFollowUps;
    const attempt = continuing ? consecutive : config.maxFollowUps;
    writeRequestIncident(getAgentDir(), sessionId, ctx.cwd, incident, decision.managed ? decision.attempts : consecutive, !continuing);
    // Managed denial/exhaustion owns its one actionable notice. Still retain the
    // incident file, but do not double-report it or accidentally trigger a turn.
    if (decision.managed && !continuing) return;
    pi.sendMessage(
      {
        customType: INCIDENT_CUSTOM_TYPE,
        content: incidentText(incident, attempt, config.maxFollowUps, continuing, decision.managed ? { attempts: decision.attempts, maxAttempts: decision.maxAttempts } : undefined),
        display: true,
        details: { limitType: incident.limitType ?? null, inactivityMs: incident.inactivityMs ?? config.inactivityMs, absoluteMs: incident.absoluteMs ?? config.absoluteMs, wallClockMs: incident.wallClockMs, idleMs: incident.idleMs ?? null, lastModelEventAt: incident.lastModelEventAt ?? null, kind: incident.kind, attempt: decision.managed ? decision.attempts : consecutive, exhausted: !continuing, elapsedMs: incident.elapsedMs },
      },
      { triggerTurn: continuing },
    );
  });

  pi.on("session_shutdown", () => {
    active = false;
    stopTimer();
  });
}

/**
 * Retry backoff (SEAMS.md "Retry backoff"): jitter on all retries and a minimum wait on 429, added in
 * front of pi's own agent-level retry wait. pi awaits `agent_end` handlers before it decides to
 * retry and sleeps its own `retryDelayMs`, so a wait here delays the retry without touching pi's
 * policy. Without this extension pi's backoff is unchanged.
 *
 * The attempt number mirrors pi's counter: pi retries a run whose last assistant message is a
 * retryable error (not a context overflow) while attempts remain, resets on any non-error
 * assistant message, and is always back at zero once the run settles.
 */
export function installRetryBackoff(pi: ExtensionAPI, loadSettings: (ctx?: ExtensionContext) => unknown = readSettings): void {
  installRecovery(pi, loadSettings);
  let attempt = 0;

  pi.on("session_start", () => {
    attempt = 0;
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; stopReason?: string };
    if (message.role === "assistant" && message.stopReason !== "error") attempt = 0;
  });

  pi.on("agent_settled", () => {
    attempt = 0;
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    const last = [...event.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
      | AssistantMessage
      | undefined;
    if (!last || last.stopReason !== "error") return;
    const settings = loadSettings(ctx);
    const policy = retryPolicy(settings);
    if (!policy.enabled) return;
    if (!isRetryableAssistantError(last) || isContextOverflow(last, ctx.model?.contextWindow ?? 0)) return;
    if (attempt + 1 > policy.maxRetries) return;
    attempt++;
    const extra = extraRetryDelayMs(classifyRetryError(last.errorMessage), retryDelayMs(policy, attempt), backoffConfig(settings));
    if (extra > 0) await abortableSleep(extra, ctx.signal);
  });
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Standalone entry for tests; installed homes reach both through the loop-guard entries.
export default function (pi: ExtensionAPI) {
  installRequestCeiling(pi);
  installRetryBackoff(pi);
}
