// Keep governed private identity in the brief; naming safety belongs to the allocation seam,
// not to prompt redaction, task aliases or changing what the state log correlates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { taskBrief } from "./brief.ts";
import type { TaskSpec } from "./goal.ts";
import { parseBrief } from "../loop-state/core.ts";
import { nativeLaneKey } from "../lane-worktrees/core.ts";

test("safe native naming does not redact dispatcher brief identity or title", () => {
  const id = ["H", "R", "N"].join("") + "-" + String(903).padStart(4, "0");
  const task: TaskSpec = { id, title: "preserve exact correlation", objective: "inspect the candidate", acceptance: "gate green", owned: ["src/**"], gate: "just check", landing: "returns candidate", agent: "lane-worker", tier: "guarded" };
  const rendered = taskBrief(task, "L1", "guarded");
  assert.equal(rendered.split("\n")[0], `Lane: L1 · Task: ${id} (${task.title}) · Tier: guarded`);
  assert.deepEqual(parseBrief(rendered), { lane: "L1", task: id, tier: "guarded" });
  const key = nativeLaneKey("/tmp/run", "L1", id);
  assert.match(key, /^r[0-9a-f]{32}l[0-9a-f]{32}$/);
  assert.equal(key.includes(id), false);
});
