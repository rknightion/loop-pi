// Transcript sync trigger, aligned with the Claude/Codex hook model
// (a transcript-checkpoint hook script): throttled checkpoints at most once per interval
// after the last *successful* upload, unthrottled lifecycle uploads, one upload at a time per home.
// Throttle state lives in the home so every pi process on that home shares it.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const STATE_NAME = ".transcript-checkpoint-state.json";
/** Upload bounds, enforced inside the upload's own process tree so they outlive the pi process. */
export const CHECKPOINT_TIMEOUT_S = 90;
/** The same bound transcript-checkpoint.py gives a lifecycle upload. */
export const LIFECYCLE_TIMEOUT_S = 180;
/** How long a lifecycle upload waits for the home's lock: longer than any checkpoint can hold it. */
export const LIFECYCLE_LOCK_WAIT_S = 120;

// Runs argv[2:] and, past argv[1] seconds, kills its whole process group: lockf too, which
// releases the home's lock. The spawn is detached, so that group is this upload alone.
export const BOUNDED = "import os,signal,subprocess,sys\n" +
  "p=subprocess.Popen(sys.argv[2:])\n" +
  "try:sys.exit(p.wait(timeout=float(sys.argv[1])))\n" +
  "except subprocess.TimeoutExpired:os.killpg(0,signal.SIGKILL)";

export interface SyncChild {
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface SyncDeps {
  agentDir: string;
  now?: () => number;
  spawn?: (command: string, args: string[]) => SyncChild;
  lockf?: string | null;
  python?: string;
  lockDir?: string;
}

function defaultSpawn(command: string, args: string[]): SyncChild {
  return nodeSpawn(command, args, { detached: true, stdio: "ignore" });
}

/** Last successful upload in ms, from the shared state file; 0 when absent or unreadable. */
export function readLastSuccessMs(agentDir: string): number {
  try {
    const data = JSON.parse(readFileSync(join(agentDir, STATE_NAME), "utf8"));
    const ns = data?.last_success_ns;
    return typeof ns === "number" && Number.isFinite(ns) ? Math.floor(ns / 1e6) : 0;
  } catch {
    return 0;
  }
}

/** Record a successful upload that started at `ms`; the stamp only ever moves forward. */
function writeLastSuccess(agentDir: string, ms: number): void {
  if (ms <= readLastSuccessMs(agentDir)) return;
  const path = join(agentDir, STATE_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `{"version": 1, "last_success_ns": ${BigInt(ms) * 1_000_000n}}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function createTranscriptSync(deps: SyncDeps) {
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? defaultSpawn;
  const lockf = deps.lockf === undefined ? (existsSync("/usr/bin/lockf") ? "/usr/bin/lockf" : null) : deps.lockf;
  const python = deps.python ?? (existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3");
  // Same lock file transcript-checkpoint.py takes for a Claude/Codex home of the same name.
  const lockPath = join(deps.lockDir ?? tmpdir(), `.agent-transcript-sync-${basename(deps.agentDir).replace(/^\.+/, "")}.flock`);
  let inFlight = 0;

  /**
   * Start an upload. `lifecycle` uploads (end of turn, shutdown) bypass the throttle and wait for
   * the home's lock; checkpoints skip when throttled, already running, or the lock is held.
   * Both stamp the shared throttle on success. Without /usr/bin/lockf (pi homes are Mac-only)
   * uploads are not serialised across processes.
   * Returns whether an upload process was started. Failures are ignored (SEAMS.md).
   */
  function trigger(lifecycle: boolean): boolean {
    try {
      const script = join(deps.agentDir, "scripts", "sync-transcripts.py");
      if (!existsSync(script)) return false;
      if (!lifecycle && (inFlight > 0 || now() - readLastSuccessMs(deps.agentDir) < SYNC_INTERVAL_MS)) return false;
      const timeout = String(lifecycle ? LIFECYCLE_TIMEOUT_S : CHECKPOINT_TIMEOUT_S);
      const sync = [python, "-c", BOUNDED, timeout, python, script, "--home", deps.agentDir];
      const [command, ...args] = lockf
        ? [lockf, "-k", "-s", "-t", String(lifecycle ? LIFECYCLE_LOCK_WAIT_S : 0), lockPath, ...sync]
        : sync;
      const startedAt = now();
      const child = spawn(command, args);
      inFlight += 1;
      let settled = false;
      const settle = (success: boolean) => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        if (success) {
          try {
            writeLastSuccess(deps.agentDir, startedAt);
          } catch {
            // A missing stamp only means the next checkpoint uploads again.
          }
        }
      };
      // Without an error listener an async spawn failure crashes the session.
      child.on("error", () => settle(false));
      child.on("exit", (code) => settle(code === 0));
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  return { trigger };
}
