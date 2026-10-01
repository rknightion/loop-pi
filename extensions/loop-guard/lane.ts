// loop-guard lane entry. Loaded into every child session as a
// pi-subagents required child extension (registered by root.ts), so it
// survives every agent file's `extensions: []` (SEAMS.md "Role by entry
// file"). Applies every-role + lane-only rules; an adapter failure or timeout
// running the shared hook scripts blocks the call here (root allows it
// through instead, per C4 item 1).

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hookScriptsToRun, runHookScripts } from "./hooks.ts";
import { installModelFamily, subagentOverrideBlock } from "./model-family.ts";
import { evaluateBashCommand } from "./rules.ts";
import { hasLanePushGrant } from "./push-grant.ts";

export default function (pi: ExtensionAPI) {
  // Capture once at extension load: later tool calls cannot widen the launch grant.
  const pushGranted = hasLanePushGrant(process.env.PI_SUBAGENT_EXTENSION_BINDINGS);
  // Shared path for the builtin `bash` tool and loop-wait's `watch_process`
  // (available to lanes), which spawns a process from a `command` field
  // exactly like bash does. Course correction from the main thread
  // (2026-09-27): loop-wait's shell-running tools go through the same
  // evaluateBashCommand + hook-script gate as bash itself.
  const evaluateShellLikeToolCall = async (
    command: string,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> => {
    const decision = evaluateBashCommand(command, "lane", 0, pushGranted);
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }

    const agentDir = getAgentDir();
    const scripts = hookScriptsToRun(agentDir, ["backlog-guard.py", "staging-guard.py"]);
    const hooks = await runHookScripts(scripts, "bash", { command }, ctx.cwd);
    if (hooks.denied) {
      return { block: true, reason: hooks.reason };
    }
    if (hooks.adapterFailures.length > 0) {
      return { block: true, reason: `loop-guard: hook adapter failure blocks lanes: ${hooks.adapterFailures.join("; ")}` };
    }
    return;
  };

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    if (isToolCallEventType("bash", event)) {
      return evaluateShellLikeToolCall(event.input.command, ctx);
    }

    if (event.toolName === "watch_process") {
      const command = (event.input as Record<string, unknown>).command;
      return evaluateShellLikeToolCall(typeof command === "string" ? command : "", ctx);
    }

    if (event.toolName === "subagent") {
      // Only the root supplies launch identity. A nested caller must not forge
      // bindings now that the feature is enabled globally.
      if ((event.input as Record<string, unknown>).extensionBindings !== undefined) {
        return { block: true, reason: "loop-guard: lanes may not supply extensionBindings; only the root binds lane identity." };
      }
      return subagentOverrideBlock(event.input);
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      const agentDir = getAgentDir();
      const scripts = hookScriptsToRun(agentDir, ["backlog-guard.py"]);
      const hooks = await runHookScripts(scripts, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
      if (hooks.denied) {
        return { block: true, reason: hooks.reason };
      }
      if (hooks.adapterFailures.length > 0) {
        return { block: true, reason: `loop-guard: hook adapter failure blocks lanes: ${hooks.adapterFailures.join("; ")}` };
      }
      return;
    }
  });

  installModelFamily(pi);
}
