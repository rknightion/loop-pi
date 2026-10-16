// pi-subagents 0.78.0 reads child tool results the way pi reports them, which switched on its
// mutating-tool failure guard (0.77.0 keyed it on an event pi never emits). The guard matches words
// such as "failed" or "error" in successful output and, at the default threshold of three, wakes the
// root with a needs_attention notice. The home config keeps the 0.77.0 effective behaviour until a
// pi-subagents release judges failure by the tool result's isError.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveControlConfig } from "../node_modules/pi-subagents/src/runs/shared/subagent-control.js";
import {
  createMutatingFailureState,
  didMutatingToolFail,
  recordMutatingFailure,
  shouldEscalateMutatingFailures,
} from "../node_modules/pi-subagents/src/runs/shared/long-running-guard.js";

const home = JSON.parse(readFileSync(new URL("../home/extensions/subagent/config.json", import.meta.url), "utf8"));

test("successful mutating commands that print 'failed' never escalate a lane to needs_attention", () => {
  const control = resolveControlConfig(home.control, undefined);
  assert.equal(control.activeNoticeAfterMs, 3_600_000, "the long-run notice loop-pi sets is kept");
  const state = createMutatingFailureState();
  const output = "0 failed, 12 passed";
  assert.equal(didMutatingToolFail(output), true, "the package still misreads this success as a failure");
  for (let i = 0; i < 50; i++) recordMutatingFailure(state, { ts: 1_000 + i, tool: "bash", path: "d", error: output }, 300_000);
  assert.equal(shouldEscalateMutatingFailures(state, control.failedToolAttemptsBeforeAttention), false);
});
