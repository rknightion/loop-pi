// loop-continuation (root only). Re-prompts a loop-pi root that stops with work owed, per
// the continuation contract. See extensions/SEAMS.md for the frozen cross-extension
// contract (pi.events channels, custom-entry names, incident path, sync trigger).
//
// It also arms the root (in the `input` hook, the only one that can refuse before a model turn):
// arm-time checks (arm.ts), the protocol marker `$LOOP_PI_RUN_DIR/loop-pi-proto`, the ops and audit
// grants freeze, and the `open` event. It writes the harness facts the root cannot forge
// (harness-facts.ts), the root context-overflow incident with `loopPi.onIncident`, and at
// `/loop-closeout` runs the closeout audit itself (closeout-audit.ts).

import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CustomEntry,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { type ParsedLaunch, parseLaunch } from "./launch-detect.ts";
import {
  ARM_REFUSED_CLASS,
  checkArm,
  defaultArmEnv,
  existingOpen,
  namesGoalPath,
  NOT_ARMED_WARNING,
  openEvent,
  PROTO_FILE,
  PROTO_VERSION,
  retainSnapshotProtocol,
  snapshotProtocolRetained,
} from "./arm.ts";
import { AUDIT_GRANTS_REJECTED_CLASS, freezeAuditGrants } from "./audit-grants.ts";
import { appendFact, isQuotaError } from "./harness-facts.ts";
import { auditBinary, CLOSEOUT_MESSAGE_TYPE, closeoutArgs, closeoutMessage, runCloseoutAudit } from "./closeout-audit.ts";
import { finalMarker, reportCounts, resolveReportPath, waitingDeadline } from "./report-status.ts";
import {
  type ArmedTimer,
  type ContinuationState,
  INITIAL_STATE,
  isParentWake,
  NUDGE_CUSTOM_TYPE,
  PUSH_CUSTOM_TYPES,
  STATE_CUSTOM_TYPE,
  type CloseOutDigest,
  evaluateSettle,
} from "./state.ts";
import { nudgeTextFor } from "./nudge-text.ts";
import { createTranscriptSync } from "./transcript-sync.ts";
import { CONTEXT_OVERFLOW_CLASS, OPS_GRANTS_REJECTED_CLASS, runOnIncident, writeIncident, writeRootIncident } from "./incident.ts";
import { loopStateBinary, readDigest } from "./close-out.ts";
import { freezeOpsGrants } from "./ops-grants.ts";
import { freezeStanding, STANDING_REJECTED_CLASS } from "./standing.ts";
import { lastAssistantText } from "./stop-controls.ts";

/** How often an open session re-checks the checkpoint throttle (lanes run without extensions). */
const SYNC_TICK_MS = 60 * 1000;

/** The cross-extension closeout event `/loop-closeout` emits: `{ lines: string[]; pending: Promise<unknown>[] }`. */
export const LOOP_CLOSEOUT_EVENT = "loop-closeout";
const OPEN_TIMEOUT_MS = 30_000;

function appendOpen(agentDir: string, log: string, event: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    try {
      const child = execFile(loopStateBinary(agentDir), ["append", log, "--by", "ext"], { cwd, timeout: OPEN_TIMEOUT_MS }, (error, stdout, stderr) => {
        done({ ok: !error, detail: String(stderr || stdout || error?.message || "").trim() });
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(event));
    } catch (error) {
      done({ ok: false, detail: String(error) });
    }
  });
}

export default function (pi: ExtensionAPI) {
  let state: ContinuationState = INITIAL_STATE;
  let pushDetected = false;
  let sessionId = "";
  let transcriptSync: ReturnType<typeof createTranscriptSync> | null = null;
  let syncTicker: ReturnType<typeof setInterval> | null = null;
  let launchCwd: string | null = null;
  // pi-subagents tags async events with the session file when there is one, else the session id.
  let sessionKey = "";
  const liveRuns = new Set<string>();
  // One context-overflow fact and at most one incident per overflow episode (until a clean reply).
  let overflowFactWritten = false;
  let overflowIncidentWritten = false;
  // The last assistant error when it was a usage or quota limit; a fact if the run settles on it.
  let quotaError: string | null = null;
  let closeoutRunning = false;
  // The relaunch warning is for a session's first input only (S3).
  let sawInput = false;

  const runDir = (): string | undefined => process.env.LOOP_PI_RUN_DIR || undefined;
  let protocolSeen = false;
  const protocolRequired = (): boolean => {
    const dir = runDir();
    return state.armed || (protocolSeen ||= dir !== undefined &&
      (existsSync(join(dir, PROTO_FILE)) || snapshotProtocolRetained(dir)));
  };

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
      const subdir =
        cls === OPS_GRANTS_REJECTED_CLASS || cls === AUDIT_GRANTS_REJECTED_CLASS || cls === STANDING_REJECTED_CLASS ? "ops" : undefined;
      writeIncident(getAgentDir(), sessionId, cwd, cls, extra, subdir);
    } catch {
      // Resolving the home must not trap the session either.
    }
  }

  function notify(ctx: ExtensionContext | null | undefined, message: string, type: "info" | "warning" | "error") {
    try {
      ctx?.ui.notify(message, type);
    } catch {
      // A notification must never trap the session.
    }
  }

  /** S3: refuse the arm with an incident, the reason shown, and `loopPi.onIncident`. */
  function refuseArm(ctx: ExtensionContext, reason: string) {
    const at = new Date().toISOString();
    let agentDir: string | null = null;
    try {
      agentDir = getAgentDir();
    } catch {
      agentDir = null;
    }
    const payload = { v: 1, session: sessionId || "unknown", class: ARM_REFUSED_CLASS, at, cwd: ctx.cwd, reason };
    const file = agentDir ? writeRootIncident(agentDir, sessionId, at, "arm-refused", payload) : null;
    notify(ctx, `loop-continuation did not arm this root: ${reason}`, "error");
    if (agentDir && file) runOnIncident(agentDir, file);
  }

  /** S3 success: ops grants, audit grants and standing freeze, then `open` when the log has none (S4). */
  async function arm(parsed: ParsedLaunch, check: { runDir: string; goalText: string; goalSha256: string; log: string }, ctx: ExtensionContext) {
    const { opsLine, auditLine, standingLine, goal: _goal, ...launch } = parsed;
    const frozen = freezeOpsGrants(opsLine);
    const audit = freezeAuditGrants(auditLine, check.runDir);
    const standing = freezeStanding(standingLine, check.runDir);
    state = {
      armed: true,
      launch,
      nudgeCount: 0,
      chainIncidentWritten: false,
      opsPath: frozen.opsPath,
      ops: frozen.ops,
      auditGrantsPath: audit.path,
      auditGrantsSha256: audit.sha256,
      standingPath: standing.path,
      standingSha256: standing.sha256,
    };
    persist();
    if (frozen.rejected !== null) {
      recordIncident(ctx.cwd, OPS_GRANTS_REJECTED_CLASS, { reason: frozen.rejected, ops_path: frozen.opsPath });
    }
    if (audit.rejected !== null) {
      recordIncident(ctx.cwd, AUDIT_GRANTS_REJECTED_CLASS, { reason: audit.rejected, audit_grants_path: audit.sourcePath });
    }
    if (standing.rejected !== null) {
      recordIncident(ctx.cwd, STANDING_REJECTED_CLASS, { reason: standing.rejected, standing_path: standing.sourcePath });
    }
    if (existingOpen(check.log)) return;
    const built = openEvent(check.goalText, check.goalSha256);
    if ("error" in built) {
      notify(ctx, `loop-continuation: open was not appended to ${check.log}: ${built.error}`, "warning");
      return;
    }
    const result = await appendOpen(getAgentDir(), check.log, built.event, ctx.cwd);
    if (!result.ok) notify(ctx, `loop-continuation: open was not appended to ${check.log}: ${result.detail}`, "warning");
  }

  /** S7: a context overflow is a fact; with an async lane live it is also a root incident. */
  function contextOverflow(cwd: string, detail: string) {
    if (!overflowFactWritten) {
      overflowFactWritten = true;
      appendFact(runDir(), "context-overflow", sessionId, detail);
    }
    if (overflowIncidentWritten || liveRuns.size === 0) return;
    overflowIncidentWritten = true;
    try {
      const agentDir = getAgentDir();
      const at = new Date().toISOString();
      const file = writeRootIncident(agentDir, sessionId, at, "context-overflow", {
        v: 1,
        session: sessionId || "unknown",
        class: CONTEXT_OVERFLOW_CLASS,
        at,
        home: agentDir,
        cwd,
        live_runs: [...liveRuns],
        detail: Array.from(detail).slice(0, 512).join(""),
      });
      if (file) runOnIncident(agentDir, file);
    } catch {
      // Incident bookkeeping must never trap the session.
    }
  }

  async function runCloseout(lines: string[], pending: unknown[]) {
    const dir = runDir();
    if (!dir || closeoutRunning) return;
    closeoutRunning = true;
    try {
      const args = closeoutArgs(dir, { path: state.auditGrantsPath ?? null, sha256: state.auditGrantsSha256 ?? null });
      const bin = auditBinary(getAgentDir());
      const result = await runCloseoutAudit(bin, args, launchCwd ?? process.cwd());
      await Promise.allSettled(pending);
      pi.sendMessage(
        {
          customType: CLOSEOUT_MESSAGE_TYPE,
          content: closeoutMessage(["loop-pi-audit", ...args], result, lines),
          display: true,
          details: { code: result.code },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // The closeout report is best effort; the root can still run the audit itself.
    } finally {
      closeoutRunning = false;
    }
  }

  // Answers other extensions: the launch's report path and its frozen ops grants. A reply with
  // nulls means this extension is loaded but no launch has been recognised (or it had no ops line).
  pi.events.on("loop-continuation:query-launch", (data) => {
    const req = data as {
      cwd?: string;
      reply: (r: {
        reportPath: string | null;
        opsPath: string | null;
        ops: unknown;
        auditGrantsPath: string | null;
        auditGrantsSha256: string | null;
        standingPath: string | null;
        standingSha256: string | null;
      }) => void;
    };
    const reportPath =
      state.armed && state.launch ? resolveReportPath(state.launch.report, req.cwd ?? launchCwd ?? null) : null;
    req.reply({
      reportPath,
      opsPath: state.opsPath ?? null,
      ops: state.ops ?? null,
      auditGrantsPath: state.auditGrantsPath ?? null,
      auditGrantsSha256: state.auditGrantsSha256 ?? null,
      standingPath: state.standingPath ?? null,
      standingSha256: state.standingSha256 ?? null,
    });
  });

  pi.events.on("subagent:async-started", (data) => {
    const d = data as { id?: unknown; sessionId?: unknown } | null;
    if (typeof d?.id === "string" && d.sessionId === sessionKey) liveRuns.add(d.id);
  });

  pi.events.on("subagent:async-complete", (data) => {
    const d = data as { runId?: unknown; id?: unknown } | null;
    const id = typeof d?.runId === "string" ? d.runId : typeof d?.id === "string" ? d.id : undefined;
    if (id) liveRuns.delete(id);
  });

  pi.events.on(LOOP_CLOSEOUT_EVENT, (data) => {
    if (!protocolRequired()) return;
    const d = data as { lines?: unknown; pending?: unknown } | null;
    const lines = Array.isArray(d?.lines) ? (d.lines as string[]) : [];
    const pending = Array.isArray(d?.pending) ? (d.pending as unknown[]) : [];
    void runCloseout(lines, pending);
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    launchCwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
    sessionKey = ctx.sessionManager.getSessionFile?.() ?? sessionId;
    liveRuns.clear();
    sawInput = false;
    if (!syncTicker) {
      syncTicker = setInterval(() => triggerSync(false), SYNC_TICK_MS);
      syncTicker.unref();
    }
    state = INITIAL_STATE;
    protocolSeen = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
        state = (entry as CustomEntry<ContinuationState>).data ?? INITIAL_STATE;
      }
    }
    protocolRequired();
  });

  pi.on("message_start", (event: MessageStartEvent) => {
    const message = event.message as { role: string; customType?: string };
    if (message.role === "custom" && message.customType && PUSH_CUSTOM_TYPES.has(message.customType)) {
      pushDetected = true;
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: unknown; errorMessage?: unknown };
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") {
      overflowFactWritten = false;
      overflowIncidentWritten = false;
      quotaError = null;
      return;
    }
    try {
      if (isContextOverflow(event.message as never)) contextOverflow(ctx.cwd, `context_length_exceeded: ${String(message.errorMessage ?? "")}`);
    } catch {
      // Classification must never trap the session.
    }
    quotaError = isQuotaError(message) ? String(message.errorMessage) : null;
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (event.aborted) return;
    const detail = `${event.reason}: ${event.errorMessage ?? "compaction failed"}`;
    appendFact(runDir(), "compaction-failed", sessionId, detail);
    if (event.reason === "overflow") contextOverflow(ctx.cwd, `overflow recovery failed: ${event.errorMessage ?? ""}`);
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

  // Arming happens here, not in before_agent_start: only `input` can stop the model turn (S3).
  pi.on("input", async (event, ctx) => {
    triggerSync(false);
    // The notice before an idle-parent wake reached no message_start, so the wake is the push.
    if (isParentWake(event)) {
      pushDetected = true;
      return { action: "continue" as const };
    }
    const first = !sawInput;
    sawInput = true;
    const parsed = parseLaunch(event.text, ctx.cwd, new Date().toISOString());
    if (!parsed) {
      if (first && !state.armed && namesGoalPath(event.text)) notify(ctx, NOT_ARMED_WARNING, "warning");
      return { action: "continue" as const };
    }
    const check = checkArm(parsed, defaultArmEnv(ctx.cwd));
    if (!check.ok) {
      refuseArm(ctx, check.reason);
      return { action: "handled" as const };
    }
    try {
      writeFileSync(join(check.runDir, PROTO_FILE), `${PROTO_VERSION}\n`);
      protocolSeen = true;
      const retentionError = await retainSnapshotProtocol(auditBinary(getAgentDir()), check.runDir, ctx.cwd);
      if (retentionError) throw new Error(retentionError);
    } catch (error) {
      refuseArm(ctx, `the protocol evidence could not be retained in ${check.runDir}: ${String(error)}`);
      return { action: "handled" as const };
    }
    await arm(parsed, check, ctx);
    return { action: "continue" as const };
  });

  pi.on("tool_execution_end", () => {
    triggerSync(false);
  });

  pi.on("agent_settled", () => {
    if (quotaError !== null) {
      appendFact(runDir(), "quota-exhausted", sessionId, quotaError);
      quotaError = null;
    }
    triggerSync(true);
  });

  pi.on("session_shutdown", () => {
    if (syncTicker) clearInterval(syncTicker);
    syncTicker = null;
    triggerSync(true);
  });
}
