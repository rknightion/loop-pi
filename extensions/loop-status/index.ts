// Root-only live loop state in the status bar (SEAMS.md "Loop status line"). It owns the status
// key `loop-status` and sets no widget. Everything is read where it already lives, on events:
//  - lanes: `subagent:async-started` / `subagent:async-complete` for this session (its own set,
//    the way loop-continuation counts them);
//  - timers and watchers: loop-wait's `loop-wait:query-timers` / `loop-wait:query-watchers`;
//  - nudge chain: the latest `loop-continuation-state` session entry (`nudgeCount`);
//  - heartbeat: the last `heartbeat` row of the loop-state log beside the launch's report;
//  - root model time: call-timing's `loopPiProgress` on the session's own assistant messages
//    against the wall time since the launch (modeltime.ts), also behind the wake notice below.
// There is no timer here: the line is rebuilt on those events, at agent start and settle, and
// after tool calls, so the heartbeat age is as of the last rebuild.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_NUDGES, STATE_CUSTOM_TYPE, isParentWake } from "../loop-continuation/state.ts";
import { deriveLogPath } from "../loop-state/core.ts";
import { asyncRunsDir, findNestedRun, formatNestedRun, formatNestedRuns, listNestedRuns } from "./descendants.ts";
import { MODEL_TIME_NOTICE_TYPE, NOTICE_GATE_START, WAKE_CUSTOM_TYPES, formatModelTime, gateNotice, rootModelTime, wakeNotice, type ModelTime } from "./modeltime.ts";
import { formatStatus } from "./status.ts";
import { installObservability } from "./observability.ts";

export const STATUS_KEY = "loop-status";
const TAIL_BYTES = 64 * 1024;

type Ctx = Pick<ExtensionContext, "ui" | "sessionManager" | "cwd" | "hasUI">;

/** Epoch ms of the newest `heartbeat` row in the tail of a loop-state log, or null. */
export function lastHeartbeatMs(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row?.ev !== "heartbeat" || typeof row.at !== "string") continue;
        const ms = Date.parse(row.at);
        if (Number.isFinite(ms)) return ms;
      } catch {
        // A torn first line of the tail, or a line that is not a row.
      }
    }
  } catch {
    // No log yet.
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

export default function (pi: ExtensionAPI): void {
  installObservability(pi);
  let ctx: Ctx | null = null;
  let sessionKey: string | null = null;
  const liveRuns = new Set<string>();
  let nudges: number | null = null;
  let logPath: string | null = null;
  let laneCap: number | null = null;
  let launchedAt: number | null = null;
  let noticeGate = NOTICE_GATE_START;
  let parentWakeInput = false;
  let heartbeat: { stamp: string; at: number | null } | null = null;
  let lastText: string | undefined;
  let pending = false;

  function remember(next: Ctx | undefined): void {
    if (next) ctx = next;
  }

  function readNudges(): void {
    nudges = null;
    try {
      const entries = ctx?.sessionManager.getEntries() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type?: string; customType?: string; data?: { nudgeCount?: unknown } };
        if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
        const count = entry.data?.nudgeCount;
        nudges = typeof count === "number" && Number.isFinite(count) ? count : null;
        return;
      }
    } catch {
      // A stale session context shows no count.
    }
  }

  /** Reads the launch answer once per launch: the log path, the slot cap and when it launched. */
  function readLaunch(): void {
    if (logPath) return;
    let reportPath: unknown;
    let concurrency: unknown;
    let launchedAtIso: unknown;
    pi.events.emit("loop-continuation:query-launch", {
      cwd: ctx?.cwd,
      reply: (r: { reportPath?: unknown; concurrency?: unknown; launchedAt?: unknown } | null | undefined) => {
        reportPath = r?.reportPath;
        concurrency = r?.concurrency;
        launchedAtIso = r?.launchedAt;
      },
    });
    if (typeof reportPath !== "string" || reportPath === "") return;
    logPath = deriveLogPath(isAbsolute(reportPath) ? reportPath : resolve(ctx?.cwd ?? ".", reportPath));
    if (!logPath) return;
    // Frozen at arm, so they are read once with the launch, alongside the log path.
    laneCap = typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : null;
    const launched = typeof launchedAtIso === "string" ? Date.parse(launchedAtIso) : NaN;
    launchedAt = Number.isFinite(launched) ? launched : null;
  }

  function heartbeatAt(): number | null {
    readLaunch();
    if (!logPath) return null;
    try {
      const st = statSync(logPath);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (heartbeat?.stamp !== stamp) heartbeat = { stamp, at: lastHeartbeatMs(logPath) };
      return heartbeat.at;
    } catch {
      return null;
    }
  }

  /** Root model time as of `now`: since the launch when known, else since the session began. */
  function modelTime(now: number): ModelTime {
    try {
      readLaunch();
      const header = Date.parse(ctx?.sessionManager.getHeader?.()?.timestamp ?? "");
      const since = launchedAt ?? (Number.isFinite(header) ? header : null);
      return rootModelTime(ctx?.sessionManager.getEntries(), since, now);
    } catch {
      // Unreadable session state is unknown, never a guessed number.
      return { state: "unknown" };
    }
  }

  function query<T>(channel: string): T[] | null {
    let result: T[] | null = null;
    pi.events.emit(channel, {
      reply: (r: unknown) => {
        result = Array.isArray(r) ? (r as T[]) : null;
      },
    });
    return result;
  }

  function render(): void {
    if (!ctx?.hasUI) return;
    const now = Date.now();
    const heartbeatMs = heartbeatAt();
    const text = formatStatus({
      lanes: liveRuns.size,
      laneCap,
      nested: listNestedRuns(asyncRunsDir(), sessionKey).length,
      timers: query<{ at: string }>("loop-wait:query-timers"),
      watchers: query<{ deadline?: string }>("loop-wait:query-watchers"),
      nudges,
      maxNudges: MAX_NUDGES,
      heartbeatAt: heartbeatMs,
      modelTime: formatModelTime(modelTime(now)),
      now,
    });
    if (text === lastText) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
      lastText = text;
    } catch {
      // A status failure must never trap the session.
    }
  }

  // Deferred to a microtask so a handler registered after this one (loop-wait arming a lane
  // deadline timer on the same event) has run before the timers are queried. Coalesces bursts.
  function refresh(next?: Ctx): void {
    remember(next);
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      render();
    });
  }

  pi.on("session_start", (_event, c) => {
    remember(c);
    sessionKey = c.sessionManager.getSessionFile?.() ?? c.sessionManager.getSessionId();
    liveRuns.clear();
    logPath = null;
    laneCap = null;
    launchedAt = null;
    noticeGate = NOTICE_GATE_START;
    parentWakeInput = false;
    heartbeat = null;
    lastText = undefined;
    readNudges();
    refresh();
  });
  pi.on("agent_start", (_event, c) => {
    remember(c);
    readNudges();
    refresh();
  });
  pi.on("agent_settled", (_event, c) => {
    remember(c);
    parentWakeInput = false;
    readNudges();
    refresh();
  });
  pi.on("tool_execution_end", (_event, c) => refresh(c));
  // The wake notice (SEAMS.md "Loop status line"). pi-subagents wakes an idle root with an
  // extension-sourced user message; loop-wait wakes it with a `loop-watch` / `loop-wake` custom
  // message. Either starts a run through `before_agent_start`, which may add one message to that
  // run: at most one notice per wake, none at or below the threshold or while the share is unknown.
  pi.on("input", (event) => {
    if (isParentWake(event)) parentWakeInput = true;
  });
  pi.on("before_agent_start", (event, c) => {
    const fromInput = parentWakeInput;
    parentWakeInput = false;
    try {
      remember(c);
      const wake = event.messageType === "custom"
        ? WAKE_CUSTOM_TYPES.has(event.message.customType)
        : fromInput && isParentWake({ source: "extension", text: event.prompt });
      if (!wake) return;
      const time = modelTime(Date.now());
      // Loop-specific advice: only for an armed launch, never a plain session on this home.
      if (launchedAt === null || time.state !== "known") return;
      const notice = wakeNotice(time);
      if (!notice) return;
      const gated = gateNotice(noticeGate, time.share);
      noticeGate = gated.gate;
      if (gated.send) return { message: { customType: MODEL_TIME_NOTICE_TYPE, content: notice, display: true } };
    } catch {
      // A notice failure must never hold up the wake.
    }
  });
  // pi-subagents' `subagent status` lists only runs this session launched. A run a lane launched
  // (depth 2) is neither listed nor resolvable by id, so the root cannot see the capacity it holds:
  // append those runs to the listing, and answer an id that is one of them instead of "not found".
  pi.on("tool_result", (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const input = (event.input ?? {}) as { action?: unknown; id?: unknown; runId?: unknown; dir?: unknown; view?: unknown; options?: { view?: unknown } };
      if (input.action !== "status" || input.dir !== undefined || input.view !== undefined || input.options?.view !== undefined) return;
      const first = event.content?.[0];
      const text = first?.type === "text" ? first.text : "";
      const requested = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : undefined;
      if (requested === undefined) {
        if (event.isError || event.content?.some((part) => part.type !== "text")) return;
        const section = formatNestedRuns(listNestedRuns(asyncRunsDir(), sessionKey));
        if (section) return { content: [{ type: "text" as const, text: `${text}\n\n${section}` }] };
        return;
      }
      if (!event.isError || !text.startsWith("Async run not found")) return;
      const run = findNestedRun(asyncRunsDir(), sessionKey, requested);
      if (run) return { content: [{ type: "text" as const, text: formatNestedRun(run) }], isError: false };
    } catch {
      // A lookup failure leaves pi-subagents' own answer untouched.
    }
  });
  pi.on("session_shutdown", () => {
    try {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Already gone.
    }
    ctx = null;
  });

  pi.events.on("subagent:async-started", (data) => {
    const d = data as { id?: unknown; sessionId?: unknown } | null;
    if (typeof d?.id === "string" && d.sessionId === sessionKey) liveRuns.add(d.id);
    refresh();
  });
  pi.events.on("subagent:async-complete", (data) => {
    const d = data as { runId?: unknown; id?: unknown } | null;
    const id = typeof d?.runId === "string" ? d.runId : typeof d?.id === "string" ? d.id : undefined;
    if (id) liveRuns.delete(id);
    refresh();
  });
}
