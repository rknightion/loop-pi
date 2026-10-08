// Per-loop SUPER/MEGASUPER dispatch cap (root only). At most two SUPER and one MEGASUPER
// launches per loop run; a launch beyond that is refused before it starts.
//
// The count is read from the loop's own state log (`codex/state-<stem>-loop<N>.jsonl`, sibling of
// the report named by `loop-continuation:query-launch`): one per distinct `dispatch` run whose
// agent is in a tier set. loop-state writes those rows after each launch, so a root restart keeps
// the count. Launches this root allowed whose dispatch row is not in the log yet (a burst of calls
// in one message, or a brief without the lane header loop-state records) are added from memory.
// A block-only recovery dispatch (`recovery_of`) is the package re-asking one run for its return,
// not a launch, and never counts. Pure: root.ts owns the wiring.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type Tier = "super" | "megasuper";

export const SUPER_AGENTS: ReadonlySet<string> = new Set(["super-worker", "super-worker-push"]);
export const MEGASUPER_AGENTS: ReadonlySet<string> = new Set([
  "megasuper-worker",
  "megasuper-worker-push",
  "agent-workflows:megasuper-worker",
]);
export const TIER_LIMITS: Readonly<Record<Tier, number>> = { super: 2, megasuper: 1 };
export const TIER_CAP_REASON = "loop-guard: per-loop cap reached (2 SUPER, 1 MEGASUPER); park the task needs=owner";

export function agentTier(agent: unknown): Tier | null {
  if (typeof agent !== "string") return null;
  if (SUPER_AGENTS.has(agent)) return "super";
  if (MEGASUPER_AGENTS.has(agent)) return "megasuper";
  return null;
}

/** Run ids of every tier dispatch in a state log's text, by tier. */
export function loggedTierRuns(logText: string): Record<Tier, Set<string>> {
  const runs: Record<Tier, Set<string>> = { super: new Set(), megasuper: new Set() };
  for (const line of logText.split("\n")) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // A torn or empty line holds no dispatch.
    }
    if (row === null || typeof row !== "object" || row.ev !== "dispatch") continue;
    if (typeof row.run !== "string" || !row.run || row.recovery_of !== undefined) continue;
    const tier = agentTier(row.agent);
    if (tier) runs[tier].add(row.run);
  }
  return runs;
}

/** The state log for a launch's report path (SEAMS.md: `report-<name>.md` has the sibling
 *  `state-<name>.jsonl`), resolved against the root's cwd; null for any other report name. The
 *  mapping is restated rather than imported so loop-guard loads without the loop-state directory. */
export function stateLogFor(reportPath: string, cwd: string): string | null {
  const report = isAbsolute(reportPath) ? reportPath : resolve(cwd, reportPath);
  const m = /^report-(.+)\.md$/.exec(basename(report));
  return m ? join(dirname(report), `state-${m[1]}.jsonl`) : null;
}

/** The log's text; empty when the log does not exist yet. Any other read error throws. */
export function readStateLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

/** One launch this root allowed: its run id once the launch reported one. */
export interface AllowedLaunch {
  tier: Tier;
  runId?: string;
}

/** The refusal for launching one more agent of `tier`, else undefined. */
export function tierCapRefusal(tier: Tier, logged: Record<Tier, Set<string>>, allowed: Iterable<AllowedLaunch>): string | undefined {
  let count = logged[tier].size;
  for (const launch of allowed) {
    if (launch.tier === tier && (launch.runId === undefined || !logged[tier].has(launch.runId))) count++;
  }
  return count >= TIER_LIMITS[tier] ? TIER_CAP_REASON : undefined;
}
