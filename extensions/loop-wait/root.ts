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

interface LoopWaitStateSnapshot {
  timers: TimerSnapshot[];
  watchers: WatcherSnapshot[];
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

  const persist = () => {
    pi.appendEntry<LoopWaitStateSnapshot>("loop-wait-state", {
      timers: timerManager?.list() ?? [],
      watchers: watchManager?.list() ?? [],
    });
  };

  const teardown = (note: string) => {
    suppressDelivery = true;
    watchManager?.shutdownAll(note);
    timerManager?.shutdownAll();
    persist();
    watchManager = undefined;
    timerManager = undefined;
    deliveryQueue = undefined;
  };

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
      const summary = {
        stopped_watchers: stoppedWatchers,
        cancelled_timers: cancelledTimers,
        note: "async subagent runs are not stopped here; stop those through the subagent tool.",
      };
      pi.appendEntry("loop-wait-closeout", summary);
      ctx.ui.notify(
        `loop-closeout: stopped ${stoppedWatchers.length} watcher(s), cancelled ${cancelledTimers.length} timer(s). ` +
          "Async subagent runs are not covered here.",
        "info",
      );
    },
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

  // session_compact/session_compact_failed fire while the session's own isCompacting flag is
  // still true (it clears immediately afterward, in the same synchronous call), so a same-tick
  // flush can see a false "still busy" reading. Retry on a short backoff instead of trusting the
  // first check; this is also cheap insurance against any other transient not-idle reading.
  const FLUSH_RETRY_DELAYS_MS = [0, 20, 50, 100, 250];
  const scheduleFlush = () => {
    for (const delayMs of FLUSH_RETRY_DELAYS_MS) {
      setTimeout(() => deliveryQueue?.flush(), delayMs).unref();
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
  pi.on("agent_settled", (_event, ctx) => {
    liveCtx = ctx;
    scheduleFlush();
  });

  pi.on("session_shutdown", () => {
    teardown("session_shutdown");
  });

  pi.on("session_start", (_event, ctx) => {
    liveCtx = ctx;
    suppressDelivery = false;
    const agentDir = getAgentDir();
    const sessionId = ctx.sessionManager.getSessionId();
    const runDir = runDirFor(agentDir, sessionId);

    deliveryQueue = new DeliveryQueue<LoopWaitMessage>({
      isIdle: () => liveCtx?.isIdle() ?? true,
      // flush() calls this for every pending message in one batch, passing triggerTurn:false for
      // every message but the last (see core.ts DeliveryQueue.flush): pi's sendMessage appends a
      // triggerTurn:false message to context immediately while idle, and the final triggerTurn:true
      // message starts exactly one turn that sees the whole batch as context.
      deliver: (message, opts) => pi.sendMessage(message, { triggerTurn: opts.triggerTurn }),
    });

    watchManager = new WatchManager({
      runDir,
      onPersist: persist,
      onFinal: (id, receipt) => {
        if (suppressDelivery) return;
        deliveryQueue?.send(loopWatchMessage(id, receipt));
      },
    });
    timerManager = new TimerManager({
      onPersist: persist,
      onFire: (id, reason) => {
        if (suppressDelivery) return;
        deliveryQueue?.send(loopWakeMessage(id, reason));
      },
    });

    // Reconstruct state from the current branch only: an abandoned branch is an alternative
    // history, not something to replay here.
    const branch = ctx.sessionManager.getBranch();
    let previous: LoopWaitStateSnapshot = { timers: [], watchers: [] };
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "loop-wait-state") {
        previous = entry.data as LoopWaitStateSnapshot;
      }
    }

    for (const snapshot of previous.watchers) watchManager.reconcileOne(snapshot);
    timerManager.reconcile(previous.timers);
    persist();
  });
}
