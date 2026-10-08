// Shared RPC test harness for loop-wait/root.test.ts and loop-wait/lane.test.ts. Not itself a
// test file (no .test.ts suffix), so `node --test` does not try to run it directly.
//
// Drives the pinned pi CLI in `--mode rpc` over stdin/stdout JSONL (docs/rpc.md), with the
// scripted `faux` provider (extensions/test-support/faux-extension.ts) standing in for a live
// model. Every session is a fresh mkdtemp PI_CODING_AGENT_DIR / PI_SUBAGENTS_TEMP_ROOT, offline,
// version-check and telemetry off, per SEAMS.md's test harness contract. Never touches ~/.pi.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(HERE, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
export const FAUX_EXTENSION = join(HERE, "..", "test-support", "faux-extension.ts");
export const ROOT_EXTENSION = join(HERE, "root.ts");
export const LANE_EXTENSION = join(HERE, "lane.ts");

export interface FauxRule {
  match: string;
  once?: boolean;
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: "stop" | "toolUse" | "error";
  errorMessage?: string;
  delayMs?: number;
  /** Never answer: the request stays open until it is aborted. */
  hang?: boolean;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

const cleanupDirs: string[] = [];
const liveChildren: Set<ChildProcessWithoutNullStreams> = new Set();

export function freshDir(prefix = "loop-wait-rpc-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

export function writeFauxScript(rules: FauxRule[]): string {
  const dir = freshDir("loop-wait-faux-");
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify({ rules }));
  return path;
}

export function cleanupAll(): void {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export interface PiRpcSession {
  child: ChildProcessWithoutNullStreams;
  events: RpcEvent[];
  send(command: Record<string, unknown>): void;
  waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs?: number): Promise<RpcEvent>;
  waitForResponse(id: string, timeoutMs?: number): Promise<RpcEvent>;
  close(): Promise<void>;
  stderr: string[];
}

export interface StartPiOptions {
  extensions: string[];
  fauxScriptPath: string;
  sessionDir?: string;
  sessionArgs?: string[];
  extraEnv?: Record<string, string>;
  /** Reuse an existing agent dir (e.g. to resume a session across two pi processes). */
  agentDir?: string;
  /** Written to <agentDir>/settings.json before startup, when the dir is freshly created. */
  settings?: Record<string, unknown>;
}

export function startPiRpc(opts: StartPiOptions): PiRpcSession & { agentDir: string } {
  const agentDir = opts.agentDir ?? freshDir("loop-wait-agentdir-");
  if (!opts.agentDir && opts.settings) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settings));
  }
  const subagentTemp = freshDir("loop-wait-subagent-");
  const extensionArgs = opts.extensions.flatMap((path) => ["--extension", path]);
  const args = [
    "--mode",
    "rpc",
    ...(opts.sessionArgs ?? ["--no-session"]),
    "--provider",
    "faux",
    "--model",
    "faux-1",
    ...extensionArgs,
  ];
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.sessionDir ?? agentDir,
    env: hermeticPiEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENTS_TEMP_ROOT: subagentTemp,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      LOOP_PI_FAUX_SCRIPT: opts.fauxScriptPath,
      ...opts.extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);

  const events: RpcEvent[] = [];
  const waiters: { predicate: (e: RpcEvent) => boolean; resolve: (e: RpcEvent) => void }[] = [];
  const stderrLines: string[] = [];

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let record: RpcEvent;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(record);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(record)) {
          const [waiter] = waiters.splice(i, 1);
          waiter.resolve(record);
        }
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk.toString("utf8"));
  });

  function waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs = 15_000): Promise<RpcEvent> {
    const already = events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveWrapped);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`loop-wait test: timed out after ${timeoutMs}ms waiting for an event; stderr:\n${stderrLines.join("")}`));
      }, timeoutMs);
      const resolveWrapped = (e: RpcEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      waiters.push({ predicate, resolve: resolveWrapped });
    });
  }

  function send(command: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  function waitForResponse(id: string, timeoutMs = 15_000): Promise<RpcEvent> {
    return waitFor((e) => e.type === "response" && e.id === id, timeoutMs);
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      liveChildren.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    });
  }

  return { child, events, send, waitFor, waitForResponse, close, stderr: stderrLines, agentDir };
}

export function assistantMessageCount(events: RpcEvent[], fromIndex: number, toIndex: number): number {
  return events
    .slice(fromIndex, toIndex)
    .filter((e) => e.type === "message_start" && (e.message as { role?: string })?.role === "assistant").length;
}
