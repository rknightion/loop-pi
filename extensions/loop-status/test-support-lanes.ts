// Test-only companion extension. It plays the parts of a root the status line reads but a bare
// test session lacks: pi-subagents' async lane events, loop-continuation's launch answer and its
// persisted state entry. Driven by prompt text, handled before any model turn:
//   lane-start <id> | lane-done <id> | timer <iso> | nudges <n> | launch <report path>
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  let reportPath: string | null = null;
  pi.events.on("loop-continuation:query-launch", (data) => {
    (data as { reply: (r: unknown) => void }).reply({ reportPath });
  });
  pi.on("input", (event, ctx) => {
    const m = /^(lane-start|lane-done|timer|nudges|launch) (\S+)$/.exec(event.text.trim());
    if (!m) return { action: "continue" as const };
    const [, verb, arg] = m;
    const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    if (verb === "lane-start") {
      pi.events.emit("subagent:async-started", { id: arg, sessionId, agent: "lane-worker", deadlineAt: Date.now() + 3_600_000 });
    } else if (verb === "lane-done") {
      pi.events.emit("subagent:async-complete", { runId: arg, triggerTurn: false, results: [] });
    } else if (verb === "timer") {
      pi.events.emit("loop-wait:arm-timer", { at: arg, reason: "status test timer", reply: () => {} });
    } else if (verb === "nudges") {
      pi.appendEntry("loop-continuation-state", { armed: true, launch: null, nudgeCount: Number(arg), chainIncidentWritten: false });
    } else {
      reportPath = arg;
    }
    return { action: "handled" as const };
  });
}
