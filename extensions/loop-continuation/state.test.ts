// Unit tests for the C7 decision function. WAITING-path cases
// stub the pi.events replies per the brief: loop-wait is being built in parallel and this module
// has no dependency on it beyond the queryTimers/armTimer callback shapes SEAMS.md fixes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateSettle, INITIAL_STATE, MAX_NUDGES, type ContinuationState } from "./state.ts";
import type { LaunchInfo } from "./launch-detect.ts";

const LAUNCH: LaunchInfo = { report: "codex/report-x-loop1.md", loop: 1, launchTs: "2026-09-25T00:00:00Z" };

function armedState(overrides: Partial<ContinuationState> = {}): ContinuationState {
  return { armed: true, launch: LAUNCH, nudgeCount: 0, chainIncidentWritten: false, ...overrides };
}

const noTimers = () => null;
const noArm = () => null;

describe("evaluateSettle: skip conditions", () => {
  test("skips on an aborted outcome", () => {
    const decision = evaluateSettle({
      outcome: "aborted",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.deepEqual(decision, { action: "skip" });
  });

  test("skips on an error outcome", () => {
    const decision = evaluateSettle({
      outcome: "error",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.deepEqual(decision, { action: "skip" });
  });

  test("skips when not armed, even on a completed outcome with no marker", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: INITIAL_STATE,
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.deepEqual(decision, { action: "skip" });
  });
});

describe("evaluateSettle: release conditions", () => {
  test("releases when the report counts", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: 2 }),
      pushDetected: false,
      reportCounted: true,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "release");
    assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, 0);
  });

  test("releases on a current PAUSED: marker", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: 1 }),
      pushDetected: false,
      reportCounted: false,
      marker: "paused",
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "release");
  });

  test("releases on WAITING when an existing timer already covers the deadline", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: 1 }),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T12:00:00Z",
      now: "2026-09-27T10:00:00Z",
      queryTimers: () => [{ id: "t1", at: "2026-09-27T11:00:00Z", reason: "lane 3" }],
      armTimer: () => {
        throw new Error("must not arm a new timer when one already covers the deadline");
      },
    });
    assert.equal(decision.action, "release");
    assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, 0);
  });

  test("releases on WAITING and auto-arms a timer when none covers the deadline (future deadline still auto-arms as before)", () => {
    let armedAt: string | null = null;
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T12:00:00Z",
      now: "2026-09-27T10:00:00Z",
      queryTimers: () => [{ id: "t1", at: "2026-09-28T00:00:00Z", reason: "unrelated, too late" }],
      armTimer: (at) => {
        armedAt = at;
        return { id: "t2", at };
      },
    });
    assert.equal(decision.action, "release");
    assert.equal(armedAt, "2026-09-27T12:00:00Z");
  });

  test("does not release a WAITING turn when loop-wait does not reply to the query (nudges instead)", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T12:00:00Z",
      now: "2026-09-27T10:00:00Z",
      queryTimers: () => null, // loop-wait not loaded
      armTimer: () => {
        throw new Error("must not attempt to arm when the query itself did not reply");
      },
    });
    assert.equal(decision.action, "nudge");
  });

  test("does not release a WAITING turn when arm-timer does not reply either (nudges instead)", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T12:00:00Z",
      now: "2026-09-27T10:00:00Z",
      queryTimers: () => [],
      armTimer: () => null,
    });
    assert.equal(decision.action, "nudge");
  });
});

describe("evaluateSettle: stale WAITING deadline", () => {
  test("a WAITING deadline already past (beyond the clock-skew tolerance) is treated as an unmarked stop: nudges, does not query or arm a timer", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T11:59:00Z",
      now: "2026-09-27T12:00:00Z", // 60s past the deadline, well beyond the 5s tolerance
      queryTimers: () => {
        throw new Error("must not query loop-wait timers for a stale WAITING deadline");
      },
      armTimer: () => {
        throw new Error("must not auto-arm a timer at a stale WAITING deadline");
      },
    });
    assert.equal(decision.action, "nudge");
    assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, 1);
    assert.equal((decision as { reason: string }).reason, "stale-waiting");
  });

  test("a WAITING deadline within the clock-skew tolerance is still current and auto-arms normally", () => {
    let armedAt: string | null = null;
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState(),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T11:59:58Z",
      now: "2026-09-27T12:00:00Z", // 2s past the deadline, inside the 5s tolerance
      queryTimers: () => [],
      armTimer: (at) => {
        armedAt = at;
        return { id: "t1", at };
      },
    });
    assert.equal(decision.action, "release");
    assert.equal(armedAt, "2026-09-27T11:59:58Z");
  });

  test("three consecutive stale WAITING stops hit the three-strike cap and write the incident", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: MAX_NUDGES }),
      pushDetected: false,
      reportCounted: false,
      marker: "waiting",
      waitingDeadline: "2026-09-27T11:00:00Z",
      now: "2026-09-27T12:00:00Z",
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "release-exhausted");
    assert.equal((decision as { writeIncident: boolean }).writeIncident, true);
  });
});

describe("evaluateSettle: nudge and strike cap", () => {
  test("nudges and increments the count when nothing releases the turn", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: 0 }),
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "nudge");
    assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, 1);
  });

  test("allows up to MAX_NUDGES consecutive nudges", () => {
    for (let count = 0; count < MAX_NUDGES; count++) {
      const decision = evaluateSettle({
        outcome: "completed",
        state: armedState({ nudgeCount: count }),
        pushDetected: false,
        reportCounted: false,
        marker: null,
        waitingDeadline: null,
        queryTimers: noTimers,
        armTimer: noArm,
      });
      assert.equal(decision.action, "nudge", `nudge #${count + 1}`);
      assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, count + 1);
    }
  });

  test("the stop after MAX_NUDGES nudges is allowed and calls for an incident", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: MAX_NUDGES }),
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "release-exhausted");
    assert.equal((decision as { writeIncident: boolean }).writeIncident, true);
  });

  test("a repeated exhausted stop in the same chain does not write a second incident", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: MAX_NUDGES, chainIncidentWritten: true }),
      pushDetected: false,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal(decision.action, "release-exhausted");
    assert.equal((decision as { writeIncident: boolean }).writeIncident, false);
  });

  test("a turn that starts from a push resets the count before deciding", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: MAX_NUDGES, chainIncidentWritten: true }),
      pushDetected: true,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    // Reset to 0 first, so this settles as nudge #1 of a fresh chain rather than exhausted.
    assert.equal(decision.action, "nudge");
    assert.equal((decision as { newState: ContinuationState }).newState.nudgeCount, 1);
  });

  test("a push reset also clears chainIncidentWritten for the new chain", () => {
    const decision = evaluateSettle({
      outcome: "completed",
      state: armedState({ nudgeCount: MAX_NUDGES, chainIncidentWritten: true }),
      pushDetected: true,
      reportCounted: false,
      marker: null,
      waitingDeadline: null,
      queryTimers: noTimers,
      armTimer: noArm,
    });
    assert.equal((decision as { newState: ContinuationState }).newState.chainIncidentWritten, false);
  });
});
