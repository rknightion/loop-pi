// Fixed text of the pi "TURN ENDINGS" block, as carried by sources/loop/harness-pi.md. Every
// loop-pi root is given that block at launch; this extension re-sends the identical block as the
// nudge so a root that stops without it gets the same reminder it was given at launch.
import type { NudgeReason } from "./state.ts";

export const NUDGE_TEXT = [
  "## TURN ENDINGS: a message with no tool call stops the run",
  "",
  "A message with no tool call ends your turn. Four endings stop a run while work is still owed; do",
  "not use any of them:",
  "1. A summary of what was done that announces the next step without taking it.",
  "2. An offer to carry on unless the operator would prefer otherwise.",
  "3. A list of decisions when, by your own account, none of them blocks the remaining work.",
  "4. Deciding this is a good place to report because the turn was long or a milestone is done.",
  "Status notes and recommendations are welcome: put them in the same message as your next tool call",
  "and continue with whatever does not depend on an answer. End a turn only when the run-end report is",
  "written and pinged, when paused, or when a lane, a `watch_start` watcher or a `wake_at` timer will",
  "wake this session. When waiting, make the last line",
  "`WAITING: <what> until <YYYY-MM-DDTHH:MM[:SS]Z>` with a future deadline; arm `wake_at` for it",
  "first. When paused, make it `PAUSED: <reason>`. Never poll `subagent` status between wakes.",
  "Launch each lane as its own `subagent` call. Give any `bash` call that can run past 15 minutes a",
  "`timeout`, or run it under `watch_start`: the watchdog reads a longer silent turn as stalled.",
  "This does not override confirmation for risky or destructive actions.",
].join("\n");

// Prepended to NUDGE_TEXT when the stop's WAITING: deadline had already passed: that
// deadline is stale, not current, so it was never treated as a wake source and nothing was armed
// for it. The root must reconcile before ending its turn again.
export const STALE_WAITING_NOTE = [
  "## Your WAITING deadline has already passed",
  "",
  "Your last message ended with a `WAITING: ... until <deadline>` line, but that deadline is now at",
  "or before the current time, so it is stale, not a current wait: nothing was armed to wake this",
  "session on it. Reconcile what you were waiting on, then end this turn with either a fresh",
  "`WAITING: <what> until <deadline>` naming a deadline that is actually still in the future, or",
  "`PAUSED: <reason>` if there is nothing left to wait on.",
].join("\n");

/** Sent when the loop state log shows nothing admissible, no live lane and nothing armed to wake. */
export const CLOSE_OUT_TEXT = "close out: nothing admissible remains; generate the report and end the run";

export const EXPIRED_PARK_NOTE = [
  "## A time-gated park deadline has passed",
  "",
  "Reevaluate the recorded evidence-later park now. Its clock is a wake source, not permission to",
  "bypass evidence or authority: resume work if its condition is satisfied, otherwise record a fresh",
  "condition and deadline or PAUSED reason. Do not close out merely because the task is parked.",
].join("\n");

/** The nudge message body for a given nudge reason. */
export function nudgeTextFor(reason: NudgeReason): string {
  if (reason === "close-out") return CLOSE_OUT_TEXT;
  if (reason === "expired-park") return `${EXPIRED_PARK_NOTE}\n\n${NUDGE_TEXT}`;
  return reason === "stale-waiting" ? `${STALE_WAITING_NOTE}\n\n${NUDGE_TEXT}` : NUDGE_TEXT;
}
