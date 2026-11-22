// Real-process proof of pi-subagents 0.89.2's unobserved runner exit proof on a nopush lane
// (SEAMS.md "run record" paragraph). Real pinned pi CLI, real pi-subagents, the shipped
// bin/loop-pi-nopush launcher, faux provider.
//
// The reconciling call is the one a second Pi runs: the model-visible `subagent` tool's
// `status` action (run-status.js), which resolves a run by id from the shared async runs root and
// calls reconcileAsyncRun(asyncDir, ...) on it. reconcileAsyncRun calls settleUnobservedRunnerExit
// (stale-run-reconciler.js). Another Pi's own async job tracker only reconciles jobs that Pi launched,
// so a run launched by a root that has since ended is reached only through id-addressed paths like this.
//
//   1. root launches a nopush lane and ends while the lane is still running; the lane finishes with
//      nobody observing its close; a second Pi reads its status: process-terminal-unobserved.json
//      appears (state unknown, reason observer-unavailable), the run's state is unchanged, and the
//      lane-children reader (loop-wait) still reads it as finished.
//   2. the same second Pi reads the status of a lane that is still running: nothing is written and
//      the run stays running. The assertion helper used here is also pointed at the run from (1), where
//      it must throw, so it is proven able to fail.
//   3. the same second Pi reads a finished lane whose recorded runner pid is alive (the record is edited to
//      name this test process): no proof, so the pid liveness check is covered on its own.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { adoptNopushLauncher } from "../test-support/lane-agents.ts";
import { isFinished, readChildStatus } from "../loop-wait/lane-children.ts";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAllAfterExit,
  expectDetachedRuns,
  freshDir,
  startPiRpc,
  waitForCondition,
  waitForDetachedWriters,
  writeFauxScript,
  type PiRpcSession,
  type RpcEvent,
} from "./rpc-test-helpers.ts";

after(() => cleanupAllAfterExit(60_000));

const FINISHED = ["complete", "completed", "failed", "stopped"];

interface Fixture { agentDir: string; subagentTemp: string; cwd: string }

function nopushHome(): Fixture {
  const agentDir = freshDir("unobserved-exit-home-");
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  writeFileSync(join(agentDir, "agents", "worker.md"), [
    "---", "name: worker", "description: Unobserved exit fixture", "tools: bash", "extensions: []",
    `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "Unobserved exit fixture.",
  ].join("\n"));
  adoptNopushLauncher(agentDir);
  return { agentDir, subagentTemp: freshDir("unobserved-exit-sub-"), cwd: freshDir("unobserved-exit-cwd-") };
}

function text(end: RpcEvent): string {
  const result = end.result as { content?: { type: string; text?: string }[] };
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

function runIdOf(end: RpcEvent): string {
  const runId = (end.result as { details?: { runId?: string } }).details?.runId;
  assert.ok(runId, `the launch reported no run id: ${text(end)}`);
  return runId;
}

const asyncDirOf = (f: Fixture, runId: string) => join(f.subagentTemp, "async-subagent-runs", runId);
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"));
const unobservedPath = (asyncDir: string) => join(asyncDir, "process-terminal-unobserved.json");

function statusWhen(f: Fixture, runId: string, want: (state: string, status: Record<string, any>) => boolean): Promise<Record<string, any>> {
  return waitForCondition(() => {
    try {
      const status = readJson(join(asyncDirOf(f, runId), "status.json"));
      return want(status.state, status) ? status : undefined;
    } catch {
      return undefined;
    }
  }, 40_000, 100);
}

/** Launch one nopush lane from a root, wait until it is running, then end the root. The lane's reply is
 *  held for laneMs, so the root is gone before the runner closes and no Pi observes that close. */
async function launchLaneThenEndRoot(f: Fixture, laneMs: number): Promise<string> {
  const root: PiRpcSession = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "LAUNCH_LANE", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "UNOBSERVED_LANE_TASK", async: true } }] },
      { match: "UNOBSERVED_LANE_TASK", delayMs: laneMs, text: "lane done" },
      { match: ".*", text: "ok" },
    ]),
    agentDir: f.agentDir, subagentTempRoot: f.subagentTemp, cwd: f.cwd,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  expectDetachedRuns(f.subagentTemp, 1);
  try {
    root.send({ id: "launch", type: "prompt", message: "LAUNCH_LANE" });
    const launch = await root.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.notEqual(launch.isError, true, `the lane launch must start: ${text(launch)}`);
    const runId = runIdOf(launch);
    const running = await statusWhen(f, runId, (state, status) => state === "running" && typeof status.pid === "number");
    assert.equal(running.launcher?.name, "nopush", "the lane runs under the nopush launcher");
    assert.equal(typeof running.pid, "number", "the runner records its pid");
    await root.waitFor((e) => e.type === "agent_end", 20_000);
    return runId;
  } finally {
    await root.close();
  }
}

/** A second Pi, with its own process and no memory of the lane, reads the run's status by id. */
async function statusFromAnotherPi(f: Fixture, runId: string, beforeStatus?: () => void): Promise<string> {
  const other = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "IDLE_PROMPT", text: "idle" },
      { match: "STATUS_PLEASE", once: true, toolCalls: [{ name: "subagent", args: { action: "status", id: runId } }] },
      { match: ".*", text: "ok" },
    ]),
    agentDir: f.agentDir, subagentTempRoot: f.subagentTemp, cwd: f.cwd,
    extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  try {
    if (beforeStatus) {
      // Starting a Pi and giving it a turn is not enough: only the status call reconciles this run.
      other.send({ id: "idle", type: "prompt", message: "IDLE_PROMPT" });
      await other.waitFor((e) => e.type === "agent_end", 20_000);
      beforeStatus();
    }
    const from = other.events.length;
    other.send({ id: "status", type: "prompt", message: "STATUS_PLEASE" });
    const end = await other.waitFor((e) => other.events.indexOf(e) >= from && e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.notEqual(end.isError, true, `the second Pi's status call must succeed: ${text(end)}`);
    await other.waitFor((e) => other.events.indexOf(e) > other.events.indexOf(end) && e.type === "agent_end", 20_000);
    return text(end);
  } finally {
    await other.close();
  }
}

/** The reconciler marked nothing for a lane that is still running. Throws when it did. */
function assertLiveLaneUntouched(asyncDir: string, before: Record<string, any>): void {
  assert.equal(existsSync(unobservedPath(asyncDir)), false, "no unobserved-exit proof is written for a live lane");
  const status = readJson(join(asyncDir, "status.json"));
  assert.equal(status.state, "running", "a live lane stays running");
  assert.equal(status.state, before.state);
  assert.equal(readJson(join(asyncDir, "process-terminal.json")).state, "pending", "the proof stays pending");
  assert.doesNotThrow(() => process.kill(status.pid, 0), "the runner is still alive");
}

test("a nopush lane that finishes after its root ended gets an unobserved proof from another Pi, and its state is unchanged", { timeout: 150_000 }, async () => {
  const f = nopushHome();
  const runId = await launchLaneThenEndRoot(f, 8_000);
  const asyncDir = asyncDirOf(f, runId);

  // The lane finishes with no Pi watching: the runner's own proof stays pending, and nobody has reconciled yet.
  await statusWhen(f, runId, (state) => FINISHED.includes(state));
  await waitForDetachedWriters(f.subagentTemp, 1);
  const before = readJson(join(asyncDir, "status.json"));
  assert.ok(FINISHED.includes(before.state), "the lane finished on its own");
  assert.equal(typeof before.bootId, "string", "the nopush launcher's boot id reached the run record");
  assert.equal(readJson(join(asyncDir, "process-terminal.json")).state, "pending", "no Pi observed the runner close");
  assert.equal(existsSync(unobservedPath(asyncDir)), false, "nothing has reconciled the run yet");
  assert.throws(() => process.kill(before.pid, 0), { code: "ESRCH" }, "the recorded runner pid is dead");

  // Another Pi reads the status by id: reconcileAsyncRun -> settleUnobservedRunnerExit.
  const reported = await statusFromAnotherPi(f, runId, () => {
    assert.equal(existsSync(unobservedPath(asyncDir)), false, "a second Pi that only started has not reconciled the run");
  });
  assert.match(reported, new RegExp(runId.slice(0, 8)), "the status call reported this run");
  const proof = await waitForCondition(() => (existsSync(unobservedPath(asyncDir)) ? readJson(unobservedPath(asyncDir)) : undefined), 10_000, 100);
  assert.equal(proof.state, "unknown");
  assert.equal(proof.reason, "observer-unavailable");
  assert.equal(proof.runId, runId);
  assert.equal(proof.runnerProcessInstanceId, before.processTerminal.runnerProcessInstanceId);
  // The verdict is its own file: process-terminal.json (the file a close a Pi observes would write) is untouched.
  assert.equal(readJson(join(asyncDir, "process-terminal.json")).state, "pending");

  // The run's state is unchanged, and loop-wait's lane-children reader still reads it as finished.
  const after = readJson(join(asyncDir, "status.json"));
  assert.equal(after.state, before.state);
  assert.equal(after.pid, before.pid);
  assert.equal(after.launcher?.name, "nopush");
  const read = readChildStatus(asyncDir);
  assert.ok(!("error" in read), "lane-children can read the run record");
  assert.equal(read.state, before.state);
  assert.equal(isFinished(read.state), true);

  // The live-lane assertion can fail: pointed at this run, which was marked, it throws.
  assert.throws(() => assertLiveLaneUntouched(asyncDir, { ...before, state: "running" }), /no unobserved-exit proof is written for a live lane/);
});

test("another Pi reading a lane that is still running writes no proof and leaves it running", { timeout: 150_000 }, async () => {
  const f = nopushHome();
  const runId = await launchLaneThenEndRoot(f, 20_000);
  const asyncDir = asyncDirOf(f, runId);
  const before = readJson(join(asyncDir, "status.json"));
  assert.equal(before.state, "running", "the lane is still running when the second Pi reads it");

  await statusFromAnotherPi(f, runId);
  assertLiveLaneUntouched(asyncDir, before);
  assert.equal(isFinished((readChildStatus(asyncDir) as { state: string }).state), false, "lane-children reads it as live");
  // cleanupAllAfterExit waits for the lane to finish (writers closed, runner gone) before removing the fixture.
});

test("another Pi reading a finished lane whose recorded runner pid is still alive writes no proof", { timeout: 150_000 }, async () => {
  const f = nopushHome();
  const runId = await launchLaneThenEndRoot(f, 8_000);
  const asyncDir = asyncDirOf(f, runId);
  await statusWhen(f, runId, (state) => FINISHED.includes(state));
  await waitForDetachedWriters(f.subagentTemp, 1);
  const statusPath = join(asyncDir, "status.json");
  const original = readFileSync(statusPath, "utf8");
  const before = JSON.parse(original);
  try {
    // The runner is gone, so make the record name a process that is alive in the same pid namespace (this test's own).
    // The proof is pending and the state terminal, so only the liveness check stands between the record and a proof.
    writeFileSync(statusPath, JSON.stringify({ ...before, pid: process.pid }));
    await statusFromAnotherPi(f, runId);
    assert.equal(existsSync(unobservedPath(asyncDir)), false, "a live recorded pid is never settled as unobserved");
    assert.equal(readJson(statusPath).state, before.state);
    assert.equal(readJson(join(asyncDir, "process-terminal.json")).state, "pending");
  } finally {
    // Cleanup waits on the recorded runner pid to be gone, so put the real record back.
    writeFileSync(statusPath, original);
  }
  // Positive control: with the real, dead pid back, the same call does write the proof.
  await statusFromAnotherPi(f, runId);
  const proof = await waitForCondition(() => (existsSync(unobservedPath(asyncDir)) ? readJson(unobservedPath(asyncDir)) : undefined), 10_000, 100);
  assert.equal(proof.reason, "observer-unavailable", "the dead recorded pid is settled once it is back");
});
