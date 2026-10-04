// loop-guard lane entry. Loaded into every child session as a
// pi-subagents required child extension (registered by root.ts), so it
// survives every agent file's `extensions: []` (SEAMS.md "Role by entry
// file"). Applies every-role + lane-only rules; an adapter failure or timeout
// running the shared hook scripts blocks the call here (root allows it
// through instead, per C4 item 1).
//
// An `ops` or `ops-probe` lane (identity bound by the root with its frozen ops entry) also takes the
// single-flight surface lock at load and holds it for its whole life; while the lock is not held,
// every shell command it runs is refused.

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hookScriptsToRun, runHookScripts } from "./hooks.ts";
import { installModelFamily, subagentOverrideBlock } from "./model-family.ts";
import { installRequestCeiling, installRetryBackoff } from "../request-ceiling/index.ts";
import { evaluateBashCommand } from "./rules.ts";
import { hasLanePushGrant } from "./push-grant.ts";
import { parseLaneBinding } from "./ops.ts";
import { acquireOpsLock, type OpsLock } from "./ops-lock.ts";
import { bashProtectedPath, isLoopControlToolPath, protoActive, runDirFromEnv, toolWriteRefusal } from "./guard-paths.ts";
import { laneIdFromBrief, planPushes, recordPushes, type PlannedPush } from "./push-log.ts";

export { isLoopControlToolPath };

export default function (pi: ExtensionAPI) {
  // Capture once at extension load: later tool calls cannot widen the launch grant.
  const rawBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const pushGranted = hasLanePushGrant(rawBindings);
  const binding = parseLaneBinding(rawBindings);
  const ops = binding.ops;
  // The run dir: the environment's, else the one the root bound (SEAMS S1). Protocol 2 refusals and
  // the push log apply only while its `loop-pi-proto` marker exists (S0).
  const runDir = runDirFromEnv() ?? binding.runDir;
  const proto = () => protoActive(runDir);
  const pendingPushes = new Map<string, PlannedPush[]>();
  let laneId: string | null | undefined;
  const opsLock: Promise<OpsLock> | undefined = ops ? acquireOpsLock(ops.surface) : undefined;
  let heldLock: OpsLock | undefined;
  if (opsLock) {
    void opsLock.then((lock) => {
      heldLock = lock;
    });
    const releaseOnExit = () => heldLock?.release();
    process.once("exit", releaseOnExit);
    pi.on("session_shutdown", async () => {
      (await opsLock).release();
      process.removeListener("exit", releaseOnExit);
    });
  }

  const opsLockRefusal = async (): Promise<ToolCallEventResult | void> => {
    if (!opsLock || !ops) return;
    const lock = await opsLock;
    if (lock.isHeld()) return;
    const why = lock.state === "busy" ? lock.reason : `the surface lock could not be taken (${lock.reason ?? lock.state})`;
    return {
      block: true,
      reason:
        `loop-guard (ops): surface '${ops.surface}' is single-flight and this lane does not hold its lock: ${why}. ` +
        "No ops command runs; return blocked.",
    };
  };

  // Shared path for the builtin `bash` tool and loop-wait's `watch_process`
  // (available to lanes), which spawns a process from a `command` field
  // exactly like bash does. Course correction from the main thread
  // (2026-09-27): loop-wait's shell-running tools go through the same
  // evaluateBashCommand + hook-script gate as bash itself.
  const evaluateShellLikeToolCall = async (
    command: string,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> => {
    const locked = await opsLockRefusal();
    if (locked) return locked;
    const p2 = proto();
    const decision = evaluateBashCommand(command, "lane", 0, pushGranted, {
      ops: ops?.entry,
      cwd: ctx.cwd,
      proto: p2,
      protectedPath: p2 ? bashProtectedPath("lane", ctx.cwd, runDir) : undefined,
    });
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

  // The lane id for the push log, from the brief's `Lane:` header (the first prompt).
  pi.on("before_agent_start", (event) => {
    if (laneId === undefined) laneId = laneIdFromBrief(typeof event.prompt === "string" ? event.prompt : "");
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
      const verdict = await evaluateShellLikeToolCall(event.input.command, ctx);
      if (verdict?.block) return verdict;
      if (proto() && runDir !== undefined) {
        const pushes = await planPushes(event.input.command, ctx.cwd);
        if (pushes.length) pendingPushes.set(event.toolCallId, pushes);
      }
      return verdict;
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
      const path = (event.input as Record<string, unknown>).path;
      if (proto()) {
        const refusal = toolWriteRefusal(path, ctx.cwd, "lane", runDir);
        if (refusal) return { block: true, reason: refusal };
      }
      if (isLoopControlToolPath(path, ctx.cwd)) {
        return {
          block: true,
          reason: `loop-guard: lanes may not ${event.toolName} '${String(path)}': codex/ops-*, codex/state-* and codex/goal-* belong to the root.`,
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
