// loop-guard lane entry. Loaded into every child session as a
// pi-subagents required child extension (registered by root.ts), so it
// survives every agent file's `extensions: []` (SEAMS.md "Role by entry
// file"). Applies every-role + lane-only rules; an adapter failure or timeout
// running the shared hook scripts blocks the call here (root allows it
// through instead, per C4 item 1).
//
// An `ops` lane (identity bound by the root with its frozen ops entry) also takes the
// single-flight surface lock at load and holds it for its whole life; while the lock is not held,
// every shell command it runs is refused.

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename as pathBasename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hookScriptsToRun, runHookScripts } from "./hooks.ts";
import { installModelFamily, subagentOverrideBlock } from "./model-family.ts";
import { installRequestCeiling, installRetryBackoff } from "../request-ceiling/index.ts";
import { evaluateBashCommand, isLoopControlPath } from "./rules.ts";
import { hasLanePushGrant } from "./push-grant.ts";
import { parseLaneBinding } from "./ops.ts";
import { acquireOpsLock, type OpsLock } from "./ops-lock.ts";

/** The absolute path pi's edit/write tools resolve `path` to (`@` prefix, `~`, `file://`). */
function toolPath(raw: string, cwd: string): string {
  let p = raw.replace(/[  -​  　]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (p.startsWith("file://")) p = new URL(p).pathname;
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** The path with symlinks resolved, following a dangling link to its target and otherwise
 *  resolving through the deepest existing ancestor. */
function realPath(p: string, depth = 0): string {
  if (depth > 16) return p;
  try {
    return realpathSync(p);
  } catch {
    try {
      if (lstatSync(p).isSymbolicLink()) return realPath(resolve(dirname(p), readlinkSync(p)), depth + 1);
    } catch {
      // Not present: resolve the parent instead.
    }
    const parent = dirname(p);
    if (parent === p) return p;
    return join(realPath(parent, depth + 1), pathBasename(p));
  }
}

export function isLoopControlToolPath(raw: unknown, cwd: string): boolean {
  if (typeof raw !== "string") return false;
  const absolute = toolPath(raw, cwd);
  return isLoopControlPath(absolute) || isLoopControlPath(realPath(absolute));
}

export default function (pi: ExtensionAPI) {
  // Capture once at extension load: later tool calls cannot widen the launch grant.
  const rawBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const pushGranted = hasLanePushGrant(rawBindings);
  const ops = parseLaneBinding(rawBindings).ops;
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
    const decision = evaluateBashCommand(command, "lane", 0, pushGranted, { ops: ops?.entry, cwd: ctx.cwd });
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
      const path = (event.input as Record<string, unknown>).path;
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
