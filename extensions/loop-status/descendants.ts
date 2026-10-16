// Runs launched by a lane's own pi process (depth 2 and below) as the root can see them.
//
// pi-subagents lists a session's background runs by the `sessionId` stamped on each run's
// `status.json`, which is the launching session's file path. A lane is a pi process with its own
// session file, so a run it launches carries the lane's path, never the root's: the root's
// `subagent status` neither lists it nor resolves its id ("Async run not found"). Every pi-subagents
// child session lives under the launching session's directory
// (`<sessions>/<root basename>/<run dir>/...`), so a run whose `sessionId` is inside the root's own
// directory is a descendant of the root. This module reads only that on-disk fact: the shared async
// run directory (`$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs`), its `.active-runs` marker index and
// each run's `status.json`. It writes nothing, and any unreadable or unexpected file is skipped, so
// a pi-subagents layout change shows no nested runs rather than failing the status call.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

const ACTIVE_INDEX = ".active-runs";
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;

export interface NestedRun {
  id: string;
  state: string;
  agent: string | null;
  mode: string | null;
  /** The run id of the parent lane when this session's own listing can name it, else null. */
  parentRunId: string | null;
  /** The directory name of the lane session below the root's session directory. */
  parentSession: string | null;
  startedAt: number | null;
  lastUpdate: number | null;
}

interface RawStatus {
  runId?: unknown;
  state?: unknown;
  sessionId?: unknown;
  sessionFile?: unknown;
  mode?: unknown;
  startedAt?: unknown;
  lastUpdate?: unknown;
  steps?: unknown;
}

/** `$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs`, or null when the launcher did not set the root. */
export function asyncRunsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return root ? join(root, "async-subagent-runs") : null;
}

/** The directory pi-subagents places this session's child sessions under, or null without a session file. */
export function sessionScope(sessionFile: string | null | undefined): string | null {
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return null;
  return sessionFile.slice(0, -".jsonl".length);
}

function readStatus(runsDir: string, id: string): RawStatus | null {
  if (!SAFE_ID.test(id)) return null;
  const path = join(runsDir, id, "status.json");
  try {
    if (statSync(path).size > MAX_STATUS_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RawStatus) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function activeIds(runsDir: string): string[] {
  try {
    return readdirSync(join(runsDir, ACTIVE_INDEX), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function sessionFilesOf(status: RawStatus): string[] {
  const files = new Set<string>();
  const top = str(status.sessionFile);
  if (top) files.add(top);
  if (Array.isArray(status.steps)) {
    for (const step of status.steps) {
      const file = step !== null && typeof step === "object" ? str((step as { sessionFile?: unknown }).sessionFile) : null;
      if (file) files.add(file);
    }
  }
  return [...files];
}

function agentOf(status: RawStatus): string | null {
  if (!Array.isArray(status.steps)) return null;
  const names = new Set<string>();
  for (const step of status.steps) {
    const agent = step !== null && typeof step === "object" ? str((step as { agent?: unknown }).agent) : null;
    if (agent) names.add(agent);
  }
  return names.size === 0 ? null : [...names].join(", ");
}

/** The first path segment of `sessionId` below `scope`, the lane's session directory name. */
function laneDirOf(scope: string, sessionId: string): string | null {
  const rest = sessionId.slice(scope.length + 1);
  const first = rest.split(sep)[0];
  return first ? first : null;
}

function insideScope(scope: string, sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.startsWith(`${scope}${sep}`);
}

function toNested(
  scope: string,
  id: string,
  status: RawStatus,
  laneSessions: Map<string, string>,
): NestedRun | null {
  if (!insideScope(scope, status.sessionId)) return null;
  const state = str(status.state);
  if (!state) return null;
  return {
    id: str(status.runId) ?? id,
    state,
    agent: agentOf(status),
    mode: str(status.mode),
    parentRunId: laneSessions.get(status.sessionId) ?? null,
    parentSession: laneDirOf(scope, status.sessionId),
    startedAt: num(status.startedAt),
    lastUpdate: num(status.lastUpdate),
  };
}

/**
 * Live (queued or running) runs launched below this session's lanes, oldest first. `sessionKey` is
 * the root's own session file, which the root's runs carry as their `sessionId`; those runs name
 * the lane session files a nested run's `sessionId` points back to.
 */
export function listNestedRuns(runsDir: string | null, sessionKey: string | null): NestedRun[] {
  const scope = sessionScope(sessionKey);
  if (!runsDir || !scope || !sessionKey) return [];
  const laneSessions = new Map<string, string>();
  const candidates: { id: string; status: RawStatus }[] = [];
  for (const id of activeIds(runsDir)) {
    const status = readStatus(runsDir, id);
    if (!status) continue;
    const runId = str(status.runId) ?? id;
    if (status.sessionId === sessionKey) {
      for (const file of sessionFilesOf(status)) laneSessions.set(file, runId);
    } else if (insideScope(scope, status.sessionId)) {
      candidates.push({ id, status });
    }
  }
  // A run below a nested run names that run as its parent too.
  for (const { id, status } of candidates) {
    for (const file of sessionFilesOf(status)) laneSessions.set(file, str(status.runId) ?? id);
  }
  const live: NestedRun[] = [];
  for (const { id, status } of candidates) {
    if (status.state !== "queued" && status.state !== "running") continue;
    const nested = toNested(scope, id, status, laneSessions);
    if (nested) live.push(nested);
  }
  return live.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
}

/**
 * One nested run by exact id or unique id prefix, in any state, or null when the id is not below
 * this session. Terminal runs are found too: their `status.json` stays on disk.
 */
export function findNestedRun(runsDir: string | null, sessionKey: string | null, idOrPrefix: string): NestedRun | null {
  const scope = sessionScope(sessionKey);
  if (!runsDir || !scope || !sessionKey || !SAFE_ID.test(idOrPrefix)) return null;
  let ids: string[] = [];
  try {
    ids = readdirSync(runsDir).filter((name) => name === idOrPrefix || (idOrPrefix.length >= 8 && name.startsWith(idOrPrefix)));
  } catch {
    return null;
  }
  const exact = ids.find((name) => name === idOrPrefix);
  const id = exact ?? (ids.length === 1 ? ids[0] : undefined);
  if (!id) return null;
  const status = readStatus(runsDir, id);
  if (!status) return null;
  const laneSessions = new Map<string, string>();
  for (const activeId of activeIds(runsDir)) {
    const active = readStatus(runsDir, activeId);
    if (!active || active.sessionId !== sessionKey) continue;
    for (const file of sessionFilesOf(active)) laneSessions.set(file, str(active.runId) ?? activeId);
  }
  return toNested(scope, id, status, laneSessions);
}

function parentLabel(run: NestedRun): string {
  if (run.parentRunId) return `parent ${run.parentRunId}`;
  return run.parentSession ? `parent lane session ${run.parentSession}` : "parent lane unknown";
}

function runLine(run: NestedRun): string {
  const detail = [run.mode, run.state].filter(Boolean).join(", ");
  return `${run.id} ${run.agent ?? "subagent"} (${detail}) ${parentLabel(run)}`;
}

/** The section appended to a no-id `subagent status` listing, or "" when nothing is nested. */
export function formatNestedRuns(runs: NestedRun[]): string {
  if (runs.length === 0) return "";
  return [
    `Nested runs below this session's lanes, not in the list above: ${runs.length}`,
    "",
    ...runs.map((run) => `- ${runLine(run)}`),
    "",
    `Check one with subagent({ action: "status", id }).`,
  ].join("\n");
}

/** The reply for `subagent status id=<nested run>` in place of "Async run not found". */
export function formatNestedRun(run: NestedRun, now: number = Date.now()): string {
  const ago = (ms: number | null) => (ms === null ? null : `${Math.max(0, Math.round((now - ms) / 1000))}s ago`);
  return [
    `Run: ${run.id}`,
    `State: ${run.state}`,
    `Agent: ${run.agent ?? "subagent"}`,
    run.mode ? `Mode: ${run.mode}` : null,
    run.parentRunId ? `Parent run: ${run.parentRunId}` : run.parentSession ? `Parent lane session: ${run.parentSession}` : null,
    run.startedAt !== null ? `Started: ${ago(run.startedAt)}` : null,
    run.lastUpdate !== null ? `Updated: ${ago(run.lastUpdate)}` : null,
    "Nested run below one of this session's lanes (read from its saved status).",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
