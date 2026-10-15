// Arm-time checks and the `open` event. Before a launch arms a root:
//   1. LOOP_PI_RUN_DIR is set and exists;
//   2. the cwd's git toplevel is the charter's repository (the parent of the charter's codex/);
//   3. the charter's optional `host:` key names this machine;
//   4. the charter exists, and an `open` already in the state log carries its sha256;
//   5. the launch's `Standing:` line names the file and digest the charter's `standing:` key names
//      (`none` or no key: the launch has none).
// A failure refuses the arm; on success the caller appends `open` (by ext) when the log has none,
// from the charter's header keys and its `## First wave` task cells. The root never writes it.
//
// The charter (charter.md template) keeps its keys in the block between its `# Charter:` title and
// its first `## ` heading, one `key: value` per line.
//
// Pure apart from the injectable `ArmEnv`, so the checks are testable without a machine.

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize } from "node:path";
import { deriveLogPath } from "../loop-state/core.ts";

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

/** The charter's header keys: `key: value` lines (unindented, no bullet) before its first `## `
 *  heading, keys lower-cased; the first of a key wins. Indented continuation lines (the
 *  `authority:` list) are not keys. */
export function charterKeys(charter: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of charter.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break;
    const m = /^([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].replace(/^`(.*)`$/, "$1").trim();
  }
  return out;
}

/** The charter's `lanes:` cap as a positive integer, or null when absent or not exactly one. */
export function runConcurrency(charter: string): number | null {
  const raw = charterKeys(charter).lanes;
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** The task ids in the `## First wave` table's task cells, in order (`<id>` or `<id> (<title>)`). */
export function firstWaveTaskIds(charter: string): string[] {
  const ids: string[] = [];
  let inside = false;
  let header = false;
  for (const line of charter.split(/\r?\n/)) {
    if (/^##\s/.test(line) && !line.startsWith("###")) {
      inside = line.replace(/^##\s+/, "").trim().toLowerCase() === "first wave";
      header = false;
      continue;
    }
    if (!inside || !line.trim().startsWith("|")) continue;
    const first = line.trim().replace(/^\|/, "").split(/(?<!\\)\|/)[0]?.trim().replace(/^`(.*)`$/, "$1").trim() ?? "";
    if (!header) {
      header = true; // the header row
      continue;
    }
    if (/^:?-{3,}:?$/.test(first) || first === "" || first.startsWith("<")) continue;
    ids.push(/^(\S+)/.exec(first)![1]);
  }
  return ids;
}

/** S3: `closeout-<name>.md` -> `state-<name>.jsonl` beside it (null for any other name). */
export function stateLogFor(closeout: string): string | null {
  return deriveLogPath(closeout);
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
  | { ok: true; runDir: string; charter: string; charterText: string; charterSha256: string; log: string }
  | { ok: false; reason: string };

/** Arm checks for a launch naming `report` (the closeout) and `charter` (both absolute). */
export function checkArm(
  launch: { report: string; charter: string; standingLine?: LaunchLine },
  env: ArmEnv,
): ArmCheck {
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

  if (!launch.charter.startsWith("/")) return refuse(`the charter path ${launch.charter} is not absolute`);
  const charterRepo = codexRepo(launch.charter);
  if (!charterRepo) return refuse(`the charter ${launch.charter} is not inside a codex/ directory`);
  const top = env.gitToplevel(env.cwd);
  if (!top) return refuse(`the cwd ${env.cwd} is not inside a git repository; the charter's repository is ${charterRepo}`);
  const same = (a: string, b: string) => {
    try {
      return env.realpath(a) === env.realpath(b);
    } catch {
      return a === b;
    }
  };
  if (!same(top, charterRepo)) return refuse(`the cwd's repository ${top} is not the charter's repository ${charterRepo}`);

  let bytes: Buffer;
  try {
    bytes = env.readFile(launch.charter);
  } catch {
    return refuse(`the charter file ${launch.charter} cannot be read`);
  }
  const charterText = bytes.toString("utf8");
  const host = charterKeys(charterText).host;
  if (host) {
    const names = env.hostNames();
    if (!names.includes(host.toLowerCase())) {
      return refuse(`the charter runs on host ${host}; this machine is ${names.join(" / ") || "unknown"}`);
    }
  }
  const standing = standingLineMismatch(charterText, charterRepo, launch.standingLine ?? { kind: "none" });
  if (standing) return refuse(standing);
  const charterSha256 = createHash("sha256").update(bytes).digest("hex");
  const log = stateLogFor(launch.report);
  if (!log) return refuse(`the closeout ${launch.report} is not a codex/closeout-<name>.md path`);
  const open = existingOpen(log);
  if (open && open.charter_sha256 !== charterSha256) {
    return refuse(`the charter changed since the loop opened: ${log} has charter_sha256 ${String(open.charter_sha256)}, the file is ${charterSha256}`);
  }
  return { ok: true, runDir, charter: launch.charter, charterText, charterSha256, log };
}

/**
 * The `open` event continuation appends at arm when the log has none (the root never writes it).
 * `charter_sha256` is the charter's sha256, which the closeout header also carries, and
 * `first_wave` the charter's `## First wave` task ids. `root_model` is the charter's `root:` value,
 * or `unknown` when the charter has none. The v3 charter sets no run tier (tiers are per task), so
 * `tier` is present only when the charter header states `tier: routine|guarded`. Telemetry only,
 * never a gate.
 */
export function openEvent(charterText: string, charterSha256: string): Record<string, unknown> {
  const keys = charterKeys(charterText);
  const tier = keys.tier === "routine" || keys.tier === "guarded" ? { tier: keys.tier } : {};
  return {
    ev: "open", charter_sha256: charterSha256, ...tier, root: "llm",
    root_model: keys.root || "unknown", first_wave: firstWaveTaskIds(charterText),
  };
}

/** What a launch says about its standing file: its `Standing:` line(s), as `parseStandingLine`
 *  reads them. */
export type LaunchLine = { kind: "none" } | { kind: "line"; path: string; sha256: string } | { kind: "invalid"; reason: string };

const CHARTER_FILE_RE = /^`?(\S+?)`?\s+sha256=([0-9a-fA-F]{64})\s*$/;

/**
 * The launch's `Standing:` line must be the charter's `standing:` key: the same file (a relative
 * charter path resolves against the charter's repository) and the same sha256. A charter key
 * `none`, or no key at all, means the launch carries no such line. Returns why they differ, or
 * null. The file itself is read and checked later, by the freeze.
 */
export function standingLineMismatch(charterText: string, charterRepo: string, line: LaunchLine): string | null {
  const raw = charterKeys(charterText).standing;
  const value = raw === undefined ? null : raw.trim();
  const none = value === null || /^`?none\b/i.test(value);
  if (none) {
    if (line.kind === "none") return null;
    return `the launch carries a Standing line but the charter's standing is ${value === null ? "absent" : "none"}`;
  }
  const m = CHARTER_FILE_RE.exec(value);
  if (!m) return "the charter's standing key is neither none nor <path> sha256=<64 hex>";
  const path = normalize(m[1].startsWith("/") ? m[1] : join(charterRepo, m[1]));
  const sha = m[2].toLowerCase();
  if (line.kind === "none") return `the charter's standing names ${path} but the launch has no Standing line`;
  if (line.kind === "invalid") return `the launch's Standing line is malformed (${line.reason}); the charter names ${path}`;
  if (normalize(line.path) !== path) return `the launch's Standing file ${line.path} is not the charter's standing file ${path}`;
  if (line.sha256 !== sha) return `the launch's Standing sha256 ${line.sha256} is not the charter's standing sha256 ${sha}`;
  return null;
}

/** A first input that names a charter file but did not arm. */
export function namesCharterPath(text: string): boolean {
  return /(?:^|[\s`'"(])(?:\S*\/)?codex\/charter-[^\s`'")]*\.md/.test(text);
}

export const NOT_ARMED_WARNING =
  "This did not arm a loop root: paste the launch file path (codex/launch-...) to relaunch it.";
