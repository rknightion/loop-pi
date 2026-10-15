import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AuditLine, parseAuditLine } from "./audit-grants.ts";
import { parseStandingLine, type StandingLine } from "./standing.ts";

// Ported from the author's loop_launch.py (frozen v3 seam S1: run identity and launch recognition).
// A launch is operator text matching "You are the (campaign) root" with exactly one distinct
// closeout token `codex/closeout-<name>-loop<N>.md`, or a bare path to an existing `launch-*.txt`
// or `launch-*.md` whose contents match. v2 `report-*` tokens are not recognised.
//
// Not ported: the "Do not pivot on receipt" mid-run closeout replacement. loop-pi never supported
// it, and moving the closeout would move the state log derived from it (S3) under live lanes.

export interface LaunchInfo {
  /** Resolved closeout path (kept relative if no cwd/base was available at recognition time). The
   *  key keeps its v2 name (S1). */
  report: string;
  loop: number | null;
  /** ISO timestamp of the launch prompt, used to check the closeout postdates it. */
  launchTs: string;
  /** Always "v3" for a launch recognised by this build; absent in state armed by an older build. */
  mode?: "v3";
  /** sha256 of the recognised launch text (the launch file's bytes for a bare-path launch). */
  launchSha256?: string;
  /** The recognised text's optional `Time budget: <N>s|m|h` line, in seconds, or null. */
  budget?: number | null;
}

/** A recognised launch plus what its text says about audit grants, standing and its charter (never
 *  persisted as part of LaunchInfo). */
export interface ParsedLaunch extends LaunchInfo {
  /** Whether the text carries an `Ops grants:` line. v3 has no ops lane, so arming refuses one. */
  hasOpsLine: boolean;
  auditLine: AuditLine;
  standingLine: StandingLine;
  /** The charter: the one `codex/charter-*-loop<N>.md` the launch names, else the closeout's sibling. */
  charter: string;
}

const MARKER_RE = /\bYou are the (?:campaign )?root\b/;

// <name>: "closeout-<anything>-loop<N>.md".
const NAME = "closeout-[\\w.-]*-loop\\d+\\.md";

// Closeout-token prefixes: "/abs/.../codex/", "./codex/" or bare "codex/".
const PREFIX = "(?:/(?:[^\\s`'\"()]*/)*codex/|\\./codex/|codex/)";

// Left boundary: start of text, whitespace, or one of ` ' " (
// Right boundary: end of text, whitespace, or one of ` ' " ) , ; :, or a sentence-ending "."
// that is itself followed by whitespace or the end of text.
const LEFT = "(?:^|(?<=[\\s`'\"(]))";
const RIGHT = "(?:$|(?=[\\s`'\")\\,;:])|(?=\\.(?:\\s|$)))";

const TOKEN_RE = new RegExp(LEFT + "(" + PREFIX + NAME + ")" + RIGHT, "g");
const CHARTER_TOKEN_RE = new RegExp(LEFT + "(" + PREFIX + "charter-[\\w.-]*-loop\\d+\\.md)" + RIGHT, "g");
const OPS_LINE_RE = /^Ops grants:/m;
// Optional "Time budget: <N>s|m|h" line in the recognised launch text (S1 `budget`).
const BUDGET_RE = /^\s*Time budget:\s*(\d+)\s*([smh])\b/im;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };
const LOOP_SUFFIX_RE = /-loop(\d+)\.md$/;
const BARE_LAUNCH_NAME_RE = /^launch-.*\.(?:txt|md)$/;

function findTokens(text: string, re: RegExp): string[] {
  const tokens: string[] = [];
  // Reset lastIndex: the token regexes are module-level `g` regexes reused across calls.
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++; // guard a zero-width match
  }
  return tokens;
}

function findCloseoutTokens(text: string): string[] {
  return findTokens(text, TOKEN_RE);
}

/** The charter a launch names (one distinct `codex/charter-*-loop<N>.md`), else the closeout's sibling charter. */
function charterFor(text: string, base: string | null, closeout: string): string {
  const named = singleTarget(findTokens(text, CHARTER_TOKEN_RE), base);
  if (named) return named.report;
  const slash = closeout.lastIndexOf("/");
  return closeout.slice(0, slash + 1) + closeout.slice(slash + 1).replace(/^closeout-/, "charter-");
}

function budgetSeconds(text: string): number | null {
  const m = BUDGET_RE.exec(text);
  return m ? parseInt(m[1], 10) * UNIT_SECONDS[m[2].toLowerCase()] : null;
}

function finalize(target: { report: string; loop: number | null }, text: string, base: string | null, launchTs: string): ParsedLaunch {
  return {
    report: target.report,
    loop: target.loop,
    launchTs,
    mode: "v3",
    launchSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    budget: budgetSeconds(text),
    hasOpsLine: OPS_LINE_RE.test(text),
    auditLine: parseAuditLine(text),
    standingLine: parseStandingLine(text),
    charter: charterFor(text, base, target.report),
  };
}

function extractLoop(token: string): number | null {
  const m = LOOP_SUFFIX_RE.exec(token);
  return m ? parseInt(m[1], 10) : null;
}

function normalizePath(p: string): string {
  // A small POSIX-only normalizer (collapse "." and ".." segments and duplicate slashes),
  // matching os.path.normpath closely enough for the absolute paths this module handles.
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

function resolveToken(token: string, base: string | null): string {
  if (token.startsWith("/")) return normalizePath(token);
  const rel = token.startsWith("./") ? token.slice(2) : token;
  if (!base) return rel;
  return normalizePath(base.replace(/\/+$/, "") + "/" + rel);
}

/** Resolve every token against `base`; return the single distinct target, or null for 0 or 2+.
 *  (`loop` is read from a closeout-shaped name; callers resolving a charter token use `report` only.) */
function singleTarget(tokens: string[], base: string | null): { report: string; loop: number | null } | null {
  const absolutes = tokens.filter((t) => t.startsWith("/")).map(normalizePath);
  const targets = new Map<string, string>(); // resolved path -> original token (first wins)
  for (const token of tokens) {
    if (!token.startsWith("/")) {
      const rel = token.startsWith("./") ? token.slice(2) : token;
      if (absolutes.some((a) => a.endsWith("/" + rel))) continue;
    }
    const resolved = resolveToken(token, base);
    if (!targets.has(resolved)) targets.set(resolved, token);
  }
  if (targets.size !== 1) return null;
  const [[report, token]] = targets.entries();
  return { report, loop: extractLoop(token) };
}

function recognize(text: string, base: string | null): { report: string; loop: number | null } | null {
  if (!MARKER_RE.test(text)) return null;
  return singleTarget(findCloseoutTokens(text), base);
}

/** The parent of the nearest enclosing `codex/` directory, or null if there is none. */
function codexDirParent(absPath: string): string | null {
  const segments = absPath.split("/");
  for (let i = segments.length - 1; i >= 1; i--) {
    if (segments[i] === "codex") {
      return segments.slice(0, i).join("/") || "/";
    }
  }
  return null;
}

function stripWrapping(text: string): string {
  const s = text.trim();
  if (s.length >= 2 && s[0] === "`" && s[s.length - 1] === "`") return s.slice(1, -1).trim();
  return s;
}

function bareCandidatePath(text: string): string | null {
  const s = stripWrapping(text);
  if (!s || s.includes("\n")) return null;
  return s;
}

export interface ReadFile {
  (path: string): string;
}

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

/**
 * Recognise a loop launch in `text` (frozen v3 seam S1).
 *
 * `cwd` resolves a relative closeout token pasted directly in `text`; `launchTs` is the ISO
 * timestamp of the prompt, used later to check the closeout postdates the launch. `readFile` lets
 * tests stub file reads for the bare `launch-*.txt`/`launch-*.md` path form.
 */
export function parseLaunch(
  text: string,
  cwd: string | null,
  launchTs: string,
  readFile: ReadFile = defaultReadFile,
): ParsedLaunch | null {
  if (!text) return null;

  const direct = recognize(text, cwd || null);
  if (direct !== null) return finalize(direct, text, cwd || null, launchTs);

  const candidate = bareCandidatePath(text);
  if (candidate === null) return null;
  const launchPath = candidate.startsWith("/") ? candidate : normalizePath((cwd || "") + "/" + candidate);
  const basename = launchPath.split("/").pop() ?? "";
  if (!BARE_LAUNCH_NAME_RE.test(basename)) return null;

  let content: string;
  try {
    content = readFile(launchPath);
  } catch {
    return null;
  }
  if (typeof content !== "string") return null;

  // A relative closeout inside the launch file resolves against the parent of the codex/
  // directory holding the launch file. Outside any codex/ directory there is no base, so the
  // file must name an absolute closeout path.
  const base = codexDirParent(launchPath);
  const inner = recognize(content, base);
  if (inner === null || !inner.report.startsWith("/")) return null;
  return finalize(inner, content, base, launchTs);
}
