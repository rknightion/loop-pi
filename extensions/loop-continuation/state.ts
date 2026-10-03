// Pure decision logic for the C7 continuation contract. No pi
// runtime imports here, so this module (and its reducer) is unit-testable without a live session.

import type { LaunchInfo } from "./launch-detect.ts";
import type { OpsGrants } from "./ops-grants.ts";

export const STATE_CUSTOM_TYPE = "loop-continuation-state";
export const NUDGE_CUSTOM_TYPE = "loop-continuation";

/** Custom message types that start a root turn by pushing new work (SEAMS.md "Names and paths"). */
export const PUSH_CUSTOM_TYPES: ReadonlySet<string> = new Set(["subagent-notify", "loop-watch", "loop-wake"]);

export const MAX_NUDGES = 3;

/**
 * A WAITING deadline at or before now (minus this tolerance) is stale, not current: it can only
 * have survived from a stop that predates this settle boundary (a hung timer, a resumed session,
 * clock drift), never a deadline the root just wrote for the future. The tolerance absorbs the
 * ordinary gap between the root composing the line and this boundary evaluating it, so a
 * deadline that is merely imminent (or a few seconds overdue) still counts as current.
 */
export const WAITING_STALE_TOLERANCE_MS = 5000;

/** Why a "nudge" decision was reached, for wording the nudge text. */
export type NudgeReason = "unmarked" | "stale-waiting" | "close-out";

/** The reason on the loop-wait timer this extension arms to back a WAITING deadline. */
export const AUTO_ARM_REASON = "loop-continuation auto-arm for WAITING deadline";

/** The part of `loop-state digest --json` the close-out check reads. */
export interface CloseOutDigest {
  live_lanes: number;
  admissible: string[];
}

export interface ContinuationState {
  armed: boolean;
  launch: LaunchInfo | null;
  /** Nudges already sent in the current unbroken chain. */
  nudgeCount: number;
  /** Whether the chain-exhausted incident has already been written for this chain. */
  chainIncidentWritten: boolean;
  /** Absolute path of the ops file named by the launch's `Ops grants:` line; absent without one. */
  opsPath?: string | null;
  /** The ops grants frozen at launch. null: no ops line, or one that was rejected. */
  ops?: OpsGrants | null;
}

export const INITIAL_STATE: ContinuationState = {
  armed: false,
  launch: null,
  nudgeCount: 0,
  chainIncidentWritten: false,
};

export type AgentActivityOutcome = "completed" | "aborted" | "error";

export interface ArmedTimer {
  id: string;
  at: string; // ISO
  reason: string;
}

export interface SettleInput {
  outcome: AgentActivityOutcome;
  state: ContinuationState;
  /** True when this turn was started by a push message (resets the strike count). */
  pushDetected: boolean;
  reportCounted: boolean;
  marker: "paused" | "waiting" | null;
  /** The WAITING line's deadline (ISO), present only when marker === "waiting". */
  waitingDeadline: string | null;
  /** Current time (ISO), for staleness checks against `waitingDeadline`. Defaults to Date.now(). */
  now?: string;
  /** Every armed, unfired, uncancelled loop-wait timer, or null when loop-wait did not reply. */
  queryTimers: () => ArmedTimer[] | null;
  /** Arms a loop-wait timer at `at`; returns the arming reply, or null when it did not reply. */
  armTimer: (at: string, reason: string) => { id: string; at: string } | null;
  /**
   * Close-out inputs, supplied only when a digest could have been read. `digest` is null when
   * the binary, the log or the output is unusable; `queryWatchers` returns every active
   * loop-wait watcher, or null when loop-wait did not reply.
   */
  closeOut?: { digest: CloseOutDigest | null; queryWatchers: () => unknown[] | null };
}

/** True when the digest shows no live lane and nothing admissible. */
export function digestIsDrained(digest: CloseOutDigest | null): boolean {
  return digest !== null && digest.live_lanes === 0 && digest.admissible.length === 0;
}

export type SettleDecision =
  | { action: "skip" }
  | { action: "release"; newState: ContinuationState }
  | { action: "release-exhausted"; newState: ContinuationState; writeIncident: boolean }
  | { action: "nudge"; newState: ContinuationState; reason: NudgeReason };

function released(state: ContinuationState): ContinuationState {
  return { ...state, nudgeCount: 0, chainIncidentWritten: false };
}

/** True when a WAITING deadline is stale: at or before `nowIso`, past the clock-skew tolerance. */
function isStaleWaitingDeadline(deadlineIso: string, nowIso: string): boolean {
  const deadlineEpoch = Date.parse(deadlineIso);
  const nowEpoch = Date.parse(nowIso);
  if (Number.isNaN(deadlineEpoch) || Number.isNaN(nowEpoch)) return false;
  return deadlineEpoch <= nowEpoch - WAITING_STALE_TOLERANCE_MS;
}

/**
 * Evaluate one `agent_before_settle` boundary against the C7 contract:
 *   - skip on an aborted or error outcome, or when not armed;
 *   - release when the report counts, the last line is a current PAUSED:, or the last line is a
 *     current (non-stale) WAITING: backed by an armed timer at or before its deadline (auto-arming
 *     one when none covers it, provided loop-wait replies at all);
 *   - a WAITING: line whose deadline is already at or before now (past the clock-skew tolerance) is
 *     NOT current: it is never queried or auto-armed, and falls straight into the same nudge path as
 *     an unmarked stop below, with `reason: "stale-waiting"` so the nudge text tells the root its
 *     deadline has passed and it must reconcile;
 *   - before the WAITING check, close out (`reason: "close-out"`) when the digest is drained and
 *     nothing but the auto-arm is armed;
 *   - otherwise nudge (`reason: "unmarked"`), up to MAX_NUDGES per chain; the next stop after that
 *     is allowed (release-exhausted) and, the first time in the chain, calls for an incident file.
 * A push-started turn resets the chain before any of the above is evaluated.
 */
export function evaluateSettle(input: SettleInput): SettleDecision {
  if (input.outcome !== "completed") return { action: "skip" };
  if (!input.state.armed || !input.state.launch) return { action: "skip" };

  const state = input.pushDetected
    ? { ...input.state, nudgeCount: 0, chainIncidentWritten: false }
    : input.state;

  if (input.reportCounted) {
    return { action: "release", newState: released(state) };
  }

  if (input.marker === "paused") {
    return { action: "release", newState: released(state) };
  }

  const nowIso = input.now ?? new Date().toISOString();
  const stale =
    input.marker === "waiting" && input.waitingDeadline
      ? isStaleWaitingDeadline(input.waitingDeadline, nowIso)
      : false;

  // Close-out: a WAITING that would be released, or a plain stop that would be nudged, ends the run
  // instead when the state log shows nothing live and nothing admissible and nothing but this
  // extension's own auto-arm is armed to wake the session. It still counts as a nudge, so the
  // strike cap bounds it.
  if (input.closeOut && state.nudgeCount < MAX_NUDGES && digestIsDrained(input.closeOut.digest)) {
    const timers = input.queryTimers();
    const watchers = input.closeOut.queryWatchers();
    if (timers !== null && watchers !== null && watchers.length === 0 && timers.every((t) => t.reason === AUTO_ARM_REASON)) {
      return { action: "nudge", newState: { ...state, nudgeCount: state.nudgeCount + 1 }, reason: "close-out" };
    }
  }

  if (input.marker === "waiting" && input.waitingDeadline && !stale) {
    const timers = input.queryTimers();
    if (timers !== null) {
      const deadlineEpoch = Date.parse(input.waitingDeadline);
      const covered = timers.some((t) => {
        const atEpoch = Date.parse(t.at);
        return !Number.isNaN(atEpoch) && !Number.isNaN(deadlineEpoch) && atEpoch <= deadlineEpoch;
      });
      if (covered) {
        return { action: "release", newState: released(state) };
      }
      const armed = input.armTimer(input.waitingDeadline, AUTO_ARM_REASON);
      if (armed) {
        return { action: "release", newState: released(state) };
      }
      // loop-wait replied to the query but not to arm-timer: fall through to nudge rather than
      // release a WAITING turn with nothing actually armed to wake it.
    }
    // timers === null: loop-wait did not reply to the query at all (not loaded). Do not release
    // a WAITING turn on trust alone; fall through to nudge.
  }
  // A stale WAITING deadline falls straight through to here without ever querying or arming a
  // timer for a deadline that has already passed.

  const reason: NudgeReason = stale ? "stale-waiting" : "unmarked";

  if (state.nudgeCount >= MAX_NUDGES) {
    return {
      action: "release-exhausted",
      newState: { ...state, nudgeCount: state.nudgeCount, chainIncidentWritten: true },
      writeIncident: !state.chainIncidentWritten,
    };
  }

  return { action: "nudge", newState: { ...state, nudgeCount: state.nudgeCount + 1 }, reason };
}
