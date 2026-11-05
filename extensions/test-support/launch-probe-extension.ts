// Test-only extension: `launch_probe` offers a workflow child start to the session's `tool_call`
// handlers exactly as pi-subagents does before it starts a workflow child, by calling the
// installed package's own `approveWorkflowChildLaunch` (src/extension/subagent-launch-tool.js),
// which runs a nested `subagent_launch` call through pi's `ctx.executeTool`. It reports whether the
// call was offered at all and the refusal, if any. Never shipped (test-support/ is excluded).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PACKAGE_MODULE = new URL("../../node_modules/pi-subagents/src/extension/subagent-launch-tool.js", import.meta.url).href;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "launch_probe",
    label: "Launch probe",
    description: "Offer a workflow child start to tool_call handlers, as pi-subagents does.",
    parameters: Type.Object({ key: Type.String(), command: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { approveWorkflowChildLaunch } = await import(PACKAGE_MODULE);
      const offered = "executeTool" in ctx && (ctx as unknown as { tools: { name: string }[] }).tools.some((tool) => tool.name === "subagent_launch");
      const args = {
        workflowRunId: "probe-run",
        key: params.key,
        agent: "worker",
        task: "PROBE_CHILD",
        cwd: ctx.cwd,
        ...(params.command ? { commands: [{ command: params.command }] } : {}),
      };
      const refusal: string | undefined = await approveWorkflowChildLaunch(ctx, () => args, signal ?? new AbortController().signal);
      return { content: [{ type: "text", text: JSON.stringify({ offered, refusal: refusal ?? null }) }], details: {} };
    },
  });
}
