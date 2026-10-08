// The state-log reading behind the per-loop SUPER/MEGASUPER cap. The launch and refusal path,
// including a root restart, is proved on the real CLI in tier-cap-e2e.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loggedTierRuns } from "./tier-cap.ts";

test("logged tier runs: one per tier dispatch run; block-only recovery, other agents, run-less and torn rows do not count", () => {
  const row = (o: Record<string, unknown>) => JSON.stringify({ v: 1, seq: 1, ts: "t", by: "ext", ...o });
  const log = [
    row({ ev: "open" }),
    row({ ev: "dispatch", lane: "L1", task: "T1", agent: "super-worker", run: "r1" }),
    row({ ev: "dispatch", lane: "L1", task: "T1", agent: "super-worker", run: "r1" }),
    row({ ev: "dispatch", lane: "L2", task: "T2", agent: "super-worker-push", run: "r2" }),
    row({ ev: "dispatch", lane: "L2", task: "T2", agent: "super-worker-push", run: "r2b", recovery_of: "r2" }),
    row({ ev: "dispatch", lane: "L3", task: "T3", agent: "megasuper-worker-push", run: "r3" }),
    row({ ev: "dispatch", lane: "L4", task: "T4", agent: "complex-worker", run: "r4" }),
    row({ ev: "return", lane: "L3", run: "r3", status: "complete" }),
    row({ ev: "dispatch", lane: "L5", task: "T5", agent: "super-worker" }),
    '{"ev":"dispatch","agent":"megasuper-worker","run":"r',
  ].join("\n");
  const runs = loggedTierRuns(log);
  assert.deepEqual([...runs.super].sort(), ["r1", "r2"]);
  assert.deepEqual([...runs.megasuper], ["r3"]);
});
