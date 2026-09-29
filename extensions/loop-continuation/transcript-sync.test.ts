// Contract of the transcript sync trigger: checkpoints throttle on the last *successful*
// upload, shared through the home; lifecycle uploads always run and wait for the home's lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOUNDED, SYNC_INTERVAL_MS, createTranscriptSync, readLastSuccessMs } from "./transcript-sync.ts";

class FakeChild extends EventEmitter {
  kill() {}
  unref() {}
  finish(code: number) {
    this.emit("exit", code);
  }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "loop-pi-sync-"));
  mkdirSync(join(home, "scripts"));
  writeFileSync(join(home, "scripts", "sync-transcripts.py"), "");
  let clock = 10 * SYNC_INTERVAL_MS;
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const make = () =>
    createTranscriptSync({
      agentDir: home,
      now: () => clock,
      lockf: "/usr/bin/lockf",
      python: "/usr/bin/python3",
      lockDir: home,
      spawn: (command, args) => {
        const child = new FakeChild();
        calls.push({ command, args, child });
        return child;
      },
    });
  return {
    home,
    calls,
    make,
    advance: (ms: number) => (clock += ms),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("a checkpoint is throttled only after a successful upload, and the throttle is shared per home", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const sync = f.make();

  assert.equal(sync.trigger(false), true);
  f.calls[0].child.finish(1);
  assert.equal(readLastSuccessMs(f.home), 0, "a failed upload leaves no stamp");
  assert.equal(sync.trigger(false), true, "a failure does not throttle the next checkpoint");
  f.calls[1].child.finish(0);

  assert.equal(sync.trigger(false), false);
  assert.equal(f.make().trigger(false), false, "another process on the same home sees the stamp");
  f.advance(SYNC_INTERVAL_MS);
  assert.equal(sync.trigger(false), true);
});

test("a checkpoint never overlaps a running upload; a lifecycle upload waits for the lock instead", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const sync = f.make();

  assert.equal(sync.trigger(false), true);
  assert.equal(sync.trigger(false), false);
  assert.deepEqual(f.calls[0].args.slice(1, 4), ["-s", "-t", "0"]);

  assert.equal(sync.trigger(true), true);
  assert.equal(f.calls[1].args[3], "120");
  f.calls[1].child.finish(0);
  assert.equal(sync.trigger(true), true, "lifecycle uploads ignore the throttle");
});

test("a hung upload is killed from inside its own process tree and releases the home's lock", {
  skip: !existsSync("/usr/bin/lockf") && "needs macOS lockf",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-pi-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, "home.flock");
  const started = Date.now();
  // Detached as in production: the bound kills its own process group, never the test runner's.
  const hung = spawn("/usr/bin/lockf", ["-k", "-s", "-t", "0", lock, "/usr/bin/python3", "-c", BOUNDED, "1", "/bin/sleep", "30"], {
    detached: true,
    stdio: "ignore",
  });
  const [code, signal] = (await once(hung, "exit")) as [number | null, string | null];
  assert.ok(Date.now() - started < 10_000, "the bound fired well before the sleep ended");
  assert.ok(code !== 0 || signal !== null);
  const next = spawnSync("/usr/bin/lockf", ["-k", "-s", "-t", "0", lock, "/usr/bin/true"]);
  assert.equal(next.status, 0, "the lock is free again");
});
