// loop-state (root only). Records `dispatch` and `return` events for each lane the root launches
// into the loop's state log, and re-injects the log's digest after compaction and at session start.
//
// The log path comes from the `loop-continuation:query-launch` event (its report path with
// `report-` replaced by `state-` and `.md` by `.jsonl`). Every append goes through the
// `loop-state` CLI, so validation, seq and locking stay in one place. A failure here warns and
// never blocks a tool call.
//
// It also caps oversized lane returns (S6, return-cap.ts): a `subagent-notify` message over 16 KB is
// replaced at `message_end`, before pi persists it, and the `context` hook caps any that reached the
// session another way (an older session, a delivery path without `message_end`). The `return` event
// is parsed from the async-complete payload, which holds the full text and is never rewritten.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Brief, deriveLogPath, failedRunBlock, parseBrief, parseLaneReturn, returnEvent, runFailed, runIdFromText } from "./core.ts";
import { capNotifyMessage, type CompletionInfo, completionInfo, contentText, NOTIFY_CUSTOM_TYPE, RETURN_CAP_BYTES } from "./return-cap.ts";

export const DIGEST_CUSTOM_TYPE = "loop-state-digest";
const CLI_TIMEOUT_MS = 10_000;
const MAX_COMPLETIONS = 256;
const RECOVERY_STATE = "loop-state-return-recovery";
type LaneBrief = Omit<Brief, "tier"> & { tier?: Brief["tier"]; agent: string };

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(bin: string, args: string[], stdin?: string, cwd?: string): Promise<CliResult> {
  return new Promise((done) => {
    try {
      const child = execFile(
        bin,
        args,
        { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          done({ code, stdout: String(stdout), stderr: error && code === -1 ? error.message : String(stderr) });
        },
      );
      child.stdin?.on("error", () => {
        // The process exited before reading stdin; the exec callback reports it.
      });
      child.stdin?.end(stdin ?? "");
    } catch (error) {
      done({ code: -1, stdout: "", stderr: String(error) });
    }
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

export default function (pi: ExtensionAPI, scheduleRecovery: (job: () => void) => ReturnType<typeof setTimeout> = (job) => setTimeout(job, 60_000)) {
  let sessionId = "";
  let cwd = process.cwd();
  let lastCtx: ExtensionContext | null = null;
  let logPath: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let lastHeartbeatRecordedAt: number | null = null;
  const warned = new Set<string>();
  const briefs = new Map<string, LaneBrief>();
  const started = new Map<string, { deadlineAt?: string }>();
  const dispatched = new Map<string, LaneBrief>();
  const returned = new Set<string>();
  const pendingComplete = new Map<string, Record<string, unknown>>();
  const handled = new Set<string>();
  const resumedFrom = new Map<string, { run: string; failed: boolean; log: string; info: { lane: string } }>();
  const resumeAttempted = new Set<string>();
  const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  // Structured async-complete facts by run id, for the return cap's saved-output path (S6).
  const completions = new Map<string, CompletionInfo>();
  const completionFor = (runId: string) => completions.get(runId);

  function warn(message: string) {
    if (warned.has(message)) return;
    warned.add(message);
    try {
      lastCtx?.ui.notify(`loop-state: ${message}`, "warning");
    } catch {
      // Warning delivery must not trap the session.
    }
  }

  function enqueue(job: () => Promise<void>) {
    chain = chain.then(job).catch((error: unknown) => warn(String(error)));
    return chain;
  }

  // No timer: these hooks observe actual root work, not an idle session or receipt polls.
  // The CLI's locked, persisted throttle is authoritative across root lifetimes.
  function rootActivity() {
    const at = Date.now();
    if (lastHeartbeatRecordedAt !== null && at - lastHeartbeatRecordedAt < 300_000) return;
    const log = resolveLog();
    if (!log) return;
    // Pending attempts are not persisted timestamps. Keep observed activity queued so a
    // suppressed restart append cannot discard a later exact-boundary event.
    enqueue(async () => {
      // Earlier queued activity may have recorded a heartbeat since this event arrived.
      if (lastHeartbeatRecordedAt !== null && at - lastHeartbeatRecordedAt < 300_000) return;
      const result = await append({ ev: "heartbeat", at: new Date(at).toISOString() }, log);
      if (result.code !== 0) {
        lastHeartbeatRecordedAt = null;
        warn(`heartbeat not recorded: ${result.stderr.trim()}`);
      } else {
        // The CLI's locked throttle remains authoritative across root lifetimes.
        lastHeartbeatRecordedAt = null;
        try {
          for (const line of readFileSync(log, "utf8").split("\n").reverse()) {
            try {
              const row = JSON.parse(line);
              if (row.ev !== "heartbeat" || typeof row.at !== "string") continue;
              const recordedAt = Date.parse(row.at);
              if (Number.isFinite(recordedAt)) { lastHeartbeatRecordedAt = recordedAt; break; }
            } catch { /* Torn log lines held no complete heartbeat. */ }
          }
        } catch { /* CLI remains the authority even if this cache read fails. */ }
      }
    });
  }

  pi.on("turn_start", rootActivity);
  pi.on("tool_execution_start", rootActivity);
  pi.on("tool_execution_end", rootActivity);

  // loop-wait retains a durable outbox until this append succeeds. Reply synchronously
  // with a promise, so shutdown can drain it without dropping suppressed terminal wakes.
  pi.events.on("loop-wait:state-event", (raw) => {
    const request = raw as { event: Record<string, unknown>; reply(recorded: Promise<boolean>): void };
    let recorded = false;
    const pending = enqueue(async () => {
      const log = resolveLog();
      if (!log) return;
      const result = await append(request.event, log);
      recorded = result.code === 0;
      if (!recorded) warn(`watch event not recorded: ${result.stderr.trim()}`);
    });
    request.reply(pending.then(() => recorded));
  });

  function cliBin(): string {
    try {
      const local = join(getAgentDir(), "bin", "loop-state");
      if (existsSync(local)) return local;
    } catch {
      // Fall through to PATH.
    }
    return "loop-state";
  }

  function resolveLog(): string | null {
    if (logPath) return logPath;
    let reportPath: unknown;
    pi.events.emit("loop-continuation:query-launch", {
      reply: (reply: { reportPath?: unknown } | null | undefined) => {
        reportPath = reply?.reportPath;
      },
    });
    if (typeof reportPath !== "string" || reportPath === "") return null;
    const derived = deriveLogPath(isAbsolute(reportPath) ? reportPath : resolve(cwd, reportPath));
    if (derived) logPath = derived;
    return derived;
  }

  // The append-only log is the durable identity ledger, including across root restarts.
  // Native start events deliberately redact tasks; never guess identities from that text.
  function restoreIdentities(log: string) {
    try {
      for (const line of readFileSync(log, "utf8").split("\n")) {
        try {
          const row = JSON.parse(line);
          if (typeof row.run !== "string") continue;
          if (row.ev === "return") returned.add(row.run);
          if (row.ev === "dispatch" && typeof row.lane === "string" && typeof row.task === "string" && typeof row.agent === "string") {
            dispatched.set(row.run, { lane: row.lane, task: row.task, agent: row.agent,
              ...(row.tier === "routine" || row.tier === "guarded" ? { tier: row.tier } : {}),
              ...(typeof row.surface === "string" ? { surface: row.surface } : {}),
              ...(Array.isArray(row.tasks) && row.tasks.every((t: unknown) => typeof t === "string") ? { tasks: row.tasks } : {}),
            });
          }
        } catch { /* Torn lines hold no usable identity. */ }
      }
    } catch { /* No log yet. */ }
  }

  function resumeBrief(input: Record<string, unknown>): LaneBrief | null {
    const target = input.id ?? input.runId;
    if (typeof target !== "string" || !target) return null;
    const log = resolveLog();
    if (log) restoreIdentities(log);
    const matches = [...dispatched.entries()].filter(([run]) => run === target || run.startsWith(target));
    const source = dispatched.get(target) ?? (matches.length === 1 ? matches[0][1] : undefined);
    if (!source) return null;
    // A new brief explicitly changes the lane/task; otherwise resume inherits the
    // exact launched identity, not the redacted package task or a lane's latest return.
    const replacement = parseBrief(input.message);
    return replacement ? { ...replacement, agent: source.agent } : { ...source };
  }

  async function append(event: Record<string, unknown>, log: string): Promise<CliResult> {
    return runCli(cliBin(), ["append", log, "--by", "ext"], JSON.stringify(event));
  }

  async function gitHead(): Promise<string> {
    const r = await new Promise<CliResult>((done) => {
      execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 }, (error, stdout, stderr) =>
        done({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : "unknown";
  }

  // pi-subagents 0.76.1 docs/extension-api.md and src/extension/rpc.js:
  // resume uses the persisted child and returns data.details with a NEW async run id.
  async function resumeForBlock(runId: string, lane: string): Promise<{ id: string; asyncDir?: string } | null> {
    const requestId = randomUUID();
    return new Promise((done) => {
      const channel = `subagents:rpc:v1:reply:${requestId}`;
      const timer = setTimeout(() => finish(null), CLI_TIMEOUT_MS);
      let unsubscribe: (() => void) | undefined;
      const finish = (id: { id: string; asyncDir?: string } | null) => {
        clearTimeout(timer);
        unsubscribe?.();
        done(id);
      };
      unsubscribe = pi.events.on(channel, (raw) => {
        const reply = raw as { version?: number; requestId?: string; success?: boolean; data?: { details?: { runId?: unknown; asyncId?: unknown; asyncDir?: unknown } }; error?: { message?: string } };
        if (reply.version !== 1 || reply.requestId !== requestId) return;
        const details = reply.data?.details;
        const id = details?.runId ?? details?.asyncId;
        if (reply.success === true && typeof id === "string" && id && id !== runId) finish({ id, ...(typeof details?.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}) });
        else {
          warn(`resume for run ${runId} refused: ${reply.error?.message ?? "no new async run id"}`);
          finish(null);
        }
      });
      try {
        pi.events.emit("subagents:rpc:v1:request", {
          version: 1, requestId, method: "resume",
          params: { id: runId, message: `Return only the missing fenced lane-return v2 JSON block for lane ${lane}, using the original brief and the work already performed. Do not repeat work, gate, review, commit or push. Preserve the original lane identity and report the original outcome honestly.` },
        });
      } catch (error) {
        warn(`resume for run ${runId}: ${String(error)}`);
        finish(null);
      }
    });
  }

  async function restoreRecovery(runId: string, revived: string, asyncDir: string | undefined, data: Record<string, unknown>, log: string, info: { lane: string }) {
    resumedFrom.set(revived, { run: runId, failed: runFailed(data), log, info });
    restoreIdentities(log);
    const brief = dispatched.get(runId);
    if (brief) await recordDispatch(revived, brief, runId);
    else warn(`recovery for run ${runId} has no recorded dispatch identity`);
    // Restart and exhausted checks are not terminal proof. Only package-owned
    // lifecycle artifacts can authorize a fallback when completion is lost.
    if (!asyncDir) return;
    const poll = (remaining: number) => {
      const timer = scheduleRecovery(() => {
        recoveryTimers.delete(timer);
        enqueue(async () => {
          if (handled.has(revived)) return;
          try {
            const status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
            if (status.runId === revived && status.sessionId === sessionId &&
                ["complete", "failed", "partial", "paused", "stopped", "rejected"].includes(status.state)) {
              handled.add(revived);
              await recordReturn(revived, { success: false }, log, info, true);
              await recordReturn(runId, data, log, info, true);
              return;
            }
          } catch { /* Unknown is pending, never failed. */ }
          if (remaining > 1) poll(remaining - 1);
          else warn(`resume for run ${runId} still lacks terminal proof; recovery remains pending`);
        });
      });
      timer.unref();
      recoveryTimers.add(timer);
    };
    poll(15);
  }

  async function recordReturn(runId: string, data: Record<string, unknown>, log: string, info: { lane: string }, final = false) {
    if (returned.has(runId)) return;
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    const first = results[0];
    const candidates = [first?.summary, first?.output, data.summary];
    const text = candidates.find((c): c is string => typeof c === "string" && c.includes("lane-return")) ?? candidates.find((c): c is string => typeof c === "string") ?? "";
    const block = parseLaneReturn(text);
    if (!block && !final && !resumeAttempted.has(runId)) {
      resumeAttempted.add(runId);
      const pending = { runId, data, log, info, sessionId, phase: "pending" };
      // Persist BEFORE launch: a restart must never issue a second resume.
      pi.appendEntry(RECOVERY_STATE, pending);
      const revived = await resumeForBlock(runId, info.lane);
      if (revived) {
        pi.appendEntry(RECOVERY_STATE, { ...pending, revived: revived.id, asyncDir: revived.asyncDir });
        await restoreRecovery(runId, revived.id, revived.asyncDir, data, log, info);
        return;
      }
    }
    const event = returnEvent(info.lane, runId, runFailed(data) ? failedRunBlock(block) : block);
    let result = await append(event, log);
    if (result.code === 2) {
      // The parsed block did not validate; keep the fact of the return.
      warn(`return for run ${runId} reduced to its status: ${result.stderr.trim()}`);
      result = await append({ ev: "return", lane: info.lane, run: runId, status: event.status }, log);
    }
    if (result.code !== 0) warn(`return for run ${runId} not recorded: ${result.stderr.trim()}`);
    else {
      returned.add(runId);
      if (resumeAttempted.has(runId)) pi.appendEntry(RECOVERY_STATE, { runId, phase: "done" });
    }
  }

  async function recordDispatch(runId: string, brief: LaneBrief, recoveryOf?: string) {
    let recorded = false;
    try {
      const log = resolveLog();
      if (!log) return;
      restoreIdentities(log);
      if (dispatched.has(runId)) {
        recorded = true;
        started.delete(runId);
        const pending = pendingComplete.get(runId);
        if (pending) {
          pendingComplete.delete(runId);
          await handleComplete(runId, pending);
        }
        return;
      }
      const deadline = started.get(runId)?.deadlineAt ?? brief.deadline;
      const event: Record<string, unknown> = {
        ev: "dispatch",
        lane: brief.lane,
        task: brief.task,
        agent: brief.agent,
        run: runId,
        base: await gitHead(),
        tier: brief.tier,
      };
      if (recoveryOf) event.recovery_of = recoveryOf;
      if (brief.surface) event.surface = brief.surface;
      const review = ["reviewer", "reviewer-high", "security-reviewer"].includes(brief.agent);
      const tasks = brief.tasks ?? [...new Set(brief.task.split(","))];
      event.tasks = tasks;
      if (review) {
        // Record the selected launch role now; readers must not guess historical roles from names.
        event.kind = "review";
        delete event.tier;
        const admitted = new Map<string, string>();
        try {
          for (const line of readFileSync(log, "utf8").split("\n")) {
            try {
              const row = JSON.parse(line);
              if (row.ev === "admit" && typeof row.task === "string") {
                if (row.tier === "routine" || row.tier === "guarded") admitted.set(row.task, row.tier);
                else admitted.delete(row.task);
              }
            } catch { /* A torn line holds no usable admit. */ }
          }
        } catch { /* No admit evidence means an unknown review tier, not the brief's tier. */ }
        const tiers = tasks.map((task) => admitted.get(task));
        if (tiers.length && tiers.every((tier) => tier !== undefined)) {
          event.tier = tiers.includes("guarded") ? "guarded" : "routine";
        }
      }
      if (deadline) event.deadline = deadline;
      const result = await append(event, log);
      if (result.code !== 0) {
        warn(`dispatch for run ${runId} not recorded: ${result.stderr.trim()}`);
        return;
      }
      // The CLI accepts an ops dispatch with no surface but names the gap on stderr; show it.
      for (const line of result.stderr.split("\n")) if (line.startsWith("loop-state: warning:")) warn(line.slice("loop-state: ".length));
      recorded = true;
      started.delete(runId);
      dispatched.set(runId, brief);
      const pending = pendingComplete.get(runId);
      if (pending) {
        pendingComplete.delete(runId);
        await handleComplete(runId, pending);
      }
    } finally {
      // An unrecorded dispatch keeps nothing for this run id: no started deadline, no early completion.
      if (!recorded) {
        started.delete(runId);
        pendingComplete.delete(runId);
      }
    }
  }

  async function handleComplete(runId: string, data: Record<string, unknown>) {
    if (handled.has(runId) || returned.has(runId)) return;
    const original = resumedFrom.get(runId);
    if (original) {
      handled.add(runId);
      await recordReturn(runId, data, original.log, dispatched.get(runId) ?? original.info, true);
      await recordReturn(original.run, original.failed ? { ...data, success: false } : data, original.log, original.info, true);
      return;
    }
    const log = resolveLog();
    if (!log) return;
    const info = dispatched.get(runId);
    if (!info) {
      // The completion beat its launch result; the dispatch will flush it.
      pendingComplete.set(runId, data);
      return;
    }
    handled.add(runId);
    await recordReturn(runId, data, log, info);
  }

  async function injectDigest() {
    const log = resolveLog();
    if (!log || !existsSync(log)) return;
    const result = await runCli(cliBin(), ["digest", log]);
    if (result.code !== 0 || !result.stdout.trim()) {
      warn(`digest failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      return;
    }
    pi.sendMessage({ customType: DIGEST_CUSTOM_TYPE, content: result.stdout, display: false }, { triggerTurn: false });
  }

  pi.on("session_start", (_event, ctx) => {
    // pi-subagents tags its events with the session file when there is one, else the session id.
    sessionId = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    lastCtx = ctx;
    logPath = null;
    lastHeartbeatRecordedAt = null;
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    handled.clear();
    briefs.clear();
    started.clear();
    dispatched.clear();
    returned.clear();
    pendingComplete.clear();
    resumedFrom.clear();
    resumeAttempted.clear();
    type Recovery = { runId: string; phase: string; revived?: string; asyncDir?: string; sessionId?: string; data?: Record<string, unknown>; log?: string; info?: { lane: string } };
    const recovery = new Map<string, Recovery>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RECOVERY_STATE) continue;
      const d = entry.data as Recovery;
      if (d && typeof d.runId === "string") {
        const previous = recovery.get(d.runId);
        recovery.set(d.runId, { ...previous, ...d });
      }
    }
    for (const state of recovery.values()) {
      handled.add(state.runId);
      resumeAttempted.add(state.runId);
      if (state.phase === "done") {
        if (state.revived) handled.add(state.revived);
      } else if (state.phase === "pending" && state.revived && state.data && state.log && state.info &&
                 (!state.sessionId || state.sessionId === sessionId)) {
        enqueue(() => restoreRecovery(state.runId, state.revived!, state.asyncDir, state.data!, state.log!, state.info!));
      }
      // A pre-launch record lacking a revived id stays pending: neither a
      // second resume nor a false failure is authorized by incomplete metadata.
    }
    // Let loop-continuation restore its launch state first.
    setImmediate(() => enqueue(async () => {
      const log = resolveLog();
      if (log) restoreIdentities(log);
      await injectDigest();
    }));
  });

  pi.on("session_shutdown", async () => {
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    await chain;
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") rootActivity();
    try {
      const replacement = capNotifyMessage(event.message as { role?: string; customType?: string; content?: unknown }, process.env.LOOP_PI_RUN_DIR, completionFor);
      if (replacement) return { message: replacement as typeof event.message };
    } catch (error) {
      warn(`return cap: ${String(error)}`);
    }
    return undefined;
  });

  pi.on("context", (event) => {
    try {
      let changed = false;
      const messages = event.messages.map((message) => {
        const m = message as { role?: string; customType?: string; content?: unknown };
        if (m.role !== "custom" || m.customType !== NOTIFY_CUSTOM_TYPE) return message;
        if (Buffer.byteLength(contentText(m.content), "utf8") <= RETURN_CAP_BYTES) return message;
        const replacement = capNotifyMessage(m, process.env.LOOP_PI_RUN_DIR, completionFor);
        if (!replacement) return message;
        changed = true;
        return replacement as typeof message;
      });
      if (changed) return { messages };
    } catch (error) {
      warn(`return cap: ${String(error)}`);
    }
    return undefined;
  });

  pi.on("session_compact", (_event, ctx) => {
    lastCtx = ctx;
    enqueue(injectDigest);
  });

  pi.on("tool_call", (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const input = event.input as Record<string, unknown>;
      if (input.action === "resume") {
        const brief = resumeBrief(input);
        if (brief) briefs.set(event.toolCallId, brief);
        return;
      }
      if (input.action !== undefined || typeof input.agent !== "string") return;
      const brief = parseBrief(input.task);
      if (brief) {
        // A guard-bound ops surface is an explicit identifier, never inferred from an agent name.
        const bindings = input.extensionBindings as Record<string, unknown> | undefined;
        const binding = bindings?.["loop-pi.guard/1"] as { surface?: unknown } | undefined;
        const surface = typeof binding?.surface === "string" && binding.surface ? binding.surface : brief.surface;
        briefs.set(event.toolCallId, { ...brief, ...(surface ? { surface } : {}), agent: input.agent });
      }
    } catch (error) {
      warn(String(error));
    }
  });

  pi.on("tool_result", (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const brief = briefs.get(event.toolCallId);
      if (!brief) return;
      briefs.delete(event.toolCallId);
      if (event.isError) return;
      const details = event.details as { runId?: unknown; asyncId?: unknown } | undefined;
      const runId =
        typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : runIdFromText(textOf(event.content));
      if (runId) enqueue(() => recordDispatch(runId, brief));
    } catch (error) {
      warn(String(error));
    }
  });

  pi.events.on("subagent:async-started", (data) => {
    const d = data as { id?: unknown; sessionId?: unknown; deadlineAt?: unknown };
    if (typeof d.id !== "string" || d.sessionId !== sessionId) return;
    // deadlineAt is epoch milliseconds.
    const at = typeof d.deadlineAt === "number" && Number.isFinite(d.deadlineAt) ? new Date(d.deadlineAt) : null;
    started.set(d.id, at && !Number.isNaN(at.getTime()) ? { deadlineAt: at.toISOString().replace(/\.\d{3}Z$/, "Z") } : {});
  });

  pi.events.on("subagent:async-complete", (data) => {
    const d = data as Record<string, unknown>;
    if (typeof d.runId !== "string") return;
    if (typeof d.sessionId === "string" && d.sessionId !== sessionId) return;
    const info = completionInfo(d);
    if (info) {
      completions.delete(info.runId);
      completions.set(info.runId, info);
      if (completions.size > MAX_COMPLETIONS) completions.delete(completions.keys().next().value!);
    }
    const runId = d.runId;
    enqueue(() => handleComplete(runId, d));
  });
}
