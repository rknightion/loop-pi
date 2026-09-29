import { readFileSync } from "node:fs";

// Ported from the author's loop_launch.py (frozen spec: seam v2.1 section 1),
// restricted to the "v2" (strict) report grammar. loop-pi has no pre-existing ACTIVATED_AT
// migration to support (that machinery in loop_launch.py/fanout_session.py exists only to let
// old Claude/Codex sessions predating the v2 report header format keep working); a brand-new
// pi root always writes v2-shaped reports, so this port fixes mode to "v2" and drops the
// legacy branch entirely. plan.md C7's own release condition ("the report counts (header
// names this loop, written after the launch)") already assumes the v2 header check.
//
// Also dropped: the "Do not pivot on receipt" mid-run report-path replacement (fanout_session
// REPLACEMENT_RE) and the "Time budget" line. Neither is named in plan.md's C7 bullets, which
// cover only arm / release / nudge / strike-cap.

export interface LaunchInfo {
  /** Resolved report path (kept relative if no cwd/base was available at recognition time). */
  report: string;
  loop: number | null;
  /** ISO timestamp of the launch prompt, used to check the report postdates it. */
  launchTs: string;
}

const MARKER_RE = /\bYou are the (?:campaign )?root\b/;

// <name>: "report-<anything>-loop<N>.md".
const NAME_V2 = "report-[\\w.-]*-loop\\d+\\.md";

// Report-token prefixes: "/abs/.../codex/", "./codex/" or bare "codex/".
const PREFIX = "(?:/(?:[^\\s`'\"()]*/)*codex/|\\./codex/|codex/)";

// Left boundary: start of text, whitespace, or one of ` ' " (
// Right boundary: end of text, whitespace, or one of ` ' " ) , ; :, or a sentence-ending "."
// that is itself followed by whitespace or the end of text.
const LEFT = "(?:^|(?<=[\\s`'\"(]))";
const RIGHT = "(?:$|(?=[\\s`'\")\\,;:])|(?=\\.(?:\\s|$)))";

const TOKEN_RE = new RegExp(LEFT + "(" + PREFIX + NAME_V2 + ")" + RIGHT, "g");
const LOOP_SUFFIX_RE = /-loop(\d+)\.md$/;
const BARE_LAUNCH_NAME_RE = /^launch-.*\.(?:txt|md)$/;

function findReportTokens(text: string): string[] {
  const tokens: string[] = [];
  // Reset lastIndex: TOKEN_RE is a module-level `g` regex reused across calls.
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    tokens.push(m[1]);
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++; // guard a zero-width match
  }
  return tokens;
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

/** Resolve every token against `base`; return the single distinct target, or null for 0 or 2+. */
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
  return singleTarget(findReportTokens(text), base);
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
 * Recognise a loop launch in `text` (seam v2.1 section 1, v2/strict mode only).
 *
 * `cwd` resolves a relative report token pasted directly in `text`; `launchTs` is the ISO
 * timestamp of the prompt, used later to check the report postdates the launch. `readFile` lets
 * tests stub file reads for the bare `launch-*.txt`/`launch-*.md` path form.
 */
export function parseLaunch(
  text: string,
  cwd: string | null,
  launchTs: string,
  readFile: ReadFile = defaultReadFile,
): LaunchInfo | null {
  if (!text) return null;

  const direct = recognize(text, cwd || null);
  if (direct !== null) {
    return { report: direct.report, loop: direct.loop, launchTs };
  }

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

  // A relative report inside the launch file resolves against the parent of the codex/
  // directory holding the launch file. Outside any codex/ directory there is no base, so the
  // file must name an absolute report path.
  const inner = recognize(content, codexDirParent(launchPath));
  if (inner === null || !inner.report.startsWith("/")) return null;
  return { report: inner.report, loop: inner.loop, launchTs };
}
