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
import { hasSubagentField } from "./subagent-view.ts";
import { installRequestCeiling, installRetryBackoff } from "../request-ceiling/index.ts";
import { evaluateBashCommand, evaluateSubagentPolicyFields, wrappedGateCommands, bindGateExecution } from "./rules.ts";
import { loadGateDeclarations } from "./gates.ts";
import { parseLaneBinding } from "./push-grant.ts";
import { bashProtectedPath, isLoopControlToolPath, protoActive, runDirFromEnv, toolWriteRefusal } from "./guard-paths.ts";
import { laneIdFromBrief, planPushes, recordPushes, unloggedPushRefusal, type PlannedPush } from "./push-log.ts";
import { capLaneAssistantMessage } from "../loop-state/return-cap.ts";

export { isLoopControlToolPath };

export default function (pi: ExtensionAPI) {
  // Capture once at extension load: later tool calls cannot widen the launch grant.
  const rawBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const binding = parseLaneBinding(rawBindings);
  // The run dir: the environment's, else the one the root bound. Once observed, the run marker
  // stays active for this child: deleting it cannot disable attribution.
  const runDir = runDirFromEnv() ?? binding.runDir;
  let protocolSeen = protoActive(runDir);
  const proto = () => (protocolSeen ||= protoActive(runDir));
  const pendingPushes = new Map<string, PlannedPush[]>();
  let laneId: string | null | undefined;

  // Shared path for the builtin `bash` tool and loop-wait's `watch_process`
  // (available to lanes), which spawns a process from a `command` field
  // exactly like bash does. Course correction from the main thread
  // (2026-09-27): loop-wait's shell-running tools go through the same
  // evaluateBashCommand + hook-script gate as bash itself.
  const evaluateShellLikeToolCall = async (
    command: string,
    ctx: ExtensionContext,
    input: Record<string, unknown>,
  ): Promise<ToolCallEventResult | void> => {
    const p2 = proto();
    const gates = loadGateDeclarations(ctx.cwd);
    const decision = evaluateBashCommand(command, "lane", 0, {
      gates,
      cwd: ctx.cwd,
      proto: p2,
      protectedPath: p2 ? bashProtectedPath("lane", ctx.cwd, runDir) : undefined,
    });
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }

    const agentDir = getAgentDir();
    const scripts = hookScriptsToRun(agentDir, ["backlog-guard.py", "staging-guard.py"]);
    const declaredCommands = wrappedGateCommands(command, gates);
    for (const declared of declaredCommands) {
      // Explicit remote moves are never allowed as gates: their wrapper has no audit plan.
      const unlogged = unloggedPushRefusal(declared, "watch_process");
      if (unlogged) return { block: true, reason: "loop-guard: declared gates may not run git push or gh pr merge; run remote moves as separate audited bash commands." };
    }
    for (const effective of [command, ...declaredCommands]) {
      const hooks = await runHookScripts(scripts, "bash", { command: effective }, ctx.cwd);
      if (hooks.denied) {
        return { block: true, reason: hooks.reason };
      }
      if (hooks.adapterFailures.length > 0) {
        return { block: true, reason: `loop-guard: hook adapter failure blocks lanes: ${hooks.adapterFailures.join("; ")}` };
      }
    }
    input.command = bindGateExecution(command, gates);
    return;
  };

  // The lane id for the push log, from the brief's `Lane:` header (the first user prompt). pi 1.2.0+
  // also fires this for extension-started runs (messageType "custom", no prompt); those must not latch it.
  pi.on("before_agent_start", (event) => {
    if (laneId !== undefined || event.messageType === "custom") return;
    laneId = laneIdFromBrief(typeof event.prompt === "string" ? event.prompt : "");
  });

  // Lane return cap (SEAMS S6): the root cannot cap an idle-wake notify, so the lane caps its own
  // final text, keeping the full copy under the run dir. A failure leaves the message whole.
  pi.on("message_end", (event, ctx: ExtensionContext) => {
    try {
      const key = laneId ?? ctx.sessionManager.getSessionId();
      const replacement = capLaneAssistantMessage(event.message as { role?: string; content?: unknown; stopReason?: unknown }, runDir, key);
      if (replacement) return { message: replacement as typeof event.message };
    } catch {
      // An uncapped return is better than a lost one.
    }
    return undefined;
  });

  // Post-exec hook: a successful bash call that pushed appends to the run dir's push log.
  pi.on("tool_execution_end", async (event) => {
    const pushes = pendingPushes.get(event.toolCallId);
    if (pushes === undefined) return;
    pendingPushes.delete(event.toolCallId);
    if (event.isError || runDir === undefined) return;
    try {
      await recordPushes(pushes, { runDir, actor: "lane", agent: binding.agent ?? null, lane: laneId ?? null });
    } catch {
      // The push log is evidence for the audit; a write failure never fails the tool call.
    }
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    if (isToolCallEventType("bash", event)) {
      const verdict = await evaluateShellLikeToolCall(event.input.command, ctx, event.input as unknown as Record<string, unknown>);
      if (verdict?.block) return verdict;
      if (proto() && runDir !== undefined) {
        // A push the log cannot see would land UNGRANTED at closeout: refuse it instead.
        const unlogged = unloggedPushRefusal(event.input.command, "bash");
        if (unlogged) return { block: true, reason: unlogged };
        const pushes = await planPushes(event.input.command, ctx.cwd);
        if (pushes.length) pendingPushes.set(event.toolCallId, pushes);
      }
      return verdict;
    }

    if (event.toolName === "watch_process") {
      const raw = (event.input as Record<string, unknown>).command;
      const command = typeof raw === "string" ? raw : "";
      const verdict = await evaluateShellLikeToolCall(command, ctx, event.input as Record<string, unknown>);
      if (verdict?.block) return verdict;
      if (proto() && runDir !== undefined) {
        const unlogged = unloggedPushRefusal(command, "watch_process");
        if (unlogged) return { block: true, reason: unlogged };
      }
      return verdict;
    }

    if (event.toolName === "subagent") {
      // Only the root supplies launch identity. A nested caller must not forge
      // bindings now that the feature is enabled globally.
      // pi-subagents 0.77.0 also accepts the field inside `options`.
      if (hasSubagentField(event.input, "extensionBindings")) {
        return { block: true, reason: "loop-guard: lanes may not supply extensionBindings; only the root binds lane identity." };
      }
      const override = subagentOverrideBlock(event.input);
      if (override) return override;
      const policy = evaluateSubagentPolicyFields(event.input);
      if (policy.block) return { block: true, reason: policy.reason };
      return;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as Record<string, unknown>).path;
      if (proto()) {
        const refusal = toolWriteRefusal(path, ctx.cwd, "lane", runDir);
        if (refusal) return { block: true, reason: refusal };
      }
      if (isLoopControlToolPath(path, ctx.cwd)) {
        return {
          block: true,
          reason: `loop-guard: lanes may not ${event.toolName} '${String(path)}': codex/state-*, codex/charter-*, codex/launch-* and codex/closeout-* belong to the root.`,
        };
      }
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
  installRequestCeiling(pi);
  installRetryBackoff(pi);
}
