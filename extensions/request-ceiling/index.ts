// Per-request ceiling (SEAMS.md "Request ceiling"). Installed by both loop-guard entries, so the
// root and every lane get it. pi's own bounds do not cover a request that keeps streaming
// reasoning: `httpIdleTimeoutMs` is an idle timer that every streamed event resets, and the
// provider `timeoutMs` stops at the response headers. This adds a wall-clock bound per model
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

function loadConfig(): CeilingConfig {
  try {
    return ceilingConfig(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")));
  } catch {
    return ceilingConfig({});
  }
}

export function installRequestCeiling(pi: ExtensionAPI, config: CeilingConfig = loadConfig()): void {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
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
    consecutive = 0;
    sessionId = ctx.sessionManager.getSessionId();
  });

  pi.on("turn_start", (_event, ctx: ExtensionContext) => {
    stopTimer();
    const mine = ++generation;
    startedAt = Date.now();
    timer = setTimeout(() => {
      if (mine !== generation || timer === undefined) return;
      timer = undefined;
      pending = {
        kind: "wall-clock",
        model: ctx.model?.id ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        wallClockMs: config.wallClockMs,
      };
      ctx.abort();
    }, config.wallClockMs);
    timer.unref?.();
  });

  pi.on("message_end", (event, ctx: ExtensionContext) => {
    const message = event.message as { role?: string; stopReason?: string; model?: string; content?: unknown };
    if (message.role !== "assistant") return;
    stopTimer();
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
    stopTimer();
    const incident = pending;
    pending = undefined;
    if (!incident) return;
    consecutive++;
    const continuing = consecutive <= config.maxFollowUps;
    const attempt = continuing ? consecutive : config.maxFollowUps;
    writeRequestIncident(getAgentDir(), sessionId, ctx.cwd, incident, consecutive, !continuing);
    pi.sendMessage(
      {
        customType: INCIDENT_CUSTOM_TYPE,
        content: incidentText(incident, attempt, config.maxFollowUps, continuing),
        display: true,
        details: { kind: incident.kind, attempt: consecutive, exhausted: !continuing, elapsedMs: incident.elapsedMs },
      },
      { triggerTurn: continuing },
    );
  });

  pi.on("session_shutdown", () => {
    stopTimer();
  });
}

// Standalone entry for tests; installed homes reach it through the loop-guard entries.
export default function (pi: ExtensionAPI) {
  installRequestCeiling(pi);
}
