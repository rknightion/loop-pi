// RPC test harness for loop-guard/e2e.test.ts. Not itself a test file (no
// .test.ts suffix), so `node --test` does not try to run it directly.
//
// Drives the pinned pi CLI in `--mode rpc` over stdin/stdout JSONL (docs/rpc.md),
// with the scripted `faux` provider (extensions/test-support/faux-extension.ts)
// standing in for a live model, per SEAMS.md's test harness contract. Every
// session is a fresh mkdtemp PI_CODING_AGENT_DIR / PI_SUBAGENTS_TEMP_ROOT,
// offline, version-check and telemetry off. Never touches ~/.pi or
// ~/.loop-pi-personal.
//
// This file intentionally does not import loop-wait/test-helpers.ts (owned by
// a parallel B4 lane and still being written): it is a self-contained copy of
// the same documented pattern, scoped to loop-guard's own e2e proof.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(HERE, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
export const FAUX_EXTENSION = join(HERE, "..", "test-support", "faux-extension.ts");
export const ROOT_EXTENSION = join(HERE, "root.ts");
export const LANE_EXTENSION = join(HERE, "lane.ts");
// This checkout's own pi-subagents package, wherever the checkout lives
// for settings.json's `packages` field.
export const PI_SUBAGENTS_PACKAGE_DIR = join(HERE, "..", "..", "node_modules", "pi-subagents");

export interface FauxRule {
  match: string;
  once?: boolean;
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: "stop" | "toolUse" | "error" | "length";
  errorMessage?: string;
  delayMs?: number;
  hang?: boolean;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

const cleanupDirs: string[] = [];
const liveChildren: Set<ChildProcessWithoutNullStreams> = new Set();

export function freshDir(prefix = "loop-guard-e2e-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

export function writeFauxScript(rules: FauxRule[]): string {
  const dir = freshDir("loop-guard-faux-");
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify({ rules }));
  return path;
}

const detachedFixtures = new Map<string, number>();
// Register before sending a launch: missing startup metadata is uncertainty, not an empty run set.
export function expectDetachedRuns(root: string, count: number): void {
  detachedFixtures.set(root, count);
}

export async function waitForDetachedWriters(root: string, count: number, timeoutMs = 30_000): Promise<void> {
  const { readProcessTerminalCandidate, readProcessTerminal } = await import(new URL("../../node_modules/pi-subagents/src/runs/background/process-terminal.js", import.meta.url).href);
  const { inspectSessionLease } = await import(new URL("../../node_modules/pi-subagents/src/runs/shared/session-lease.js", import.meta.url).href);
  let diagnostic = "startup metadata missing";
  try {
    await waitForCondition(() => {
      try {
        const runsDir = join(root, "async-subagent-runs");
        const runs = readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && ![".active-runs", ".terminal-runs"].includes(entry.name));
        if (runs.length !== count) { diagnostic = `expected ${count} runs, found ${runs.length}`; return; }
        for (const run of runs) {
          const dir = join(runsDir, run.name);
          const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
          const receipt = readProcessTerminalCandidate(dir);
          const proof = readProcessTerminal(dir, { runId: run.name, runnerProcessInstanceId: receipt?.runnerProcessInstanceId });
          const expected = receipt?.expectedWriters;
          const entries = Object.entries(expected ?? {}) as [string, number][];
          const writers = Object.values(receipt?.writers ?? {}).flat() as any[];
          if (status.runId !== run.name || !receipt || receipt.runId !== run.name
            || receipt.runnerProcessInstanceId !== status.processTerminal?.runnerProcessInstanceId
            || !["complete", "completed", "failed", "stopped", "paused"].includes(status.state)
            || !proof || !["pending", "observed"].includes(proof.state)
            || !entries.length
            || entries.some(([index, n]) => receipt.writers[index]?.length !== n)
            || Object.keys(receipt.writers).some((index) => !(index in expected))
            || writers.some((writer) => writer.processTree.state !== "observed")
            || (receipt.revivalLeaseToken && receipt.revivalLeaseReleaseAcknowledged !== true)
            || (receipt.sessionFile && inspectSessionLease(receipt.sessionFile, join(root, "session-leases")).state !== "free")) {
            diagnostic = `${run.name}: terminal writer receipt incomplete`; return;
          }
          // In-process native sessions have expectedWriters=0: their only OS writer is the runner.
          // With a dead root the overall proof may stay pending, so require its validated candidate,
          // terminal status, all external writer closures, free session lease AND runner absence.
          // Numeric PID absence is exit evidence only. Never use status metadata to signal a process.
          if (!Number.isInteger(status.pid) || status.pid <= 1) { diagnostic = `${run.name}: runner identity missing`; return; }
          try { process.kill(status.pid, 0); diagnostic = `${run.name}: runner has not exited`; return; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        return true;
      } catch (error) { diagnostic = String(error); return; }
    }, timeoutMs, 50);
  } catch {
    throw new Error(`retaining fixture directories: detached writer quiescence unknown (${diagnostic})`);
  }
}

export async function cleanupAllAfterExit(timeoutMs = 30_000): Promise<void> {
  await Promise.all([...liveChildren].map((child) => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.off("exit", exited); reject(new Error("fixture child did not exit before cleanup")); }, 10_000);
    const exited = () => { clearTimeout(timer); resolve(); };
    child.once("exit", exited);
    child.kill("SIGKILL");
  })));
  await Promise.all([...detachedFixtures].map(([root, count]) => waitForDetachedWriters(root, count, timeoutMs)));
  detachedFixtures.clear();
  cleanupAll();
}

export function cleanupAll(): void {
  if (detachedFixtures.size || [...liveChildren].some((child) => child.exitCode === null && child.signalCode === null)) {
    throw new Error("retaining fixture directories: writers require asynchronous cleanup");
  }
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
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Execute the installed bundle's actual module body, not its parallel src/ copy.
// esbuild preserves module boundaries as comments; follow only chunks reachable from pi.extensions.
export function bundledModuleUrl(module: string, names: string[]): string {
  const pkg = JSON.parse(readFileSync(join(PI_SUBAGENTS_PACKAGE_DIR, "package.json"), "utf8"));
  const pending = [...pkg.pi.extensions] as string[];
  const seen = new Set<string>();
  const sections: string[] = [];
  while (pending.length) {
    const relative = pending.pop()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    const path = join(PI_SUBAGENTS_PACKAGE_DIR, relative);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*\()"(\.\/[^"\n]+\.js)"/g)) {
      pending.push(join(dirname(relative), match[1]));
    }
    const marker = `// src/${module}.ts\n`;
    let start = text.indexOf(marker);
    while (start >= 0) {
      start += marker.length;
      const end = text.indexOf("\n// src/", start);
      sections.push(text.slice(start, end < 0 ? undefined : end));
      start = text.indexOf(marker, start);
    }
  }
  if (!sections.length) throw new Error(`installed bundle is missing ${module}`);
  return `data:text/javascript;base64,${Buffer.from(sections.join("\n") + `\nexport { ${names.join(", ")} };`).toString("base64")}`;
}

export interface PiRpcSession {
  child: ChildProcessWithoutNullStreams;
  events: RpcEvent[];
  send(command: Record<string, unknown>): void;
  waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs?: number): Promise<RpcEvent>;
  close(): Promise<void>;
  stderr: string[];
}

export interface StartPiOptions {
  extensions: string[];
  fauxScriptPath: string;
  agentDir: string;
  subagentTempRoot: string;
  cwd: string;
  /** Extra CLI args appended after the standard set (e.g. `--exclude-tools subagents_enable`). */
  extraArgs?: string[];
  /** Default: --no-session. Pass [] to let pi create a real session file (needed for children). */
  sessionArgs?: string[];
  /** Extra environment. The `LOOP_PI_RUN_DIR` this test process started with is dropped, so a test
   *  run inside a loop never hands its own run dir to the pi it spawns; a value a test set itself
   *  (in `process.env` or here) is passed through. */
  env?: Record<string, string | undefined>;
}

// The run dir this test process inherited (a test run from inside a live loop), captured at load.
const AMBIENT_RUN_DIR = process.env.LOOP_PI_RUN_DIR;

export function startPiRpc(opts: StartPiOptions): PiRpcSession {
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
    ...(opts.extraArgs ?? []),
  ];
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: hermeticPiEnv({
      PI_CODING_AGENT_DIR: opts.agentDir,
      PI_SUBAGENTS_TEMP_ROOT: opts.subagentTempRoot,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      LOOP_PI_FAUX_SCRIPT: opts.fauxScriptPath,
      LOOP_PI_RUN_DIR: process.env.LOOP_PI_RUN_DIR !== AMBIENT_RUN_DIR ? process.env.LOOP_PI_RUN_DIR : undefined,
      ...opts.env,
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

  function waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs = 20_000): Promise<RpcEvent> {
    const already = events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveWrapped);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`loop-guard e2e: timed out after ${timeoutMs}ms waiting for an event; stderr:\n${stderrLines.join("")}`));
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

  function close(): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        liveChildren.delete(child);
        resolve();
        return;
      }
      child.once("exit", () => { liveChildren.delete(child); resolve(); });
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

  return { child, events, send, waitFor, close, stderr: stderrLines };
}

/** Poll the filesystem until `find` returns a path for which `check` is true, or time out. */
export async function waitForCondition<T>(
  poll: () => T | undefined,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = poll();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`loop-guard e2e: timed out after ${timeoutMs}ms polling for a condition`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}
