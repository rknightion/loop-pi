// Runtime boundary: a recorded time-gated park must not look like completed work to close-out.
// Real pi + loop-state, faux model only. The model reconciles the park on the wake, never a human.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, ROOT_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { cleanupFixtures, loopFixture } from "./test-fixture.ts";

after(cleanupAll);
after(cleanupFixtures);

const CONTINUATION = new URL("./index.ts", import.meta.url).pathname;
const CLOCK_REASON = "loop-continuation time-gated park deadline";

for (const stop of ["paused", "report", "aborted", "paused-queued"] as const) {
  test(`an armed park clock is cancelled by an intervening ${stop} stop`, { timeout: 25_000 }, async () => {
    const f = loopFixture();
    const park = `at=$(python3 -c 'from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(seconds=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z"))'); "${f.agentDir}/bin/loop-state" append "${f.log}" park task=T-1 needs=evidence-later reason=clock-gated until="$at"; printf 'PARK_RECORDED'`;
    const report = ["# Loop: x loop3 · Goal: " + "a".repeat(64), "## Outcome", "## Evidence", "## Pending", "## Questions", "## Stalls and deaths", "## Tokens and wakeups"].join("\n");
    const stopRule = stop === "report"
      ? { match: "STOP_NOW", once: true, toolCalls: [{ name: "bash", args: { command: `printf '%s' '${report}' > '${f.report}'; printf 'REPORT_WRITTEN'`, timeout: 5 } }] }
      : stop === "aborted"
        ? { match: "STOP_NOW", once: true, toolCalls: [{ name: "bash", args: { command: "sleep 10", timeout: 15 } }] }
        : { match: "STOP_NOW", once: true, text: "PAUSED: operator stopped work", delayMs: stop === "paused-queued" ? 6_000 : 0 };
    const rpc = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION, CONTINUATION], agentDir: f.agentDir, sessionDir: f.repo,
      extraEnv: { LOOP_PI_RUN_DIR: f.runDir },
      fauxScriptPath: writeFauxScript([
        { match: "You are the root", once: true, toolCalls: [{ name: "bash", args: { command: park, timeout: 5 } }] },
        { match: "PARK_RECORDED", once: true, text: "Time-gated work is parked." },
        stopRule,
        { match: "REPORT_WRITTEN", text: "Report complete." },
        { match: ".*", text: "PAUSED: unexpected wake" },
      ]),
    });
    try {
      rpc.send({ id: "launch", type: "prompt", message: f.launch });
      await rpc.waitFor((e) => e.type === "agent_settled");
      rpc.send({ id: "armed", type: "get_entries" });
      const entries = ((await rpc.waitForResponse("armed")).data as any).entries;
      const before = entries.filter((e: any) => e.customType === "loop-wait-state").at(-1).data;
      assert.equal(before.timers.filter((t: any) => t.reason === CLOCK_REASON).length, 1, "park clock really was armed");
      const deadline = Date.parse(before.timers.find((t: any) => t.reason === CLOCK_REASON).at);
      assert.ok(deadline > Date.now(), "intervening stop starts before clock expiry");
      const firstSettle = rpc.events.findIndex((e) => e.type === "agent_settled");
      rpc.send({ id: "stop", type: "prompt", message: "STOP_NOW" });
      if (stop === "aborted") {
        await rpc.waitFor((e) => e.type === "tool_execution_start" && JSON.stringify(e).includes("sleep 10"));
        rpc.send({ id: "abort", type: "abort" });
        await rpc.waitForResponse("abort");
      }
      await rpc.waitFor((e) => e.type === "agent_settled" && rpc.events.indexOf(e) > firstSettle);
      await delay(Math.max(0, deadline - Date.now()) + 400);
      assert.equal(rpc.events.filter((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake").length, 0, "stopped clock must never wake the root, including a fired-but-queued wake");
      rpc.send({ id: "after", type: "get_entries" });
      const after = ((await rpc.waitForResponse("after")).data as any).entries.filter((e: any) => e.customType === "loop-wait-state").at(-1).data;
      assert.equal(after.timers.filter((t: any) => t.reason === CLOCK_REASON).length, 0, "owned timer removed durably");
    } finally {
      await rpc.close();
    }
  });
}

test("a time-gated park wakes once and work resumes without a human message", { timeout: 25_000 }, async () => {
  const f = loopFixture();
  const resumed = join(f.repo, "resumed");
  // Compute the deadline in the running CLI, not before pi startup, to avoid a startup race.
  const park = `at=$(python3 -c 'from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(seconds=3)).isoformat(timespec="milliseconds").replace("+00:00", "Z"))'); "${f.agentDir}/bin/loop-state" append "${f.log}" park task=T-1 needs=evidence-later reason=clock-gated until="$at"; printf 'PARK_RECORDED'`;
  const rpc = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, CONTINUATION],
    agentDir: f.agentDir,
    sessionDir: f.repo,
    extraEnv: { LOOP_PI_RUN_DIR: f.runDir },
    fauxScriptPath: writeFauxScript([
      { match: "You are the root", once: true, toolCalls: [{ name: "bash", args: { command: park, timeout: 5 } }] },
      { match: "PARK_RECORDED", once: true, text: "Time-gated work is parked." },
      { match: "WAKE .*time-gated park", once: true, toolCalls: [{ name: "bash", args: { command: `"${f.agentDir}/bin/loop-state" append "${f.log}" admit task=T-1; touch "${resumed}"; printf 'RESUMED_WORK'`, timeout: 5 } }] },
      { match: "RESUMED_WORK", text: "PAUSED: proof complete" },
      { match: ".*", text: "PAUSED: unexpected continuation" },
    ]),
  });
  try {
    rpc.send({ id: "launch", type: "prompt", message: f.launch });
    await rpc.waitFor((e) => e.type === "agent_settled");
    const firstSettle = rpc.events.findIndex((e) => e.type === "agent_settled");
    assert.equal(existsSync(resumed), false, "work stays parked before the deadline");
    const recordedPark = readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.ev === "park");
    assert.equal(recordedPark?.needs, "evidence-later", "the real loop-state CLI recorded the park");
    assert.ok(Date.parse(recordedPark.until) > Date.now(), "the root released before the clock expired");
    const wake = await rpc.waitFor((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake", 7_000);
    const wakeIndex = rpc.events.indexOf(wake);
    assert.ok(wakeIndex > firstSettle, "the timer starts a new root turn after the parked turn settled");
    await rpc.waitFor((e) => e.type === "tool_execution_end" && JSON.stringify(e).includes("RESUMED_WORK"));
    await rpc.waitFor((e) => e.type === "agent_settled" && rpc.events.indexOf(e) > wakeIndex);
    assert.ok(existsSync(resumed), "the real bash tool resumed work");
    await delay(400);
    assert.equal(rpc.events.filter((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake").length, 1, "no duplicate timer wake");
    assert.equal(rpc.events.filter((e) => e.type === "message_start" && (e.message as any)?.role === "user").length, 1, "only the launch was human input");
  } finally {
    await rpc.close();
  }
});
