// Test-only companion extension. Emits the `subagent:async-started` payload the way pi-subagents
// 0.76.1 does: `sessionId` is the parent's session FILE PATH (`getSessionFile() ?? getSessionId()`),
// `deadlineAt` is epoch milliseconds, `task` is redacted, and the event fires before any tool result.
// Then emits `subagent:async-complete` for run "run-a" only, so run "run-b" is left to fire.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    setTimeout(() => {
      const base = { sessionId, agent: "lane-worker", task: "[redacted]", mode: "single" };
      pi.events.emit("subagent:async-started", { ...base, id: "run-a", deadlineAt: Date.now() + 250 });
      pi.events.emit("subagent:async-started", { ...base, id: "run-b", deadlineAt: Date.now() + 500 });
      pi.events.emit("subagent:async-complete", { runId: "run-a", triggerTurn: false, results: [] });
    }, 100).unref();
  });
}
