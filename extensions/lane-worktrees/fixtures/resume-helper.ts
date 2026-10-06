// Test-only extension (fixtures/ is excluded from installed builds). The faux model's script is
// static, so it cannot name a run id it has not seen yet. This rewrites `id: "LAST_RUN"` on a
// `subagent` call to the run id of the last async launch this session saw, so a scripted root can
// resume the lane it launched.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let last: string | undefined;
  let first: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
      const details = (entry.message as { details?: { runId?: string; asyncId?: string } }).details;
      last = details?.runId ?? details?.asyncId ?? last;
      first ??= last;
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "subagent") return;
    const details = (event.result as { details?: { runId?: unknown; asyncId?: unknown } } | undefined)?.details;
    const id = typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : undefined;
    if (id) {
      last = id;
      first ??= id;
    }
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    if (input.id === "LAST_RUN" && last) input.id = last;
    if (input.id === "FIRST_RUN" && first) input.id = first;
  });
}
