// Pure helpers for loop-wait's lane deadline timers: which deadline a launched lane gets, and the
// reason text that ties a timer to its run id so a completion can find and cancel it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BRIEF_DEADLINE_RE = /^[ \t]*Deadline:[ \t]*(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z)[ \t]*$/gm;

/** The brief's `Deadline: <ISO>` line (the latest one when several tasks carry one), as epoch ms. */
export function briefDeadlineMs(text: unknown): number | null {
  if (typeof text !== "string") return null;
  let latest: number | null = null;
  for (const m of text.matchAll(BRIEF_DEADLINE_RE)) {
    const ms = Date.parse(m[1]);
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** The latest brief deadline across a `subagent` call's `task` and `tasks[].task` (single and parallel forms). */
export function subagentArgsDeadlineMs(args: unknown): number | null {
  if (typeof args !== "object" || args === null) return null;
  const a = args as { task?: unknown; tasks?: unknown };
  const candidates: unknown[] = [a.task];
  if (Array.isArray(a.tasks)) for (const t of a.tasks) candidates.push((t as { task?: unknown } | null)?.task);
  let latest: number | null = null;
  for (const c of candidates) {
    const ms = briefDeadlineMs(c);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** `timeoutMs:` from an agent file's frontmatter, or null. */
export function agentFileTimeoutMs(agentDir: string, agent: unknown): number | null {
  if (typeof agent !== "string" || !/^[A-Za-z0-9._-]+$/.test(agent)) return null;
  const path = join(agentDir, "agents", `${agent}.md`);
  if (!existsSync(path)) return null;
  try {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"));
    const m = front ? /^timeoutMs:\s*(\d+)\s*$/m.exec(front[1]) : null;
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export interface AsyncStartedPayload {
  id?: unknown;
  sessionId?: unknown;
  agent?: unknown;
  timeoutMs?: unknown;
  deadlineAt?: unknown;
}

const finiteNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Deadline for a lane timer: the payload's `deadlineAt`, else now + its `timeoutMs`, else now + the agent file's `timeoutMs`. */
export function payloadDeadlineMs(payload: AsyncStartedPayload, agentDir: string, nowMs: number): number | null {
  const deadlineAt = finiteNumber(payload.deadlineAt);
  if (deadlineAt !== null) return deadlineAt;
  const timeoutMs = finiteNumber(payload.timeoutMs) ?? agentFileTimeoutMs(agentDir, payload.agent);
  return timeoutMs !== null && timeoutMs > 0 ? nowMs + timeoutMs : null;
}

const LANE_REASON_RE = /^lane run=(\S+) /;

export function laneTimerReason(runId: string, agent: unknown): string {
  return `lane run=${runId} agent=${typeof agent === "string" ? agent : "unknown"} reached its deadline: check the lane`;
}

/** The run id a lane-timer reason names, or null for any other reason. */
export function runIdFromReason(reason: string): string | null {
  const m = LANE_REASON_RE.exec(reason);
  return m ? m[1] : null;
}
