// Supported lifecycle adapter: one pi retry machine, content-free recovery metadata.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RECOVERY_STOP = "loop-pi recovery required; automatic continuation declined";
export const EPISODE_STOP = "loop-pi recovery budget exhausted; start a new user turn to resume";
export interface RecoveryConfig { episodeMs: number; providerIds: string[] }
export function recoveryConfig(settings: unknown): RecoveryConfig {
  const raw = (settings as { loopPi?: { retryRecovery?: Partial<RecoveryConfig> } })?.loopPi?.retryRecovery;
  return {
    episodeMs: typeof raw?.episodeMs === "number" && Number.isFinite(raw.episodeMs) && raw.episodeMs > 0 && raw.episodeMs <= 2147483647 ? raw.episodeMs : 1200000,
    providerIds: Array.isArray(raw?.providerIds) ? raw.providerIds.filter((x): x is string => typeof x === "string") : [],
  };
}
interface ProxyError { code: string; type?: string; message?: string; status?: number }
const CODES = new Set(["stream_incomplete", "previous_response_owner_unavailable", "bridge_previous_response_not_found", "continuity_recovery_required", "native_websocket_backpressure", "invalid_api_key", "insufficient_quota"]);
function proxyError(value: unknown, status?: number): ProxyError | undefined {
  if (!value || typeof value !== "object") return;
  const e = value as Record<string, unknown>;
  if (typeof e.code !== "string") return;
  return { code: CODES.has(e.code) ? e.code : "unrecognized", type: typeof e.type === "string" ? e.type : undefined, message: typeof e.message === "string" ? e.message : undefined, status };
}
export function httpProxyError(message?: string): ProxyError | undefined {
  const match = /^[^\r\n]{1,128} API error \((\d{3})\): (\{.*\})$/s.exec(message ?? "");
  if (!match) return;
  try { const body = JSON.parse(match[2]); return proxyError(body.error ?? body, Number(match[1])); } catch { return; }
}
export function portableRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (p.previous_response_id != null || !Array.isArray(p.input)) return false;
  if (Array.isArray(p.tools) && p.tools.some((tool) => !tool || typeof tool !== "object" || !["function", "custom"].includes(tool.type))) return false;
  const calls = new Set(p.input.filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call").map((item) => item.call_id));
  if (p.input.some((item) => (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") && !calls.has(item.call_id))) return false;
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
export function installRecovery(pi: ExtensionAPI, loadSettings: () => unknown): void {
  let deadline: number | undefined;
  let startedAt = 0;
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
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const reset = () => { clearTimer(); deadline = undefined; expired = false; notified = false; halted = false; active = false; };
  const arm = (ctx: { abort(): void }) => {
    clearTimer();
    if (deadline === undefined || !active) return;
    const expire = () => {
      timer = undefined;
      expired = true;
      if (active) ctx.abort();
    };
    if (Date.now() >= deadline) expire();
    else { timer = setTimeout(expire, deadline - Date.now()); timer.unref?.(); }
  };
  pi.events.on("loop-recovery:may-follow-up", (value: unknown) => {
    (value as { reply(allowed: boolean): void }).reply(!opted || (!expired && !halted));
  });
  pi.on("model_select", () => { reset(); opted = false; });
  pi.events.on("loop-recovery:request-timeout", () => { if (active) timedOut = true; });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    // Input may be queued while a request or retry is active. Only an idle
    // genuine user turn resets the episode; queued input cannot extend it.
    if (event.source !== "extension" && !active) reset();
  });
  pi.on("turn_start", (_event, ctx) => {
    if (provider !== ctx.model?.provider) reset();
    provider = ctx.model?.provider;
    active = true;
    startedAt = Date.now();
    opted = recoveryConfig(loadSettings()).providerIds.includes(ctx.model?.provider ?? "");
    timedOut = false; portable = false; output = false; error = undefined; attemptId = undefined;
    if (opted && halted) ctx.abort();
    else if (opted) arm(ctx);
  });
  pi.on("before_provider_headers", (event) => {
    if (!active || !opted) return;
    attemptId = randomUUID();
    for (const name of Object.keys(event.headers)) if (name.toLowerCase() === "x-client-request-id") delete event.headers[name];
    event.headers["x-client-request-id"] = attemptId;
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!active || !opted) return;
    if (expired || (deadline !== undefined && Date.now() >= deadline)) { expired = true; ctx.abort(); }
    if (opted) portable = portableRequest(event.payload);
  });
  pi.on("provider_stream_event", (event) => {
    if (!active || !opted) return;
    const data = event.data as { type?: string; error?: unknown; response?: { error?: unknown } };
    if (data?.type === "response.failed") error = proxyError(data.response?.error);
    else if (data?.type === "error") error = proxyError(data.error ?? data);
    else if (data?.type?.includes("output_item") || data?.type?.endsWith(".delta")) output = true;
  });
  pi.on("message_update", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const e = event.assistantMessageEvent;
    if ((e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") && e.delta.length > 0) output = true;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const message = event.message;
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    if (!failed && message.stopReason !== "length") reset();
    if (opted && failed && !expired && (message.stopReason !== "aborted" || timedOut) && deadline === undefined) {
      deadline = startedAt + recoveryConfig(loadSettings()).episodeMs;
      arm(ctx);
    }
    if (!opted) return;
    error ??= httpProxyError(message.errorMessage);
    output ||= message.content.some((block) => block.type === "toolCall" || (block.type === "text" && block.text.length > 0) || (block.type === "thinking" && block.thinking.length > 0));
    const denied = failed && (expired || ((message.stopReason === "error" || timedOut) && (output || !portable || (error !== undefined && !safeProxyRetry(error)))));
    if (denied) halted = true;
    const allowed = message.stopReason === "error" && !denied && safeProxyRetry(error);
    return { message: {
      ...message,
      ...(denied ? { stopReason: "error" as const, errorMessage: expired ? EPISODE_STOP : RECOVERY_STOP } : {}),
      ...(allowed ? { errorMessage: `server error: ${error!.code}; safe unstarted request may retry` } : {}),
      loopPiRecovery: { attemptId: attemptId ?? null, code: error?.code ?? null, status: error?.status ?? null, disposition: denied ? "stop" : allowed ? "retry" : "unchanged" },
    } };
  });
  pi.on("agent_settled", () => {
    active = false; clearTimer();
    if (expired && !notified) {
      notified = true;
      pi.sendMessage({ customType: "loop-recovery-exhausted", content: EPISODE_STOP,
        display: true, details: { episodeMs: recoveryConfig(loadSettings()).episodeMs } }, { triggerTurn: false });
    }
  });
}
