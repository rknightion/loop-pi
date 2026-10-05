// Arm-time checks and the `open` event (frozen seams S3 and S4). Before a launch arms a root:
//   1. LOOP_PI_RUN_DIR is set and exists;
//   2. the cwd's git toplevel is the goal's repository (the parent of the goal's codex/);
//   3. the goal's `## Run` `host:` (optional) names this machine;
//   4. the goal file exists, and an `open` already in the state log carries its sha256;
//   5. the launch's `Ops grants:` and `Audit grants:` lines name the files and digests the goal's
//      `## Authority` `ops:` and `audit grants:` lines name (`none` or no line: the launch has none).
// A failure refuses the arm; on success the caller appends `open` (by ext) when the log has none,
// from the goal's `## Run` and its envelope table's task cells.
//
// Pure apart from the injectable `ArmEnv`, so the checks are testable without a machine.

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize } from "node:path";

export const PROTO_FILE = "loop-pi-proto";
export const PROTO_VERSION = "2";
export const ARM_REFUSED_CLASS = "loop-arm-refused";

/** Durable protocol evidence left in the launcher snapshot, including when begin precedes arm. */
export function snapshotProtocolRetained(runDir: string): boolean {
  try {
    return JSON.parse(readFileSync(join(runDir, "audit-before.json"), "utf8")).protocol === 2;
  } catch {
    return false;
  }
}

/** Preserve a pre-arm baseline under the audit's own lock; do not resnapshot or invent one. */
export function retainSnapshotProtocol(bin: string, runDir: string, cwd: string): Promise<string | null> {
  if (!existsSync(join(runDir, "audit-before.json"))) return Promise.resolve(null);
  return new Promise((done) => {
    try {
      execFile(bin, ["retain-protocol", "--run-dir", runDir], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        done(error ? String(stderr || stdout || error.message).trim() : null);
      });
    } catch (error) {
      done(String(error));
    }
  });
}

export interface ArmEnv {
  runDir: string | undefined;
  cwd: string;
  /** The git toplevel of `cwd`, or null outside a repository. */
  gitToplevel(cwd: string): string | null;
  /** This machine's short host names (lower case), e.g. `os.hostname()` up to the first dot. */
  hostNames(): string[];
  readFile(path: string): Buffer;
  realpath(path: string): string;
}

export const defaultArmEnv = (cwd: string): ArmEnv => ({
  runDir: process.env.LOOP_PI_RUN_DIR,
  cwd,
  gitToplevel(dir) {
    try {
      const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
      return out.trim() || null;
    } catch {
      return null;
    }
  },
  hostNames() {
    const names = new Set<string>();
    const short = hostname().split(".")[0]?.trim().toLowerCase();
    if (short) names.add(short);
    if (process.platform === "darwin") {
      try {
        const local = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
        const name = local.trim().toLowerCase();
        if (name) names.add(name);
      } catch {
        // No LocalHostName: os.hostname() alone decides.
      }
    }
    return [...names];
  },
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync(path),
});

/** The parent of the nearest enclosing `codex/` directory of an absolute path, or null. */
export function codexRepo(absPath: string): string | null {
  const segments = absPath.split("/");
  for (let i = segments.length - 2; i >= 1; i--) {
    if (segments[i] === "codex") return segments.slice(0, i).join("/") || "/";
  }
  return null;
}

/** `key: value` lines of one `## <name>` section, keys lower-cased; the first of a key wins. */
export function sectionKeys(goal: string, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of goal.split(/\r?\n/)) {
    if (/^##\s/.test(line) && !line.startsWith("###")) {
      inside = line.replace(/^##\s+/, "").trim().toLowerCase() === name.toLowerCase();
      continue;
    }
    if (!inside) continue;
    const m = /^\s*(?:[-*]\s+)?([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].replace(/^`(.*)`$/, "$1").trim();
  }
  return out;
}

/** The task ids in the `## Envelope` table's task cells, in order (`<id>` or `<id> (<title>)`). */
export function envelopeTaskIds(goal: string): string[] {
  const ids: string[] = [];
  let inside = false;
  let header = false;
  for (const line of goal.split(/\r?\n/)) {
    if (/^##\s/.test(line) && !line.startsWith("###")) {
      inside = line.replace(/^##\s+/, "").trim().toLowerCase() === "envelope";
      header = false;
      continue;
    }
    if (!inside || !line.trim().startsWith("|")) continue;
    const first = line.trim().replace(/^\|/, "").split(/(?<!\\)\|/)[0]?.trim().replace(/^`(.*)`$/, "$1").trim() ?? "";
    if (!header) {
      header = true; // the header row
      continue;
    }
    if (/^:?-{3,}:?$/.test(first) || first === "") continue;
    ids.push(/^(\S+)/.exec(first)![1]);
  }
  return ids;
}

/** `report-<name>.md` -> `state-<name>.jsonl` beside it. */
export function stateLogFor(report: string): string {
  const slash = report.lastIndexOf("/");
  return report.slice(0, slash + 1) + report.slice(slash + 1).replace(/^report-/, "state-").replace(/\.md$/, ".jsonl");
}

/** The first `open` event in a state log, or null when there is none (or no log). */
export function existingOpen(log: string): Record<string, unknown> | null {
  if (!existsSync(log)) return null;
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event?.ev === "open") return event;
    } catch {
      // A malformed line is loop-state's problem to report, not the arm's.
    }
  }
  return null;
}

export type ArmCheck =
  | { ok: true; runDir: string; goal: string; goalText: string; goalSha256: string; log: string }
  | { ok: false; reason: string };

/** S3 checks for a launch naming `report` and `goal` (both absolute). */
export function checkArm(launch: { report: string; goal: string; opsLine?: GrantLine; auditLine?: GrantLine }, env: ArmEnv): ArmCheck {
  const refuse = (reason: string): ArmCheck => ({ ok: false, reason });
  const runDir = env.runDir;
  if (!runDir) return refuse("LOOP_PI_RUN_DIR is not set: start the root with the loop-pi launcher from inside the loop repository");
  let isDir = false;
  try {
    isDir = statSync(runDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return refuse(`LOOP_PI_RUN_DIR ${runDir} does not exist`);

  if (!launch.goal.startsWith("/")) return refuse(`the goal path ${launch.goal} is not absolute`);
  const goalRepo = codexRepo(launch.goal);
  if (!goalRepo) return refuse(`the goal ${launch.goal} is not inside a codex/ directory`);
  const top = env.gitToplevel(env.cwd);
  if (!top) return refuse(`the cwd ${env.cwd} is not inside a git repository; the goal's repository is ${goalRepo}`);
  const same = (a: string, b: string) => {
    try {
      return env.realpath(a) === env.realpath(b);
    } catch {
      return a === b;
    }
  };
  if (!same(top, goalRepo)) return refuse(`the cwd's repository ${top} is not the goal's repository ${goalRepo}`);

  let bytes: Buffer;
  try {
    bytes = env.readFile(launch.goal);
  } catch {
    return refuse(`the goal file ${launch.goal} cannot be read`);
  }
  const goalText = bytes.toString("utf8");
  const host = sectionKeys(goalText, "Run").host;
  if (host) {
    const names = env.hostNames();
    if (!names.includes(host.toLowerCase())) {
      return refuse(`the goal runs on host ${host}; this machine is ${names.join(" / ") || "unknown"}`);
    }
  }
  const grants = grantLinesMismatch(goalText, goalRepo, { opsLine: launch.opsLine ?? { kind: "none" }, auditLine: launch.auditLine ?? { kind: "none" } });
  if (grants) return refuse(grants);
  const goalSha256 = createHash("sha256").update(bytes).digest("hex");
  const log = stateLogFor(launch.report);
  const open = existingOpen(log);
  if (open && open.goal_sha256 !== goalSha256) {
    return refuse(`the goal changed since the loop opened: ${log} has goal_sha256 ${String(open.goal_sha256)}, the file is ${goalSha256}`);
  }
  return { ok: true, runDir, goal: launch.goal, goalText, goalSha256, log };
}

/** The `open` event for a goal, or the reason it cannot be built. */
export function openEvent(goalText: string, goalSha256: string): { event: Record<string, unknown> } | { error: string } {
  const run = sectionKeys(goalText, "Run");
  const tier = run.tier;
  if (tier !== "routine" && tier !== "guarded") return { error: `## Run tier is '${tier ?? ""}', not routine or guarded` };
  const rootModel = run["root-model"];
  if (!rootModel) return { error: "## Run has no root-model" };
  return { event: { ev: "open", goal_sha256: goalSha256, tier, root: "llm", root_model: rootModel, envelope: envelopeTaskIds(goalText) } };
}

/** What a launch says about one grants file: its `<label>:` line(s), as `parseOpsLine` / `parseAuditLine` read them. */
export type GrantLine = { kind: "none" } | { kind: "line"; path: string; sha256: string } | { kind: "invalid"; reason: string };

const GOAL_GRANT_RE = /^`?(\S+?)`?\s+sha256=([0-9a-fA-F]{64})\s*$/;

/**
 * The launch's grants lines must be the goal's `## Authority` `ops:` and `audit grants:` lines: the
 * same file (a relative goal path resolves against the goal's repository) and the same sha256. A goal
 * line `none`, or no goal line at all, means the launch carries no such line. Returns why they differ,
 * or null. The file itself is read and checked later, by the freeze.
 */
export function grantLinesMismatch(
  goalText: string,
  goalRepo: string,
  launch: { opsLine: GrantLine; auditLine: GrantLine },
): string | null {
  const authority = sectionKeys(goalText, "Authority");
  const check = (key: string, label: string, line: GrantLine): string | null => {
    const raw = authority[key];
    const goalValue = raw === undefined ? null : raw.trim();
    const goalNone = goalValue === null || /^`?none\b/i.test(goalValue);
    if (goalNone) {
      if (line.kind === "none") return null;
      return `the launch carries an ${label} line but the goal's ## Authority ${key} is ${goalValue === null ? "absent" : "none"}`;
    }
    const m = GOAL_GRANT_RE.exec(goalValue);
    if (!m) return `the goal's ## Authority ${key} line is neither none nor <path> sha256=<64 hex>`;
    const goalPath = normalize(m[1].startsWith("/") ? m[1] : join(goalRepo, m[1]));
    const goalSha = m[2].toLowerCase();
    if (line.kind === "none") return `the goal's ## Authority ${key} names ${goalPath} but the launch has no ${label} line`;
    if (line.kind === "invalid") return `the launch's ${label} line is malformed (${line.reason}); the goal names ${goalPath}`;
    if (normalize(line.path) !== goalPath) return `the launch's ${label} file ${line.path} is not the goal's ${key} file ${goalPath}`;
    if (line.sha256 !== goalSha) return `the launch's ${label} sha256 ${line.sha256} is not the goal's ${key} sha256 ${goalSha}`;
    return null;
  };
  return check("ops", "Ops grants", launch.opsLine) ?? check("audit grants", "Audit grants", launch.auditLine);
}

/** A first input that names a goal file but did not arm. */
export function namesGoalPath(text: string): boolean {
  return /(?:^|[\s`'"(])(?:\S*\/)?codex\/goal-[^\s`'")]*\.md/.test(text);
}

export const NOT_ARMED_WARNING =
  "This did not arm a loop root: paste the launch file path (codex/launch-...) to relaunch with its grants.";
