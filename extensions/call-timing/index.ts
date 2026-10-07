// Recorded timing seam: observe supported pi 1.0.4 hooks, never wrap the provider or alter retries.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETAINED_HEADERS = new Set([
  "x-request-id", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests", "service-tier",
]);

export interface CallTiming {
  firstTokenAt: number | null;
  attempts: null;
  processingMs: number | null;
  headers: Record<string, string>;
}

/** Only recorded nonnegative 32-bit integer milliseconds, matching the catalogue read seam. */
export function processingMilliseconds(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isInteger(number) && number >= 0 && number < 2 ** 31 ? number : null;
}

export function responseTiming(headers: Record<string, string>): Pick<CallTiming, "headers" | "processingMs"> {
  const retained: Record<string, string> = {};
  let processingMs: number | null = null;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (RETAINED_HEADERS.has(name)) retained[name] = value;
    else if (name === "openai-processing-ms") processingMs = processingMilliseconds(value);
  }
  return { headers: retained, processingMs };
}

export default function (pi: ExtensionAPI) {
  let timing: CallTiming | undefined;
  const reset = () => { timing = undefined; };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("turn_start", () => {
    timing = { firstTokenAt: null, attempts: null, processingMs: null, headers: {} };
  });
  pi.on("turn_end", reset);

  pi.on("after_provider_response", (event) => {
    if (!timing) return;
    // The hook has no authoritative attempt count. Replace, don't accumulate, response headers.
    Object.assign(timing, responseTiming(event.headers));
  });
  pi.on("message_update", (event) => {
    if (!timing || timing.firstTokenAt !== null || event.message.role !== "assistant") return;
    const delta = event.assistantMessageEvent;
    if ((delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") && delta.delta.length > 0) {
      timing.firstTokenAt = Date.now();
    }
  });
  pi.on("message_end", (event) => {
    if (!timing || event.message.role !== "assistant") return;
    const recorded = timing;
    reset();
    // pi applies message_end replacements to agent state and persists them before turn_end.
    return { message: { ...event.message, loopPiTiming: recorded } };
  });
}
