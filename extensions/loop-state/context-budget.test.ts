import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_BUDGET_STATE, installContextBudget, nativeChildrenQuiet, PUSH_COMPACT_PERCENT, PUSH_COMPACT_PERCENT_ENV } from "./context-budget.ts";

// Policy boundaries supplement (never replace) the native CLI proof.
function fixture(quiet: () => Promise<boolean> = async () => true) {
  const handlers = new Map<string, any>();
  const branch: any[] = [];
  const warnings: string[] = [];
  let attempts = 0;
  const triggers: unknown[] = [];
  let outcome: "error" | "complete" = "error";
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler),
    events: { on: () => undefined }, appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data, id: `entry-${branch.length}` }) };
  const ctx = { isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ percent: 80, tokens: 80, contextWindow: 100 }),
    sessionManager: { getBranch: () => branch },
    compact: (options: any) => { attempts++; if (outcome === "complete") options.onComplete(); else options.onError(new Error("fixture failure")); } };
  const budget = installContextBudget(pi as never, { drain: () => Promise.resolve(), quiet, prepare: async (_ctx: unknown, trigger: unknown) => { triggers.push(trigger); return { summary: "fixture", log: "unused", logSha256: "fixture" }; }, warn: message => warnings.push(message) });
  budget.sessionStart(ctx as never);
  return { handlers, ctx, branch, warnings, budget, triggers, setOutcome: (value: "error" | "complete") => { outcome = value; }, start: () => budget.sessionStart(ctx as never), attempts: () => attempts, settle: () => handlers.get("agent_settled")({ aborted: false }, ctx) };
}

test("80 percent threshold, hysteresis, failure latch and reload: never one attempt per callback", async () => {
  const f = fixture();
  let percent = 79;
  f.ctx.getContextUsage = () => ({ percent, tokens: percent, contextWindow: 100 });
  await f.settle();
  assert.equal(f.attempts(), 0);
  percent = 80;
  await f.settle();
  assert.equal(f.attempts(), 1);
  for (percent of [80, 95, 70, 79, 80]) await f.settle();
  assert.equal(f.attempts(), 1, "failure does not retry at unchanged or marginally lower high usage");
  f.start();
  await f.settle();
  assert.equal(f.attempts(), 1, "persisted latch survives runtime reload");
  percent = 69;
  await f.settle();
  percent = 80;
  await f.settle();
  assert.equal(f.attempts(), 2);
  assert.ok(f.branch.some(e => e.customType === CONTEXT_BUDGET_STATE && e.data.latched === false));
});

test("busy, pending, operator abort and unknown API usage never force compaction", async () => {
  for (const boundary of ["busy", "pending", "abort", "unknown", "missing-api"]) {
    const f = fixture();
    if (boundary === "busy") f.ctx.isIdle = () => false;
    if (boundary === "pending") f.ctx.hasPendingMessages = () => true;
    if (boundary === "unknown") f.ctx.getContextUsage = (() => ({ percent: null, tokens: null, contextWindow: 100 })) as any;
    if (boundary === "missing-api") f.ctx.getContextUsage = undefined as any;
    await f.handlers.get("agent_settled")({ aborted: boundary === "abort" }, f.ctx);
    assert.equal(f.attempts(), 0, boundary);
    if (["unknown", "missing-api"].includes(boundary)) assert.match(f.warnings.join("\n"), /unsupported/);
  }
});


test("two attempts survive low-usage rearm and same-session reload", async () => {
  const f = fixture();
  let percent = 80;
  f.ctx.getContextUsage = () => ({ percent, tokens: percent, contextWindow: 100 });
  for (let i = 0; i < 3; i++) {
    percent = 69; await f.settle();
    percent = 80; await f.settle();
    f.start();
  }
  assert.equal(f.attempts(), 2, "same-session limit must survive reload and hysteresis");
});


test("native active or unknown children defer without consuming the persisted cap", async () => {
  for (const quiet of [async () => false, async (): Promise<boolean> => { throw new Error("unknown"); }]) {
    const f = fixture(quiet);
    await f.settle();
    f.start();
    await f.settle();
    assert.equal(f.attempts(), 0);
    assert.equal(f.branch.length, 0, "quiet deferral persists no consumed attempt");
  }
});

test("unknown legacy budget consumption refuses a fresh same-session allowance", async () => {
  for (const data of [{ v: 1, latched: false }, { v: 2, attempts: 0 }]) {
    const f = fixture();
    f.branch.push({ type: "custom", customType: CONTEXT_BUDGET_STATE, data });
    f.start();
    await f.settle();
    assert.equal(f.attempts(), 0);
  }
});


test("actual native status refuses a finalizing running job whose displayed steps are complete", async () => {
  const { registerSubagentRpcBridge } = await import(new URL("../../node_modules/pi-subagents/src/extension/rpc.js", import.meta.url).href);
  const sessionId = "/fixture/session.jsonl";
  const handlers = new Map<string, any>();
  const events = { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name); },
    emit: (name: string, value: any) => handlers.get(name)?.(value) };
  const state = { currentSessionId: sessionId, statusProjectionSessionId: sessionId, foregroundControls: new Map(),
    asyncJobs: new Map([["run", { asyncId: "run", sessionId, status: "running", mode: "single", startedAt: 1, updatedAt: 2,
      steps: [{ agent: "worker", status: "complete", startedAt: 1, endedAt: 2 }] }]]), fleetJobs: new Map(), activeAsyncCapacity: { used: 1, limit: 64 } };
  registerSubagentRpcBridge({ events, state, getContext: () => ({ sessionManager: { getSessionFile: () => sessionId, getSessionId: () => "session" } }),
    execute: () => { throw new Error("unexpected executor status path"); } });
  let reply: any;
  events.on("subagents:rpc:v1:reply:proof", (value: any) => { reply = value; });
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  assert.equal(reply.success, true);
  assert.equal(reply.data.fleet.totalActive, 0, "real native displayed step count is zero during finalization");
  assert.equal(reply.data.asyncSnapshot.runs[0].state, "running", "top-level job still matches the native compaction wake predicate");
  assert.equal(nativeChildrenQuiet(reply.data), false, "finalizing native job must defer without admitting compaction");
  state.activeAsyncCapacity.used = 0;
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  assert.equal(nativeChildrenQuiet(reply.data), false, "zero released capacity and zero displayed steps do not close a still-running native job");
  const completed = state.asyncJobs.get("run")!;
  completed.status = "complete";
  completed.steps[0].status = "running";
  state.activeAsyncCapacity.used = 0;
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  assert.equal(reply.data.fleet.totalActive, 0);
  assert.equal(reply.data.asyncSnapshot.runs[0].state, "complete");
  assert.equal(reply.data.asyncSnapshot.runs[0].children[0].kind, "step");
  assert.equal(reply.data.asyncSnapshot.runs[0].children[0].state, "running", "real native display retains stale step metadata after job completion");
  assert.equal(nativeChildrenQuiet(reply.data), true, "terminal native jobs with stale displayed steps must not be mistaken for active jobs");
  state.asyncJobs.clear();
  state.activeAsyncCapacity.used = 0;
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  assert.equal(nativeChildrenQuiet(reply.data), true, "actual empty native status establishes quiet");
  for (const change of [
    { fleet: { ...reply.data.fleet, topLevelAsyncCapacity: { used: 1, limit: 64 } } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, omitted: { runs: 1, children: 0, byteLimitExceeded: false } } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, omitted: { runs: 0, children: 0, byteLimitExceeded: true } } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, runs: [{ id: "job", kind: "subagent", state: "queued" }] } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, omitted: { runs: 0, children: 1, byteLimitExceeded: false } } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, runs: [{ id: "job", kind: "subagent", state: "complete", children: [{ id: "child", kind: "unknown", state: "running" }] }] } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, runs: [{ id: "job", kind: "subagent", state: "complete", children: [{ id: "child", kind: "step", state: "unknown" }] }] } },
    { asyncSnapshot: { ...reply.data.asyncSnapshot, runs: [{ state: "complete" }] } },
    { asyncSnapshot: undefined },
  ]) assert.equal(nativeChildrenQuiet({ ...reply.data, ...change }), false, "partial or active native status cannot establish quiet");
  // Correct the earlier synthetic expectation: a step is display metadata, not a
  // still-running native job. The real RPC transition above establishes this case.
  assert.equal(nativeChildrenQuiet({ ...reply.data, asyncSnapshot: { ...reply.data.asyncSnapshot,
    runs: [{ id: "job", kind: "subagent", state: "complete", children: [{ id: "step", kind: "step", state: "running" }] }] } }), true);
  // Actual queued/running materialized work remains a root under a terminal workflow.
  state.asyncJobs.set("run", { ...completed, mode: "workflow", status: "complete", steps: [] });
  state.asyncJobs.set("nested", { ...completed, asyncId: "nested", status: "running", parentWorkflowRunId: "run", steps: [{ agent: "worker", status: "complete" }] } as any);
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  assert.ok(reply.data.asyncSnapshot.runs.some((run: any) => run.id === "nested" && run.state === "running"));
  assert.equal(reply.data.fleet.totalActive, 0, "terminal display steps do not stand in for nested native job state");
  assert.equal(nativeChildrenQuiet(reply.data), false, "a terminal workflow cannot hide its actual running native child job");
});


function withPushPercent<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[PUSH_COMPACT_PERCENT_ENV];
  if (value === undefined) delete process.env[PUSH_COMPACT_PERCENT_ENV]; else process.env[PUSH_COMPACT_PERCENT_ENV] = value;
  return run().finally(() => { if (previous === undefined) delete process.env[PUSH_COMPACT_PERCENT_ENV]; else process.env[PUSH_COMPACT_PERCENT_ENV] = previous; });
}

test("a landed push compacts past the push share without a quiet fleet; the 80 percent backstop still needs quiet", () => withPushPercent(undefined, async () => {
  assert.ok(PUSH_COMPACT_PERCENT >= 50 && PUSH_COMPACT_PERCENT <= 60);
  const usage = (percent: number) => ({ percent, tokens: percent, contextWindow: 100 });
  // The fleet is never quiet and its status never answers: only the push path may proceed.
  const f = fixture(async () => { throw new Error("status must not be consulted for a landed push"); });
  f.ctx.getContextUsage = () => usage(PUSH_COMPACT_PERCENT + 1);
  await f.settle();
  assert.equal(f.attempts(), 0, "high usage without a landed push waits for the backstop");
  f.budget.landed();
  f.ctx.getContextUsage = () => usage(PUSH_COMPACT_PERCENT - 1);
  await f.settle();
  assert.equal(f.attempts(), 0, "below the push share a landed push does not compact");
  f.ctx.getContextUsage = () => usage(PUSH_COMPACT_PERCENT + 1);
  await f.settle();
  assert.equal(f.attempts(), 0, "a landed push is spent at the first settled boundary after it");
  f.budget.landed();
  await f.settle();
  assert.equal(f.attempts(), 1);
  assert.deepEqual(f.triggers, [{ reason: "landed-push", percent: PUSH_COMPACT_PERCENT + 1, threshold: PUSH_COMPACT_PERCENT }]);
  assert.equal(f.branch.at(-1)?.data.latched, false, "the push path does not take the 80 percent latch");
  // The backstop path is unchanged: it defers on an unreadable fleet.
  const g = fixture(async () => { throw new Error("unknown"); });
  g.ctx.getContextUsage = () => usage(80);
  await g.settle();
  assert.equal(g.attempts(), 0);
}));

test("a busy root keeps the landed push for its next settled boundary", () => withPushPercent(undefined, async () => {
  const f = fixture();
  f.ctx.getContextUsage = () => ({ percent: 70, tokens: 70, contextWindow: 100 });
  f.budget.landed();
  f.ctx.hasPendingMessages = () => true;
  await f.settle();
  assert.equal(f.attempts(), 0);
  f.ctx.hasPendingMessages = () => false;
  await f.settle();
  assert.equal(f.attempts(), 1);
}));

test("successful push compactions are not capped; failed ones consume the two-attempt allowance", () => withPushPercent(undefined, async () => {
  const f = fixture();
  f.ctx.getContextUsage = () => ({ percent: 60, tokens: 60, contextWindow: 100 });
  f.setOutcome("complete");
  for (let i = 0; i < 5; i++) { f.budget.landed(); await f.settle(); }
  assert.equal(f.attempts(), 5, "a completed compaction returns its attempt");
  f.setOutcome("error");
  for (let i = 0; i < 4; i++) { f.budget.landed(); await f.settle(); }
  assert.equal(f.attempts(), 7, "two failures, then the allowance is spent");
  f.start();
  f.budget.landed();
  await f.settle();
  assert.equal(f.attempts(), 7, "reload keeps the consumed allowance");
}));

test("the push share is configurable and an invalid value falls back to the default", async () => {
  const usage = { percent: 45, tokens: 45, contextWindow: 100 };
  await withPushPercent("40", async () => {
    const f = fixture();
    f.ctx.getContextUsage = () => usage;
    f.budget.landed();
    await f.settle();
    assert.equal(f.attempts(), 1);
    assert.equal((f.triggers[0] as any).threshold, 40);
  });
  for (const bad of ["", "abc", "0", "-5", "80", "150", "40%"]) {
    await withPushPercent(bad, async () => {
      const f = fixture();
      f.ctx.getContextUsage = () => usage;
      f.budget.landed();
      await f.settle();
      assert.equal(f.attempts(), 0, `'${bad}' is ignored`);
    });
  }
});

test("a push compaction declined because live work arrived hands its attempt back", () => withPushPercent(undefined, async () => {
  const f = fixture();
  f.ctx.getContextUsage = () => ({ percent: 60, tokens: 60, contextWindow: 100 });
  for (let i = 0; i < 4; i++) {
    f.budget.landed();
    // A child completion lands while the summary is being prepared.
    const settled = f.settle();
    f.budget.completed();
    await settled;
  }
  assert.equal(f.attempts(), 0, "declined without compacting");
  f.budget.landed();
  await f.settle();
  assert.equal(f.attempts(), 1, "the allowance is intact");
}));
