// loop-guard root entry. Registered on the root's own
// `--extension` flag, never through settings `packages` (SEAMS.md "Role by
// entry file"). Applies every-role + root-only rules to every tool call, runs
// the shared hook scripts for bash/edit/write, and registers loop-guard's and
// loop-wait's lane entries as pi-subagents required child extensions so every
// descendant gets fenced regardless of its own `extensions: []`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { hookScriptsToRun, runHookScripts } from "./hooks.ts";
import { installModelFamily, subagentOverrideBlock } from "./model-family.ts";
import { installRequestCeiling, installRetryBackoff } from "../request-ceiling/index.ts";
import { bindLaneIdentity } from "./push-grant.ts";
import { evaluateOpsLaunch, QUERY_LAUNCH_EVENT } from "./ops.ts";
import { evaluateBashCommand, evaluateBgWait, evaluateSubagentCall, evaluateWatchProcess, isAsyncSubagentLaunch, wrappedGateCommands, bindGateExecution } from "./rules.ts";
import { loadGateDeclarations } from "./gates.ts";
import { bashProtectedPath, protoActive, runDirFromEnv, toolWriteRefusal } from "./guard-paths.ts";
import { planPushes, recordPushes, unloggedPushRefusal, type PlannedPush } from "./push-log.ts";

const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** Protocol 2: the longest `bash` timeout (seconds) the root may set; longer waits go through
 *  `watch_start`, so the watchdog never reads a long silent turn as a stall. */
export const ROOT_BASH_TIMEOUT_MAX_S = 900;

/** Custom messages that wake the root: a lane return, a watcher exit and a fired timer. */
const WAKE_MESSAGES: ReadonlySet<string> = new Set(["subagent-notify", "loop-watch", "loop-wake"]);

/** The run id of an async launch from its tool result (pi-subagents 0.75.0): `details.runId`, else
 *  `details.asyncId`, else the `Async: <agent> [<id>]` text. */
export function launchedRunId(result: unknown): string | undefined {
  const r = result as { details?: { runId?: unknown; asyncId?: unknown }; content?: { type?: string; text?: unknown }[] } | undefined;
  if (typeof r?.details?.runId === "string" && r.details.runId) return r.details.runId;
  if (typeof r?.details?.asyncId === "string" && r.details.asyncId) return r.details.asyncId;
  for (const part of r?.content ?? []) {
    const m = typeof part?.text === "string" ? /Async: \S+ \[([^\]\s]+)\]/.exec(part.text) : null;
    if (m) return m[1];
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  // The loop run dir the launcher exported. Protocol 2 refusals and the push log apply only while
  // its `loop-pi-proto` marker exists (SEAMS S0), which loop-continuation writes when it arms.
  const runDir = runDirFromEnv();
  const proto = () => protoActive(runDir);
  // Pushes planned at tool_call (remote branches read before the command runs), by tool call id.
  const pendingPushes = new Map<string, PlannedPush[]>();
  // `subagent` status targets (run id, or "*" for the fleet) checked since the last wake.
  const statusSinceWake = new Set<string>();
  const wake = () => statusSinceWake.clear();

  let asyncRunsActive = 0;
  // Tool call ids of qualifying async launches whose tool execution has not ended yet.
  const pendingAsyncLaunches = new Set<string>();
  let childRegistration: { dispose(): void } | undefined;
  // Fail closed (course correction, main thread, 2026-09-27): if
  // registerRequiredChildExtensions ever throws, children can no longer be
  // trusted to load loop-guard-lane/loop-wait-lane regardless of their own
  // `extensions: []`, so every subsequent `subagent` launch is blocked for
  // the rest of this session rather than merely logged and allowed through.
  let childRegistrationFailed = false;

  // Ops runs active in this session, by surface: launches between tool_call and the end of their
  // tool execution (by tool call id), then started runs (by run id) until `subagent:async-complete`.
  const pendingOps = new Map<string, { surface: string; async: boolean }>();
  const runningOps = new Map<string, string>();
  const completedRuns = new Set<string>();
  const isSurfaceActive = (surface: string) =>
    [...pendingOps.values()].some((p) => p.surface === surface) || [...runningOps.values()].includes(surface);

  /** The frozen ops grants from loop-continuation, or undefined when nothing answers. */
  const queryFrozenOps = (): unknown => {
    let ops: unknown;
    pi.events.emit(QUERY_LAUNCH_EVENT, {
      reply: (launch: { ops?: unknown } | null | undefined) => {
        ops = launch?.ops ?? null;
      },
    });
    return ops;
  };

  pi.events.on(ASYNC_COMPLETE_EVENT, (data) => {
    const event = data as { runId?: unknown; id?: unknown } | null;
    const runId = typeof event?.runId === "string" ? event.runId : typeof event?.id === "string" ? event.id : undefined;
    if (!runId) return;
    completedRuns.add(runId);
    runningOps.delete(runId);
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    wake();
    const sessionId = ctx.sessionManager.getSessionId();
    const extensions: { id: string; path: string }[] = [
      { id: "loop-guard-lane", path: fileURLToPath(new URL("./lane.ts", import.meta.url)) },
    ];
    const loopWaitLanePath = fileURLToPath(new URL("../loop-wait/lane.ts", import.meta.url));
    // loop-wait is a sibling B4 lane; only register it once it exists so this
    // root does not fail to start while that lane is still being written.
    if (existsSync(loopWaitLanePath)) {
      extensions.push({ id: "loop-wait-lane", path: loopWaitLanePath });
    }
    try {
      childRegistration = registerRequiredChildExtensions({ sessionId, extensions, requireForAllRunners: true });
    } catch (err) {
      childRegistrationFailed = true;
      ctx.ui.notify(
        `loop-guard: failed to register required child extensions: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    childRegistration?.dispose();
    childRegistration = undefined;
  });

  pi.on("session_compact", () => {
    wake();
  });

  pi.on("input", () => {
    wake();
    return { action: "continue" as const };
  });

  // Tracks "is any async subagent run active" for the watch_process root rule
  // (SEAMS.md cross-extension contract: loop-guard owns this itself). This is
  // a conservative approximation, not an exact scheduler: it increments on
  // every qualifying async launch and decrements by one per `subagent-notify`
  // completion message, even though one notify message can report several
  // completed runs batched together. That asymmetry only ever makes the flag
  // stay "active" longer than strictly necessary, which is the safe direction
  // for a rule whose purpose is "don't block a pushed completion".
  //
  // Launches are tracked by tool call id until their tool execution ends. A tracked launch that
  // ends in error started no run, so no subagent-notify will ever release it: it is released
  // here instead. Only a tracked id is released, and only once, so an error from any other
  // call, or a repeated end event, never lowers the count.
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "subagent" && isAsyncSubagentLaunch(event.args ?? {})) {
      if (pendingAsyncLaunches.has(event.toolCallId)) return;
      pendingAsyncLaunches.add(event.toolCallId);
      asyncRunsActive += 1;
    }
  });

  pi.on("tool_execution_end", (event) => {
    const pending = pendingOps.get(event.toolCallId);
    if (pending !== undefined) {
      const surface = pending.surface;
      pendingOps.delete(event.toolCallId);
      const runId = launchedRunId(event.result);
      if (runId !== undefined) {
        if (!completedRuns.has(runId)) runningOps.set(runId, surface);
      } else if (!event.isError && pending.async) {
        // An async launch that reported no run id can never be seen completing: keep the
        // surface active for the rest of the session rather than lose track of it.
        runningOps.set(`call:${event.toolCallId}`, surface);
      }
    }
    if (!pendingAsyncLaunches.delete(event.toolCallId)) return;
    if (event.isError) asyncRunsActive = Math.max(0, asyncRunsActive - 1);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; customType?: string };
    if (message.role === "custom" && message.customType === "subagent-notify") {
      asyncRunsActive = Math.max(0, asyncRunsActive - 1);
    }
    if (message.role === "custom" && typeof message.customType === "string" && WAKE_MESSAGES.has(message.customType)) wake();
  });

  // Push log (SEAMS S1): a successful root bash call that pushed appends one line per moved branch.
  pi.on("tool_execution_end", async (event) => {
    const pushes = pendingPushes.get(event.toolCallId);
    if (pushes === undefined) return;
    pendingPushes.delete(event.toolCallId);
    if (event.isError || runDir === undefined) return;
    try {
      await recordPushes(pushes, { runDir, actor: "root", agent: null, lane: null });
    } catch {
      // The push log is evidence for the audit; a write failure never fails the tool call.
    }
  });

  // Shared path for any tool that ultimately runs a shell command: the builtin
  // `bash` tool and loop-wait's `watch_process`/`watch_start`, which spawn a
  // process from a `command` field exactly like bash does. Course correction
  // from the main thread (2026-09-27): loop-wait's shell-running tools go
  // through the same evaluateBashCommand + hook-script gate as bash itself;
  // loop-wait remains the single owner of the watch/wait mechanics, loop-guard
  // is the single enforcement point for what command text may run.
  const evaluateShellLikeToolCall = async (
    command: string,
    ctx: ExtensionContext,
    input: Record<string, unknown>,
  ): Promise<ToolCallEventResult | void> => {
    const p2 = proto();
    const gates = loadGateDeclarations(ctx.cwd);
    const decision = evaluateBashCommand(command, "root", 0, true, {
      gates,
      cwd: ctx.cwd,
      proto: p2,
      protectedPath: p2 ? bashProtectedPath("root", ctx.cwd, runDir) : undefined,
    });
    if (decision.warning) {
      ctx.ui.notify(decision.warning, "warning");
    } else if (decision.block) {
      return { block: true, reason: decision.reason };
    }

    const agentDir = getAgentDir();
    const scripts = hookScriptsToRun(agentDir, ["backlog-guard.py", "staging-guard.py"]);
    const declaredCommands = wrappedGateCommands(command, gates);
    for (const declared of declaredCommands) {
      const unlogged = unloggedPushRefusal(declared, "watch_process");
      if (unlogged) return { block: true, reason: "loop-guard: declared gates may not run git push or gh pr merge; run remote moves as separate audited bash commands." };
    }
    for (const effective of [command, ...declaredCommands]) {
      const hooks = await runHookScripts(scripts, "bash", { command: effective }, ctx.cwd);
      if (hooks.denied) {
        return { block: true, reason: hooks.reason };
      }
      for (const failure of hooks.adapterFailures) {
        ctx.ui.notify(`loop-guard: hook adapter failure ignored for root: ${failure}`, "warning");
      }
    }
    input.command = bindGateExecution(command, gates);
    return;
  };

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    if (isToolCallEventType("bash", event)) {
      const timeout = (event.input as { timeout?: unknown }).timeout;
      if (proto() && typeof timeout === "number" && timeout > ROOT_BASH_TIMEOUT_MAX_S) {
        return {
          block: true,
          reason:
            `loop-guard: a root \`bash\` timeout of ${timeout} s is over ${ROOT_BASH_TIMEOUT_MAX_S} s; the watchdog reads a turn that ` +
            "long as stalled. Run the work under `watch_start` and end the turn; its exit wakes the root.",
        };
      }
      const verdict = await evaluateShellLikeToolCall(event.input.command, ctx, event.input as unknown as Record<string, unknown>);
      if (verdict?.block) return verdict;
      if (proto() && runDir !== undefined) {
        const pushes = await planPushes(event.input.command, ctx.cwd);
        if (pushes.length) pendingPushes.set(event.toolCallId, pushes);
      }
      return verdict;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      if (proto()) {
        const refusal = toolWriteRefusal((event.input as Record<string, unknown>).path, ctx.cwd, "root", runDir);
        if (refusal) return { block: true, reason: refusal };
      }
      const agentDir = getAgentDir();
      const scripts = hookScriptsToRun(agentDir, ["backlog-guard.py"]);
      const hooks = await runHookScripts(scripts, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
      if (hooks.denied) {
        return { block: true, reason: hooks.reason };
      }
      for (const failure of hooks.adapterFailures) {
        ctx.ui.notify(`loop-guard: hook adapter failure ignored for root: ${failure}`, "warning");
      }
      return;
    }

    if (event.toolName === "subagent") {
      if (childRegistrationFailed) {
        return {
          block: true,
          reason:
            "loop-guard: registerRequiredChildExtensions failed earlier this session, so a child cannot be " +
            "guaranteed to load the required child extension; every subagent call is blocked (fail closed).",
        };
      }
      const wrongModel = subagentOverrideBlock(event.input);
      if (wrongModel) {
        return wrongModel;
      }
      const input = event.input as Record<string, unknown>;
      if (input.action === "status" && proto()) {
        const target = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : "*";
        if (statusSinceWake.has(target)) {
          return {
            block: true,
            reason:
              `loop-guard: \`subagent\` status for '${target}' was already read and nothing has woken the root since. ` +
              "Never poll between wakes: end the turn; a lane return, a loop-watch or a loop-wake wakes the root.",
          };
        }
        statusSinceWake.add(target);
      }
      const decision = evaluateSubagentCall(input);
      if (decision.block) {
        return { block: true, reason: decision.reason };
      }
      const ops = evaluateOpsLaunch(input, queryFrozenOps(), isSurfaceActive);
      if (ops.block) {
        return { block: true, reason: ops.reason };
      }
      if (input.action === undefined && typeof input.agent === "string" && typeof input.task === "string") {
        bindLaneIdentity(input, input.agent, ops.entry, { runDir });
        if (ops.entry) pendingOps.set(event.toolCallId, { surface: ops.entry.surface, async: isAsyncSubagentLaunch(input) });
      } else {
        // Only a single launch is bound; a model-supplied binding never reaches any other shape.
        delete input.extensionBindings;
      }
      return;
    }

    if (event.toolName === "watch_process") {
      const decision = evaluateWatchProcess(asyncRunsActive > 0);
      if (decision.block) {
        return { block: true, reason: decision.reason };
      }
      const command = (event.input as Record<string, unknown>).command;
      return evaluateShellLikeToolCall(typeof command === "string" ? command : "", ctx, event.input as Record<string, unknown>);
    }

    if (event.toolName === "watch_start") {
      const command = (event.input as Record<string, unknown>).command;
      return evaluateShellLikeToolCall(typeof command === "string" ? command : "", ctx, event.input as Record<string, unknown>);
    }

    if (event.toolName === "bg_wait") {
      const decision = evaluateBgWait();
      return { block: true, reason: decision.reason };
    }
  });

  installModelFamily(pi);
  installRequestCeiling(pi);
  installRetryBackoff(pi);
}
