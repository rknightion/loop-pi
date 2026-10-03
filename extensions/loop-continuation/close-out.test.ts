// readDigest against a fake loop-state script: binary resolution, log path, and every failure
// mode that must leave the caller on today's behaviour (null).

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readDigest, stateLogPath } from "./close-out.ts";

describe("stateLogPath", () => {
  test("swaps report- for state- and .md for .jsonl in the basename only", () => {
    assert.equal(
      stateLogPath("/r/report-site/codex/report-cf2otel-loop12.md"),
      "/r/report-site/codex/state-cf2otel-loop12.jsonl",
    );
  });
});

describe("readDigest", () => {
  let tmp: string;
  let agentDir: string;
  let reportPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-close-out-"));
    agentDir = join(tmp, "home");
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    mkdirSync(join(tmp, "codex"), { recursive: true });
    reportPath = join(tmp, "codex", "report-x-loop1.md");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function fakeLoopState(dir: string, body: string) {
    const path = join(dir, "loop-state");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  function touchLog() {
    writeFileSync(join(tmp, "codex", "state-x-loop1.jsonl"), "");
  }

  test("runs <agentDir>/bin/loop-state digest <log> --json and parses the answer", async () => {
    touchLog();
    // Echo the arguments into the output so the test sees the exact invocation.
    fakeLoopState(
      join(agentDir, "bin"),
      `case "$*" in "digest ${join(tmp, "codex", "state-x-loop1.jsonl")} --json") echo '{"live_lanes":0,"open_tasks":[],"admissible":[],"parked":["P-1"]}';; *) echo bad-args >&2; exit 3;; esac`,
    );
    const digest = await readDigest({ agentDir, reportPath });
    assert.deepEqual(digest, { live_lanes: 0, admissible: [] });
  });

  test("falls back to loop-state on PATH when the home has none", async () => {
    touchLog();
    const pathDir = join(tmp, "pathbin");
    mkdirSync(pathDir);
    fakeLoopState(pathDir, `echo '{"live_lanes":2,"admissible":["T-1"]}'`);
    const digest = await readDigest({
      agentDir: join(tmp, "empty-home"),
      reportPath,
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
    });
    assert.deepEqual(digest, { live_lanes: 2, admissible: ["T-1"] });
  });

  test("null when the log is missing, without running the binary", async () => {
    fakeLoopState(join(agentDir, "bin"), `touch ${join(tmp, "ran")}; echo '{"live_lanes":0,"admissible":[]}'`);
    assert.equal(await readDigest({ agentDir, reportPath }), null);
    assert.equal((await import("node:fs")).existsSync(join(tmp, "ran")), false);
  });

  test("null when no loop-state exists anywhere", async () => {
    touchLog();
    const digest = await readDigest({ agentDir: join(tmp, "empty-home"), reportPath, env: { PATH: tmp } });
    assert.equal(digest, null);
  });

  test("null on a non-zero exit, on bad output and on a wrong shape", async () => {
    touchLog();
    for (const body of [
      `echo '{"live_lanes":0,"admissible":[]}'; exit 1`,
      `echo 'not json'`,
      `echo '{"live_lanes":"0","admissible":[]}'`,
      `echo '{"live_lanes":0}'`,
    ]) {
      fakeLoopState(join(agentDir, "bin"), body);
      assert.equal(await readDigest({ agentDir, reportPath }), null, body);
    }
  });

  test("null when the binary outlives its timeout", async () => {
    touchLog();
    fakeLoopState(join(agentDir, "bin"), `sleep 5; echo '{"live_lanes":0,"admissible":[]}'`);
    const started = Date.now();
    assert.equal(await readDigest({ agentDir, reportPath, timeoutMs: 300 }), null);
    assert.ok(Date.now() - started < 4000);
  });
});
