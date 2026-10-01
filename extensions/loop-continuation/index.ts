// loop-continuation (root only). Re-prompts a loop-pi root that stops with work owed, per
// the continuation contract. See extensions/SEAMS.md for the frozen cross-extension
// contract (pi.events channels, custom-entry names, incident path, sync trigger).
//
// Owned paths: pi/extensions/loop-continuation/** only (per SEAMS.md's ownership table).

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  CustomEntry,
  CustomMessageEntryDraft,
  ExtensionAPI,
  MessageStartEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseLaunch } from "./launch-detect.ts";
import { finalMarker, reportCounts, waitingDeadline } from "./report-status.ts";
import {
  type ArmedTimer,
  type ContinuationState,
  INITIAL_STATE,
  NUDGE_CUSTOM_TYPE,
  PUSH_CUSTOM_TYPES,
  STATE_CUSTOM_TYPE,
  evaluateSettle,
} from "./state.ts";
import { nudgeTextFor } from "./nudge-text.ts";
import { createTranscriptSync } from "./transcript-sync.ts";
import { writeIncident } from "./incident.ts";

/** How often an open session re-checks the checkpoint throttle (lanes run without extensions). */
const SYNC_TICK_MS = 60 * 1000;

/** The text content of an assistant message's content blocks, or null when there is none. */
function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block: unknown): block is { type: string; text: string } => {
          return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
        })
        .map((block) => block.text)
        .join("\n");
    }
    return null;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let state: ContinuationState = INITIAL_STATE;
  let pushDetected = false;
  let sessionId = "";
  let transcriptSync: ReturnType<typeof createTranscriptSync> | null = null;
  let syncTicker: ReturnType<typeof setInterval> | null = null;

  function triggerSync(lifecycle: boolean) {
    try {
      transcriptSync ??= createTranscriptSync({ agentDir: getAgentDir() });
      transcriptSync.trigger(lifecycle);
    } catch {
      // Sync trigger failures are ignored (SEAMS.md).
    }
  }

  function persist() {
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  function queryTimers(): ArmedTimer[] | null {
    let replied = false;
    let timers: ArmedTimer[] = [];
    pi.events.emit("loop-wait:query-timers", {
      reply: (t: ArmedTimer[]) => {
        replied = true;
        timers = t;
      },
    });
    return replied ? timers : null;
  }

  function armTimer(at: string, reason: string): { id: string; at: string } | null {
    let result: { id: string; at: string } | null = null;
    pi.events.emit("loop-wait:arm-timer", {
      at,
      reason,
      reply: (r: { id: string; at: string }) => {
        result = r;
      },
    });
    return result;
  }

  function recordIncident(cwd: string) {
    try {
      writeIncident(getAgentDir(), sessionId, cwd);
    } catch {
      // Resolving the home must not trap the session either.
    }
  }

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    if (!syncTicker) {
      syncTicker = setInterval(() => triggerSync(false), SYNC_TICK_MS);
      syncTicker.unref();
    }
    state = INITIAL_STATE;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
        state = (entry as CustomEntry<ContinuationState>).data ?? INITIAL_STATE;
      }
    }
  });

  pi.on("message_start", (event: MessageStartEvent) => {
    const message = event.message as { role: string; customType?: string };
    if (message.role === "custom" && message.customType && PUSH_CUSTOM_TYPES.has(message.customType)) {
      pushDetected = true;
    }
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    const parsed = parseLaunch(event.prompt, ctx.cwd, new Date().toISOString());
    if (parsed) {
      state = { armed: true, launch: parsed, nudgeCount: 0, chainIncidentWritten: false };
      persist();
    }
  });

  pi.on(
    "agent_before_settle",
    (event: AgentBeforeSettleEvent, ctx): AgentBeforeSettleEventResult => {
      const wasPushed = pushDetected;
      pushDetected = false;

      const cwd = ctx.cwd;
      const reportCounted = state.armed && state.launch ? reportCounts(state.launch, cwd) : false;
      const lastText = reportCounted ? null : lastAssistantText(event.context.contextMessages as never[]);
      const marker = reportCounted ? null : finalMarker(lastText);
      const deadline = marker === "waiting" ? waitingDeadline(lastText) : null;

      const decision = evaluateSettle({
        outcome: event.outcome,
        state,
        pushDetected: wasPushed,
        reportCounted,
        marker,
        waitingDeadline: deadline,
        now: new Date().toISOString(),
        queryTimers,
        armTimer,
      });

      switch (decision.action) {
        case "skip":
          return {};
        case "release":
          state = decision.newState;
          persist();
          return {};
        case "release-exhausted":
          state = decision.newState;
          persist();
          if (decision.writeIncident) recordIncident(cwd);
          return {};
        case "nudge": {
          state = decision.newState;
          persist();
          const draft: CustomMessageEntryDraft = {
            type: "custom_message",
            customType: NUDGE_CUSTOM_TYPE,
            content: nudgeTextFor(decision.reason),
            display: true,
            details: { nudge: state.nudgeCount, reason: decision.reason },
          };
          return { entries: [...event.entries, draft], continue: true };
        }
      }
    },
  );

  pi.on("input", () => {
    triggerSync(false);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", () => {
    triggerSync(false);
  });

  pi.on("agent_settled", () => {
    triggerSync(true);
  });

  pi.on("session_shutdown", () => {
    if (syncTicker) clearInterval(syncTicker);
    syncTicker = null;
    triggerSync(true);
  });
}
