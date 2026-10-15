// loop-continuation wiring: the loop-continuation:query-launch answer and the idle nudge end to end.
// The first group loads index.ts against a fake ExtensionAPI; the last drives a real pi process on
// the scripted faux provider.

import assert from "node:assert/strict";
import { chmodSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, ROOT_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { cleanupFixtures, fakePi, loopFixture } from "./test-fixture.ts";

after(cleanupAll);
after(cleanupFixtures);

test("query-launch answers the closeout path as reportPath with ops always null; a resumed session restores it", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.equal(pi.query().reportPath, null);
    assert.equal(pi.query().ops, null);
    await pi.input(f.launch);
    const answer = pi.query();
    assert.deepEqual({ reportPath: answer.reportPath, opsPath: answer.opsPath, ops: answer.ops }, { reportPath: f.report, opsPath: null, ops: null });
    const stored = pi.entries.at(-1)!;
    assert.equal(stored.customType, "loop-continuation-state");
    assert.equal("ops" in stored.data, false, "v3 persists no ops grants");
    assert.equal(stored.data.launch.mode, "v3");
    assert.equal(stored.data.launch.charter, undefined, "the charter is frozen in rootContext, not LaunchInfo");
    assert.equal(stored.data.rootContext.goalPath, f.charter);
    assert.equal(readdirSync(f.agentDir).includes("incidents"), false);

    const resumed = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      resumed.handlers.get("session_start")!({}, resumed.ctx([{ type: "custom", customType: "loop-continuation-state", data: stored.data }]));
      assert.equal(resumed.query().reportPath, f.report);
    } finally {
      resumed.restore();
    }
  } finally {
    pi.restore();
  }
});

test("query-launch carries the charter's lanes cap as concurrency, omits it when missing or malformed, and a resumed session keeps it", async () => {
  const cases: [string, string | null, number | undefined][] = [
    ["a plain value", "4", 4],
    ["a value with surrounding spaces", " 3 ", 3],
    ["no lanes key", null, undefined],
    ["a non-numeric value", "many", undefined],
    ["zero", "0", undefined],
    ["a negative value", "-2", undefined],
    ["a fraction", "2.5", undefined],
    ["a number followed by prose", "4 lanes", undefined],
  ];
  for (const [label, value, want] of cases) {
    const f = loopFixture({ lanes: value });
    const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      assert.equal("concurrency" in pi.query(), false, `${label}: nothing is armed yet, so no concurrency`);
      await pi.input(f.launch);
      const answer = pi.query();
      assert.equal(answer.reportPath, f.report, `${label}: the launch armed`);
      assert.equal(answer.concurrency, want, label);
      assert.equal("concurrency" in answer, want !== undefined, `${label}: the field is absent, not undefined or null`);
      if (want === undefined) continue;
      const stored = pi.entries.at(-1)!;
      const resumed = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
      try {
        resumed.handlers.get("session_start")!({}, resumed.ctx([{ type: "custom", customType: "loop-continuation-state", data: stored.data }]));
        assert.equal(resumed.query().concurrency, want, `${label}: restored from the state entry`);
      } finally {
        resumed.restore();
      }
    } finally {
      pi.restore();
    }
  }
});

/** Replace the fixture home's loop-state with one that prints `digest` for any call (open included). */
function fakeLoopState(agentDir: string, digest: string): void {
  const fake = join(agentDir, "bin", "loop-state");
  // The fixture's loop-state is a symlink to this checkout's bin/loop-state: replace the link, never write through it.
  rmSync(fake, { force: true });
  writeFileSync(fake, `#!/bin/sh\necho '${digest}'\n`);
  chmodSync(fake, 0o755);
}

test("a watcher reply that is not an array counts as no reply, so the idle check falls back to the WAITING release", async () => {
  for (const reply of [undefined, { length: 0 }, null, "none"]) {
    const f = loopFixture();
    fakeLoopState(f.agentDir, '{"live_lanes":0,"parked":[]}');
    writeFileSync(f.log, "");
    const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      pi.bus.set("loop-wait:query-timers", [(d: any) => d.reply([])]);
      pi.bus.set("loop-wait:arm-timer", [(d: any) => d.reply({ id: "t1", at: d.at })]);
      pi.bus.set("loop-wait:query-watchers", [(d: any) => d.reply(reply)]);
      assert.deepEqual(await pi.input(f.launch), { action: "continue" });
      const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
      const result = await pi.handlers.get("agent_before_settle")!(
        { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: `WAITING: lanes until ${future}` }] } },
        pi.ctx(),
      );
      assert.deepEqual(result, {}, `reply ${JSON.stringify(reply)}: released, not nudged as idle`);
    } finally {
      pi.restore();
    }
  }
});

// End to end on the faux provider: loop-wait and loop-continuation loaded, a fake loop-state in
// the home's bin/, a state log beside the closeout. A WAITING stop with no live lane and nothing
// armed gets the idle nudge instead of a release; with a live lane it is released as before.
function runIdle(digestJson: string) {
  const f = loopFixture();
  fakeLoopState(f.agentDir, digestJson);
  writeFileSync(f.log, "");
  const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const script = writeFauxScript([
    { match: "You are the root", once: true, text: `Waiting on lanes.\nWAITING: lanes until ${future}`, stopReason: "stop" },
    { match: "No lane is live", text: "PAUSED: nothing is ready", stopReason: "stop" },
    { match: "Turn endings", text: "PAUSED: nothing else", stopReason: "stop" },
  ]);
  const rpc = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, new URL("./index.ts", import.meta.url).pathname],
    fauxScriptPath: script,
    agentDir: f.agentDir,
    sessionDir: f.repo,
    extraEnv: { LOOP_PI_RUN_DIR: f.runDir },
  });
  return { rpc, launch: f.launch };
}

test("a WAITING stop with no live lane and nothing armed but the auto-arm gets the idle nudge", async () => {
  // v3 digest: no admit events, so nothing is ever admissible; only live lanes decide.
  const { rpc, launch } = runIdle('{"live_lanes":0,"open_tasks":0,"admissible":[],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: launch });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter(
      (e: any) => e.type === "entry_appended" && e.entry?.type === "custom_message" && e.entry?.customType === "loop-continuation",
    ) as any[];
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].entry.details.reason, "idle");
    assert.match(nudges[0].entry.content, /No lane is live and nothing will wake this session/);
    assert.doesNotMatch(nudges[0].entry.content, /^close out/i, "a nudge never leads with an owner control phrase");
  } finally {
    await rpc.close();
  }
});

test("a WAITING stop with a live lane is released as before", async () => {
  const { rpc, launch } = runIdle('{"live_lanes":1,"open_tasks":1,"admissible":[],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: launch });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter((e: any) => e.type === "entry_appended" && e.entry?.customType === "loop-continuation");
    assert.equal(nudges.length, 0);
  } finally {
    await rpc.close();
  }
});
