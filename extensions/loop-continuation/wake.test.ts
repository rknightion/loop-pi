// pi-subagents 0.80.0 and later wake an idle root with the notice itself: a custom-message run with
// no `input` event. Any run a pi-subagents notice starts is the push that resets the nudge chain.
// The 0.76.1 to 0.79.x user-message wake texts stay recognised for a root on an older home.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { SUBAGENT_MESSAGE_TYPES } from "../../node_modules/pi-subagents/src/tui/subagent-messages.js";
import { PARENT_WAKE_TEXT, SUBAGENT_WAKE_TYPES, isParentWake, isSubagentWakeRun } from "./state.ts";
import { cleanupFixtures, fakePi, loopFixture } from "./test-fixture.ts";

after(cleanupFixtures);

const plainStop = (pi: Awaited<ReturnType<typeof fakePi>>) =>
  pi.handlers.get("agent_before_settle")!(
    { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: "Still working." }] } },
    pi.ctx(),
  );
const nudged = (result: any) => Array.isArray(result?.entries) && result.entries.some((e: any) => e.customType === "loop-continuation");
const PACKAGE = new URL("../../node_modules/pi-subagents/src/", import.meta.url);

test("the installed pi-subagents wakes with a turn-starting notice and no user wake text", () => {
  const wake = readFileSync(new URL("shared/parent-wake.js", PACKAGE), "utf8");
  assert.doesNotMatch(wake, /sendUserMessage|PARENT_WAKE_TEXT/, "a user-message wake is back: restore the input path");
  assert.match(wake, /pi\.sendMessage\(message, options\)/);
});

test("every turn-starting pi-subagents message type is a wake type", () => {
  for (const type of SUBAGENT_MESSAGE_TYPES) assert.ok(SUBAGENT_WAKE_TYPES.has(type), type);
  assert.match(readFileSync(new URL("extension/index.js", PACKAGE), "utf8"), /customType: "subagent-compaction-resume"/);
  assert.equal(SUBAGENT_WAKE_TYPES.size, SUBAGENT_MESSAGE_TYPES.length + 1, "only the compaction resume is added");
  assert.equal(isSubagentWakeRun({ messageType: "custom", message: { customType: "subagent_control_notice" } }), true);
  assert.equal(isSubagentWakeRun({ messageType: "custom", message: { customType: "loop-continuation" } }), false);
  assert.equal(isSubagentWakeRun({ messageType: "user" }), false);
});

test("the pre-0.80 wake texts are still recognised as wakes, only from an extension", () => {
  assert.equal(isParentWake({ source: "extension", text: PARENT_WAKE_TEXT }), true);
  assert.equal(isParentWake({ source: "extension", text: "Subagent updates above." }), true);
  assert.equal(isParentWake({ source: "interactive", text: PARENT_WAKE_TEXT }), false);
  assert.equal(isParentWake({ source: "extension", text: "Subagent updates" }), false);
});

test("a run started by a pi-subagents attention notice resets an exhausted nudge chain", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    for (let i = 0; i < 3; i++) assert.ok(nudged(await plainStop(pi)), `nudge ${i + 1}`);
    assert.equal(nudged(await plainStop(pi)), false, "the chain is exhausted");
    pi.handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "custom", message: { role: "custom", customType: "subagent_control_notice", content: "needs attention" } }, pi.ctx());
    assert.ok(nudged(await plainStop(pi)), "the wake run reset the chain");
  } finally {
    pi.restore();
  }
});

test("a pre-0.80 idle-parent wake input resets an exhausted nudge chain, so the next plain stop is nudged again", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    for (let i = 0; i < 3; i++) assert.ok(nudged(await plainStop(pi)), `nudge ${i + 1}`);
    assert.equal(nudged(await plainStop(pi)), false, "the chain is exhausted");

    const wake = await pi.handlers.get("input")!({ type: "input", text: PARENT_WAKE_TEXT, source: "extension" }, pi.ctx());
    assert.deepEqual(wake, { action: "continue" });
    assert.ok(nudged(await plainStop(pi)), "the wake reset the chain");
  } finally {
    pi.restore();
  }
});

test("the same text typed by the operator is not a wake", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    await pi.input(f.launch);
    for (let i = 0; i < 4; i++) await plainStop(pi);
    await pi.input(PARENT_WAKE_TEXT);
    assert.equal(nudged(await plainStop(pi)), false);
  } finally {
    pi.restore();
  }
});
