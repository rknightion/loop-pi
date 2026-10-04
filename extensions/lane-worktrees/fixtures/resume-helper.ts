// Test-only extension (fixtures/ is excluded from installed builds). The faux model's script is
// static, so it cannot name a run id it has not seen yet. This rewrites `id: "LAST_RUN"` on a
// `subagent` call to the run id of the last async launch this session saw, so a scripted root can
// resume the lane it launched.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let last: string | undefined;
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "subagent") return;
    const details = (event.result as { details?: { runId?: unknown; asyncId?: unknown } } | undefined)?.details;
    const id = typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : undefined;
    if (id) last = id;
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    if (input.id === "LAST_RUN" && last) input.id = last;
  });
}
