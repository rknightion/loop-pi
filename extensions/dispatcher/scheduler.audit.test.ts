import assert from "node:assert/strict";
import { test } from "node:test";
import { Dispatcher, type Ports } from "./scheduler.ts";

test("scheduler records resolved admit tier and guarded surfaces on dispatch", async () => {
  const events: Record<string, unknown>[] = [];
  let dispatched!: () => void;
  const observed = new Promise<void>((resolve) => { dispatched = resolve; });
  const ports: Ports = {
    append: async (event) => { events.push(event); if (event.ev === "dispatch") dispatched(); },
    spawn: async () => ({ runId: "r1" }), remoteSha: async () => "base",
    isAncestor: async () => true, changedFiles: async () => [],
    backlogDone: async () => ({ ok: true, detail: "ok" }), closeout: async () => ({ ok: true, detail: "ok" }),
    commitBacklog: async () => ({ ok: true, detail: "ok" }), onClose: async () => {}, log: () => {},
  };
  const dispatcher = new Dispatcher({
    tasks: [{ id: "T1", objective: "x", acceptance: "ok", owned: ["src/auth/**"], gate: "check",
      landing: "lands-after-green", agent: "lane-worker", tier: "routine" }],
    tiers: { T1: "guarded" }, runTier: "routine", cap: 1, composedGate: "check", guardedExtra: [],
    files: [], goalSha256: "goal", rootModel: "none",
  }, ports);
  void dispatcher.start();
  await observed;
  const admit = events.find((event) => event.ev === "admit")!;
  assert.equal(admit.tier, "guarded");
  assert.deepEqual(admit.surfaces, ["**/auth/**"]);
  const dispatch = events.find((event) => event.ev === "dispatch")!;
  assert.equal(dispatch.tier, "guarded");
  assert.equal(dispatch.surface, "**/auth/**");
  assert.deepEqual(dispatch.tasks, ["T1"]);
  assert.equal(dispatch.kind, "work");
});
