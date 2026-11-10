// When a closeout counts (seam S2). The function and field names keep the "report" spelling of the
// persisted launch state; the path is the launch's closeout. The v3 rules (file, header, sections)
// apply to every run. A charter that says `protocol: v4` and not `loop-land: off` adds the landing
// ledger rule below; any other charter is judged by the v3 rules alone.

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
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

const CLOSEOUT_NAME_RE = /^closeout-.*-loop(\d+)\.md$/;
const LANDING_EVENTS = new Set(["ready", "refused", "merged", "verified", "abandoned"]);
const LEDGER_EVENTS = new Set([...LANDING_EVENTS, "closeout-check", "error"]);
const MAIN_STATES = new Set(["green", "red", "unread"]);
const DEPLOY_STATES = new Set(["synced", "failed", "unread", "n/a"]);
/** The most of a ledger read, and of a charter read for its header. */
const LEDGER_MAX_BYTES = 16 * 1024 * 1024;
const CHARTER_MAX_BYTES = 1024 * 1024;

/** Python's `str.splitlines` line boundaries, which the landing rule in the other harnesses uses. */
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

interface LedgerEvent {
  event: string;
  /** Seconds since the epoch. */
  ts: number;
  outcome: unknown;
  key: string | null;
  main: unknown;
  deploy: unknown;
}

type ReadResult = { text: string } | { missing: true } | { notRegular: true } | { unreadable: true };

/** Reads a regular file without ever blocking on a FIFO or device: it is opened non-blocking and checked
 *  on the open descriptor, so a path swapped in between cannot hang the settle hook. At most `maxBytes`
 *  are read; `strict` makes invalid UTF-8 an error instead of a replacement character. */
function readRegularFile(path: string, maxBytes: number, strict: boolean): ReadResult & { truncated?: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { notRegular: true };
    const buf = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buf.length) {
      const n = readSync(fd, buf, used, buf.length - used, null);
      if (n === 0) break;
      used += n;
    }
    const truncated = used > maxBytes;
    if (truncated && strict) return { unreadable: true };
    const bytes = buf.subarray(0, Math.min(used, maxBytes));
    try {
      return { text: new TextDecoder("utf-8", { fatal: strict, ignoreBOM: true }).decode(bytes), truncated };
    } catch {
      return { unreadable: true };
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { unreadable: true };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to recover: the descriptor is gone either way.
      }
    }
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The run directory and charter a closeout path names, by the contract's file naming:
 *  `<dir>/closeout-<date>-loop<N>.md` has the run directory `<dir>/loop<N>/` and the charter
 *  `<dir>/charter-<date>-loop<N>.md` (the last by name that is a regular file, or null). Null when the
 *  closeout's name carries no loop number. `N` is the number without leading zeros. */
function runFilesFor(closeoutPath: string): { runDir: string; charter: string | null } | null {
  const slash = closeoutPath.lastIndexOf("/");
  const dir = slash > 0 ? closeoutPath.slice(0, slash) : slash === 0 ? "/" : ".";
  const m = CLOSEOUT_NAME_RE.exec(closeoutPath.slice(slash + 1));
  if (!m) return null;
  const n = BigInt(m[1]).toString();
  const wanted = new RegExp(`^charter-.*-loop${n}\\.md$`);
  const prefix = dir === "/" ? "" : dir;
  let charter: string | null = null;
  try {
    const names = readdirSync(dir).filter((name) => wanted.test(name)).sort();
    for (let i = names.length - 1; i >= 0 && charter === null; i--) {
      if (isRegularFile(join(prefix, names[i]))) charter = join(prefix, names[i]);
    }
  } catch {
    // An unreadable directory has no charter: the v3 rule stands.
  }
  return { runDir: join(prefix, `loop${n}`), charter };
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CHARTER_KEY_RE = /^([A-Za-z][\w-]*):[ \t]*(.*?)\s*$/;

/** The first token of the first `key:` line for each key in the charter's header: column 0, outside code
 *  fences, before the first `## ` heading. A fence closes only on a line of the same character at least as
 *  long as its opener. Quotes and backticks around the token are removed; the first occurrence of a key
 *  wins even when its value is empty. */
function headerValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let fence: string | null = null;
  for (const line of text.split(LINE_BREAK_RE)) {
    const marker = FENCE_RE.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && new RegExp(`^${fence[0]}+$`).test(line.trim())) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (line.startsWith("## ")) break;
    const kv = CHARTER_KEY_RE.exec(line);
    if (!kv || values.has(kv[1].toLowerCase())) continue;
    const token = kv[2].split(/\s+/).filter(Boolean)[0] ?? "";
    values.set(kv[1].toLowerCase(), token.replace(/^["'`]+|["'`]+$/g, "").toLowerCase());
  }
  return values;
}

/** True when the run's charter says `protocol: v4` and does not say `loop-land: off`. A charter that cannot
 *  be read, like none at all, means the v3 rule. */
function wantsLedger(charter: string | null): boolean {
  if (charter === null) return false;
  const read = readRegularFile(charter, CHARTER_MAX_BYTES, false);
  if (!("text" in read)) return false;
  const values = headerValues(read.text);
  return values.get("protocol") === "v4" && values.get("loop-land") !== "off";
}

const SEC_PER_DAY = 86400;

/** Days from 1970-01-01 to a proleptic Gregorian date. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
/** The weekday of a date, Monday = 1. */
const weekday = (days: number) => ((((days + 3) % 7) + 7) % 7) + 1;

/** The schema's `ts` (`YYYY-MM-DDTHH:MM:SSZ`) and the other ISO 8601 forms the landing rule's parser takes
 *  (Python `datetime.fromisoformat`, after `Z` becomes `+00:00`): a date as `YYYY-MM-DD`, `YYYYMMDD` or
 *  an ISO week date, alone or followed by one separator character and a time with an optional offset. A
 *  time without an offset is read as UTC. Anything else, such as `1` or `Nov 10 2026`, is not a time. */
export function ledgerEpoch(raw: string): number | null {
  const s = raw.replace(/Z/g, "+00:00");
  let days: number;
  let rest: string;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)) || (m = /^(\d{4})(\d{2})(\d{2})/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo)) return null;
    days = daysFromCivil(y, mo, d);
    rest = s.slice(m[0].length);
  } else if ((m = /^(\d{4})-W(\d{2})(?:-(\d))?/.exec(s)) || (m = /^(\d{4})W(\d{2})(\d)?/.exec(s))) {
    const [y, w, wd] = [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
    const jan1 = daysFromCivil(y, 1, 1);
    const weeks = weekday(jan1) === 4 || (isLeap(y) && weekday(jan1) === 3) ? 53 : 52;
    if (y < 1 || w < 1 || w > weeks || wd < 1 || wd > 7) return null;
    const jan4 = jan1 + 3;
    days = jan4 - (weekday(jan4) - 1) + (w - 1) * 7 + (wd - 1);
    rest = s.slice(m[0].length);
  } else {
    return null;
  }
  let seconds = days * SEC_PER_DAY;
  if (rest !== "") {
    const body = Array.from(rest).slice(1).join("");
    const cut = body.search(/[+-]/);
    const tzPart = cut < 0 ? "" : body.slice(cut);
    let timePart = cut < 0 ? body : body.slice(0, cut);
    // The parser tolerates one space before an offset (not after a fraction) and a colon left dangling
    // right before one.
    if (tzPart !== "") {
      if (timePart.endsWith(" ") && !/[.,]/.test(timePart)) timePart = timePart.slice(0, -1);
      else if (timePart.endsWith(":")) timePart = timePart.slice(0, -1);
    }
    const t =
      /^(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?$/.exec(timePart) ?? /^(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?$/.exec(timePart);
    if (!t) return null;
    const [h, mi, se] = [Number(t[1]), Number(t[2] ?? 0), Number(t[3] ?? 0)];
    const frac = t[4] ? Number(`0.${t[4]}`) : 0;
    const dayEnd = h === 24 && mi === 0 && se === 0 && frac === 0;
    if ((h > 23 && !dayEnd) || mi > 59 || se > 59) return null;
    seconds += h * 3600 + mi * 60 + se + frac;
    if (tzPart !== "") {
      const z =
        /^([+-])(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?$/.exec(tzPart) ?? /^([+-])(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?$/.exec(tzPart);
      if (!z) return null;
      const [zh, zm, zs] = [Number(z[2]), Number(z[3] ?? 0), Number(z[4] ?? 0)];
      if (zh > 23 || zm > 59 || zs > 59) return null;
      const offset = zh * 3600 + zm * 60 + zs + (z[5] ? Number(`0.${z[5]}`) : 0);
      seconds -= z[1] === "-" ? -offset : offset;
    }
  }
  return seconds;
}

/** The landing a ledger event belongs to: its pull request, else the first 12 characters of its head. */
function landingKey(row: Record<string, unknown>): string | null {
  if (typeof row.pr === "number" && Number.isInteger(row.pr)) return `pull request ${row.pr}`;
  if (typeof row.head === "string" && row.head.trim() !== "") return `head ${Array.from(row.head).slice(0, 12).join("")}`;
  return null;
}

/** Every event in `<run dir>/landings.jsonl`, or why the ledger blocks a closeout. */
function readLedger(path: string): { events: LedgerEvent[] } | { error: string } {
  const read = readRegularFile(path, LEDGER_MAX_BYTES, true);
  if ("missing" in read) return { error: "does not exist, so there is no closeout-check event" };
  if ("notRegular" in read) return { error: "is not a regular file" };
  if ("unreadable" in read) return { error: "cannot be read as UTF-8 text" };
  const events: LedgerEvent[] = [];
  const lines = read.text.split(LINE_BREAK_RE);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const bad = (why: string) => ({ error: `cannot be parsed (line ${i + 1} ${why})` });
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      // Includes a line nested too deeply for the parser (a RangeError).
      return bad("is not valid JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("is not a JSON object");
    const row = value as Record<string, unknown>;
    if (typeof row.event !== "string" || !LEDGER_EVENTS.has(row.event)) return bad("has an unknown event");
    const ts = typeof row.ts === "string" ? ledgerEpoch(row.ts) : null;
    if (ts === null) return bad("has no readable ts");
    const key = LANDING_EVENTS.has(row.event) ? landingKey(row) : null;
    if (LANDING_EVENTS.has(row.event) && key === null) return bad("names neither a pull request nor a head");
    if (row.event === "verified" && !(MAIN_STATES.has(row.main as string) && DEPLOY_STATES.has(row.deploy as string))) {
      return bad("is a verified event without a valid main and deploy");
    }
    events.push({ event: row.event, ts, outcome: row.outcome, key, main: row.main, deploy: row.deploy });
  }
  return { events };
}

/** Why a landing's events leave it unsettled, or null. A merged landing needs a `verified` event after its
 *  last merge with main and the deploy read, whatever event follows; one never merged is open only at
 *  `ready`. */
function unsettled(history: LedgerEvent[]): string | null {
  let lastMerged = -1;
  history.forEach((e, i) => {
    if (e.event === "merged") lastMerged = i;
  });
  if (lastMerged >= 0) {
    const verified = history.slice(lastMerged).filter((e) => e.event === "verified");
    if (!verified.length) return "merged and not verified; run `loop-land verify`";
    const latest = verified[verified.length - 1];
    if (latest.main === "unread" || latest.deploy === "unread") {
      return `verified with ${latest.main === "unread" ? "main" : "the deploy"} unread; run \`loop-land verify\` again`;
    }
    return null;
  }
  return history[history.length - 1].event === "ready" ? "at ready; run `loop-land abandon` or finish it" : null;
}

/** The ledger rule: why the closeout does not count, or null when it does. An `error` event changes no
 *  landing's state; main `red` and the deploy `failed` do not block. */
function ledgerWhyNot(runDir: string): string | null {
  const ledger = readLedger(join(runDir, "landings.jsonl"));
  if ("error" in ledger) return `landing ledger ${ledger.error}`;
  const events = ledger.events;
  const landings = new Map<string, LedgerEvent[]>();
  for (const e of events) if (e.key !== null) landings.set(e.key, [...(landings.get(e.key) ?? []), e]);
  for (const [key, history] of landings) {
    const why = unsettled(history);
    if (why) return `landing ledger has ${key} ${why}`;
  }
  let checkAt = -1;
  let mergedAt = -1;
  let newestMerge = -Infinity;
  events.forEach((e, i) => {
    if (e.event === "closeout-check") checkAt = i;
    else if (e.event === "merged") {
      mergedAt = i;
      newestMerge = Math.max(newestMerge, e.ts);
    }
  });
  if (checkAt < 0) return "landing ledger has no closeout-check event; run `loop-land summary --check`";
  const check = events[checkAt];
  if (mergedAt >= 0 && (checkAt < mergedAt || check.ts < newestMerge)) {
    return "landing ledger closeout-check is older than the last merge; run `loop-land summary --check`";
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
  if (files && wantsLedger(files.charter)) {
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
