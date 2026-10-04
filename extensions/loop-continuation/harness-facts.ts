// Harness facts (frozen seam S1): `$LOOP_PI_RUN_DIR/harness-facts.jsonl`, one JSON object per line,
//   {"v":1,"ts":"<ISO>","kind":"compaction-failed"|"quota-exhausted"|"context-overflow","session":"<id>","detail":"<= 512 chars"}
// written only by loop-continuation. `loop-state` reads it to admit `close reason=budget`, so these are
// facts the root cannot forge: a failed compaction or overflow recovery pi reports, a request that
// ended on a usage or quota limit after pi's retries, a context overflow.

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const FACTS_FILE = "harness-facts.jsonl";
export type FactKind = "compaction-failed" | "quota-exhausted" | "context-overflow";
export const DETAIL_MAX_CHARS = 512;

/** Append one fact. No run dir, or any write failure: nothing is written and nothing throws. */
export function appendFact(runDir: string | undefined, kind: FactKind, session: string, detail: string, now: Date = new Date()): boolean {
  if (!runDir || !existsSync(runDir)) return false;
  const fact = { v: 1, ts: now.toISOString(), kind, session: session || "unknown", detail: Array.from(detail).slice(0, DETAIL_MAX_CHARS).join("") };
  try {
    appendFileSync(join(runDir, FACTS_FILE), `${JSON.stringify(fact)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** A provider error that is a usage, quota or rate limit (pi-ai's retry and limit wording). */
const QUOTA_RE =
  /usage.?limit|quota|insufficient_quota|rate.?limit|too many requests|\b429\b|out of budget|available balance|billing|UsageLimitError/i;

export function isQuotaError(message: { stopReason?: unknown; errorMessage?: unknown }): boolean {
  return message.stopReason === "error" && typeof message.errorMessage === "string" && QUOTA_RE.test(message.errorMessage);
}
