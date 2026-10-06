// Lane briefs (SEAMS.md S3) built from the Envelope, and the two blocks the dispatcher reads back:
// a lane's `lane-return` (v2) and a triager's `triage` decision.

import { splitList, type TaskSpec } from "./goal.ts";

export const ATTEMPT_CEILING = 4;

const DEFAULT_STOP = "Stop when the acceptance check and the gate pass on your landed candidate, or when the next step needs a file outside Owned files.";
const DEFAULT_ESCALATION = "Return status blocked with the question in `questions`; do not guess.";

export interface BriefFields {
  lane: string;
  task: string;
  tier: string;
  objective: string;
  owned: string;
  acceptance: string;
  gate: string;
  landing: string;
  stop: string;
  escalation: string;
  deadline?: string;
}

export function renderBrief(f: BriefFields): string {
  const lines = [
    `Lane: ${f.lane} · Task: ${f.task} · Tier: ${f.tier}`,
    `Objective: ${f.objective}`,
    `Owned files: ${f.owned}`,
    `Acceptance check: ${f.acceptance}`,
    `Gate: ${f.gate}`,
    `Landing: ${f.landing}`,
    `Stop rule: ${f.stop}`,
    `Escalation: ${f.escalation}`,
  ];
  if (f.deadline) lines.push(`Deadline: ${f.deadline}`);
  return lines.join("\n");
}

/** An implementation lane's brief, exactly the S3 lines, from the task's Envelope entry. */
export function taskBrief(task: TaskSpec, lane: string, tier: string): string {
  return renderBrief({
    lane,
    task: task.title ? `${task.id} (${task.title})` : task.id,
    tier,
    objective: task.objective,
    owned: task.owned.join(", "),
    acceptance: task.acceptance,
    gate: task.gate,
    landing: task.landing,
    stop: task.stop || DEFAULT_STOP,
    escalation: task.escalation || DEFAULT_ESCALATION,
    deadline: task.deadline,
  });
}

/** The composed gate on the integrated SHA, run once by a gate-runner (S10 "Gate once"). */
export function gateBrief(lane: string, tasks: string[], tier: string, sha: string, cmd: string): string {
  return renderBrief({
    lane,
    task: tasks.join(","),
    tier,
    objective:
      `Run the composed gate once on ${sha}, the integrated SHA after tasks ${tasks.join(", ")} landed, in a ` +
      "detached worktree of that SHA, and classify every failure with evidence. Do not repair source.",
    owned: "none",
    acceptance: `\`${cmd}\` exits 0 at ${sha}`,
    gate: cmd,
    landing: "returns candidate",
    stop: "Stop after one run of the gate.",
    escalation: "Return status failed with the failing tail; never edit a file.",
  });
}

/** A triager decides what follows a non-complete return: retry, park or split. */
export function triageBrief(
  lane: string,
  task: TaskSpec,
  tier: string,
  failedLane: string,
  failedBrief: string,
  failedReturn: string,
  attemptsUsed: number,
): string {
  const head = renderBrief({
    lane,
    task: task.id,
    tier,
    objective:
      `Lane ${failedLane} did not complete task ${task.id} (${attemptsUsed} of ${ATTEMPT_CEILING} attempts used). ` +
      "Read its brief and return below, inspect the repository read-only, and decide one action: retry with " +
      "a revised brief, park with the class of what it needs, or split into briefs whose owned files lie " +
      "inside this task's owned files. Gate and Landing stay as they are.",
    owned: "none (read-only; backlog notes only)",
    acceptance: "the final message ends with exactly one triage block in the shape below",
    gate: "none",
    landing: "returns candidate",
    stop: "Stop once you can name the action and its reason.",
    escalation: "Decide park with needs owner when only the owner can decide.",
  });
  return [
    head,
    "",
    "Park needs `authority` only for a write, credential use, destructive, spend or outward action that " +
      "neither the standing line, the standing file, the goal nor its frozen grants cover. Never for an " +
      "owned-files gap (amend or add a follow-up task; `dependency` if neither fits), a reached ceiling " +
      "(`defect`), a tool, provider, preflight, review-service or harness failure (`defect`, naming the " +
      "tool), or a read (reads are standing).",
    "",
    "End with exactly one block:",
    "```triage",
    `{"v":1,"lane":"${lane}","decision":"retry|park|split","reason":"<why>","brief":"<revised 7-field brief, for retry>",` +
      '"needs":"owner|authority|evidence-later|dependency|defect (for park)","split":["<7-field brief>", "..."]}',
    "```",
    "",
    "Failed brief:",
    "```",
    failedBrief,
    "```",
    "",
    "Failed return:",
    "```",
    failedReturn,
    "```",
  ].join("\n");
}

/** The S3 fields of a brief, by name; the header line and unknown lines are ignored. */
export function parseBriefFields(brief: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of brief.split(/\r?\n/)) {
    const m = /^(Objective|Owned files|Acceptance check|Gate|Landing|Stop rule|Escalation|Deadline):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

export interface LaneReturn {
  lane?: string;
  status: "complete" | "partial" | "blocked" | "failed";
  sha: string | null;
  landed: boolean;
  base?: string;
  check?: string;
  exit: number | null;
  ci: string | null;
  coderabbit?: { ran: boolean; major: number; unreviewed: number } | null;
  questions: string[];
  parsed: boolean;
  /** pi-subagents reported the run failed or timed out; the block's own claims are evidence only. */
  runFailed?: boolean;
}

/** A failed run's return: never complete and never landed, whatever its block says. */
export function failedRunReturn(r: LaneReturn): LaneReturn {
  return { ...r, status: r.status === "complete" ? "failed" : r.status, landed: false, runFailed: true };
}

function lastFenced(text: string, tag: string): string | undefined {
  const re = new RegExp("```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```", "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}

const STATUSES = new Set(["complete", "partial", "blocked", "failed"]);

/** The last `lane-return` block. A missing or malformed block reads as a failed return. */
export function parseLaneReturn(text: string): LaneReturn {
  const failed: LaneReturn = { status: "failed", sha: null, landed: false, exit: null, ci: null, questions: [], parsed: false };
  const body = lastFenced(text, "lane-return");
  if (!body) return failed;
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return failed;
  }
  if (!data || typeof data !== "object" || data.v !== 2 || !STATUSES.has(data.status)) return failed;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const cr = data.coderabbit;
  return {
    lane: str(data.lane),
    status: data.status,
    sha: str(data.sha) ?? null,
    landed: data.landed === true,
    base: str(data.base),
    check: str(data.check),
    exit: Number.isInteger(data.exit) ? data.exit : null,
    ci: str(data.ci) ?? null,
    coderabbit:
      cr && typeof cr === "object" && typeof cr.ran === "boolean" && Number.isInteger(cr.major) && Number.isInteger(cr.unreviewed)
        ? { ran: cr.ran, major: cr.major, unreviewed: cr.unreviewed }
        : null,
    questions: Array.isArray(data.questions) ? data.questions.filter((q: unknown) => typeof q === "string") : [],
    parsed: true,
  };
}

/** What a triager may change in a brief. Gate and Landing are never taken from it. */
export interface RevisedBrief {
  objective: string;
  owned: string[];
  acceptance: string;
  stop?: string;
  escalation?: string;
}

export type Triage =
  | { action: "retry"; brief: RevisedBrief; reason: string }
  | { action: "park"; needs: string; reason: string }
  | { action: "split"; reason: string; tasks: RevisedBrief[] }
  | { action: "none"; reason: string };

export const PARK_NEEDS = new Set(["owner", "authority", "evidence-later", "dependency", "defect"]);

function revised(brief: unknown): RevisedBrief | undefined {
  if (typeof brief !== "string") return undefined;
  const f = parseBriefFields(brief);
  const owned = splitList(f["Owned files"] ?? "");
  if (!f.Objective || !owned.length || !f["Acceptance check"]) return undefined;
  return { objective: f.Objective, owned, acceptance: f["Acceptance check"], stop: f["Stop rule"] || undefined, escalation: f.Escalation || undefined };
}

export function parseTriage(text: string): Triage {
  const body = lastFenced(text, "triage");
  if (!body) return { action: "none", reason: "the triager returned no triage block" };
  let d: any;
  try {
    d = JSON.parse(body);
  } catch {
    return { action: "none", reason: "the triage block is not JSON" };
  }
  if (d?.v !== 1) return { action: "none", reason: "the triage block is not v 1" };
  const reason = typeof d.reason === "string" && d.reason ? d.reason : "no reason given";
  if (d.decision === "retry") {
    const brief = revised(d.brief);
    return brief ? { action: "retry", brief, reason } : { action: "none", reason: "retry without a brief carrying Objective, Owned files and Acceptance check" };
  }
  if (d.decision === "park") {
    return PARK_NEEDS.has(d.needs) ? { action: "park", needs: d.needs, reason } : { action: "none", reason: `park with an unknown needs class (${String(d.needs)})` };
  }
  if (d.decision === "split") {
    const tasks = Array.isArray(d.split) ? d.split.map(revised) : [];
    if (tasks.length && tasks.every(Boolean)) return { action: "split", reason, tasks: tasks as RevisedBrief[] };
    return { action: "none", reason: "a split brief lacks Objective, Owned files or Acceptance check" };
  }
  return { action: "none", reason: `the triage decision is not usable (${String(d.decision)})` };
}

/** The retry route for an agent: the retry variant keeps push authority (S9). */
export function retryAgent(agent: string): string {
  const push = agent.endsWith("-push");
  if (agent.startsWith("complex-worker")) return agent;
  return push ? "lane-worker-retry-push" : "lane-worker-retry";
}
