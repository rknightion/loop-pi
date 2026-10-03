// loop-state (root only). Records `dispatch` and `return` events for each lane the root launches
// into the loop's state log, and re-injects the log's digest after compaction and at session start.
//
// The log path comes from the `loop-continuation:query-launch` event (its report path with
// `report-` replaced by `state-` and `.md` by `.jsonl`). Every append goes through the
// `loop-state` CLI, so validation, seq and locking stay in one place. A failure here warns and
// never blocks a tool call.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Brief, deriveLogPath, parseBrief, parseLaneReturn, returnEvent, runIdFromText } from "./core.ts";

export const DIGEST_CUSTOM_TYPE = "loop-state-digest";
const CLI_TIMEOUT_MS = 10_000;

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

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let cwd = process.cwd();
  let lastCtx: ExtensionContext | null = null;
  let logPath: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const warned = new Set<string>();
  const briefs = new Map<string, Brief & { agent: string }>();
  const started = new Map<string, { deadlineAt?: string }>();
  const dispatched = new Map<string, { lane: string; task: string }>();
  const pendingComplete = new Map<string, Record<string, unknown>>();

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
  }

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

  async function recordReturn(runId: string, data: Record<string, unknown>, log: string, info: { lane: string }) {
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    const first = results[0];
    const candidates = [first?.summary, first?.output, data.summary];
    const text = candidates.find((c): c is string => typeof c === "string" && c.includes("lane-return")) ?? candidates.find((c): c is string => typeof c === "string") ?? "";
    const event = returnEvent(info.lane, runId, parseLaneReturn(text));
    let result = await append(event, log);
    if (result.code === 2) {
      // The parsed block did not validate; keep the fact of the return.
      warn(`return for run ${runId} reduced to its status: ${result.stderr.trim()}`);
      result = await append({ ev: "return", lane: info.lane, run: runId, status: event.status }, log);
    }
    if (result.code !== 0) warn(`return for run ${runId} not recorded: ${result.stderr.trim()}`);
  }

  async function recordDispatch(runId: string, brief: Brief & { agent: string }) {
    let recorded = false;
    try {
      const log = resolveLog();
      if (!log) return;
      const deadline = started.get(runId)?.deadlineAt ?? brief.deadline;
      const event: Record<string, unknown> = {
        ev: "dispatch",
        lane: brief.lane,
        task: brief.task,
        agent: brief.agent,
        run: runId,
        base: await gitHead(),
      };
      if (deadline) event.deadline = deadline;
      const result = await append(event, log);
      if (result.code !== 0) {
        warn(`dispatch for run ${runId} not recorded: ${result.stderr.trim()}`);
        return;
      }
      recorded = true;
      started.delete(runId);
      dispatched.set(runId, { lane: brief.lane, task: brief.task });
      const pending = pendingComplete.get(runId);
      if (pending) {
        pendingComplete.delete(runId);
        await recordReturn(runId, pending, log, { lane: brief.lane });
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
    const log = resolveLog();
    if (!log) return;
    const info = dispatched.get(runId);
    if (!info) {
      // The completion beat its launch result; the dispatch will flush it.
      pendingComplete.set(runId, data);
      return;
    }
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
    // Let loop-continuation restore its launch state first.
    setImmediate(() => enqueue(injectDigest));
  });

  pi.on("session_compact", (_event, ctx) => {
    lastCtx = ctx;
    enqueue(injectDigest);
  });

  pi.on("tool_call", (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const input = event.input as Record<string, unknown>;
      if (input.action !== undefined || typeof input.agent !== "string") return;
      const brief = parseBrief(input.task);
      if (brief) briefs.set(event.toolCallId, { ...brief, agent: input.agent });
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
    const runId = d.runId;
    enqueue(() => handleComplete(runId, d));
  });
}
