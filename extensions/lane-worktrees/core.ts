// Pure helpers for lane-worktrees (frozen seam S9). No pi imports.

import { basename } from "node:path";
import { parseBrief } from "../loop-state/core.ts";

export const STATE_CUSTOM_TYPE = "lane-worktrees-state";

export interface LaneBrief {
  lane: string;
  task: string;
  landing: string;
}

const LANDING_RE = /^Landing:\s*(returns candidate|pushes branch \S+)\s*$/m;
const LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A brief whose header names the lane and task and whose `Landing:` is a candidate or a branch. */
export function parseLaneBrief(task: unknown): LaneBrief | null {
  const brief = parseBrief(task);
  if (!brief || typeof task !== "string") return null;
  const landing = LANDING_RE.exec(task);
  if (!landing) return null;
  return { lane: brief.lane, task: brief.task, landing: landing[1] };
}

/** A lane id that is one safe path component and one git ref component. */
export function safeLaneId(id: string): boolean {
  return LANE_ID_RE.test(id) && !id.includes("..") && !id.endsWith(".lock") && !id.endsWith(".");
}

/** `loop/<run-dir basename>/<lane-id>`. */
export function laneBranch(runDir: string, lane: string): string {
  return `loop/${basename(runDir.replace(/\/+$/, ""))}/${lane}`;
}

/** Root `land` and `park` events after `afterSeq` in a state log's text, with the highest seq seen. */
export function landParkEvents(logText: string, afterSeq: number): { events: { ev: "land" | "park"; task: string; seq: number }[]; maxSeq: number } {
  const events: { ev: "land" | "park"; task: string; seq: number }[] = [];
  let maxSeq = afterSeq;
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const seq = typeof e.seq === "number" ? e.seq : 0;
    if (seq > maxSeq) maxSeq = seq;
    if (seq <= afterSeq || e.by !== "root") continue;
    if ((e.ev === "land" || e.ev === "park") && typeof e.task === "string") events.push({ ev: e.ev, task: e.task, seq });
  }
  return { events, maxSeq };
}

/** The run id of an async `subagent` launch from its tool result (`details.runId`, `details.asyncId`, or the text). */
export function launchedRunId(result: unknown): string | undefined {
  const r = result as { details?: { runId?: unknown; asyncId?: unknown }; content?: { text?: unknown }[] } | undefined;
  if (typeof r?.details?.runId === "string" && r.details.runId) return r.details.runId;
  if (typeof r?.details?.asyncId === "string" && r.details.asyncId) return r.details.asyncId;
  for (const part of r?.content ?? []) {
    const m = typeof part?.text === "string" ? /Async[^:\n]*:[^[\n]*\[([^\]\s]+)\]/.exec(part.text) : null;
    if (m) return m[1];
  }
  return undefined;
}
