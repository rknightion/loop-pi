// When a closeout counts (seam S2). The function and field names keep the "report" spelling of the
// persisted launch state; the path is the launch's closeout. The v3 rules (file, header, sections)
// apply to every run. A charter that says `protocol: v4` and not `loop-land: off` adds the landing
// ledger rule below; any other charter is judged by the v3 rules alone.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchInfo } from "./launch-detect.ts";

const HEADER_RE = /^# Closeout: \S+ loop(\d+) · Charter: [0-9a-f]{64}$/;
const REQUIRED_SECTIONS = ["## Landed", "## Parked", "## For ratification", "## Notes"];

const LEADING_DECORATION_RE = /^[\s*_`>-]+/;
const TRAILING_DECORATION_RE = /[\s.!*_`)]+$/;
const PAUSED_RE = /^PAUSED: .+$/;
const WAITING_RE = /^WAITING: .+ until (\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z)$/;

function normalizePath(p: string): string {
  const isAbsolute = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = out.join("/");
  return (isAbsolute ? "/" : "") + joined || (isAbsolute ? "/" : ".");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * An absolute snapshot is used as is. A still-relative one walks up from `cwd` to the first
 * directory where the closeout exists or that holds `.git`, matching fanout_session's fallback for
 * a launch recognised with no cwd at all.
 */
export function resolveReportPath(report: string, cwd: string | null): string {
  const path = expandHome(report);
  if (path.startsWith("/")) return normalizePath(path);
  const base = cwd || process.cwd();
  let probe = base;
  for (;;) {
    const candidate = normalizePath(probe.replace(/\/+$/, "") + "/" + path);
    if (existsSync(candidate) || existsSync(probe.replace(/\/+$/, "") + "/.git")) {
      return candidate;
    }
    const parent = probe.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    if (parent === probe) {
      return normalizePath(base.replace(/\/+$/, "") + "/" + path);
    }
    probe = parent;
  }
}

const CLOSEOUT_NAME_RE = /^closeout-.+-loop(\d+)\.md$/;
const LEDGER_EVENTS = new Set(["ready", "refused", "merged", "verified", "abandoned", "closeout-check", "error"]);

interface LedgerEvent {
  event: string;
  ts: number;
  outcome: unknown;
  pr: unknown;
  head: unknown;
  main: unknown;
  deploy: unknown;
}

/** The run directory and charters a closeout path names, by the contract's file naming:
 *  `<dir>/closeout-<date>-loop<N>.md` has the run directory `<dir>/loop<N>/` and the charter
 *  `<dir>/charter-<date>-loop<N>.md`. Null when the closeout's name carries no loop number. Charters are
 *  sorted by name. */
function runFilesFor(closeoutPath: string): { runDir: string; charters: string[] } | null {
  const slash = closeoutPath.lastIndexOf("/");
  const dir = slash > 0 ? closeoutPath.slice(0, slash) : slash === 0 ? "/" : ".";
  const m = CLOSEOUT_NAME_RE.exec(closeoutPath.slice(slash + 1));
  if (!m) return null;
  const n = m[1];
  const wanted = new RegExp(`^charter-.+-loop${n}\\.md$`);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => wanted.test(name)).sort();
  } catch {
    // An unreadable directory has no charter: the v3 rule stands.
  }
  const prefix = dir === "/" ? "" : dir;
  return { runDir: join(prefix, `loop${n}`), charters: names.map((name) => join(prefix, name)) };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** The value of the first `key:` line in the charter's header: column 0, outside code fences, before the
 *  first `## ` heading. A fence closes only on a line of the same character at least as long as its opener,
 *  so a shorter fence inside a longer one hides nothing after the outer fence. A quoted value is unquoted. */
function headerValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let fence: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const marker = FENCE_RE.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (line.startsWith("## ")) break;
    const kv = /^(protocol|loop-land):[ \t]*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (!values.has(key)) values.set(key, (kv[2] ?? kv[3] ?? kv[4] ?? "").trim().toLowerCase());
  }
  return values;
}

/** True when the run's charter (the last by name; one that cannot be read means the v3 rule) says
 *  `protocol: v4` and does not say `loop-land: off`. */
function wantsLedger(charters: string[]): boolean {
  if (!charters.length) return false;
  let text: string;
  try {
    text = readFileSync(charters[charters.length - 1], "utf8");
  } catch {
    return false;
  }
  const values = headerValues(text);
  return values.get("protocol") === "v4" && values.get("loop-land") !== "off";
}

/** Every event in `<run dir>/landings.jsonl`, or a reason the file cannot be parsed. An absent or empty
 *  ledger has no events. */
function readLedger(path: string): { events: LedgerEvent[] } | { error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [] };
    return { error: "cannot be read" };
  }
  const events: LedgerEvent[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      // Includes a line nested too deeply for the parser (a RangeError).
      return { error: `cannot be parsed (line ${i + 1} is not JSON)` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: `cannot be parsed (line ${i + 1} is not an object)` };
    }
    const row = value as Record<string, unknown>;
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (typeof row.event !== "string" || !LEDGER_EVENTS.has(row.event) || Number.isNaN(ts)) {
      return { error: `cannot be parsed (line ${i + 1} has no known event and time)` };
    }
    events.push({ event: row.event, ts, outcome: row.outcome, pr: row.pr, head: row.head, main: row.main, deploy: row.deploy });
  }
  return { events };
}

function landingKey(e: LedgerEvent): string {
  return typeof e.pr === "number" ? `pull request ${e.pr}` : `head ${String(e.head)}`;
}

interface Landing {
  /** The last event that is not an `error`. */
  last: LedgerEvent;
  merged: boolean;
  /** A `merged` event with no `verified` after it. */
  unverified: boolean;
  /** The latest `verified` event. */
  verified: LedgerEvent | null;
}

/** The ledger rule: why the closeout does not count, or null when it does. Per landing: blocked when it was
 *  merged and has no later `verified`, or its latest `verified` has main or the deploy `unread`, whatever
 *  event follows; a landing never merged blocks only while its last event is `ready`. An `error` event changes
 *  no landing's state. Main `red` or the deploy `failed` does not block. */
function ledgerWhyNot(runDir: string): string | null {
  const ledger = readLedger(join(runDir, "landings.jsonl"));
  if ("error" in ledger) return `landing ledger ${ledger.error}`;
  const events = ledger.events;
  const landings = new Map<string, Landing>();
  for (const e of events) {
    if (e.event === "closeout-check" || e.event === "error") continue;
    const key = landingKey(e);
    const landing = landings.get(key) ?? { last: e, merged: false, unverified: false, verified: null };
    landing.last = e;
    if (e.event === "merged") {
      landing.merged = true;
      landing.unverified = true;
    } else if (e.event === "verified") {
      landing.unverified = false;
      landing.verified = e;
    }
    landings.set(key, landing);
  }
  for (const [key, l] of landings) {
    if (l.unverified) return `landing ledger has ${key} merged and not verified; run \`loop-land verify\``;
    if (l.verified && (l.verified.main === "unread" || l.verified.deploy === "unread")) {
      return `landing ledger has ${key} verified with ${l.verified.main === "unread" ? "main" : "the deploy"} unread; run \`loop-land verify\``;
    }
    if (!l.merged && l.last.event === "ready") return `landing ledger leaves ${key} at ready; run \`loop-land abandon\` or finish it`;
  }
  let checkAt = -1;
  let mergedAt = -1;
  events.forEach((e, i) => {
    if (e.event === "closeout-check") checkAt = i;
    else if (e.event === "merged") mergedAt = i;
  });
  if (checkAt < 0) return "landing ledger has no closeout-check event";
  const check = events[checkAt];
  if (mergedAt >= 0) {
    const merged = events[mergedAt];
    if (check.ts < merged.ts || (check.ts === merged.ts && checkAt < mergedAt)) {
      return "landing ledger closeout-check is older than the last merge; run `loop-land summary --check`";
    }
  }
  if (check.outcome !== "ok") return "landing ledger closeout-check is not ok";
  return null;
}

export interface ReportStatus {
  counts: boolean;
  /** A short clause naming the first failed rule, or null when the report counts. */
  whyNot: string | null;
}

/** S2: does the snapshotted closeout count right now? */
export function reportStatus(launch: LaunchInfo | null, cwd: string | null): ReportStatus {
  if (!launch || !launch.report) return { counts: false, whyNot: "is not known" };
  const path = resolveReportPath(launch.report, cwd);
  let lst;
  try {
    lst = lstatSync(path);
  } catch {
    return { counts: false, whyNot: "does not exist yet" };
  }
  if (lst.isSymbolicLink()) return { counts: false, whyNot: "is a symlink, not a regular file" };
  if (!lst.isFile()) {
    return { counts: false, whyNot: lst.isDirectory() ? "is not a regular file" : "does not exist yet" };
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return { counts: false, whyNot: "cannot be read" };
  }
  const launchEpoch = Date.parse(launch.launchTs);
  if (!Number.isNaN(launchEpoch) && st.mtimeMs <= launchEpoch) {
    return { counts: false, whyNot: "predates the launch (it was last written before this run started)" };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { counts: false, whyNot: "cannot be read" };
  }
  const lines = content.split(/\r\n|\r|\n/);
  const header = lines.length ? HEADER_RE.exec(lines[0]) : null;
  if (!header) {
    return {
      counts: false,
      whyNot: "has no valid header on line 1 (`# Closeout: <repo> loop<N> · Charter: <64-hex sha256>`)",
    };
  }
  if (launch.loop !== null && parseInt(header[1], 10) !== launch.loop) {
    return { counts: false, whyNot: `has a header that names loop ${parseInt(header[1], 10)}, not loop ${launch.loop}` };
  }
  const missing = REQUIRED_SECTIONS.filter((section) => !lines.includes(section));
  if (missing.length) {
    return { counts: false, whyNot: "is missing sections: " + missing.join(", ") };
  }
  const files = runFilesFor(path);
  if (files && wantsLedger(files.charters)) {
    const why = ledgerWhyNot(files.runDir);
    if (why) return { counts: false, whyNot: why };
  }
  return { counts: true, whyNot: null };
}

export function reportCounts(launch: LaunchInfo | null, cwd: string | null): boolean {
  return reportStatus(launch, cwd).counts;
}

export type FinalMarker = "paused" | "waiting" | null;

/**
 * The last non-empty line of `lastMessage` with markdown decoration removed: leading
 * `[\s*_`>-]+` and trailing `[\s.!*_`)]+`. A root that bolds, bullets or punctuates its marker
 * line still has it read as the marker.
 */
function lastMarkerLine(lastMessage: string | null): string | null {
  if (!lastMessage) return null;
  const lines = lastMessage.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return null;
  return lines[lines.length - 1].replace(LEADING_DECORATION_RE, "").replace(TRAILING_DECORATION_RE, "");
}

/** Section 4: the marker on the last non-empty line of `lastMessage`, or null. */
export function finalMarker(lastMessage: string | null): FinalMarker {
  const line = lastMarkerLine(lastMessage);
  if (line === null) return null;
  if (PAUSED_RE.test(line)) return "paused";
  if (WAITING_RE.test(line)) return "waiting";
  return null;
}

/** The UTC deadline captured from a current `WAITING: … until <deadline>` last line, or null. */
export function waitingDeadline(lastMessage: string | null): string | null {
  const line = lastMarkerLine(lastMessage);
  if (line === null) return null;
  const m = WAITING_RE.exec(line);
  return m ? m[1] : null;
}
