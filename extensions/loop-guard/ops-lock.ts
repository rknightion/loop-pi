// Single-flight lock for an ops surface: a kernel flock held by a small stdlib python child for the
// life of the ops lane. The child takes `fcntl.flock(LOCK_EX | LOCK_NB)` on
// `<lock dir>/<surface>.lock`, prints `locked` or `busy`, and exits (dropping the lock) when its
// stdin reaches EOF or its parent pid changes, so a crashed lane never leaves the surface locked.
// Coverage is one machine: lanes on two machines do not see each other's lock.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPS_LOCK_DIR_ENV = "LOOP_PI_OPS_LOCK_DIR";

export function opsLockDir(): string {
  return process.env[OPS_LOCK_DIR_ENV] || join(homedir(), ".local", "state", "loop-pi", "ops-locks");
}

export function opsLockPath(surface: string, dir = opsLockDir()): string {
  return join(dir, `${encodeURIComponent(surface)}.lock`);
}

const HOLDER = [
  "import fcntl,os,select,sys",
  "ppid=os.getppid()",
  "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)",
  "try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)",
  "except OSError:print('busy',flush=True);sys.exit(3)",
  "os.ftruncate(fd,0);os.write(fd,str(ppid).encode())",
  "print('locked',flush=True)",
  "while os.getppid()==ppid:",
  " r=select.select([0],[],[],1.0)[0]",
  " if r and not os.read(0,4096):break",
].join("\n");

export type OpsLockState = "held" | "busy" | "error";

export interface OpsLock {
  state: OpsLockState;
  path: string;
  reason?: string;
  /** True while the holder child is still alive and holding the lock. */
  isHeld(): boolean;
  release(): void;
}

/** Take the surface lock. Resolves once the holder reports; never rejects. */
export function acquireOpsLock(
  surface: string,
  options: { dir?: string; python?: string; timeoutMs?: number } = {},
): Promise<OpsLock> {
  const dir = options.dir ?? opsLockDir();
  const path = opsLockPath(surface, dir);
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const release = () => {
      if (!child) return;
      child.stdin?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      child = undefined;
    };
    const finish = (state: OpsLockState, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (state !== "held") release();
      else {
        // The lock must not keep the lane process alive; the holder exits with it.
        child?.unref();
        (child?.stdout as unknown as { unref?: () => void } | null)?.unref?.();
        (child?.stdin as unknown as { unref?: () => void } | null)?.unref?.();
        (child?.stderr as unknown as { unref?: () => void } | null)?.unref?.();
      }
      const holder = child;
      const isHeld = () =>
        state === "held" && holder !== undefined && child === holder && holder.exitCode === null && holder.signalCode === null;
      resolve({ state, path, reason, isHeld, release });
    };
    const timer = setTimeout(() => finish("error", "the lock holder did not report in time"), options.timeoutMs ?? 10_000);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      child = spawn(options.python ?? "python3", ["-c", HOLDER, path], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      finish("error", err instanceof Error ? err.message : String(err));
      return;
    }
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      if (/^locked$/m.test(out)) finish("held");
      else if (/^busy$/m.test(out)) finish("busy", `another ops lane on this machine holds ${path}`);
    });
    child.stderr?.resume();
    child.on("error", (err) => finish("error", err.message));
    child.on("exit", (code) => finish("error", `the lock holder exited (${code}) before reporting`));
  });
}
