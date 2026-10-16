// loop-continuation (root only). Re-prompts a loop-pi root that stops with work owed, per
// the continuation contract. See extensions/SEAMS.md for the frozen cross-extension
// contract (pi.events channels, custom-entry names, incident path, sync trigger).
//
// It also arms the root (in the `input` hook, the only one that can refuse before a model turn):
// arm-time checks against the charter (arm.ts), the run marker `$LOOP_PI_RUN_DIR/loop-pi-proto`,
// the standing freeze, and the `open` event the root never writes. It writes the harness facts the root cannot forge
// (harness-facts.ts), the root context-overflow incident with `loopPi.onIncident`, and at
// `/loop-closeout` runs the closeout audit itself (closeout-audit.ts).

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  namesCharterPath,
  NOT_ARMED_WARNING,
  openEvent,
  PROTO_FILE,
  PROTO_VERSION,
  retainSnapshotProtocol,
  runConcurrency,
  snapshotProtocolRetained,
} from "./arm.ts";
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
import { CONTEXT_OVERFLOW_CLASS, runOnIncident, writeIncident, writeRootIncident } from "./incident.ts";
import { loopStateBinary, readDigest, stateLogPath } from "./close-out.ts";
import { freezeStanding, STANDING_REJECTED_CLASS } from "./standing.ts";
import { lastAssistantText } from "./stop-controls.ts";
import {
  classifyRootStop,
  judgementText,
  lastAssistantMessage,
  RECOVERY_STOPPED_CLASS,
  RESUME_CUSTOM_TYPE,
  RESUME_EVENT,
  resumeDelayMs,
  resumeText,
  rootRecoveryConfig,
  type SettleEvidence,
} from "./root-recovery.ts";

/** How often an open session re-checks the checkpoint throttle (lanes run without extensions). */
const SYNC_TICK_MS = 60 * 1000;

/** The cross-extension closeout event `/loop-closeout` emits: `{ lines: string[]; pending: Promise<unknown>[] }`. */
export const LOOP_CLOSEOUT_EVENT = "loop-closeout";
const OPEN_TIMEOUT_MS = 30_000;

/** Append one event to the state log through the loop-state CLI, by ext. */
function appendEvent(agentDir: string, log: string, event: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; detail: string }> {
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
  // Automatic root recovery (root-recovery.ts). `harnessAbort` attributes this run's abort to the
  // request ceiling or the recovery controller (their synchronous pre-abort events), never the operator.
  let harnessAbort: SettleEvidence["harnessAbort"] = null;
  let ceilingLimit: SettleEvidence["ceilingLimit"] = null;
  /** Resumes sent since the root last completed a healthy model request. */
  let resumeAttempt = 0;
  /** When the pending resume is due (epoch ms); kept across runs that start before it fires. */
  let resumeDueAt: number | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeCause: { cause: string; detail: string } | null = null;
  /** Bumped by every cancel, so a resume whose judgement append raced a cancel is not sent. */
  let resumeEpoch = 0;
  /** The failed message a stop incident was written for, so one failure writes one incident. */
  let stoppedFor: string | null = null;

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
      const subdir = cls === STANDING_REJECTED_CLASS ? "standing" : undefined;
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

  /** Arm success: standing freeze, then `open` when the log has none. */
  async function arm(parsed: ParsedLaunch, check: { runDir: string; charterText: string; charterSha256: string; log: string }, ctx: ExtensionContext) {
    const { standingLine, charter, ...launch } = parsed;
    const standing = freezeStanding(standingLine, check.runDir);
    state = {
      armed: true,
      launch,
      nudgeCount: 0,
      chainIncidentWritten: false,
      standingPath: standing.path,
      standingSha256: standing.sha256,
      concurrency: runConcurrency(check.charterText),
      rootContext: {
        goalPath: charter, goalSha256: check.charterSha256, goalText: check.charterText,
        cwd: ctx.cwd, runDir: check.runDir, sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      },
    };
    persist();
    if (standing.rejected !== null) {
      recordIncident(ctx.cwd, STANDING_REJECTED_CLASS, { reason: standing.rejected, standing_path: standing.sourcePath });
    }
    if (existingOpen(check.log)) return;
    const result = await appendEvent(getAgentDir(), check.log, openEvent(check.charterText, check.charterSha256), ctx.cwd);
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

  function clearResumeTimer() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  /** Forget a pending resume entirely: healthy progress, the owner's own input, or a hard stop. */
  function cancelResume() {
    resumeEpoch++;
    clearResumeTimer();
    resumeDueAt = null;
    resumeCause = null;
  }

  function recoverySettings(): unknown {
    try {
      return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
    } catch {
      return {};
    }
  }

  /** The state log of the armed launch, or null. */
  function armedLog(cwd: string): string | null {
    if (!state.armed || !state.launch) return null;
    return stateLogPath(resolveReportPath(state.launch.report, cwd));
  }

  async function recordJudgement(ctx: ExtensionContext, text: string) {
    const log = armedLog(ctx.cwd);
    if (!log) return;
    try {
      const result = await appendEvent(getAgentDir(), log, { ev: "judgement", text }, ctx.cwd);
      if (!result.ok) notify(ctx, `loop-continuation: could not record "${text}" in ${log}: ${result.detail}`, "warning");
    } catch {
      // Recording must never trap the session.
    }
  }

  /** A stop-class failure: one root incident and one judgement per failed message, then wait for the owner. */
  function recordRecoveryStop(ctx: ExtensionContext, failed: { timestamp?: unknown; errorMessage?: unknown } | null, cause: string, detail: string) {
    cancelResume();
    const key = JSON.stringify([failed?.timestamp ?? null, failed?.errorMessage ?? null, cause]);
    if (stoppedFor === key) return;
    stoppedFor = key;
    const at = new Date().toISOString();
    try {
      const agentDir = getAgentDir();
      const file = writeRootIncident(agentDir, sessionId, at, "recovery-stopped", {
        v: 1, session: sessionId || "unknown", class: RECOVERY_STOPPED_CLASS, at, home: agentDir, cwd: ctx.cwd, cause, detail,
      });
      if (file) runOnIncident(agentDir, file);
    } catch {
      // Incident bookkeeping must never trap the session.
    }
    notify(ctx, `loop-continuation: not resuming automatically after ${cause} (${detail}); the owner must act`, "error");
    void recordJudgement(ctx, judgementText("stop", resumeAttempt, cause, detail));
  }

  /** Arm (or re-arm, keeping its due time) the resume timer for the next attempt. */
  function scheduleResume(ctx: ExtensionContext, cause: string, detail: string) {
    const config = rootRecoveryConfig(recoverySettings());
    if (!config.enabled) return;
    const delay = resumeDelayMs(resumeAttempt + 1, config);
    resumeDueAt ??= Date.now() + delay;
    resumeCause = { cause, detail };
    clearResumeTimer();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void fireResume(ctx, delay);
    }, Math.max(0, resumeDueAt - Date.now()));
    resumeTimer.unref?.();
  }

  /** The backoff elapsed: resume only an armed, idle root that is still stopped on a failed request. */
  async function fireResume(ctx: ExtensionContext, delay: number) {
    const cause = resumeCause;
    resumeDueAt = null;
    resumeCause = null;
    const stillStopped = (): boolean => {
      try {
        if (!state.armed || !state.launch || !ctx.isIdle()) return false; // A running turn decides again when it settles.
        if (reportCounts(state.launch, ctx.cwd)) return false;
        const last = lastAssistantMessage(ctx.sessionManager.getBranch());
        return !!last && (last.stopReason === "error" || last.stopReason === "aborted");
      } catch {
        return false;
      }
    };
    if (!cause || !stillStopped()) return;
    const epoch = resumeEpoch;
    const attempt = resumeAttempt + 1;
    // Recorded before it is sent, so every resume the root receives is in the state log.
    await recordJudgement(ctx, judgementText("resume", attempt, cause.cause, cause.detail, delay));
    if (epoch !== resumeEpoch || !stillStopped()) return; // The owner or a run took over meanwhile.
    resumeAttempt = attempt;
    // Reset the recovery episode as an owner's idle input would; only this event does so.
    pi.events.emit(RESUME_EVENT, {});
    pi.sendMessage(
      {
        customType: RESUME_CUSTOM_TYPE,
        content: resumeText(attempt, cause.cause as never, cause.detail, delay),
        display: true,
        details: { attempt, cause: cause.cause, detail: cause.detail, delayMs: delay },
      },
      { triggerTurn: true },
    );
  }

  /** After a run settles: resume, stop, or leave alone (see root-recovery.ts). */
  function decideRecovery(ctx: ExtensionContext) {
    const evidence: SettleEvidence = { harnessAbort, ceilingLimit, contextWindow: ctx.model?.contextWindow };
    harnessAbort = null;
    ceilingLimit = null;
    if (!state.armed || !state.launch) return;
    let last: ReturnType<typeof lastAssistantMessage>;
    try {
      if (reportCounts(state.launch, ctx.cwd)) return cancelResume();
      last = lastAssistantMessage(ctx.sessionManager.getBranch());
    } catch {
      return;
    }
    const decision = classifyRootStop(last, evidence);
    if (decision.action === "none") {
      if (decision.why === "operator-cancelled") cancelResume();
      return;
    }
    if (decision.action === "stop") return recordRecoveryStop(ctx, last, decision.cause, decision.detail);
    scheduleResume(ctx, decision.cause, decision.detail);
  }

  async function runCloseout(lines: string[], pending: unknown[]) {
    const dir = runDir();
    if (!dir || closeoutRunning) return;
    closeoutRunning = true;
    try {
      const frozen = state.rootContext;
      const args = closeoutArgs(dir, frozen ? { path: frozen.goalPath, sha256: frozen.goalSha256 } : null);
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

  // Answers other extensions: the launch's closeout path (key `reportPath`, S1), its frozen standing
  // and the charter's `lanes:` cap. A reply with nulls means no launch has been recognised.
  pi.events.on("loop-continuation:query-launch", (data) => {
    const req = data as {
      cwd?: string;
      reply: (r: {
        reportPath: string | null;
        standingPath: string | null;
        standingSha256: string | null;
        concurrency?: number;
      }) => void;
    };
    const reportPath =
      state.armed && state.launch ? resolveReportPath(state.launch.report, req.cwd ?? launchCwd ?? null) : null;
    req.reply({
      reportPath,
      ...(state.armed && state.rootContext ? { rootContext: { ...state.rootContext } } : {}),
      standingPath: state.standingPath ?? null,
      standingSha256: state.standingSha256 ?? null,
      // Additive and optional: absent without a launch, or when the charter has no valid concurrency.
      ...(state.armed && typeof state.concurrency === "number" && state.concurrency >= 1 ? { concurrency: state.concurrency } : {}),
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

  pi.events.on("loop-recovery:request-timeout", (data) => {
    harnessAbort = "request-timeout";
    const limit = (data as { limitType?: unknown } | null)?.limitType;
    ceilingLimit = limit === "inactivity" || limit === "absolute" ? limit : null;
  });
  pi.events.on("loop-recovery:abort", () => {
    harnessAbort ??= "recovery-abort";
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
    cancelResume();
    resumeAttempt = 0;
    harnessAbort = null;
    ceilingLimit = null;
    stoppedFor = null;
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
    if (message.stopReason === "stop" || message.stopReason === "toolUse") {
      // Healthy progress: the next outage starts its backoff from the base delay again.
      resumeAttempt = 0;
      cancelResume();
    }
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
      // An earlier handler already continues this run. pi-subagents 0.77.0 does this for a silent
      // completion turn with its `subagent-completion-unanswered` reminder (a known package
      // customType, not a push); a nudge on top would give one silent turn two prompts. Decide at the
      // settle that follows, with the push flag intact. Its terminal `subagent-completion-unhandled`
      // notice does not continue the run, so the nudge chain still keeps an unmarked root going.
      if (event.continue) return {};
      const wasPushed = pushDetected;
      pushDetected = false;

      const cwd = ctx.cwd;
      const reportCounted = state.armed && state.launch ? reportCounts(state.launch, cwd) : false;
      const lastText = reportCounted ? null : lastAssistantText(event.context.contextMessages as never[]);
      const marker = reportCounted ? null : finalMarker(lastText);
      const deadline = marker === "waiting" ? waitingDeadline(lastText) : null;

      // Read the digest only when a WAITING would be released or a plain stop nudged.
      let closeOut: { digest: CloseOutDigest | null; queryWatchers: () => unknown[] | null; liveRuns: number } | undefined;
      if (event.outcome === "completed" && state.armed && state.launch && !reportCounted && marker !== "paused") {
        const digest = await readDigest({
          agentDir: getAgentDir(),
          reportPath: resolveReportPath(state.launch.report, cwd),
        });
        closeOut = { digest, queryWatchers, liveRuns: liveRuns.size };
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
    // The owner's own input takes over from any pending automatic resume.
    if (event.source !== "extension") cancelResume();
    // The notice before an idle-parent wake reached no message_start, so the wake is the push.
    if (isParentWake(event)) {
      pushDetected = true;
      return { action: "continue" as const };
    }
    const first = !sawInput;
    sawInput = true;
    const parsed = parseLaunch(event.text, ctx.cwd, new Date().toISOString());
    if (!parsed) {
      if (first && !state.armed && namesCharterPath(event.text)) notify(ctx, NOT_ARMED_WARNING, "warning");
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

  pi.on("agent_start", () => {
    // A run is starting: hold the resume timer, keeping its due time, until this run settles.
    clearResumeTimer();
  });

  pi.on("agent_settled", (_event, ctx) => {
    try {
      decideRecovery(ctx);
    } catch {
      // Recovery bookkeeping must never trap the session.
    }
    if (quotaError !== null) {
      appendFact(runDir(), "quota-exhausted", sessionId, quotaError);
      quotaError = null;
    }
    triggerSync(true);
  });

  pi.on("session_shutdown", () => {
    cancelResume();
    if (syncTicker) clearInterval(syncTicker);
    syncTicker = null;
    triggerSync(true);
  });
}
