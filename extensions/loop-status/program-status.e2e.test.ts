// Real-CLI test: the pinned pi in interactive mode on a pseudo-terminal, with the faux provider,
// loop-wait's root extension, the real loop-status extension and the test-support lane companion.
// pi reports OSC 7501 itself (PI_PROGRAM_STATUS=1 skips the support query); this reads every report
// the terminal would see and proves a waiting loop root never reports `done` (program-status.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { cleanupAll, CLI_PATH, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";

const DRIVER = join(import.meta.dirname, "..", "test-support", "pty-session.py");
const STATUS_EXTENSION = join(import.meta.dirname, "index.ts");
const COMPANION = join(import.meta.dirname, "test-support-lanes.ts");

after(cleanupAll);

type Report = Record<string, string>;

/** Every OSC 7501 report in a captured terminal stream, with `msg` and `title` decoded. */
function reports(stream: string): Report[] {
  const out: Report[] = [];
  for (const match of stream.matchAll(/\x1b\]7501;([^\x1b\x07]*)/g)) {
    const report: Report = {};
    for (const pair of match[1].split(":")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const [key, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
      report[key] = key === "msg" || key === "title" ? Buffer.from(value, "base64").toString("utf8") : value;
    }
    out.push(report);
  }
  return out;
}

test("an interactive loop root reports working while a lane runs and asks for the owner once nothing is pending", () => {
  const agentDir = freshDir("loop-status-pty-");
  const out = join(agentDir, "terminal.out");
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const b64 = (s: string): string => esc(Buffer.from(s).toString("base64"));
  const steps = [
    { wait: "\x1b\\]7501;state=idle", send: "launch /tmp/none/codex/closeout-demo-loop1.md\r" },
    { wait: null, send: "lane-start run-a\r" },
    { wait: null, send: "hello\r" },
    // The settled run's resting report, whatever it is: pi's own would be `done`.
    { wait: `\x1b\\]7501;state=(?:done|working:app=pi:msg=${b64("Loop waiting on 1 lane").slice(0, 16)})`, send: "lane-done run-a\r" },
    // pi-subagents wakes the root with the lane's return about a second later; a turn stands in for it.
    { wait: "\x1b\\]7501;id=run-a:state=clear", send: null },
    { wait: null, send: "hello\r", timeout: 2 },
    { wait: "\x1b\\]7501;state=blocked", send: null, timeout: 10 },
  ];
  const result = spawnSync("python3", [DRIVER, JSON.stringify({
    argv: [process.execPath, CLI_PATH, "--no-session", "--provider", "faux", "--model", "faux-1",
      ...[FAUX_EXTENSION, ROOT_EXTENSION, STATUS_EXTENSION, COMPANION].flatMap((path) => ["--extension", path])],
    steps,
    out,
  })], {
    cwd: agentDir,
    timeout: 120_000,
    env: hermeticPiEnv({
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENTS_TEMP_ROOT: freshDir("loop-status-pty-subagents-"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_PROGRAM_STATUS: "1",
      LOOP_PI_FAUX_SCRIPT: writeFauxScript([{ match: ".*", text: "ok" }]),
    }),
  });
  const stream = readFileSync(out, "utf8");
  const seen = reports(stream);
  const root = seen.filter((r) => r.id === undefined);
  assert.equal(root.some((r) => r.state === "done"), false, `pi's resting done never reaches the terminal: ${JSON.stringify(seen)}`);
  assert.equal(result.status, 0, `a step timed out; reports so far: ${JSON.stringify(seen)}\n${result.stderr}`);

  // Between the lane's end and the wake the root stays working: only the settled turn asks for the owner.
  assert.deepEqual(root.map((r) => r.state), ["idle", "working", "working", "working", "blocked"]);
  assert.match(root[2].msg, /^Loop waiting on 1 lane/);
  assert.deepEqual([root[4].kind, root[4].msg], ["question", "Loop stopped: waiting for the owner"]);
  assert.deepEqual(seen.filter((r) => r.id === "run-a").map((r) => [r.state, r.title]), [["working", "worker"], ["clear", undefined]]);
});
