// Fixed text of the "Turn endings" block of the v3 pi harness file (harness-pi.md). Every loop-pi
// root reads that block at launch; this extension re-sends the identical block as the nudge so a
// root that stops without it gets the same reminder it was given at launch.
import type { NudgeReason } from "./state.ts";

export const NUDGE_TEXT = [
  "## Turn endings",
  "",
  "A message with no tool call ends your turn. Never end a turn with a summary that announces the next",
  "step, an offer to carry on, a list of decisions none of which blocks the remaining work, or a",
  "decision that this is a good place to stop. End a turn only when the closeout is written, when",
  "paused, or when a lane, a watch_start watcher or a wake_at timer will wake this session; when",
  "waiting, arm wake_at and make the last line `WAITING: <what> until <YYYY-MM-DDTHH:MM[:SS]Z>`; when",
  "paused, `PAUSED: <reason>`. Launch each lane as its own subagent call.",
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

/** Sent when no lane is live and nothing is armed to wake the session. It never leads with an owner
 *  control phrase: the root decides from the board whether work remains (contract sections 2, 12). */
export const IDLE_TEXT = [
  "## No lane is live and nothing will wake this session",
  "",
  "No lane is running and no watch_start watcher or wake_at timer is armed, so a WAITING line waits on",
  "nothing. Dispatch the next ready, unexcluded task from the board in the charter's priority order",
  "(contract section 2). If none remains in the charter's scope, run the closeout sweep and write the",
  "closeout file (contract section 12). Otherwise end with `PAUSED: <reason>`.",
].join("\n");

export const EXPIRED_PARK_NOTE = [
  "## A time-gated park deadline has passed",
  "",
  "Reevaluate the recorded evidence-later park now. Its clock is a wake source, not permission to",
  "bypass evidence or authority: resume work if its condition is satisfied, otherwise record a fresh",
  "condition and deadline or PAUSED reason. Do not close out merely because the task is parked.",
].join("\n");

/** The nudge message body for a given nudge reason. */
export function nudgeTextFor(reason: NudgeReason): string {
  if (reason === "idle") return IDLE_TEXT;
  if (reason === "expired-park") return `${EXPIRED_PARK_NOTE}\n\n${NUDGE_TEXT}`;
  return reason === "stale-waiting" ? `${STALE_WAITING_NOTE}\n\n${NUDGE_TEXT}` : NUDGE_TEXT;
}
