// loop-continuation wiring: the ops freeze at launch, the loop-continuation:query-launch answer,
// and the close-out nudge end to end. The first group loads index.ts against a fake ExtensionAPI;
// the last drives a real pi process on the scripted faux provider.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, ROOT_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { addAuthority, cleanupFixtures, fakePi, loopFixture } from "./test-fixture.ts";

after(cleanupAll);
after(cleanupFixtures);

const OPS = {
  v: 1,
  ops: [{ surface: "deploy:site", kind: "deploy", allow: ["^just deploy( |$)"], secret_paths: ["kv/ci/site/token"] }],
};

/** A loop that passes the arm checks, loaded into index.ts through a fake ExtensionAPI. The goal's
 *  `## Authority` `ops:` line is written to match the launch line (arm refuses a mismatch). */
async function armedPi() {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  const launchText = (opsLine: string | null) => {
    if (opsLine) addAuthority(f, opsLine.replace(/^Ops grants:/, "ops:"));
    return `${f.launch}${opsLine ? "\n" + opsLine : ""}`;
  };
  return { f, pi, launchText };
}

test("the ops file is read once at launch; a later edit is ignored; query-launch answers it", async () => {
  const { f, pi, launchText } = await armedPi();
  const opsPath = join(f.repo, "codex", "ops.json");
  const text = JSON.stringify(OPS);
  writeFileSync(opsPath, text);
  const sha = createHash("sha256").update(text).digest("hex");
  try {
    assert.equal(pi.query().reportPath, null);
    assert.equal(pi.query().ops, null);

    await pi.input(launchText(`Ops grants: ${opsPath} sha256=${sha}`));
    writeFileSync(opsPath, JSON.stringify({ v: 1, ops: [] }));
    const answer = pi.query();
    assert.deepEqual({ reportPath: answer.reportPath, opsPath: answer.opsPath, ops: answer.ops }, { reportPath: f.report, opsPath, ops: OPS });
    const stored = pi.entries.at(-1)!;
    assert.equal(stored.customType, "loop-continuation-state");
    assert.deepEqual(stored.data.ops, OPS);
    assert.equal(stored.data.launch.opsLine, undefined, "the ops line is not persisted inside LaunchInfo");
    assert.equal(readdirSync(f.agentDir).includes("incidents"), false);

    // A resumed session restores the frozen grants from the state entry, not from the file.
    const resumed = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      resumed.handlers.get("session_start")!(
        {},
        resumed.ctx([{ type: "custom", customType: "loop-continuation-state", data: stored.data }]),
      );
      assert.deepEqual(resumed.query().ops, OPS);
    } finally {
      resumed.restore();
    }
  } finally {
    pi.restore();
  }
});

test("a digest mismatch, a missing file and an invalid file store ops:null and write an incident", async () => {
  const cases: { name: string; line: (dir: string) => string }[] = [
    { name: "mismatch", line: (dir) => (writeFileSync(join(dir, "o.json"), JSON.stringify(OPS)), `Ops grants: ${join(dir, "o.json")} sha256=${"0".repeat(64)}`) },
    { name: "missing", line: (dir) => `Ops grants: ${join(dir, "absent.json")} sha256=${"0".repeat(64)}` },
    {
      name: "invalid",
      line: (dir) => {
        const bad = JSON.stringify({ v: 1, ops: [{ surface: "s", kind: "nuke", allow: [], secret_paths: [] }] });
        writeFileSync(join(dir, "o.json"), bad);
        return `Ops grants: ${join(dir, "o.json")} sha256=${createHash("sha256").update(bad).digest("hex")}`;
      },
    },
  ];
  for (const c of cases) {
    const { f, pi, launchText } = await armedPi();
    try {
      await pi.input(launchText(c.line(join(f.repo, "codex"))));
      assert.equal(pi.query().ops, null, c.name);
      assert.deepEqual(readdirSync(join(f.agentDir, "incidents")), ["ops"], `${c.name}: nothing at the top level`);
      const files = readdirSync(join(f.agentDir, "incidents", "ops"));
      assert.equal(files.length, 1, c.name);
      assert.match(files[0], /^sess-1-.*\.json$/);
      const incident = JSON.parse(readFileSync(join(f.agentDir, "incidents", "ops", files[0]), "utf8"));
      assert.equal(incident.class, "loop-ops-grants-rejected", c.name);
      assert.equal(incident.session, "sess-1");
      assert.ok(typeof incident.reason === "string" && incident.reason.length > 0);
    } finally {
      pi.restore();
    }
  }
});

test("a launch with no Ops grants line stores no grants and writes no incident", async () => {
  const { f, pi, launchText } = await armedPi();
  try {
    await pi.input(launchText(null));
    const answer = pi.query();
    assert.deepEqual({ reportPath: answer.reportPath, opsPath: answer.opsPath, ops: answer.ops }, { reportPath: f.report, opsPath: null, ops: null });
    assert.equal(readdirSync(f.agentDir).includes("incidents"), false);
  } finally {
    pi.restore();
  }
});

test("query-launch carries the goal's ## Run concurrency, omits it when missing or malformed, and a resumed session keeps it", async () => {
  const cases: [string, string | null, number | undefined][] = [
    ["a plain value", "4", 4],
    ["a value with surrounding spaces", " 3 ", 3],
    ["no concurrency line", null, undefined],
    ["a non-numeric value", "many", undefined],
    ["zero", "0", undefined],
    ["a negative value", "-2", undefined],
    ["a fraction", "2.5", undefined],
    ["a number followed by prose", "4 lanes", undefined],
  ];
  for (const [label, value, want] of cases) {
    const f = loopFixture({ concurrency: value });
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

test("a watcher reply that is not an array counts as no reply, so close-out falls back to the WAITING release", async () => {
  for (const reply of [undefined, { length: 0 }, null, "none"]) {
    const f = loopFixture();
    fakeLoopState(f.agentDir, '{"live_lanes":0,"open_tasks":[],"admissible":[],"parked":[]}');
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
      assert.deepEqual(result, {}, `reply ${JSON.stringify(reply)}: released, not nudged to close out`);
    } finally {
      pi.restore();
    }
  }
});

// End to end on the faux provider: loop-wait and loop-continuation loaded, a fake loop-state in
// the home's bin/, a state log beside the report. A WAITING stop with nothing admissible gets a
// close-out nudge instead of a release; with an admissible task it is released as before.
function runCloseOut(digestJson: string) {
  const f = loopFixture();
  fakeLoopState(f.agentDir, digestJson);
  writeFileSync(f.log, "");
  const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const script = writeFauxScript([
    { match: "You are the root", once: true, text: `Waiting on lanes.\nWAITING: lanes until ${future}`, stopReason: "stop" },
    { match: "close out", text: "PAUSED: closing out", stopReason: "stop" },
    { match: "TURN ENDINGS", text: "PAUSED: nothing else", stopReason: "stop" },
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

test("a WAITING stop with a drained digest is nudged to close out instead of released", async () => {
  const { rpc, launch } = runCloseOut('{"live_lanes":0,"open_tasks":[],"admissible":[],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: launch });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter(
      (e: any) => e.type === "entry_appended" && e.entry?.type === "custom_message" && e.entry?.customType === "loop-continuation",
    ) as any[];
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].entry.details.reason, "close-out");
    assert.match(nudges[0].entry.content, /close out: nothing admissible remains; generate the report and end the run/);
  } finally {
    await rpc.close();
  }
});

test("a WAITING stop with an admissible task is released as before", async () => {
  const { rpc, launch } = runCloseOut('{"live_lanes":0,"open_tasks":["T-1"],"admissible":["T-1"],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: launch });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter((e: any) => e.type === "entry_appended" && e.entry?.customType === "loop-continuation");
    assert.equal(nudges.length, 0);
  } finally {
    await rpc.close();
  }
});
