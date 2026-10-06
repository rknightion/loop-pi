// pi-subagents 0.76.1 wakes an idle root by appending its notice with no extension message events,
// then sending the extension-sourced user message "Subagent updates above.". That wake is the push
// that resets the nudge chain; it is not the session's first operator input.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PARENT_WAKE_TEXT } from "./state.ts";
import { cleanupFixtures, fakePi, loopFixture } from "./test-fixture.ts";

after(cleanupFixtures);

const plainStop = (pi: Awaited<ReturnType<typeof fakePi>>) =>
  pi.handlers.get("agent_before_settle")!(
    { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: "Still working." }] } },
    pi.ctx(),
  );
const nudged = (result: any) => Array.isArray(result?.entries) && result.entries.some((e: any) => e.customType === "loop-continuation");

test("an idle-parent wake resets an exhausted nudge chain, so the next plain stop is nudged again", async () => {
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
