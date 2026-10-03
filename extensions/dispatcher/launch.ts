// Reads the S1 launch message the dispatcher is started with: the same text an LLM root gets, or
// the path of a launch file holding it. Pure apart from the injected file reader.

import { basename, dirname, isAbsolute, join } from "node:path";

export interface Launch {
  goal: string;
  report: string;
  log: string;
  repo: string;
  opsLine: boolean;
}

const GOAL_RE = /(\/\S*\/codex\/goal-[^\s`'"]+\.md)\b/;
const REPORT_RE = /(\/\S*\/codex\/report-[^\s`'"]+-loop\d+\.md)\b/;

/** `report-<c>-loop<N>.md` -> `state-<c>-loop<N>.jsonl` beside it (S2). */
export function stateLogFor(report: string): string {
  return join(dirname(report), basename(report).replace(/^report-/, "state-").replace(/\.md$/, ".jsonl"));
}

export function parseLaunch(text: string, readFile: (path: string) => string | undefined): Launch | { error: string } {
  let body = text.trim();
  if (isAbsolute(body) && !/\s/.test(body) && /\.(txt|md)$/.test(body)) {
    const content = readFile(body);
    if (content === undefined) return { error: `cannot read the launch file ${body}` };
    body = content;
  }
  const goal = GOAL_RE.exec(body)?.[1];
  const report = REPORT_RE.exec(body)?.[1];
  if (!goal) return { error: "the launch message names no absolute <repo>/codex/goal-*.md path" };
  if (!report) return { error: "the launch message names no absolute <repo>/codex/report-<name>-loop<N>.md path" };
  return { goal, report, log: stateLogFor(report), repo: dirname(dirname(report)), opsLine: /^\s*Ops grants:/m.test(body) };
}
