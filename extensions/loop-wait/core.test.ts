// Unit tests for loop-wait/core.ts: pure logic and real (but tiny, local) child processes.
// No pi, no models, no network. Every temp dir is under os.tmpdir() and cleaned up; every spawned
// process is killed or allowed to exit before the test ends.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, test } from "node:test";

import {
  computeDelayMs,
  DeliveryQueue,
  firstHeartbeatDelayMs,
  isOverdue,
  isProcessAlive,
  isReceiptStale,
  logPathFor,
  makeTailBuffer,
  processStartIdentity,
  type Receipt,
  readReceipt,
  receiptPathFor,
  runDirFor,
  runWatchProcess,
  TimerManager,
  WatchManager,
  writeReceiptAtomic,
} from "./core.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-wait-core-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("timer arithmetic", () => {
  test("computeDelayMs clamps to zero for a past timestamp", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    assert.equal(computeDelayMs(past, Date.now()), 0);
  });

  test("computeDelayMs returns the exact future gap", () => {
    const now = Date.now();
    const at = new Date(now + 5_000).toISOString();
    assert.equal(computeDelayMs(at, now), 5_000);
  });

  test("isOverdue is true only for timestamps at or before now", () => {
    const now = Date.now();
    assert.equal(isOverdue(new Date(now - 1).toISOString(), now), true);
    assert.equal(isOverdue(new Date(now).toISOString(), now), true);
    assert.equal(isOverdue(new Date(now + 1).toISOString(), now), false);
  });

  test("computeDelayMs throws on an unparseable timestamp", () => {
    assert.throws(() => computeDelayMs("not-a-date", Date.now()));
  });
});

describe("receipt staleness", () => {
  function receipt(overrides: Partial<Receipt>): Receipt {
    return {
      phase: "running",
      observations: 1,
      last_observed_at: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      result: null,
      pid: 123,
      command: "sleep 1",
      interval_s: 5,
      ...overrides,
    };
  }

  test("a fresh running receipt is not stale", () => {
    assert.equal(isReceiptStale(receipt({}), Date.now()), false);
  });

  test("a running receipt older than 2x interval_s is stale", () => {
    const r = receipt({ last_observed_at: new Date(Date.now() - 11_000).toISOString(), interval_s: 5 });
    assert.equal(isReceiptStale(r, Date.now()), true);
  });

  test("a running receipt just under 2x interval_s is not stale", () => {
    const r = receipt({ last_observed_at: new Date(Date.now() - 9_000).toISOString(), interval_s: 5 });
    assert.equal(isReceiptStale(r, Date.now()), false);
  });

  test("a done receipt is never stale regardless of age", () => {
    const r = receipt({ phase: "done", last_observed_at: new Date(Date.now() - 999_999).toISOString() });
    assert.equal(isReceiptStale(r, Date.now()), false);
  });

  test("an unparseable last_observed_at is treated as stale", () => {
    const r = receipt({ last_observed_at: "garbage" });
    assert.equal(isReceiptStale(r, Date.now()), true);
  });
});

describe("liveness witness", () => {
  test("first heartbeat is within 2 minutes even for a much larger interval", () => {
    assert.equal(firstHeartbeatDelayMs(10 * 60_000), 120_000);
  });

  test("first heartbeat matches the interval when it is already under 2 minutes", () => {
    assert.equal(firstHeartbeatDelayMs(5_000), 5_000);
  });
});

describe("tail buffer", () => {
  test("keeps only the last N lines across multiple chunks", () => {
    const tail = makeTailBuffer(3);
    tail.push("a\nb\nc\n");
    tail.push("d\ne\n");
    assert.deepEqual(tail.lines(), ["c", "d", "e"]);
  });

  test("includes a trailing partial line without a newline", () => {
    const tail = makeTailBuffer(5);
    tail.push("one\ntwo\nthree");
    assert.deepEqual(tail.lines(), ["one", "two", "three"]);
  });
});

describe("process liveness", () => {
  test("the current process is alive", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  test("a pid that cannot exist is not alive", () => {
    // PIDs above 4194304 (Linux pid_max ceiling) are never valid; this is also far above
    // any real macOS pid. A false positive here would make the orphan-detection tests moot.
    assert.equal(isProcessAlive(9_999_999), false);
  });
});

describe("receipt IO", () => {
  test("writeReceiptAtomic writes via temp file + rename and readReceipt reads it back", () => {
    const dir = freshDir();
    const path = join(dir, "sub", "watch.json");
    const receipt: Receipt = {
      phase: "running",
      observations: 2,
      last_observed_at: new Date().toISOString(),
      deadline: new Date(Date.now() + 1000).toISOString(),
      result: null,
      pid: 1,
      command: "true",
      interval_s: 1,
    };
    writeReceiptAtomic(path, receipt);
    assert.deepEqual(readReceipt(path), receipt);
  });

  test("readReceipt returns undefined for a missing file", () => {
    const dir = freshDir();
    assert.equal(readReceipt(join(dir, "missing.json")), undefined);
  });
});

describe("runWatchProcess", () => {
  test("returns the exit code and tail when the process exits before its deadline", async () => {
    const result = await runWatchProcess({ command: "printf 'one\\ntwo\\n'; exit 0", deadlineS: 10, tailLines: 10 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.deadlineHit, false);
    assert.deepEqual(result.tail, ["one", "two"]);
  });

  test("kills the process and reports deadline_hit when it outlives the deadline", async () => {
    const result = await runWatchProcess({ command: "sleep 30", deadlineS: 1, tailLines: 10 });
    assert.equal(result.deadlineHit, true);
    assert.notEqual(result.exitCode, 0);
  });

  test("kills the process on abort", async () => {
    const controller = new AbortController();
    const promise = runWatchProcess({ command: "sleep 30", deadlineS: 30, tailLines: 10, signal: controller.signal });
    await delay(200);
    controller.abort();
    const result = await promise;
    assert.equal(result.deadlineHit, false);
    assert.notEqual(result.exitCode, 0);
  });
});

describe("WatchManager", () => {
  test("heartbeats the receipt and finalizes on exit", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({
      runDir: dir,
      onFinal: (_id, receipt) => finals.push(receipt),
      onPersist: () => {},
    });
    const id = manager.start({ command: "printf 'hi\\n'; sleep 0.3; exit 0", deadlineS: 10, intervalS: 1, label: "t" });
    await delay(600);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].phase, "done");
    assert.equal(finals[0].result?.exit_code, 0);
    const receipt = readReceipt(receiptPathFor(dir, id));
    assert.equal(receipt?.phase, "done");
  });

  test("finalizes as failed with deadline_hit when the deadline passes", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    manager.start({ command: "sleep 30", deadlineS: 1, intervalS: 1, label: "deadline-test" });
    await delay(1500);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].result?.deadline_hit, true);
  });

  test("watch_stop kills the process and finalizes the receipt", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const id = manager.start({ command: "sleep 30", deadlineS: 30, intervalS: 5, label: "stop-test" });
    await delay(100);
    assert.equal(manager.stop(id), true);
    await delay(200);
    assert.equal(finals.length, 1);
  });

  test("reconcileOne reports a dead pid as orphaned", () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const outcome = manager.reconcileOne({
      id: "orphan-1",
      label: "orphan",
      pid: 9_999_999,
      phase: "running",
      command: "sleep 999",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      interval_s: 5,
    });
    assert.equal(outcome, "orphaned");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].phase, "failed");
    assert.match(finals[0].note ?? "", /orphan/);
  });

  test("reconcileOne adopts a live pid and keeps polling it", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    // A real, separately spawned dummy process stands in for "still alive after restart": never
    // the test runner's own pid, so shutdownAll's kill can never signal this test process.
    const dummy = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    dummy.unref();
    assert.ok(dummy.pid);
    const outcome = manager.reconcileOne({
      id: "adopt-1",
      label: "adopted",
      pid: dummy.pid as number,
      start_identity: processStartIdentity(dummy.pid as number),
      phase: "running",
      command: "sleep 30",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      interval_s: 5,
    });
    assert.equal(outcome, "adopted");
    assert.equal(manager.list().find((w) => w.id === "adopt-1")?.phase, "running");
    manager.shutdownAll("test cleanup");
    await delay(200);
    assert.equal(isProcessAlive(dummy.pid as number), false);
  });
});

describe("reconcile verifies process identity, not pid alone", () => {
  // After a restart the recorded pid may belong to an unrelated process that reused it. Only a
  // live pid whose start identity matches the one recorded at spawn is ours to adopt or signal.
  async function reconcileForeign(startIdentity: string | undefined) {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    stranger.unref();
    assert.ok(stranger.pid);
    try {
      const snapshot = {
        id: "reused-pid",
        label: "reused",
        pid: stranger.pid as number,
        pgid: stranger.pid as number,
        phase: "running" as const,
        command: "sleep 30",
        deadline: new Date(Date.now() + 1_000).toISOString(),
        interval_s: 1,
        ...(startIdentity === undefined ? {} : { start_identity: startIdentity }),
      };
      const outcome = manager.reconcileOne(snapshot);
      assert.equal(outcome, "orphaned");
      assert.equal(manager.list().length, 0, "a process that is not provably ours must not be adopted");
      assert.equal(finals.length, 1);
      assert.equal(finals[0].phase, "failed");
      assert.match(finals[0].note ?? "", /not ours/);
      manager.shutdownAll("cleanup");
      await delay(1500); // past the snapshot's deadline: nothing may have been armed to kill it
      assert.equal(isProcessAlive(stranger.pid as number), true, "a pid that is not ours must never be signalled");
    } finally {
      if (isProcessAlive(stranger.pid as number)) process.kill(stranger.pid as number, "SIGKILL");
    }
  }

  test("a live pid with a different start identity is neither adopted nor killed", async () => {
    await reconcileForeign("Thu Jan  1 00:00:00 1970");
  });

  test("a live pid with no recorded start identity is neither adopted nor killed", async () => {
    await reconcileForeign(undefined);
  });

  test("start records the watcher's start identity in its snapshot", async () => {
    const dir = freshDir();
    const manager = new WatchManager({ runDir: dir, onFinal: () => {}, onPersist: () => {} });
    const id = manager.start({ command: "sleep 30", deadlineS: 30, intervalS: 5, label: "identity" });
    try {
      const snap = manager.list().find((w) => w.id === id) as { start_identity?: string | null } | undefined;
      assert.ok(snap?.start_identity, "the start identity must be recorded at spawn");
    } finally {
      manager.stop(id);
      await delay(200);
    }
  });
});

describe("process group termination (compound commands)", () => {
  // spawnWatched runs every command through `sh -c`; a compound command like `sleep 30 &
  // echo $! > <file>; wait` backgrounds a real grandchild of that shell before the deadline,
  // abort or watch_stop kill fires, proving the fix reaches descendants and not just the shell.
  function backgroundGrandchildCommand(pidFile: string, sleepSeconds = 30): string {
    return `sleep ${sleepSeconds} & echo $! > '${pidFile}'; wait`;
  }

  // A grandchild that ignores SIGTERM outright (ignoring it rather than merely surviving the
  // first signal), while the leader (blocked in `wait`, no trap of its own) dies from the very
  // same group-wide SIGTERM almost immediately. Proves the SIGKILL escalation checks the whole
  // group's liveness, not just whether our own leader/settled bookkeeping already fired.
  function stubbornGrandchildCommand(pidFile: string, sleepSeconds = 30): string {
    return `(trap '' TERM; sleep ${sleepSeconds}) & echo $! > '${pidFile}'; wait`;
  }

  async function readGrandchildPid(pidFile: string): Promise<number> {
    for (let i = 0; i < 50; i++) {
      if (existsSync(pidFile)) {
        const text = readFileSync(pidFile, "utf8").trim();
        if (text) return Number(text);
      }
      await delay(50);
    }
    throw new Error(`grandchild pid file never appeared: ${pidFile}`);
  }

  // Pipe closure and the leader's close event can precede the OS finishing the grandchild's
  // exit/reap. Wait for that observable condition, not a fixed sleep. The one-second bound is
  // shorter than the three-second SIGKILL escalation: a missed SIGTERM still fails the test.
  async function waitForGrandchildExit(pid: number): Promise<void> {
    const until = Date.now() + 1000;
    while (isProcessAlive(pid) && Date.now() < until) await delay(10);
  }

  test("runWatchProcess kills the whole process group on deadline, not just the sh -c pid", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "grandchild.pid");
    const resultPromise = runWatchProcess({ command: backgroundGrandchildCommand(pidFile), deadlineS: 1, tailLines: 5 });
    const grandchildPid = await readGrandchildPid(pidFile);
    assert.equal(isProcessAlive(grandchildPid), true);
    const result = await resultPromise;
    assert.equal(result.deadlineHit, true);
    await waitForGrandchildExit(grandchildPid);
    assert.equal(isProcessAlive(grandchildPid), false, "the grandchild must be dead, not orphaned");
  });

  test("runWatchProcess kills the whole process group on abort, not just the sh -c pid", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "grandchild.pid");
    const controller = new AbortController();
    const resultPromise = runWatchProcess({
      command: backgroundGrandchildCommand(pidFile),
      deadlineS: 30,
      tailLines: 5,
      signal: controller.signal,
    });
    const grandchildPid = await readGrandchildPid(pidFile);
    controller.abort();
    await resultPromise;
    await waitForGrandchildExit(grandchildPid);
    assert.equal(isProcessAlive(grandchildPid), false, "the grandchild must be dead, not orphaned");
  });

  test("WatchManager kills the whole process group when the deadline is exceeded", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "grandchild.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    manager.start({ command: backgroundGrandchildCommand(pidFile), deadlineS: 1, intervalS: 1, label: "group-deadline" });
    const grandchildPid = await readGrandchildPid(pidFile);
    await delay(1500);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].result?.deadline_hit, true);
    assert.equal(isProcessAlive(grandchildPid), false, "the grandchild must be dead, not orphaned");
  });

  test("WatchManager.stop kills the whole process group, not just the sh -c pid", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "grandchild.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const id = manager.start({ command: backgroundGrandchildCommand(pidFile), deadlineS: 30, intervalS: 5, label: "group-stop" });
    const grandchildPid = await readGrandchildPid(pidFile);
    assert.equal(manager.stop(id), true);
    await delay(300);
    assert.equal(finals.length, 1);
    assert.equal(isProcessAlive(grandchildPid), false, "the grandchild must be dead, not orphaned");
  });

  test("reconcileOne without a recorded pgid falls back to pid-only termination", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "legacy-grandchild.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    // Stands in for a watcher persisted by a pre-fix version of this code: a real detached group
    // leader with its own backgrounded child, but the snapshot below carries no pgid field.
    const dummy = spawn("sh", ["-c", backgroundGrandchildCommand(pidFile)], { detached: true, stdio: "ignore" });
    dummy.unref();
    assert.ok(dummy.pid);
    const grandchildPid = await readGrandchildPid(pidFile);
    const outcome = manager.reconcileOne({
      id: "legacy-1",
      label: "legacy",
      pid: dummy.pid as number,
      start_identity: processStartIdentity(dummy.pid as number),
      phase: "running",
      command: "sleep 30",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      interval_s: 5,
      // no pgid: this is the point of the test.
    });
    assert.equal(outcome, "adopted");
    manager.shutdownAll("pid-only test");
    await delay(300);
    try {
      assert.equal(isProcessAlive(dummy.pid as number), false, "the leader itself is still killed");
      assert.equal(isProcessAlive(grandchildPid), true, "without a recorded pgid we must not signal the whole group");
    } finally {
      // No process may leak past this test even though the assertion above expects it alive.
      if (isProcessAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    }
  });

  test("reconcileOne with a recorded pgid kills the whole group, including the grandchild", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "adopted-grandchild.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const dummy = spawn("sh", ["-c", backgroundGrandchildCommand(pidFile)], { detached: true, stdio: "ignore" });
    dummy.unref();
    assert.ok(dummy.pid);
    const grandchildPid = await readGrandchildPid(pidFile);
    const outcome = manager.reconcileOne({
      id: "adopted-pgid-1",
      label: "adopted-with-pgid",
      pid: dummy.pid as number,
      start_identity: processStartIdentity(dummy.pid as number),
      pgid: dummy.pid as number,
      phase: "running",
      command: "sleep 30",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      interval_s: 5,
    });
    assert.equal(outcome, "adopted");
    manager.shutdownAll("group test");
    await delay(300);
    assert.equal(isProcessAlive(dummy.pid as number), false);
    assert.equal(isProcessAlive(grandchildPid), false, "a recorded pgid must kill the whole group, including the grandchild");
  });

  test("runWatchProcess's SIGKILL escalation reaches a grandchild that ignores SIGTERM, even though the leader dies quickly", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "stubborn.pid");
    const started = Date.now();
    let settled = false;
    const resultPromise = runWatchProcess({ command: stubbornGrandchildCommand(pidFile), deadlineS: 1, tailLines: 5 });
    void resultPromise.then(() => {
      settled = true;
    });
    const grandchildPid = await readGrandchildPid(pidFile);
    // Right after the deadline's SIGTERM: the leader (blocked in `wait`) is already dead, but the
    // trap'd grandchild ignored the signal, is still alive and still holds stdout, so the wait
    // (which finalises on stdio close, not leader exit) has not resolved yet.
    await delay(1300 - (Date.now() - started));
    assert.equal(isProcessAlive(grandchildPid), true, "the grandchild ignores SIGTERM and must still be alive here");
    assert.equal(settled, false, "the wait must not resolve while the grandchild still holds stdout");
    const result = await resultPromise;
    assert.equal(result.deadlineHit, true);
    assert.ok(Date.now() - started < 6000, "the escalation, not the grandchild's own 30s, must end the wait");
    assert.equal(isProcessAlive(grandchildPid), false, "the escalation's SIGKILL must still reach it via the group, not the (already-dead) leader");
  });

  test("WatchManager's SIGKILL escalation reaches a grandchild that ignores SIGTERM, even though the leader dies quickly", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "stubborn.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const id = manager.start({ command: stubbornGrandchildCommand(pidFile), deadlineS: 30, intervalS: 5, label: "stubborn" });
    const grandchildPid = await readGrandchildPid(pidFile);
    assert.equal(manager.stop(id), true);
    await delay(300);
    assert.equal(isProcessAlive(grandchildPid), true, "the grandchild ignores SIGTERM and must still be alive here");
    await delay(3200);
    assert.equal(isProcessAlive(grandchildPid), false, "the escalation's SIGKILL must still reach it via the group, not the (already-dead) leader");
    assert.equal(finals.length, 1);
  });
});

describe("finalising on stdio close, not leader exit", () => {
  // The shell leader exits at once; a descendant still holding its stdout writes the last line
  // afterwards. Finalising on the leader's `exit` drops that line from the tail, the receipt and
  // the log; finalising on `close` waits for every holder of stdout/stderr to let go.
  const TRAILING = "(sleep 0.4; echo late; echo late-err >&2) & echo early; exit 0";

  test("runWatchProcess keeps output written after the leader exits", async () => {
    const result = await runWatchProcess({ command: TRAILING, deadlineS: 10, tailLines: 10 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.deadlineHit, false);
    assert.deepEqual([...result.tail].sort(), ["early", "late", "late-err"]);
  });

  test("WatchManager's final receipt and log hold output written after the leader exits", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const id = manager.start({ command: TRAILING, deadlineS: 10, intervalS: 1, label: "trailing" });
    await delay(1000);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].phase, "done");
    assert.equal(finals[0].result?.exit_code, 0);
    assert.deepEqual([...(finals[0].tail ?? [])].sort(), ["early", "late", "late-err"]);
    const log = readFileSync(logPathFor(dir, id), "utf8");
    assert.match(log, /late\n/);
    assert.match(log, /late-err\n/);
  });

  test("runWatchProcess still ends on its deadline when a grandchild holds stdout after the leader exits", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "holder.pid");
    const started = Date.now();
    const result = await runWatchProcess({ command: `sleep 30 & echo $! > '${pidFile}'; exit 0`, deadlineS: 1, tailLines: 5 });
    assert.equal(result.deadlineHit, true);
    assert.ok(Date.now() - started < 5000, "must not wait for the grandchild's own 30s");
    const holder = Number(readFileSync(pidFile, "utf8").trim());
    assert.equal(isProcessAlive(holder), false, "the stdout holder must be killed with the group");
  });

  test("WatchManager still finalises on its deadline when a grandchild holds stdout after the leader exits", async () => {
    const dir = freshDir();
    const pidFile = join(dir, "holder.pid");
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    manager.start({ command: `sleep 30 & echo $! > '${pidFile}'; exit 0`, deadlineS: 1, intervalS: 1, label: "holder" });
    await delay(1600);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].result?.deadline_hit, true);
    await delay(300);
    const holder = Number(readFileSync(pidFile, "utf8").trim());
    assert.equal(isProcessAlive(holder), false, "the stdout holder must be killed with the group");
  });
});

describe("deadline scheduling beyond the setTimeout ceiling", () => {
  test("a fresh watcher's deadline far beyond 2^31-1 ms does not fire immediately", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const id = manager.start({ command: "sleep 30", deadlineS: 40 * 86_400, intervalS: 3600, label: "far-future-deadline" });
    await delay(300);
    assert.equal(finals.length, 0, "must not finalize as deadline-exceeded before the real deadline");
    assert.equal(manager.stop(id), true);
    await delay(300);
  });

  test("an adopted watcher's remaining deadline far beyond 2^31-1 ms does not fire immediately", async () => {
    const dir = freshDir();
    const finals: Receipt[] = [];
    const manager = new WatchManager({ runDir: dir, onFinal: (_id, r) => finals.push(r), onPersist: () => {} });
    const dummy = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    dummy.unref();
    assert.ok(dummy.pid);
    const outcome = manager.reconcileOne({
      id: "adopt-far-1",
      label: "adopted-far",
      pid: dummy.pid as number,
      start_identity: processStartIdentity(dummy.pid as number),
      phase: "running",
      command: "sleep 30",
      deadline: new Date(Date.now() + 40 * 86_400_000).toISOString(),
      interval_s: 3600,
    });
    assert.equal(outcome, "adopted");
    await delay(300);
    assert.equal(finals.length, 0, "must not finalize as deadline-exceeded before the real deadline");
    manager.shutdownAll("cleanup");
    await delay(300);
  });
});

describe("TimerManager", () => {
  test("fires onFire once when the delay elapses", async () => {
    const fired: string[] = [];
    const manager = new TimerManager({ onFire: (id) => fired.push(id), onPersist: () => {} });
    const armed = manager.arm(new Date(Date.now() + 100).toISOString(), "test-timer");
    await delay(300);
    assert.deepEqual(fired, [armed.id]);
    assert.equal(manager.list().length, 0);
  });

  test("a timer beyond setTimeout's 2^31-1 ms ceiling does not fire early", async () => {
    const fired: string[] = [];
    const manager = new TimerManager({ onFire: (id) => fired.push(id), onPersist: () => {} });
    const armed = manager.arm(new Date(Date.now() + 30 * 86_400_000).toISOString(), "far-future");
    await delay(100);
    assert.deepEqual(fired, []);
    assert.deepEqual(manager.cancel(armed.id), { status: "cancelled", id: armed.id });
  });

  test("cancel prevents a later fire", async () => {
    const fired: string[] = [];
    const manager = new TimerManager({ onFire: (id) => fired.push(id), onPersist: () => {} });
    const armed = manager.arm(new Date(Date.now() + 150).toISOString(), "cancel-me");
    assert.deepEqual(manager.cancel(armed.id), { status: "cancelled", id: armed.id });
    await delay(300);
    assert.deepEqual(fired, []);
  });

  test("cancel accepts a unique id prefix of at least 8 characters", () => {
    const manager = new TimerManager({ onFire: () => {}, onPersist: () => {} });
    const armed = manager.arm(new Date(Date.now() + 60_000).toISOString(), "prefix-me");
    const prefix = armed.id.slice(0, 8);
    assert.deepEqual(manager.cancel(prefix), { status: "cancelled", id: armed.id });
    assert.equal(manager.list().length, 0);
  });

  test("cancel reports ambiguous, and cancels nothing, when a prefix matches more than one armed timer", () => {
    const manager = new TimerManager({ onFire: () => {}, onPersist: () => {} });
    manager.arm(new Date(Date.now() + 60_000).toISOString(), "a", "abcdefgh-1111");
    manager.arm(new Date(Date.now() + 60_000).toISOString(), "b", "abcdefgh-2222");
    const result = manager.cancel("abcdefgh");
    assert.equal(result.status, "ambiguous");
    assert.deepEqual(new Set((result as { matches: string[] }).matches), new Set(["abcdefgh-1111", "abcdefgh-2222"]));
    assert.equal(manager.list().length, 2, "an ambiguous prefix must cancel nothing");
  });

  test("cancel reports not_found for an unmatched id, and never partial-matches below the minimum prefix length", () => {
    const manager = new TimerManager({ onFire: () => {}, onPersist: () => {} });
    manager.arm(new Date(Date.now() + 60_000).toISOString(), "solo", "deadbeef-full-id");
    assert.deepEqual(manager.cancel("no-such-id"), { status: "not_found" });
    // "deadbee" is 7 characters, below the minimum prefix length, so it must not partial-match
    // even though it is a real prefix of the armed id.
    assert.deepEqual(manager.cancel("deadbee"), { status: "not_found" });
    assert.equal(manager.list().length, 1);
  });

  test("reconcile re-arms a future timer and fires an overdue one exactly once", async () => {
    const fired: string[] = [];
    const manager = new TimerManager({ onFire: (id) => fired.push(id), onPersist: () => {} });
    const future = { id: "future-1", at: new Date(Date.now() + 200).toISOString(), reason: "future" };
    const overdue = { id: "overdue-1", at: new Date(Date.now() - 5_000).toISOString(), reason: "overdue" };
    const outcome = manager.reconcile([future, overdue]);
    assert.deepEqual(outcome.rearmed, ["future-1"]);
    assert.deepEqual(outcome.firedOverdue, ["overdue-1"]);
    assert.deepEqual(fired, ["overdue-1"]);
    await delay(400);
    assert.deepEqual(fired, ["overdue-1", "future-1"]);
  });

  test("shutdownAll clears handles without firing them", async () => {
    const fired: string[] = [];
    const manager = new TimerManager({ onFire: (id) => fired.push(id), onPersist: () => {} });
    manager.arm(new Date(Date.now() + 100).toISOString(), "should-not-fire");
    manager.shutdownAll();
    await delay(300);
    assert.deepEqual(fired, []);
  });
});

describe("DeliveryQueue", () => {
  test("delivers immediately when idle, triggering a turn", () => {
    const delivered: { message: string; triggerTurn: boolean }[] = [];
    const queue = new DeliveryQueue<string>({
      isIdle: () => true,
      deliver: (m, opts) => delivered.push({ message: m, triggerTurn: opts.triggerTurn }),
    });
    queue.send("a");
    assert.deepEqual(delivered, [{ message: "a", triggerTurn: true }]);
  });

  test("defers delivery while busy and flushes once idle again", () => {
    const delivered: string[] = [];
    let idle = false;
    const queue = new DeliveryQueue<string>({ isIdle: () => idle, deliver: (m) => delivered.push(m) });
    queue.send("busy-message");
    assert.deepEqual(delivered, []);
    assert.equal(queue.length, 1);
    idle = true;
    queue.flush();
    assert.deepEqual(delivered, ["busy-message"]);
  });

  test("flush delivers every pending message in one call, in order, with only the last triggering a turn", () => {
    const delivered: { message: string; triggerTurn: boolean }[] = [];
    let idle = false;
    const queue = new DeliveryQueue<string>({
      isIdle: () => idle,
      deliver: (m, opts) => delivered.push({ message: m, triggerTurn: opts.triggerTurn }),
    });
    queue.send("one");
    queue.send("two");
    queue.send("three");
    // Still busy: nothing delivered yet, all three queued.
    assert.deepEqual(delivered, []);
    assert.equal(queue.length, 3);

    idle = true;
    queue.flush();

    assert.deepEqual(delivered, [
      { message: "one", triggerTurn: false },
      { message: "two", triggerTurn: false },
      { message: "three", triggerTurn: true },
    ]);
    assert.equal(queue.length, 0, "one flush must drain every pending message, not just one");
  });

  test("flush is a no-op while still busy", () => {
    const delivered: string[] = [];
    const queue = new DeliveryQueue<string>({ isIdle: () => false, deliver: (m) => delivered.push(m) });
    queue.send("one");
    queue.send("two");
    queue.flush();
    assert.deepEqual(delivered, []);
    assert.equal(queue.length, 2);
  });

  test("removePending drops a matching queued message before it is ever delivered", () => {
    const delivered: string[] = [];
    let idle = false;
    const queue = new DeliveryQueue<{ id: string }>({ isIdle: () => idle, deliver: (m) => delivered.push(m.id) });
    queue.send({ id: "keep" });
    queue.send({ id: "drop-me" });
    const removed = queue.removePending((m) => m.id === "drop-me");
    assert.deepEqual(removed, [{ id: "drop-me" }]);
    assert.equal(queue.length, 1);

    idle = true;
    queue.flush();
    assert.deepEqual(delivered, ["keep"], "the dropped message must never reach delivery, even after going idle");
  });
});

describe("run dir layout", () => {
  test("runDirFor is scoped by agent dir and session id", () => {
    assert.equal(runDirFor("/home/.agent", "sess-1"), "/home/.agent/loop-wait/sess-1");
  });
});
