// Goal and LOOP.md parsing, and the planner predicate for a dispatcher root (SEAMS.md S4, S5, S7).
//
// The goal format is the campaign's frozen one:
//
//   ## Run                 key: value lines: tier, root (`llm|dispatcher - <reason>`), root-model, concurrency
//   ## Envelope            a markdown table with exactly these columns:
//                          | task | acceptance check | owned files | gate | landing | agent | tier |
//   ## Authority           key: value lines: push agents, ops (`<path> sha256=<hex>` | none),
//                          secret paths, credential creation
//
// Owned files are comma-separated globs. A cell wrapped in one pair of backticks is unwrapped and
// `\|` stands for a literal pipe. The table carries no objective: the dispatcher takes it from the
// task's backlog title.

import { guardedHits } from "./glob.ts";

export interface TaskSpec {
  id: string;
  objective: string;
  acceptance: string;
  owned: string[];
  gate: string;
  landing: string;
  agent: string;
  tier: string;
  stop?: string;
  escalation?: string;
  deadline?: string;
}

export interface Goal {
  run: Record<string, string>;
  tasks: TaskSpec[];
  authority: Record<string, string>;
  sections: string[];
  /** Envelope table problems: a missing or extra column, a short row. */
  errors: string[];
}

export interface LoopMd {
  keys: Record<string, string>;
}

export const ENVELOPE_COLUMNS = ["task", "acceptance check", "owned files", "gate", "landing", "agent", "tier"];

function unwrap(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith("`") && v.endsWith("`") ? v.slice(1, -1).trim() : v;
}

function keyValue(line: string): [string, string] | undefined {
  const m = /^\s*(?:[-*]\s+)?([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/.exec(line);
  return m ? [m[1].toLowerCase(), unwrap(m[2])] : undefined;
}

/** Comma-separated items; a comma inside `{...}` belongs to a glob. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if ((c === "," && depth === 0) || i === value.length) {
      out.push(unwrap(value.slice(start, i)));
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}

/** Cells of one table row; `\|` is a literal pipe. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => unwrap(c.replace(/\\\|/g, "|")));
}

function parseEnvelope(lines: string[], errors: string[]): TaskSpec[] {
  const rows = lines.filter((l) => l.trim().startsWith("|"));
  if (!rows.length) {
    errors.push("## Envelope has no table");
    return [];
  }
  const header = cells(rows[0]).map((c) => c.toLowerCase());
  if (header.join("|") !== ENVELOPE_COLUMNS.join("|")) {
    errors.push(`## Envelope columns are '${header.join(" | ")}', not '${ENVELOPE_COLUMNS.join(" | ")}'`);
    return [];
  }
  const tasks: TaskSpec[] = [];
  for (const row of rows.slice(1)) {
    const c = cells(row);
    if (c.every((x) => /^:?-{3,}:?$/.test(x))) continue;
    if (c.length !== ENVELOPE_COLUMNS.length) {
      errors.push(`## Envelope row has ${c.length} cells, not ${ENVELOPE_COLUMNS.length}: ${row.trim()}`);
      continue;
    }
    const [id, acceptance, owned, gate, landing, agent, tier] = c;
    tasks.push({ id, objective: "", acceptance, owned: splitList(owned), gate, landing, agent, tier });
  }
  return tasks;
}

export function parseGoal(text: string): Goal {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\S.*?)\s*$/.exec(line);
    if (h && !line.startsWith("###")) {
      current = h[1];
      sections.set(current, []);
    } else if (current) {
      sections.get(current)!.push(line);
    }
  }
  const kv = (name: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of sections.get(name) ?? []) {
      const pair = keyValue(line);
      if (pair && !(pair[0] in out)) out[pair[0]] = pair[1];
    }
    return out;
  };
  const errors: string[] = [];
  const tasks = parseEnvelope(sections.get("Envelope") ?? [], errors);
  return { run: kv("Run"), tasks, authority: kv("Authority"), sections: [...sections.keys()], errors };
}

/** The composed gate: LOOP.md `gate:`, else the one gate every task shares. */
export function composedGate(goal: Goal, loop: LoopMd): string | undefined {
  if (loop.keys.gate) return loop.keys.gate;
  const gates = new Set(goal.tasks.map((t) => t.gate));
  return gates.size === 1 ? [...gates][0] || undefined : undefined;
}

/** The key: value lines that open LOOP.md, up to the first `## ` heading; the first of a key wins.
 *  This is exactly loop-state's reading (`read_loop_md_keys` in bin/loop-state): the value is the
 *  rest of the line with its surrounding blanks trimmed and nothing else removed, so
 *  `release-on-push: no (tags only)` is not `no`. A test runs both readers on the same files. */
export function parseLoopMd(text: string | null | undefined): LoopMd {
  const keys: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (line.startsWith("## ")) break;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m && !Object.hasOwn(keys, m[1])) keys[m[1]] = m[2];
  }
  return { keys };
}

export function hasOpsGrant(goal: Goal): boolean {
  const ops = goal.authority.ops ?? "";
  return ops !== "" && !/^none\b/i.test(ops);
}

export function guardedExtra(loop: LoopMd): string[] {
  return splitList(loop.keys["guarded-paths"] ?? "");
}

/** S4: land-before-green needs a routine repo that neither releases nor deploys on push and whose
 *  LOOP.md carries no `baseline-red` (a main known to be red). The
 *  fourth leg, `ci-required` matching the branch-protection required checks, is loop-lint's: it
 *  reads them through `gh api` when the goal and LOOP.md are written. Neither this check nor
 *  loop-state's (which is offline) repeats it. */
export function preGreenEligible(loop: LoopMd): boolean {
  return (
    loop.keys.tier === "routine" &&
    loop.keys["release-on-push"] === "no" &&
    loop.keys["deploy-on-push"] === "no" &&
    !Object.hasOwn(loop.keys, "baseline-red")
  );
}

/** The tier a task runs at: guarded when its owned files touch the guarded set (S4 decision 4),
 *  else its Envelope tier, else the repo's. */
export function effectiveTier(task: TaskSpec, loop: LoopMd, files: readonly string[] = []): string {
  if (guardedHits(task.owned, guardedExtra(loop), files).length) return "guarded";
  return task.tier || loop.keys.tier || "guarded";
}

export function canPush(agent: string): boolean {
  return agent.endsWith("-push");
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

/** S7 planner predicate: a dispatcher root only when every task is routine with owned files, an
 *  acceptance check, a gate and `lands-*` landing; no ops grant; at least three tasks; and LOOP.md
 *  carries no `baseline-red`, whose base-versus-integrated gate judgement only an LLM root makes.
 *  The Envelope table has no dependency column, so file order (overlapping owned files run in table
 *  order) is the only ordering there is. Pure: takes the goal and LOOP.md text (or their parsed forms) and,
 *  optionally, the repository's tracked files for the guarded-path check. */
export function dispatcherEligible(
  goal: string | Goal,
  loopMd: string | LoopMd | null | undefined,
  files: readonly string[] = [],
): Eligibility {
  const g = typeof goal === "string" ? parseGoal(goal) : goal;
  const loop = typeof loopMd === "object" && loopMd !== null ? loopMd : parseLoopMd(loopMd);
  const reasons: string[] = [...g.errors];
  if (g.tasks.length < 3) reasons.push(`the Envelope has ${g.tasks.length} task(s); a dispatcher needs at least 3`);
  if (hasOpsGrant(g)) reasons.push("the goal grants ops");
  if (Object.hasOwn(loop.keys, "baseline-red")) {
    reasons.push(`LOOP.md carries \`baseline-red: ${loop.keys["baseline-red"]}\`; a known-red main needs an LLM root`);
  }
  const ids = new Set<string>();
  for (const t of g.tasks) {
    if (ids.has(t.id)) reasons.push(`task id ${t.id} appears twice`);
    ids.add(t.id);
    if (!t.acceptance) reasons.push(`${t.id}: no acceptance check`);
    if (!t.owned.length) reasons.push(`${t.id}: no owned files`);
    if (!t.gate) reasons.push(`${t.id}: no gate`);
    if (!t.agent) reasons.push(`${t.id}: no agent route`);
    if (t.landing !== "lands-after-green" && t.landing !== "lands-pre-green") {
      reasons.push(`${t.id}: landing is '${t.landing || "missing"}', not lands-after-green or lands-pre-green`);
    } else if (t.agent && !canPush(t.agent)) {
      reasons.push(`${t.id}: landing ${t.landing} needs a -push agent, not ${t.agent}`);
    }
    if (t.landing === "lands-pre-green" && !preGreenEligible(loop)) {
      reasons.push(`${t.id}: lands-pre-green in a repo that is not land-before-green eligible`);
    }
    const hits = guardedHits(t.owned, guardedExtra(loop), files);
    if (hits.length) reasons.push(`${t.id}: owned files touch guarded paths (${hits.join(", ")})`);
    else if (effectiveTier(t, loop, files) !== "routine") reasons.push(`${t.id}: tier ${effectiveTier(t, loop, files)}`);
  }
  return { eligible: reasons.length === 0, reasons };
}
