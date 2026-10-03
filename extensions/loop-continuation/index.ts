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
import { finalMarker, reportCounts, resolveReportPath, waitingDeadline } from "./report-status.ts";
import {
  type ArmedTimer,
  type ContinuationState,
  INITIAL_STATE,
  NUDGE_CUSTOM_TYPE,
  PUSH_CUSTOM_TYPES,
  STATE_CUSTOM_TYPE,
  type CloseOutDigest,
  evaluateSettle,
} from "./state.ts";
import { nudgeTextFor } from "./nudge-text.ts";
import { createTranscriptSync } from "./transcript-sync.ts";
import { OPS_GRANTS_REJECTED_CLASS, writeIncident } from "./incident.ts";
import { readDigest } from "./close-out.ts";
import { freezeOpsGrants } from "./ops-grants.ts";

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
  let launchCwd: string | null = null;

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

  function queryWatchers(): unknown[] | null {
    // Only an array is a reply; anything else reads as no reply, so close-out keeps its fallback.
    let watchers: unknown[] | null = null;
    pi.events.emit("loop-wait:query-watchers", {
      reply: (w: unknown) => {
        watchers = Array.isArray(w) ? w : null;
      },
    });
    return watchers;
  }

  function recordIncident(cwd: string, cls?: string, extra?: Record<string, unknown>) {
    try {
      writeIncident(getAgentDir(), sessionId, cwd, cls, extra, cls === OPS_GRANTS_REJECTED_CLASS ? "ops" : undefined);
    } catch {
      // Resolving the home must not trap the session either.
    }
  }

  // Answers other extensions: the launch's report path and its frozen ops grants. A reply with
  // nulls means this extension is loaded but no launch has been recognised (or it had no ops line).
  pi.events.on("loop-continuation:query-launch", (data) => {
    const req = data as {
      cwd?: string;
      reply: (r: { reportPath: string | null; opsPath: string | null; ops: unknown }) => void;
    };
    const reportPath =
      state.armed && state.launch ? resolveReportPath(state.launch.report, req.cwd ?? launchCwd ?? null) : null;
    req.reply({ reportPath, opsPath: state.opsPath ?? null, ops: state.ops ?? null });
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    launchCwd = ctx.cwd;
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
      const { opsLine, ...launch } = parsed;
      const frozen = freezeOpsGrants(opsLine);
      state = {
        armed: true,
        launch,
        nudgeCount: 0,
        chainIncidentWritten: false,
        opsPath: frozen.opsPath,
        ops: frozen.ops,
      };
      persist();
      if (frozen.rejected !== null) {
        recordIncident(ctx.cwd, OPS_GRANTS_REJECTED_CLASS, { reason: frozen.rejected, ops_path: frozen.opsPath });
      }
    }
  });

  pi.on(
    "agent_before_settle",
    async (event: AgentBeforeSettleEvent, ctx): Promise<AgentBeforeSettleEventResult> => {
      const wasPushed = pushDetected;
      pushDetected = false;

      const cwd = ctx.cwd;
      const reportCounted = state.armed && state.launch ? reportCounts(state.launch, cwd) : false;
      const lastText = reportCounted ? null : lastAssistantText(event.context.contextMessages as never[]);
      const marker = reportCounted ? null : finalMarker(lastText);
      const deadline = marker === "waiting" ? waitingDeadline(lastText) : null;

      // Read the digest only when a WAITING would be released or a plain stop nudged.
      let closeOut: { digest: CloseOutDigest | null; queryWatchers: () => unknown[] | null } | undefined;
      if (event.outcome === "completed" && state.armed && state.launch && !reportCounted && marker !== "paused") {
        const digest = await readDigest({
          agentDir: getAgentDir(),
          reportPath: resolveReportPath(state.launch.report, cwd),
        });
        closeOut = { digest, queryWatchers };
      }

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
        closeOut,
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
