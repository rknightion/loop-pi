import assert from "node:assert/strict";
import { test } from "node:test";
import { disableSteeringRecovery } from "./subagent-view.ts";

test("a steer call always carries steeringRecovery false, wherever the model put the field", () => {
  for (const input of [
    { action: "steer", id: "r", message: "m" },
    { action: " steer ", id: "r", message: "m", steeringRecovery: true },
    { action: "steer", id: "r", message: "m", options: { steeringRecovery: true, index: 0 } },
  ] as Record<string, unknown>[]) {
    disableSteeringRecovery(input);
    assert.equal(input.steeringRecovery, undefined);
    assert.equal((input.options as Record<string, unknown>).steeringRecovery, false);
  }
});

test("other calls are left alone", () => {
  for (const input of [{ agent: "worker", task: "t" }, { action: "resume", id: "r", message: "m" }, { action: "status", id: "r" }] as Record<string, unknown>[]) {
    const before = JSON.stringify(input);
    disableSteeringRecovery(input);
    assert.equal(JSON.stringify(input), before);
  }
});
