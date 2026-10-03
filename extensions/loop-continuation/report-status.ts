// Ported from the fan-out session helper (fanout_session.py) of the author's agent-workflows plugin
// (report_status/report_counts/final_marker), v2/strict mode only. See launch-detect.ts for why
// loop-continuation drops the legacy branch.

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { LaunchInfo } from "./launch-detect.ts";

const HEADER_RE = /^# Loop: \S+ loop(\d+) · Goal: [0-9a-f]{64}$/;
const REQUIRED_SECTIONS = [
  "## Outcome",
  "## Evidence",
  "## Pending",
  "## Questions",
  "## Stalls and deaths",
  "## Tokens and wakeups",
];

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
 * directory where the report exists or that holds `.git`, matching fanout_session's fallback for
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

export interface ReportStatus {
  counts: boolean;
  /** A short clause naming the first failed rule, or null when the report counts. */
  whyNot: string | null;
}

/** Section 3: does the snapshotted report count right now? */
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
      whyNot: "has no valid header on line 1 (`# Loop: <repo> loop<N> · Goal: <64-hex sha256>`)",
    };
  }
  if (launch.loop !== null && parseInt(header[1], 10) !== launch.loop) {
    return { counts: false, whyNot: `has a header that names loop ${parseInt(header[1], 10)}, not loop ${launch.loop}` };
  }
  const missing = REQUIRED_SECTIONS.filter((section) => !lines.includes(section));
  if (missing.length) {
    return { counts: false, whyNot: "is missing sections: " + missing.join(", ") };
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
