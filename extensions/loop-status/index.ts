// Root-only live loop state in the status bar (SEAMS.md "Loop status line"). It owns the status
// key `loop-status` and sets no widget. Everything is read where it already lives, on events:
//  - lanes: `subagent:async-started` / `subagent:async-complete` for this session (its own set,
//    the way loop-continuation counts them);
//  - timers and watchers: loop-wait's `loop-wait:query-timers` / `loop-wait:query-watchers`;
//  - nudge chain: the latest `loop-continuation-state` session entry (`nudgeCount`);
//  - heartbeat: the last `heartbeat` row of the loop-state log beside the launch's report.
// There is no timer here: the line is rebuilt on those events, at agent start and settle, and
// after tool calls, so the heartbeat age is as of the last rebuild.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_NUDGES, STATE_CUSTOM_TYPE } from "../loop-continuation/state.ts";
import { deriveLogPath } from "../loop-state/core.ts";
import { formatStatus } from "./status.ts";

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
  let ctx: Ctx | null = null;
  let sessionKey: string | null = null;
  const liveRuns = new Set<string>();
  let nudges: number | null = null;
  let logPath: string | null = null;
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

  function heartbeatAt(): number | null {
    if (!logPath) {
      let reportPath: unknown;
      pi.events.emit("loop-continuation:query-launch", {
        cwd: ctx?.cwd,
        reply: (r: { reportPath?: unknown } | null | undefined) => {
          reportPath = r?.reportPath;
        },
      });
      if (typeof reportPath !== "string" || reportPath === "") return null;
      logPath = deriveLogPath(isAbsolute(reportPath) ? reportPath : resolve(ctx?.cwd ?? ".", reportPath));
      if (!logPath) return null;
    }
    try {
      const st = statSync(logPath);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (heartbeat?.stamp !== stamp) heartbeat = { stamp, at: lastHeartbeatMs(logPath) };
      return heartbeat.at;
    } catch {
      return null;
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
    const text = formatStatus({
      lanes: liveRuns.size,
      timers: query<{ at: string }>("loop-wait:query-timers"),
      watchers: query<{ deadline?: string }>("loop-wait:query-watchers"),
      nudges,
      maxNudges: MAX_NUDGES,
      heartbeatAt: heartbeatAt(),
      now: Date.now(),
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
    readNudges();
    refresh();
  });
  pi.on("tool_execution_end", (_event, c) => refresh(c));
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
