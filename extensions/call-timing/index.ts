// Recorded timing seam: observe supported pi 1.0.4 hooks, never wrap the provider or alter retries.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type RequestProgress, DEFAULT_CHECKPOINT_INTERVAL_MS, checkpointIntervalMs, checkpointPath, endProgress,
  newProgress, observeAssistantEvent, observeProviderEvent, observeResponse, removeOrphanTemps, snapshot, writeCheckpoint,
} from "./progress.ts";

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

function readSettings(): unknown {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function sessionOf(ctx: ExtensionContext | undefined): string | null {
  try {
    return ctx?.sessionManager?.getSessionId() ?? null;
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let timing: CallTiming | undefined;
  const reset = () => { timing = undefined; };

  // Request progress (SEAMS.md "Request progress seam"). Checkpoints are written only when a
  // real session context names the session; a bare hook call keeps progress in memory only.
  let progress: RequestProgress | undefined;
  let checkpoint: string | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let session: string | null = null;
  let turns = 0;
  let intervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS;
  let cleanedFor: string | null = null;
  const persist = () => {
    if (progress && checkpoint) writeCheckpoint(checkpoint, snapshot(progress, Date.now()));
  };
  const closeProgress = (state: "ended" | "abandoned", stopReason: string | null) => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    if (!progress) return undefined;
    const now = Date.now();
    endProgress(progress, state, stopReason, now);
    const final = snapshot(progress, now);
    if (checkpoint) writeCheckpoint(checkpoint, final);
    progress = undefined;
    checkpoint = null;
    return final;
  };

  pi.on("session_start", (_event, ctx) => {
    reset();
    closeProgress("abandoned", null);
    session = sessionOf(ctx);
    turns = 0;
    intervalMs = ctx ? checkpointIntervalMs(readSettings()) : DEFAULT_CHECKPOINT_INTERVAL_MS;
  });
  pi.on("session_shutdown", () => {
    reset();
    closeProgress("abandoned", null);
  });
  pi.on("turn_start", (_event, ctx) => {
    timing = { firstTokenAt: null, attempts: null, processingMs: null, headers: {} };
    closeProgress("abandoned", null);
    session = sessionOf(ctx) ?? session;
    const model = ctx?.model;
    progress = newProgress({
      session, request: randomUUID(), turn: ++turns,
      provider: model?.provider ?? null, model: model?.id ?? null, api: model?.api ?? null,
    }, Date.now());
    checkpoint = ctx ? checkpointPath(getAgentDir(), session) : null;
    if (checkpoint) {
      if (cleanedFor !== checkpoint) removeOrphanTemps(checkpoint);
      cleanedFor = checkpoint;
      persist();
      ticker = setInterval(persist, intervalMs);
      ticker.unref();
    }
  });
  pi.on("turn_end", () => {
    reset();
    closeProgress("abandoned", null);
  });

  pi.on("after_provider_response", (event) => {
    if (progress) observeResponse(progress, headerValue(event.headers, "x-request-id"), Date.now());
    if (!timing) return;
    // The hook has no authoritative attempt count. Replace, don't accumulate, response headers.
    Object.assign(timing, responseTiming(event.headers));
  });
  pi.on("provider_stream_event", (event) => {
    if (progress) observeProviderEvent(progress, event.data, Date.now());
  });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const delta = event.assistantMessageEvent;
    if (progress) {
      const first = progress.modelEvents === 0;
      if (observeAssistantEvent(progress, delta, Date.now()) && first) persist();
    }
    if (!timing || timing.firstTokenAt !== null) return;
    if ((delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") && delta.delta.length > 0) {
      timing.firstTokenAt = Date.now();
    }
  });
  pi.on("message_end", (event) => {
    if (!timing || event.message.role !== "assistant") return;
    const recorded = timing;
    reset();
    const progressed = closeProgress("ended", event.message.stopReason ?? null);
    // pi applies message_end replacements to agent state and persists them before turn_end.
    return { message: { ...event.message, loopPiTiming: recorded, ...(progressed ? { loopPiProgress: progressed } : {}) } };
  });
}
