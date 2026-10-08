// loop-wait root entry: watch_process, watch_start, watch_stop, wake_at, wake_cancel, plus the
// session_start/session_shutdown persistence and reconciliation, the compaction-safe delivery of
// loop-watch/loop-wake messages, the pi.events answers other extensions rely on (SEAMS.md), and a
// closeout sweep command.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DeliveryQueue,
  type Receipt,
  runDirFor,
  runWatchProcess,
  TimerManager,
  type TimerSnapshot,
  WatchManager,
  type WatcherSnapshot,
} from "./core.ts";
import { registerWatchProcess } from "./lane.ts";
import {
  type AsyncStartedPayload,
  laneTimerReason,
  payloadDeadlineMs,
  runIdFromReason,
  subagentArgsDeadlineMs,
} from "./lane-timers.ts";
import { registerRuntimeEntry } from "./runtime-entry.ts";
import { AUTO_ARM_REASON, TIME_PARK_ARM_REASON, STATE_CUSTOM_TYPE, type ContinuationState } from "../loop-continuation/state.ts";
import { finalMarker, reportCounts } from "../loop-continuation/report-status.ts";
import { continuationClockStopped, lastAssistantText } from "../loop-continuation/stop-controls.ts";

interface WatchEvent {
  ev: "watch";
  op: "start" | "stop";
  what: string;
  deadline: string;
}

interface LoopWaitStateSnapshot {
  timers: TimerSnapshot[];
  watchers: WatcherSnapshot[];
  // Optional for compatibility with session entries written before lifecycle logging.
  pendingEvents?: WatchEvent[];
  // Wake messages held after an operator abort. The timer or watch that produced each is already
  // gone from this snapshot, so a restart would otherwise lose them.
  heldMessages?: LoopWaitMessage[];
}

interface LoopWaitMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

const WatchStartParams = Type.Object({
  command: Type.String({ description: "Shell command to run in the background (never append `&`)." }),
  deadline_s: Type.Number({ minimum: 1, description: "Kill the process and finalize the receipt if it has not exited by this deadline." }),
  interval_s: Type.Number({ minimum: 1, description: "Heartbeat interval for the receipt." }),
  label: Type.String({ description: "Short human-readable label for this watch." }),
});
const WatchStopParams = Type.Object({ id: Type.String() });
const WakeAtParams = Type.Object({
  at: Type.String({ description: "ISO-8601 timestamp to wake at." }),
  reason: Type.String({ description: "Why the root is waking, echoed back in the wake message." }),
});
const WakeCancelParams = Type.Object({ id: Type.String() });

function loopWatchMessage(id: string, receipt: Receipt): LoopWaitMessage {
  const result = receipt.result;
  return {
    customType: "loop-watch",
    display: true,
    content: `WATCH ${id} (${receipt.label ?? "unlabeled"}): phase=${receipt.phase} exit_code=${result?.exit_code ?? "null"} deadline_hit=${result?.deadline_hit ?? false}${receipt.note ? ` note=${receipt.note}` : ""}`,
    details: { id, receipt },
  };
}

function loopWakeMessage(id: string, reason: string): LoopWaitMessage {
  return {
    customType: "loop-wake",
    display: true,
    content: `WAKE ${id}: ${reason}`,
    details: { id, reason },
  };
}

export default function (pi: ExtensionAPI): void {
  let watchManager: WatchManager | undefined;
  let timerManager: TimerManager | undefined;
  let deliveryQueue: DeliveryQueue<LoopWaitMessage> | undefined;
  let liveCtx: ExtensionContext | undefined;
  let suppressDelivery = false;
  let clockAbortSignal: AbortSignal | undefined;
  // Set when the operator aborted a run (Esc): fired wakes stay queued until the owner's next input.
  let holdWakes = false;
  // Set by an owner input that arrived while wakes were held; the hold ends at the settle it produces.
  let ownerInputPending = false;
  // True from the start of a hold until its messages are delivered: the queue is then persisted.
  let persistHeld = false;
  // Set when request-ceiling is about to abort a run, so that abort is not read as the operator's.
  let ceilingAbort = false;
  // Session identities pi-subagents may stamp on this session's async-started events.
  let sessionIdentities = new Set<string>();
  // Deadline from a launching call's brief, by toolCallId, until that call's result names the run.
  const briefDeadlines = new Map<string, number>();
  let pendingEvents: WatchEvent[] = [];
  const recording = new Map<string, Promise<void>>();
  // During synchronous startup reconciliation, callbacks can persist before all managers
  // have been reconstructed. Keep not-yet-processed instances in those snapshots.
  const restoringWatchers = new Map<string, WatcherSnapshot>();
  const restoringTimers = new Map<string, TimerSnapshot>();

  const persist = () => {
    pi.appendEntry<LoopWaitStateSnapshot>("loop-wait-state", {
      timers: [...restoringTimers.values(), ...(timerManager?.list() ?? [])],
      watchers: [...restoringWatchers.values(), ...(watchManager?.list() ?? [])],
      pendingEvents: [...pendingEvents],
      heldMessages: persistHeld ? (deliveryQueue?.pendingMatching(() => true) ?? []) : undefined,
    });
  };
  const queueWake = (message: LoopWaitMessage) => {
    deliveryQueue?.send(message);
    if (persistHeld) persist();
  };

  const deliverEvent = (event: WatchEvent) => {
    // One causal queue per instance, not one delivery per event: an available stop
    // must never overtake a start whose append failed before writing. Replaying that
    // start after an acknowledged stop would otherwise falsely reopen the digest.
    const instance = JSON.stringify([event.what, event.deadline]);
    if (recording.has(instance)) return;
    const job = (async () => {
      for (;;) {
        const next = pendingEvents.find(e => e.what === event.what && e.deadline === event.deadline);
        if (!next) return;
        let outcome: Promise<boolean> | undefined;
        try {
          pi.events.emit("loop-wait:state-event", { event: next, reply: (r: Promise<boolean>) => { outcome = r; } });
        } catch { /* A missing recorder must not disrupt process/timer cleanup. */ }
        // Do not deliver any successor on missing/failed ACK. A new lifecycle event
        // or startup retries this head; there is no unbounded automatic retry loop.
        if (!outcome || !await outcome) return;
        const key = JSON.stringify(next);
        pendingEvents = pendingEvents.filter(e => JSON.stringify(e) !== key);
        persist();
      }
    })().catch(() => {}).finally(() => recording.delete(instance));
    recording.set(instance, job);
  };
  const recordEvent = (op: WatchEvent["op"], what: string, deadline: string) => {
    const event: WatchEvent = { ev: "watch", op, what, deadline };
    if (!pendingEvents.some(e => JSON.stringify(e) === JSON.stringify(event))) pendingEvents.push(event);
    // Persist before transport. Restart replays the outbox; CLI locking deduplicates an
    // append that succeeded just before the acknowledgement/session write was interrupted.
    persist();
    deliverEvent(event);
  };
  const timerEvent = (op: WatchEvent["op"], t: TimerSnapshot) => recordEvent(op, `wake ${t.id}: ${t.reason}`, t.at);
  const drainEvents = () => Promise.all([...recording.values()]);

  const teardown = (note: string) => {
    clockAbortSignal?.removeEventListener("abort", cancelContinuationClocks);
    clockAbortSignal = undefined;
    suppressDelivery = true;
    holdWakes = false;
    ownerInputPending = false;
    watchManager?.shutdownAll(note);
    timerManager?.shutdownAll();
    // persistHeld stays set so this last snapshot keeps the held messages; session_start recomputes it.
    persist();
    persistHeld = false;
    watchManager = undefined;
    timerManager = undefined;
    deliveryQueue = undefined;
  };

  // Registered first so it runs before this entry's own session_start handler below.
  registerRuntimeEntry(pi);
  registerWatchProcess(pi);

  pi.registerTool({
    name: "watch_start",
    label: "Start background watch",
    description:
      "Start a long-lived shell command in the background and return a watch-id at once. The receipt " +
      "at <agentDir>/loop-wait/<sessionId>/receipts/<id>.json is heartbeated every interval_s. On exit " +
      "or deadline the root is woken with a loop-watch message. Never spawns with a trailing `&`.",
    promptSnippet: "watch_start(command, deadline_s, interval_s, label) - start a background watch, wakes the root on completion",
    parameters: WatchStartParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      liveCtx = ctx;
      if (!watchManager) throw new Error("loop-wait: watch_start called before session_start reconciliation");
      const id = watchManager.start({
        command: params.command,
        deadlineS: params.deadline_s,
        intervalS: params.interval_s,
        label: params.label,
        cwd: ctx.cwd,
      });
      persist();
      await drainEvents();
      return {
        content: [{ type: "text", text: `watch-id=${id}` }],
        details: { id },
      };
    },
  });

  pi.registerTool({
    name: "watch_stop",
    label: "Stop background watch",
    description: "Stop a watch started with watch_start and finalize its receipt.",
    parameters: WatchStopParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      liveCtx = ctx;
      const stopped = watchManager?.stop(params.id) ?? false;
      persist();
      await drainEvents();
      return {
        content: [{ type: "text", text: stopped ? `stopped ${params.id}` : `no active watch ${params.id}` }],
        details: { stopped },
      };
    },
  });

  pi.registerTool({
    name: "wake_at",
    label: "Wake at",
    description: "Arm a timed wake. The root is woken with a loop-wake message at the given ISO-8601 timestamp.",
    promptSnippet: "wake_at(at, reason) - arm a timed wake",
    parameters: WakeAtParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      liveCtx = ctx;
      if (!timerManager) throw new Error("loop-wait: wake_at called before session_start reconciliation");
      const armed = timerManager.arm(params.at, params.reason);
      persist();
      await drainEvents();
      return {
        content: [{ type: "text", text: `timer-id=${armed.id} at=${armed.at}` }],
        details: armed,
      };
    },
  });

  pi.registerTool({
    name: "wake_cancel",
    label: "Cancel wake",
    description:
      "Cancel a timer armed with wake_at. Accepts the exact timer id or a unique prefix of at least " +
      "8 characters. If the timer already fired but its wake message is still queued behind a busy " +
      "root, that queued message is dropped instead of the (already gone) timer. On no match, the " +
      "error lists every currently armed timer so the root can recover a lost id.",
    parameters: WakeCancelParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      liveCtx = ctx;
      const result = timerManager?.cancel(params.id) ?? ({ status: "not_found" } as const);
      // A timer that fired while the root was busy is removed from TimerManager's live map by
      // fire() before its loop-wake message is delivered (the compaction-safe DeliveryQueue). A
      // wake_cancel arriving in that window must still reach the queued message, or a wake the
      // root believes it cancelled still surfaces minutes later once the root goes idle.
      // Same matching as TimerManager.cancel: the exact id, else a unique prefix of 8+ characters.
      const queuedWakeId = (message: LoopWaitMessage) =>
        message.customType === "loop-wake" ? (message.details as { id?: string } | undefined)?.id : undefined;
      const queuedIds = (deliveryQueue?.pendingMatching((m) => queuedWakeId(m) !== undefined) ?? []).map(
        (m) => queuedWakeId(m) as string,
      );
      const target =
        result.status === "cancelled"
          ? result.id
          : queuedIds.includes(params.id)
            ? params.id
            : params.id.length >= 8 && queuedIds.filter((id) => id.startsWith(params.id)).length === 1
              ? queuedIds.find((id) => id.startsWith(params.id))
              : undefined;
      const droppedQueued =
        target === undefined ? [] : (deliveryQueue?.removePending((m) => queuedWakeId(m) === target) ?? []);
      persist();
      await drainEvents();

      if (result.status === "cancelled") {
        const note = droppedQueued.length > 0 ? " (its queued wake message was also dropped)" : "";
        return {
          content: [{ type: "text", text: `cancelled ${result.id}${note}` }],
          details: { cancelled: true, id: result.id, droppedQueued: droppedQueued.length > 0 },
        };
      }
      if (droppedQueued.length > 0) {
        return {
          content: [{ type: "text", text: `${target} had already fired; dropped its queued wake message before delivery` }],
          details: { cancelled: true, id: target, droppedQueued: true },
        };
      }
      if (result.status === "ambiguous") {
        return {
          content: [{ type: "text", text: `ambiguous timer id prefix "${params.id}": matches ${result.matches.join(", ")}` }],
          details: { cancelled: false, ambiguous: result.matches },
        };
      }
      const armed = timerManager?.list() ?? [];
      const armedText = armed.length ? armed.map((t) => `${t.id} at=${t.at} reason=${t.reason}`).join("; ") : "none currently armed";
      return {
        content: [{ type: "text", text: `no armed timer matching "${params.id}". Currently armed: ${armedText}` }],
        details: { cancelled: false, armed },
      };
    },
  });

  pi.registerCommand("loop-closeout", {
    description: "Stop every loop-wait watcher, cancel every armed timer, and report the sweep.",
    handler: async (_args, ctx) => {
      suppressDelivery = true;
      const stoppedWatchers = watchManager?.shutdownAll("loop-closeout sweep") ?? [];
      const cancelledTimers = timerManager?.list() ?? [];
      for (const timer of cancelledTimers) timerManager?.cancel(timer.id);
      suppressDelivery = false;
      persist();
      await drainEvents();
      const summary = {
        stopped_watchers: stoppedWatchers,
        cancelled_timers: cancelledTimers,
        note: "async subagent runs are not stopped here; stop those through the subagent tool.",
      };
      pi.appendEntry("loop-wait-closeout", summary);
      const sweepLine =
        `loop-closeout: stopped ${stoppedWatchers.length} watcher(s), cancelled ${cancelledTimers.length} timer(s). ` +
        "Async subagent runs are not covered here.";
      ctx.ui.notify(sweepLine, "info");
      // The rest of the closeout belongs to other root extensions (SEAMS.md "loop-closeout"):
      // loop-continuation runs the closeout audit and reports to the root, lane-worktrees sweeps
      // the lane worktrees. They add summary lines to `lines` and their work to `pending`.
      pi.events.emit("loop-closeout", { lines: [sweepLine], pending: [] });
    },
  });

  // request-ceiling emits this just before it aborts a stuck request (SEAMS.md "Request ceiling").
  // That abort is not the operator's: its incident follow-up and any fired wakes go out as before.
  pi.events.on("loop-recovery:request-timeout", () => {
    ceilingAbort = true;
  });
  pi.events.on("loop-wait:query-timers", (data) => {
    (data as { reply: (timers: TimerSnapshot[]) => void }).reply(timerManager?.list() ?? []);
  });
  pi.events.on("loop-wait:arm-timer", (data) => {
    const req = data as { at: string; reason: string; reply: (r: { id: string; at: string }) => void };
    if (!timerManager) {
      // No reply: SEAMS.md's contract is that a missing reply means the provider is not
      // available, so callers fail safe. A stub {id:"",...} would look armed to a caller that
      // only checks "did I get a reply".
      return;
    }
    const armed = timerManager.arm(req.at, req.reason);
    persist();
    req.reply({ id: armed.id, at: armed.at });
  });
  pi.events.on("loop-wait:query-watchers", (data) => {
    (data as { reply: (ws: WatcherSnapshot[]) => void }).reply(watchManager?.list() ?? []);
  });

  // Lane deadline timers. Every async lane this session launches gets a loop-wait timer at its
  // deadline, so the root is woken if the lane never returns. The timer's reason names the run id;
  // a completion cancels by it, including a wake that already fired but is still queued. Timers
  // the root armed itself are never touched: only reasons that name a run are matched.
  const laneTimersFor = (runId: string) => (timerManager?.list() ?? []).filter((t) => runIdFromReason(t.reason) === runId);

  const armLaneTimer = (runId: string, agent: unknown, deadlineMs: number) => {
    if (!timerManager) return;
    for (const existing of laneTimersFor(runId)) timerManager.cancel(existing.id);
    timerManager.arm(new Date(deadlineMs).toISOString(), laneTimerReason(runId, agent));
    persist();
  };

  pi.events.on("subagent:async-started", (data) => {
    const payload = data as AsyncStartedPayload;
    if (typeof payload.id !== "string" || typeof payload.sessionId !== "string") return;
    if (!sessionIdentities.has(payload.sessionId)) return;
    const deadlineMs = payloadDeadlineMs(payload, getAgentDir(), Date.now());
    if (deadlineMs === null) return;
    armLaneTimer(payload.id, payload.agent, deadlineMs);
  });

  pi.events.on("subagent:async-complete", (data) => {
    const runId = (data as { runId?: unknown }).runId;
    if (typeof runId !== "string") return;
    const live = laneTimersFor(runId);
    for (const timer of live) timerManager?.cancel(timer.id);
    const queued = (m: LoopWaitMessage) =>
      m.customType === "loop-wake" && runIdFromReason((m.details as { reason?: string } | undefined)?.reason ?? "") === runId;
    const dropped = deliveryQueue?.removePending(queued) ?? [];
    if (live.length > 0 || dropped.length > 0) persist();
  });

  // The async-started payload redacts the brief, so a `Deadline:` line is read from the launching
  // call's arguments and applied once that call's result names the run id.
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "subagent") return;
    const deadlineMs = subagentArgsDeadlineMs(event.args);
    if (deadlineMs !== null) briefDeadlines.set(event.toolCallId, deadlineMs);
  });
  pi.on("tool_execution_end", (event) => {
    const deadlineMs = briefDeadlines.get(event.toolCallId);
    if (deadlineMs === undefined) return;
    briefDeadlines.delete(event.toolCallId);
    if (event.isError) return;
    const details = (event.result as { details?: { runId?: unknown; asyncId?: unknown } } | undefined)?.details;
    const runId = typeof details?.runId === "string" ? details.runId : details?.asyncId;
    if (typeof runId !== "string") return;
    const [existing] = laneTimersFor(runId);
    // Only a run whose timer was armed (this session's, still running) is re-timed.
    if (!existing) return;
    const agent = /^lane run=\S+ agent=(\S+) /.exec(existing.reason)?.[1];
    armLaneTimer(runId, agent, deadlineMs);
  });

  function cancelContinuationClocks() {
    const ownedReason = (reason: unknown) => reason === TIME_PARK_ARM_REASON || reason === AUTO_ARM_REASON;
    const clocks = (timerManager?.list() ?? []).filter((timer) => ownedReason(timer.reason));
    for (const clock of clocks) timerManager?.cancel(clock.id);
    const dropped = deliveryQueue?.removePending((message) =>
      message.customType === "loop-wake" && ownedReason((message.details as { reason?: unknown } | undefined)?.reason),
    ) ?? [];
    if (clocks.length || dropped.length) persist();
  }

  // pi skips agent_before_settle when the operator aborts an active run. Its public run signal
  // is available at agent_start: revoke the clock synchronously on abort, even during a tool.
  pi.on("agent_start", (_event, ctx) => {
    liveCtx = ctx;
    ceilingAbort = false;
    clockAbortSignal?.removeEventListener("abort", cancelContinuationClocks);
    clockAbortSignal = ctx.signal;
    if (clockAbortSignal?.aborted) cancelContinuationClocks();
    else clockAbortSignal?.addEventListener("abort", cancelContinuationClocks, { once: true });
  });

  // A later stop revokes continuation's earlier promise to wake. Do this at the actionable
  // settle boundary, before agent_settled can flush fired-but-queued wakes. Only the two exact
  // continuation-owned reasons are eligible: root, lane deadline and ops timers remain untouched.
  // The launch is read from its already-frozen branch entry, not a new cross-extension channel.
  pi.on("agent_before_settle", (event, ctx) => {
    liveCtx = ctx;
    let continuation: ContinuationState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
        continuation = entry.data as ContinuationState;
      }
    }
    const counted = !!(continuation?.armed && continuation.launch && reportCounts(continuation.launch, ctx.cwd));
    const marker = finalMarker(lastAssistantText(event.context.contextMessages as never[]));
    if (!continuationClockStopped(event.outcome, counted, marker)) return;
    cancelContinuationClocks();
  });

  // session_compact/session_compact_failed fire while the session's own isCompacting flag is
  // still true (it clears immediately afterward, in the same synchronous call), so a same-tick
  // flush can see a false "still busy" reading. Retry on a short backoff instead of trusting the
  // first check; this is also cheap insurance against any other transient not-idle reading.
  const FLUSH_RETRY_DELAYS_MS = [0, 20, 50, 100, 250];
  const scheduleFlush = () => {
    for (const delayMs of FLUSH_RETRY_DELAYS_MS) {
      setTimeout(() => {
        deliveryQueue?.flush();
        // Delivered: the held copies in the snapshot are no longer needed.
        if (persistHeld && !holdWakes && deliveryQueue?.length === 0) {
          persistHeld = false;
          persist();
        }
      }, delayMs).unref();
    }
  };

  pi.on("session_before_compact", (_event, ctx) => {
    liveCtx = ctx;
  });
  pi.on("session_compact", (_event, ctx) => {
    liveCtx = ctx;
    scheduleFlush();
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    liveCtx = ctx;
    scheduleFlush();
  });
  // An operator abort (agent_settled.aborted) must not restart the root with a fired wake the
  // operator just stopped: hold every wake, fired or yet to fire, until the owner's next input.
  pi.on("agent_settled", (event, ctx) => {
    liveCtx = ctx;
    clockAbortSignal?.removeEventListener("abort", cancelContinuationClocks);
    clockAbortSignal = undefined;
    if ((event as { aborted?: boolean } | undefined)?.aborted === true && !ceilingAbort) {
      holdWakes = true;
      ownerInputPending = false;
      persistHeld = true;
      persist();
    } else if (ownerInputPending) {
      holdWakes = false;
      ownerInputPending = false;
    }
    ceilingAbort = false;
    if (!holdWakes) scheduleFlush();
  });
  // The owner's next input ends the hold, but only at the settle that input produces: releasing
  // here would let a wake firing before the input's turn starts open a concurrent turn.
  pi.on("input", (event) => {
    if (holdWakes && event.source !== "extension") ownerInputPending = true;
  });

  pi.on("session_shutdown", async () => {
    teardown("session_shutdown");
    await drainEvents();
  });

  pi.on("session_start", (_event, ctx) => {
    liveCtx = ctx;
    suppressDelivery = false;
    holdWakes = false;
    ownerInputPending = false;
    persistHeld = false;
    ceilingAbort = false;
    const agentDir = getAgentDir();
    const sessionId = ctx.sessionManager.getSessionId();
    sessionIdentities = new Set(
      [sessionId, ctx.sessionManager.getSessionFile?.()].filter((id): id is string => typeof id === "string" && id !== ""),
    );
    briefDeadlines.clear();
    const runDir = runDirFor(agentDir, sessionId);

    deliveryQueue = new DeliveryQueue<LoopWaitMessage>({
      isIdle: () => liveCtx?.isIdle() ?? true,
      isHeld: () => holdWakes,
      // flush() calls this for every pending message in one batch, passing triggerTurn:false for
      // every message but the last (see core.ts DeliveryQueue.flush): pi's sendMessage appends a
      // triggerTurn:false message to context immediately while idle, and the final triggerTurn:true
      // message starts exactly one turn that sees the whole batch as context.
      deliver: (message, opts) => pi.sendMessage(message, { triggerTurn: opts.triggerTurn }),
    });

    // Reconstruct before callbacks can persist new state. Legacy entries have no outbox.
    const branch = ctx.sessionManager.getBranch();
    let previous: LoopWaitStateSnapshot = { timers: [], watchers: [] };
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "loop-wait-state") {
        previous = entry.data as LoopWaitStateSnapshot;
      }
    }
    pendingEvents = [...(previous.pendingEvents ?? [])];
    // Wakes held after an operator abort outlive a reload or resume: re-queue them still held, so
    // they are delivered at the settle after the owner's next input, never at startup.
    if (previous.heldMessages?.length) {
      holdWakes = true;
      persistHeld = true;
      deliveryQueue.restore(previous.heldMessages);
    }
    recording.clear();
    restoringWatchers.clear();
    restoringTimers.clear();
    for (const w of previous.watchers) restoringWatchers.set(w.id, w);
    for (const t of previous.timers) restoringTimers.set(t.id, t);

    watchManager = new WatchManager({
      runDir,
      onPersist: persist,
      onStart: w => recordEvent("start", `watch ${w.id}: ${w.label}`, w.deadline),
      onFinal: (id, receipt) => {
        recordEvent("stop", `watch ${id}: ${receipt.label ?? "unlabeled"}`, receipt.deadline);
        if (suppressDelivery) return;
        queueWake(loopWatchMessage(id, receipt));
      },
    });
    timerManager = new TimerManager({
      onPersist: persist,
      onArm: t => timerEvent("start", t),
      onEnd: t => timerEvent("stop", t),
      onFire: (id, reason) => {
        if (suppressDelivery) return;
        queueWake(loopWakeMessage(id, reason));
      },
    });

    // Replay pending starts before terminal reconciliation can append their stops.
    for (const event of pendingEvents) deliverEvent(event);
    for (const snapshot of previous.watchers) {
      restoringWatchers.delete(snapshot.id);
      watchManager.reconcileOne(snapshot);
    }
    for (const timer of previous.timers) {
      restoringTimers.delete(timer.id);
      timerManager.reconcile([timer]);
    }
    persist();
  });
}
