// Protocol 2 paths (SEAMS S0, S1, S8): the loop run dir, its `loop-pi-proto` marker, the
// standing-authority registry, and the write refusals built on them for edit/write tool paths
// (exact) and bash write targets (best effort, through rules.ts's `protectedPath`).
//
// The run dir is `$LOOP_PI_RUN_DIR`, or for a lane without it in its environment the `runDir` its
// root bound. Every refusal here applies only while `<run dir>/loop-pi-proto` exists, so a root
// armed by an older build keeps today's verdicts. Lane worktrees live under
// `<run dir>/worktrees/<lane-id>/` (S9): the files inside a lane's worktree are the lane's own
// work and stay writable; everything else under the run dir is written only by the harness.

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename as pathBasename, isAbsolute, join, resolve } from "node:path";
import { isGrantsPath, isLoopControlPath, rootControlReason } from "./rules.ts";

export const RUN_DIR_ENV = "LOOP_PI_RUN_DIR";
export const PROTO_MARKER = "loop-pi-proto";

/** `$LOOP_PI_RUN_DIR` when it is an absolute path. */
export function runDirFromEnv(): string | undefined {
  const value = process.env[RUN_DIR_ENV];
  return value && isAbsolute(value) ? value : undefined;
}

/** True when the run dir carries the protocol 2 marker. Checked per call: the marker is written
 *  when the root arms, after the extensions load. */
export function protoActive(runDir: string | undefined): boolean {
  return runDir !== undefined && existsSync(join(runDir, PROTO_MARKER));
}

/** The standing-authority registry (SEAMS S11), written only by the planner. */
export function authorityDir(): string {
  return join(homedir(), "repos", "agent-docs", "authority");
}

/** The absolute path pi's edit/write tools resolve `path` to (`@` prefix, `~`, `file://`). */
export function toolPath(raw: string, cwd: string): string {
  let p = raw.replace(/[  -​  　]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (p.startsWith("file://")) p = new URL(p).pathname;
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** The path with symlinks resolved, following a dangling link to its target and otherwise
 *  resolving through the deepest existing ancestor. */
export function realPath(p: string, depth = 0): string {
  if (depth > 16) return p;
  try {
    return realpathSync(p);
  } catch {
    try {
      if (lstatSync(p).isSymbolicLink()) return realPath(resolve(dirname(p), readlinkSync(p)), depth + 1);
    } catch {
      // Not present: resolve the parent instead.
    }
    const parent = dirname(p);
    if (parent === p) return p;
    return join(realPath(parent, depth + 1), pathBasename(p));
  }
}

/** A bash word as the shell would expand the parts the guard can read: a leading
 *  `$LOOP_PI_RUN_DIR`, `$HOME` (either spelling) or `~`, then relative to `cwd`. */
export function shellPath(raw: string, cwd: string, runDir: string | undefined): string {
  let p = raw;
  const runVar = /^\$(?:\{LOOP_PI_RUN_DIR\}|LOOP_PI_RUN_DIR)(?=\/|$)/;
  if (runVar.test(p) && runDir !== undefined) p = p.replace(runVar, runDir);
  p = p.replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/, homedir());
  return toolPath(p, cwd);
}

// macOS volumes are case-insensitive by default: compare folded there.
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);

/** `path` relative to `dir` when it is `dir` or inside it, else undefined. */
function inside(path: string, dir: string): string | undefined {
  const d = fold(dir).replace(/\/+$/, "");
  const p = fold(path);
  if (p === d) return "";
  return p.startsWith(`${d}/`) ? path.slice(d.length + 1) : undefined;
}

/** Both spellings of a path: as written (made absolute) and with its symlinks resolved. */
function spellings(absolute: string): string[] {
  const real = realPath(absolute);
  return real === absolute ? [absolute] : [absolute, real];
}

/** Why an absolute path is a protected run-dir file, or undefined. */
export function runDirWriteReason(absolute: string, runDir: string, shown = absolute): string | undefined {
  for (const candidate of spellings(absolute)) {
    for (const dir of spellings(resolve(runDir))) {
      const rel = inside(candidate, dir);
      if (rel === undefined) continue;
      const parts = rel.split("/").filter(Boolean);
      // A file inside a lane's own worktree (`worktrees/<lane-id>/...`) is that lane's work.
      if (parts.length >= 3 && fold(parts[0]) === "worktrees") continue;
      return `loop-guard: '${shown}' is inside the loop run dir (${runDir}); only the harness writes its files.`;
    }
  }
  return undefined;
}

/** Why an absolute path is in the standing-authority registry, or undefined. */
export function authorityWriteReason(absolute: string, shown = absolute): string | undefined {
  for (const candidate of spellings(absolute)) {
    for (const dir of spellings(authorityDir())) {
      if (inside(candidate, dir) !== undefined) {
        return `loop-guard: '${shown}' is in the standing-authority registry; only the planner writes it, never a loop.`;
      }
    }
  }
  return undefined;
}

export type GuardRole = "root" | "lane";

/** The `protectedPath` predicate rules.ts applies to bash write targets under protocol 2: the run
 *  dir for every role, and the authority registry for lanes. */
export function bashProtectedPath(role: GuardRole, cwd: string, runDir: string | undefined): (path: string) => string | undefined {
  return (word: string) => {
    const absolute = shellPath(word, cwd, runDir);
    if (runDir !== undefined) {
      const reason = runDirWriteReason(absolute, runDir, word);
      if (reason) return reason;
    }
    return role === "lane" ? authorityWriteReason(absolute, word) : undefined;
  };
}

/** True when an edit/write tool path is a loop control file (`codex/grants-*` too under protocol 2). */
export function isLoopControlToolPath(raw: unknown, cwd: string, grants = false): boolean {
  if (typeof raw !== "string") return false;
  const absolute = toolPath(raw, cwd);
  return isLoopControlPath(absolute, undefined, { grants }) || isLoopControlPath(realPath(absolute), undefined, { grants });
}

/** True when an edit/write tool path is one of the planner's files the root may not write under
 *  protocol 2 (`codex/ops-*`, `codex/grants-*`, `codex/launch-*`, `codex/goal-*`), either spelling. */
export function isRootControlToolPath(raw: string, cwd: string): boolean {
  const absolute = toolPath(raw, cwd);
  return isLoopControlPath(absolute, undefined, { root: true }) || isLoopControlPath(realPath(absolute), undefined, { root: true });
}

/** Protocol 2 refusal for an edit/write tool path: the run dir and the authority registry for
 *  root and lanes, `codex/grants-*` for lanes, and the planner's files (`codex/ops|grants|launch|goal-*`)
 *  for the root. Call only while the marker exists. */
export function toolWriteRefusal(raw: unknown, cwd: string, role: GuardRole, runDir: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const absolute = toolPath(raw, cwd);
  if (runDir !== undefined) {
    const reason = runDirWriteReason(absolute, runDir, raw);
    if (reason) return reason;
  }
  const authority = authorityWriteReason(absolute, raw);
  if (authority) return authority;
  if (role === "lane" && (isGrantsPath(absolute) || isGrantsPath(realPath(absolute)))) {
    return `loop-guard: lanes may not write '${raw}': codex/grants-* belongs to the root.`;
  }
  if (role === "root" && isRootControlToolPath(raw, cwd)) return rootControlReason(raw);
  return undefined;
}
