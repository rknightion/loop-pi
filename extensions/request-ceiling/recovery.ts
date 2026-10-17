// Supported lifecycle adapter: one pi retry machine, content-free recovery metadata.
import { randomUUID } from "node:crypto";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EMPTY_LENGTH_ERROR } from "./core.ts";
import { classifyRetryError, retryPolicy } from "./backoff.ts";

export const RECOVERY_STOP = "loop-pi recovery required; automatic continuation declined";
export const EPISODE_STOP = "loop-pi recovery budget exhausted; start a new user turn to resume";
export interface RecoveryConfig { episodeMs: number; providerIds: string[]; maxAttempts: number }
export function recoveryConfig(settings: unknown): RecoveryConfig {
  const raw = (settings as { loopPi?: { retryRecovery?: Partial<RecoveryConfig> } })?.loopPi?.retryRecovery;
  return {
    episodeMs: typeof raw?.episodeMs === "number" && Number.isFinite(raw.episodeMs) && raw.episodeMs > 0 && raw.episodeMs <= 2147483647 ? raw.episodeMs : 1200000,
    providerIds: Array.isArray(raw?.providerIds) ? raw.providerIds.filter((x): x is string => typeof x === "string") : [],
    maxAttempts: typeof raw?.maxAttempts === "number" && Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1 && raw.maxAttempts <= 5 ? raw.maxAttempts : 5,
  };
}
interface ProxyError { code: string; type?: string; message?: string; status?: number }
const POLICY_CODES = new Set(["cyber_policy", "content_policy_violation", "content_filter", "policy_violation", "safety_violation"]);
const AUTH_CODES = new Set(["invalid_api_key", "authentication_error", "permission_denied", "insufficient_permissions"]);
const CODES = new Set(["stream_incomplete", "previous_response_owner_unavailable", "bridge_previous_response_not_found", "continuity_recovery_required", "native_websocket_backpressure", "insufficient_quota", "context_length_exceeded", ...POLICY_CODES, ...AUTH_CODES]);
const ERROR_TYPES = new Set(["server_error", "invalid_request_error", "authentication_error", "permission_error", "policy_error", "rate_limit_error"]);
const correlation = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
function proxyError(value: unknown, status?: number): ProxyError | undefined {
  if (!value || typeof value !== "object") return;
  const e = value as Record<string, unknown>;
  return { code: typeof e.code === "string" && CODES.has(e.code) ? e.code : "unrecognized", type: typeof e.type === "string" ? ERROR_TYPES.has(e.type) ? e.type : "unrecognized" : undefined, message: typeof e.message === "string" ? e.message : undefined, status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined };
}
export function httpProxyError(message?: string): ProxyError | undefined {
  const match = /^[^\r\n]{1,128} API error \((\d{3})\): ([\s\S]*)$/.exec(message ?? "");
  if (!match) return;
  const status = Number(match[1]);
  try {
    const body = JSON.parse(match[2]);
    return proxyError(body?.error ?? body, status) ?? (status === 401 || status === 403 ? { code: "authentication_error", status } : undefined);
  } catch { return status === 401 || status === 403 ? { code: "authentication_error", status } : undefined; }
}
export function portableRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (p.previous_response_id != null || p.conversation != null || !Array.isArray(p.input)) return false;
  const inputTypes = new Set(["message", "reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
  if (p.input.some((item) => !item || typeof item !== "object" || (item.type !== undefined ? !inputTypes.has(item.type) : !["user", "assistant", "system", "developer"].includes(item.role)))) return false;
  if (p.tools != null && (!Array.isArray(p.tools) || p.tools.some((tool) => !tool || typeof tool !== "object" || !["function", "custom"].includes(tool.type)))) return false;
  const calls = new Map<string, string>();
  const completed = new Set<string>();
  for (const item of p.input) {
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (typeof item.call_id !== "string" || !item.call_id || calls.has(item.call_id)) return false;
      calls.set(item.call_id, item.type);
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      if (typeof item.call_id !== "string" || calls.get(item.call_id) + "_output" !== item.type || completed.has(item.call_id)) return false;
      completed.add(item.call_id);
    }
  }
  if (calls.size !== completed.size) return false;
  const pending: unknown[] = [p.input];
  while (pending.length) {
    const value: unknown = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const item = value as Record<string, unknown>;
    if ("file_id" in item || "container_id" in item || item.type === "item_reference" || item.type === "input_file") return false;
    pending.push(...Object.values(item));
  }
  return true;
}
export function safeProxyRetry(error: ProxyError | undefined): boolean {
  if (!error || error.type !== "server_error" || (error.status !== undefined && (error.status < 500 || error.status > 504))) return false;
  if (error.code === "previous_response_owner_unavailable" || error.code === "native_websocket_backpressure") return true;
  return error.code === "stream_incomplete" && error.message === "The previous response anchor was rejected upstream; retry the request.";
}
// Positive provenance, not an API-name guess. Native/custom providers and inherited
// builtin authentication are opaque here. A static non-builtin compatibility registration
// without OAuth delegates to the pinned standard API and cannot auth-reroute its base URL.
function standardSummaryRoute(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model || model.api !== "openai-responses") return false;
  const registry = ctx.modelRegistry;
  const config = registry.getRegisteredProviderConfig(model.provider);
  const physical = registry.find(model.provider, model.id);
  return !!config && !!registry.getProvider(model.provider) && !!physical
    && physical.api === model.api && physical.baseUrl === model.baseUrl
    // Free-form model sampling fields are applied last and can inject anchors or
    // hosted tools into a summary that has no payload inspection callback.
    && !model.samplingParams && !model.samplingParamsByThinkingLevel
    && !getBuiltinProviders().includes(model.provider as ReturnType<typeof getBuiltinProviders>[number])
    && !registry.getRegisteredNativeProvider(model.provider)
    && !config.streamSimple && !config.oauth && !config.refreshModels
    && !registry.getProvider(model.provider)?.auth.oauth && !registry.isUsingOAuth(model);
}
export function installRecovery(pi: ExtensionAPI, loadSettings: (ctx?: ExtensionContext) => unknown): void {
  let deadline: number | undefined;
  let startedAt = 0;
  let episodeMs = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let expired = false;
  let notified = false;
  let opted = false;
  let halted = false;
  let provider: string | undefined;
  let portable = false;
  let output = false;
  let error: ProxyError | undefined;
  let attemptId: string | undefined;
  let responses = false;
  let toolsExecuted = false;
  let unsafeOutput = false;
  let stopReason: string | undefined;
  let stopNotified = false;
  let attempts = 0;
  let attemptLimit = 1;
  let exhaustionCause: string | undefined;
  let ceilingAllowed = false;
  let admissionReason: string | undefined;
  let responseStatus: number | undefined;
  let requestId: string | null = null;
  let compactionAllowed = false;
  let summaryScope = false;
  let summaryInvocations = 0;
  let summaryClientId: string | null = null;
  type Upstream = { code: string | null; type: string | null; status: number | null; requestId: string | null; clientRequestId: string | null };
  let stoppedUpstream: Upstream | undefined;
  let failedUpstream: Upstream | undefined;
  let lastRequestUpstream: Upstream | undefined;
  const upstream = (): Upstream => ({ code: error?.code ?? null, type: error?.type ?? null, status: error?.status ?? responseStatus ?? null, requestId, clientRequestId: attemptId ?? null });
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const reset = () => { clearTimer(); deadline = undefined; expired = false; notified = false; halted = false; active = false; stopReason = undefined; stopNotified = false; attempts = 0; exhaustionCause = undefined; ceilingAllowed = false; admissionReason = undefined; stoppedUpstream = undefined; failedUpstream = undefined; lastRequestUpstream = undefined; compactionAllowed = false; summaryScope = false; summaryInvocations = 0; summaryClientId = null; };
  const abortRecovery = (ctx: { abort(): void; signal?: AbortSignal }) => {
    // Synchronous attribution before abort: loop-wait must not mistake this for operator Esc.
    // Not when the owner already aborted this run: that stop is theirs, and announcing it as the
    // harness's would rewrite the owner's held notices (SEAMS.md "Run-dir files and return caps").
    if (!ctx.signal?.aborted) pi.events.emit("loop-recovery:abort", {});
    ctx.abort();
  };
  const arm = (ctx: { abort(): void; signal?: AbortSignal }) => {
    clearTimer();
    if (deadline === undefined || (!active && !summaryScope)) return;
    const expire = () => {
      timer = undefined;
      expired = true;
      exhaustionCause ??= "episode-expired";
      if (active || summaryScope) abortRecovery(ctx);
    };
    if (Date.now() >= deadline) expire();
    else { timer = setTimeout(expire, deadline - Date.now()); timer.unref?.(); }
  };
  const notifyExhausted = () => {
    if (!expired || notified) return;
    notified = true;
    pi.sendMessage({ customType: "loop-recovery-exhausted",
      content: `${EPISODE_STOP} (${exhaustionCause ?? "episode-expired"}). Child updates are retained. Inspect saved work before resuming.`,
      display: true, details: { episodeMs, reason: exhaustionCause ?? "episode-expired", attempts, maxAttempts: attemptLimit } }, { triggerTurn: false });
  };
  const mayContinue = () => {
    if (!halted && deadline !== undefined && Date.now() >= deadline) { expired = true; exhaustionCause ??= "episode-expired"; }
    if (!active) notifyExhausted();
    return !opted || (!expired && !halted);
  };
  pi.events.on("loop-recovery:may-follow-up", (value: unknown) => {
    (value as { reply(allowed: boolean): void }).reply(mayContinue());
  });
  // Existing wake consumers keep their boolean query. Only the ceiling uses this richer
  // decision so refused managed incidents do not emit a second actionable stop notice.
  pi.events.on("loop-recovery:ceiling-decision", (value: unknown) => {
    const query = value as { consecutive: number; maxFollowUps: number; reply(decision: { managed: boolean; allowed: boolean; attempts: number; maxAttempts: number }): void };
    if (opted && ceilingAllowed && query.consecutive > query.maxFollowUps && !halted && !expired) {
      expired = true; exhaustionCause = "ceiling-limit";
    }
    query.reply({ managed: opted, allowed: opted ? ceilingAllowed && mayContinue() : true, attempts, maxAttempts: attemptLimit });
  });
  pi.on("model_select", () => { reset(); opted = false; });
  // loop-continuation's automatic root resume (SEAMS.md "Automatic root recovery"): after its backoff
  // it resets an idle episode exactly as an owner's idle input would. Wakes never emit this.
  pi.events.on("loop-recovery:resume", () => { if (!active) reset(); });
  pi.events.on("loop-recovery:request-timeout", () => { if (active) timedOut = true; });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source === "extension" && !mayContinue()) return { action: "handled" as const };
    // Input may be queued while a request or retry is active. Only an idle
    // genuine user turn resets the episode; queued input cannot extend it.
    if (event.source !== "extension" && !active) reset();
  });
  pi.on("turn_start", (_event, ctx) => {
    if (provider !== ctx.model?.provider) reset();
    provider = ctx.model?.provider;
    active = true;
    startedAt = Date.now();
    const settings = loadSettings(ctx);
    const config = recoveryConfig(settings);
    // Freeze the effective duration once a failure establishes the episode.
    if (deadline === undefined) episodeMs = config.episodeMs;
    const native = retryPolicy(settings);
    const nextLimit = Math.min(config.maxAttempts, native.enabled ? Math.max(1, Math.floor(native.maxRetries) + 1) : 1);
    attemptLimit = attempts === 0 ? nextLimit : Math.min(attemptLimit, nextLimit);
    opted = config.providerIds.includes(ctx.model?.provider ?? "");
    timedOut = false; portable = false; output = false; error = undefined; attemptId = undefined;
    ceilingAllowed = false; admissionReason = undefined; responseStatus = undefined; requestId = null; compactionAllowed = false; failedUpstream = undefined; lastRequestUpstream = undefined;
    responses = ctx.model?.api === "openai-responses"; toolsExecuted = false; unsafeOutput = false;
    if (opted && halted) abortRecovery(ctx);
    else if (opted) arm(ctx);
  });
  const providerRetriesHidden = (ctx: ExtensionContext) => {
    const retries = (loadSettings(ctx) as { retry?: { provider?: { maxRetries?: unknown } } })?.retry?.provider?.maxRetries;
    return retries !== undefined && retries !== 0;
  };
  const stopSummary = (reason: string, ctx: ExtensionContext) => {
    // No summary result instrumentation exists. Never reuse the overflow error's
    // status/refusal/server correlation as evidence about this opaque operation.
    halted = true; stopReason ??= reason; ceilingAllowed = false;
    stoppedUpstream = { code: null, type: null, status: null, requestId: null, clientRequestId: summaryClientId };
    abortRecovery(ctx);
  };
  const budgetAvailable = (ctx: ExtensionContext) => {
    if (attempts >= attemptLimit) { expired = true; exhaustionCause ??= "attempt-limit"; }
    if (deadline !== undefined && Date.now() >= deadline) { expired = true; exhaustionCause ??= "episode-expired"; }
    if (expired) { abortRecovery(ctx); return false; }
    return true;
  };
  pi.on("session_before_compact", (event, ctx) => {
    if (!opted || deadline === undefined) return; // Ordinary compaction unchanged.
    summaryScope = false;
    const p = event.preparation;
    const twoCalls = p.isSplitTurn && p.messagesToSummarize.length > 0 && p.turnPrefixMessages.length > 0;
    const reason = halted ? stopReason ?? "recovery-halted"
      : !compactionAllowed || !portable || !responses || toolsExecuted || unsafeOutput ? "summary-original-request-not-safe"
      : twoCalls ? "two-call-summary-not-authorized"
      : !standardSummaryRoute(ctx) ? "summary-route-not-established"
      : providerRetriesHidden(ctx) ? "unobservable-provider-retries"
      : summaryInvocations > 0 ? "opaque-summary-retry-not-authorized" : undefined;
    if (reason) { stopSummary(reason, ctx); return { cancel: true }; }
    if (!budgetAvailable(ctx)) return { cancel: true };
    summaryScope = true;
    arm(ctx);
  });
  pi.on("session_compact", (_event, ctx) => { summaryScope = false; compactionAllowed = false; arm(ctx); });
  pi.on("session_compact_failed", (event, ctx) => {
    if (summaryScope && !halted && !expired) {
      if (event.aborted) { halted = true; stopReason = "operator-cancelled"; stopNotified = true; }
      else stopSummary("opaque-summary-failure-not-replayable", ctx);
    }
    summaryScope = false; compactionAllowed = false; arm(ctx);
  });
  pi.on("cache_warming_decision", () => {
    // Also stop idle refreshes while a retained failed episode awaits a wake.
    if (opted && (active || deadline !== undefined || halted || expired)) return { action: "stop" };
  });
  pi.on("before_provider_headers", (event, ctx) => {
    if ((!active && !summaryScope) || !opted) return;
    if (halted) { abortRecovery(ctx); return; }
    if (summaryScope && summaryInvocations > 0) {
      stopSummary("opaque-summary-retry-not-authorized", ctx); return;
    }
    if (providerRetriesHidden(ctx)) {
      admissionReason = "unobservable-provider-retries"; halted = true; stopReason = admissionReason;
      abortRecovery(ctx); return;
    }
    if (!budgetAvailable(ctx)) return;
    attemptId = randomUUID();
    for (const name of Object.keys(event.headers)) if (name.toLowerCase() === "x-client-request-id") delete event.headers[name];
    event.headers["x-client-request-id"] = attemptId;
    attempts++;
    if (summaryScope) { summaryInvocations++; summaryClientId = attemptId; }
    lastRequestUpstream = { code: null, type: null, status: null, requestId: null, clientRequestId: attemptId };
  });
  pi.on("before_provider_request", (event) => {
    if (!active || !opted || summaryScope) return;
    portable = portableRequest(event.payload);
  });
  pi.on("after_provider_response", (event) => {
    if (!active || !opted) return;
    responseStatus = Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : undefined;
    requestId = null;
    for (const [name, value] of Object.entries(event.headers)) if (name.toLowerCase() === "x-request-id") requestId = correlation(value);
    if (lastRequestUpstream) lastRequestUpstream = { ...lastRequestUpstream, status: responseStatus ?? null, requestId };
  });
  pi.on("tool_execution_start", () => { if (active) toolsExecuted = true; });
  pi.on("provider_stream_event", (event) => {
    if (!active || !opted) return;
    const data = event.data as { type?: string; item?: { type?: string }; error?: unknown; response?: { error?: unknown; output?: { type?: string }[] } };
    const items = [...(data?.item ? [data.item] : []), ...(Array.isArray(data?.response?.output) ? data.response.output : [])];
    if (items.some((item) => !item || !["message", "reasoning", "function_call", "custom_tool_call"].includes(item.type ?? ""))) unsafeOutput = true;
    if (data?.type === "response.failed" || data?.type === "error") {
      error = proxyError(data.type === "response.failed" ? data.response?.error : data.error ?? data);
      failedUpstream = upstream();
    } else if (data?.type?.includes("output_item") || data?.type?.endsWith(".delta")) output = true;
  });
  pi.on("message_update", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const e = event.assistantMessageEvent;
    if ((e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") && e.delta.length > 0) output = true;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    let message = event.message;
    // Terminal done has no intervening message_update. Enforce a retained episode
    // before success can reset it or make a completed tool call executable.
    if (opted && active && deadline !== undefined && Date.now() >= deadline
      && (message.stopReason === "stop" || message.stopReason === "toolUse")) {
      expired = true; exhaustionCause ??= "episode-expired";
      abortRecovery(ctx);
      message = {...message, stopReason: "aborted", errorMessage: EPISODE_STOP};
    }
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    const operatorCancelled = message.stopReason === "aborted" && !timedOut && !expired && !admissionReason && !halted;
    if (message.stopReason === "stop" || message.stopReason === "toolUse") reset();
    if (opted && operatorCancelled) {
      // Preserve the original abort outcome and do not blame the upstream or post a
      // recovery notice. Automatic input remains held until genuine idle input.
      halted = true; stopReason = "operator-cancelled"; stopNotified = true;
    }
    if (!opted) return;
    error ??= httpProxyError(message.errorMessage);
    if (!error && failed) {
      // Some transports expose only error text. A known refusal token may deny
      // replay, never authorize it; retain the allowlisted classification only.
      const refusal = [...POLICY_CODES, ...AUTH_CODES].find((code) => new RegExp(`\\b${code}\\b`).test(message.errorMessage ?? ""));
      if (refusal) error = { code: refusal };
    }
    output ||= message.content.some((block) => block.type === "toolCall" || (block.type === "text" && block.text.length > 0) || (block.type === "thinking" && block.thinking.length > 0));
    // The pinned Responses agent loop never executes local tool calls from an errored
    // assistant. Native retry omits that attempt, preserving earlier completed tool results.
    const localReplay = responses && portable && !toolsExecuted && !unsafeOutput;
    const interrupted = error?.code === "stream_incomplete" && error.type === "server_error"
      && (error.status === undefined || (error.status >= 500 && error.status <= 504));
    const retryable = safeProxyRetry(error) || (localReplay && interrupted);
    const contextOverflowAllowed = error === undefined || (error.code === "context_length_exceeded"
      && error.type === "invalid_request_error" && (error.status === undefined || error.status === 400));
    const contextOverflow = contextOverflowAllowed && message.stopReason === "error"
      && isContextOverflow(message, ctx.model?.contextWindow);
    const nativeCompaction = contextOverflow && localReplay && !output;
    const emptyCeiling = localReplay && message.errorMessage === EMPTY_LENGTH_ERROR
      && !message.content.some((block) => block.type === "toolCall" || (block.type === "text" && block.text.length > 0));
    const ownedRecovery = nativeCompaction || emptyCeiling;
    let reason: string | undefined;
    if (failed && expired) reason = exhaustionCause ?? "episode-expired";
    else if (admissionReason) reason = admissionReason;
    else if (failed && !operatorCancelled && error && (POLICY_CODES.has(error.code) || error.type === "policy_error")) reason = "upstream-policy-refusal";
    else if (failed && !operatorCancelled && error && (AUTH_CODES.has(error.code) || error.type === "authentication_error" || error.type === "permission_error" || error.status === 401 || error.status === 403)) reason = "upstream-auth-refusal";
    else if (failed && !operatorCancelled && error && !retryable && !contextOverflow) reason = "non-retryable-upstream";
    else if (failed && !responses && isContextOverflow(message, ctx.model?.contextWindow)) reason = "summary-route-not-established";
    else if (failed && !ownedRecovery && (message.stopReason === "error" || timedOut)) {
      if (!portable) reason = "protected-request";
      else if (toolsExecuted) reason = "tool-execution-observed";
      else if (unsafeOutput) reason = "hosted-or-unknown-output";
      else if (timedOut && !localReplay) reason = "timeout-not-replayable";
      else if (output && !(localReplay && (interrupted || timedOut))) reason = "partial-output-not-replayable";
      else if (error !== undefined && !retryable) reason = "non-retryable-upstream";
      else if (error === undefined && !timedOut && !isRetryableAssistantError(message)) reason = "unclassified-failure";
    }
    // Safety classification precedes exhaustion: a policy/auth refusal must not
    // disappear behind a generic budget decision on the last eligible attempt.
    if (failed && !operatorCancelled && !reason && attempts >= attemptLimit) {
      expired = true; exhaustionCause = "attempt-limit"; reason = exhaustionCause;
    }
    const denied = reason !== undefined;
    if (denied && !expired) {
      halted = true; stopReason ??= reason;
      stoppedUpstream ??= upstream();
    }
    const nativeTransient = error === undefined && message.stopReason === "error" && isRetryableAssistantError(message);
    const allowed = !denied && !operatorCancelled && ((message.stopReason === "error" && !ownedRecovery && (retryable || nativeTransient)) || (timedOut && localReplay));
    ceilingAllowed = !denied && !operatorCancelled && (emptyCeiling || (timedOut && localReplay));
    compactionAllowed = !denied && !operatorCancelled && (nativeCompaction || emptyCeiling || (timedOut && localReplay));
    // Healthy request time is excluded. Only positively authorized recovery establishes
    // the shared deadline; later attempts and progress never move it.
    if (failed && !expired && deadline === undefined && (allowed || ceilingAllowed || compactionAllowed)) {
      deadline = Date.now() + episodeMs;
      arm(ctx);
    }
    const retryReason = timedOut ? "safe-local-timeout" : localReplay && interrupted ? "interrupted-local-response" : "unstarted-request";
    const upstreamLabel = stoppedUpstream?.code && stoppedUpstream.code !== "unrecognized" ? `; upstream=${stoppedUpstream.code}` : "";
    const explanation = `${RECOVERY_STOP} (${stopReason ?? reason}${upstreamLabel}). Inspect saved work, then send a new message to resume.`;
    return { message: {
      ...message,
      ...(denied ? { stopReason: "error" as const, errorMessage: expired ? EPISODE_STOP : explanation } : {}),
      ...(allowed && !timedOut ? { errorMessage: `server error: ${error?.code ?? classifyRetryError(message.errorMessage)}; ${retryReason}; retrying from completed history` } : {}),
      loopPiRecovery: { attemptId: attemptId ?? null, code: error?.code ?? null, status: error?.status ?? null, disposition: denied ? "stop" : allowed ? "retry" : "unchanged",
        reason: denied ? (stopReason ?? reason) : allowed ? retryReason : nativeCompaction ? "native-compaction" : emptyCeiling ? "bounded-empty-output" : null,
        outputObserved: output, requestPortable: portable, toolsExecuted,
        attempts, maxAttempts: attemptLimit,
        upstream: upstream(),
      },
    } };
  });
  pi.on("agent_settled", () => {
    active = false; clearTimer();
    if (halted && !expired && !stopNotified) {
      stopNotified = true;
      pi.sendMessage({ customType: "loop-recovery-required",
        content: `${RECOVERY_STOP} (${stopReason}${stoppedUpstream?.code && stoppedUpstream.code !== "unrecognized" ? `; upstream=${stoppedUpstream.code}` : ""}). Child updates are retained. Inspect saved work, then send a new message to resume.`,
        display: true, details: { reason: stopReason, attempts, maxAttempts: attemptLimit, upstream: stoppedUpstream ?? null } }, { triggerTurn: false });
    }
    notifyExhausted();
  });
}
