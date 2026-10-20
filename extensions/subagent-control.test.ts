// pi-subagents 0.79.1 classifies mutating-tool failures by the actual result's isError.
// Keep the existing attention threshold until its finite-threshold policy is selected separately.
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
  const success = { isError: false, content: [{ type: "text", text: output }] };
  const failure = { isError: true, content: [{ type: "text", text: "command exited with code 1" }] };
  assert.equal(didMutatingToolFail(success), false);
  assert.equal(didMutatingToolFail(failure), true);
  for (let i = 0; i < 50; i++) recordMutatingFailure(state, { ts: 1_000 + i, tool: "bash", path: "d", error: output }, 300_000);
  assert.equal(shouldEscalateMutatingFailures(state, control.failedToolAttemptsBeforeAttention), false);
});
