import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { timeParkDeadline } from "./close-out.ts";
import { evaluateSettle, MAX_NUDGES, TIME_PARK_ARM_REASON, type ArmedTimer, type SettleInput } from "./state.ts";
import { nudgeTextFor } from "./nudge-text.ts";

const NOW = "2026-10-01T00:00:00Z";
const FUTURE = "2026-10-01T00:01:00Z";
const PAST = "2026-09-30T23:59:00Z";

function input(overrides: Partial<SettleInput> = {}): SettleInput {
  return {
    outcome: "completed",
    state: { armed: true, launch: { report: "report-x-loop1.md", loop: 1, launchTs: NOW }, nudgeCount: 0, chainIncidentWritten: false },
    pushDetected: false, reportCounted: false, marker: null, waitingDeadline: null, now: NOW,
    queryTimers: () => [], armTimer: () => ({ id: "clock", at: FUTURE }),
    closeOut: { digest: { live_lanes: 0, admissible: [], timeParkDeadline: FUTURE }, queryWatchers: () => [] },
    ...overrides,
  };
}

test("clock parks arm once across repeated settle boundaries and respect an earlier WAITING deadline", () => {
  const timers: ArmedTimer[] = [];
  let arms = 0;
  const current = input({
    queryTimers: () => timers,
    armTimer: (at, reason) => { arms++; timers.push({ id: "clock", at, reason }); return { id: "clock", at }; },
  });
  assert.equal(evaluateSettle(current).action, "release");
  assert.equal(evaluateSettle(current).action, "release");
  assert.equal(arms, 1);
  assert.equal(timers[0].reason, TIME_PARK_ARM_REASON);
  timers.length = 0;
  const earlier = "2026-10-01T00:00:30Z";
  assert.equal(evaluateSettle({ ...current, marker: "waiting", waitingDeadline: earlier }).action, "release");
  assert.equal(timers[0].at, earlier);
});

test("expired parks request bounded reconciliation rather than close-out or rearming overdue timers", () => {
  const expired = input({
    marker: "waiting", waitingDeadline: FUTURE,
    closeOut: { digest: { live_lanes: 0, admissible: [], timeParkDeadline: PAST }, queryWatchers: () => [] },
    queryTimers: () => { throw new Error("expired park should not query timers"); },
    armTimer: () => { throw new Error("expired park must not rearm"); },
  });
  const decision = evaluateSettle(expired);
  assert.equal(decision.action, "nudge");
  if (decision.action !== "nudge") return;
  assert.equal(decision.reason, "expired-park");
  assert.match(nudgeTextFor(decision.reason), /Reevaluate.*evidence-later/s);
  assert.equal(evaluateSettle({ ...expired, state: { ...expired.state, nudgeCount: MAX_NUDGES } }).action, "release-exhausted");
});

test("clock parks cannot override PAUSED, report completion, abort/error or an unarmed session", () => {
  const stopped = input({
    queryTimers: () => { throw new Error("stop control must not query timers"); },
    armTimer: () => { throw new Error("stop control must not arm timers"); },
  });
  for (const overrides of [
    { marker: "paused" as const }, { reportCounted: true }, { outcome: "aborted" as const },
    { outcome: "error" as const }, { state: { ...stopped.state, armed: false } },
  ]) {
    const decision = evaluateSettle({ ...stopped, ...overrides });
    assert.ok(decision.action === "release" || decision.action === "skip");
  }
});

test("without a timer provider a future park is nudged, not silently released or closed out", () => {
  const decision = evaluateSettle(input({ queryTimers: () => null, armTimer: () => null }));
  assert.equal(decision.action, "nudge");
  if (decision.action === "nudge") assert.equal(decision.reason, "unmarked");
});

test("only active evidence-later parks supply a clock; superseded, owner and invalid parks do not", () => {
  const dir = mkdtempSync(join(tmpdir(), "clock-parks-"));
  const log = join(dir, "state.jsonl");
  const park = (task: string, until: string, needs = "evidence-later") => ({ ev: "park", task, needs, until });
  const read = (events: unknown[], parked = ["T-1", "T-2"]) => {
    writeFileSync(log, events.map((event) => JSON.stringify(event)).join("\n"));
    return timeParkDeadline(log, parked);
  };
  try {
    assert.equal(read([park("T-1", FUTURE), park("T-2", PAST)]), PAST, "earliest clock wins");
    assert.equal(read([park("T-1", FUTURE)], []), null, "digest must still show it parked");
    for (const needs of ["owner", "authority", "dependency", "budget", "defect"]) {
      assert.equal(read([park("T-1", FUTURE, needs)]), null, needs);
    }
    for (const event of [
      { ev: "admit", task: "T-1" }, { ev: "dispatch", task: "T-1" }, { ev: "land", task: "T-1" },
      { ev: "accept", task: "T-1", accepted: true }, { ev: "close" }, park("T-1", FUTURE, "owner"),
    ]) assert.equal(read([park("T-1", FUTURE), event]), null, JSON.stringify(event));
    for (const until of ["later", "2026-10-01T00:00:00", ""]) assert.equal(read([park("T-1", until)]), null);
    writeFileSync(log, `${JSON.stringify(park("T-1", FUTURE))}\n{`);
    assert.equal(timeParkDeadline(log, ["T-1"]), null, "partial/malformed logs fail safe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
