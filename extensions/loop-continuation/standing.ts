// The standing-authority registry entry frozen at arm (frozen seam S-STANDING). The launch may
// carry one line
//   Standing: <absolute path> sha256=<64 hex>
// parsed exactly like `Audit grants:`, and it must agree with the goal's `## Authority` `standing:`
// key (arm.ts). At arm the file is read once, checked against the stated digest and copied to
// `$LOOP_PI_RUN_DIR/standing.md`. A missing file or a mismatch means no standing file and an
// incident under `incidents/ops/`; the arm still succeeds.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STANDING_FILE = "standing.md";
export const STANDING_REJECTED_CLASS = "loop-standing-rejected";

export type StandingLine =
  | { kind: "none" }
  | { kind: "line"; path: string; sha256: string }
  | { kind: "invalid"; reason: string };

const LINE_START_RE = /^Standing:/;
const LINE_RE = /^Standing:[ \t]+(.+?)[ \t]+sha256=([0-9a-fA-F]{64})[ \t]*$/;

/** Find the `Standing:` line in a launch text. One well-formed line is the only accepted form. */
export function parseStandingLine(text: string): StandingLine {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => LINE_START_RE.test(line));
  if (lines.length === 0) return { kind: "none" };
  if (lines.length > 1) return { kind: "invalid", reason: "the launch carries more than one Standing line" };
  const m = LINE_RE.exec(lines[0]);
  if (!m) return { kind: "invalid", reason: "the Standing line is not `Standing: <path> sha256=<64 hex>`" };
  if (!m[1].startsWith("/")) return { kind: "invalid", reason: "the Standing path is not absolute" };
  return { kind: "line", path: m[1], sha256: m[2].toLowerCase() };
}

export interface StandingFreeze {
  /** The frozen copy in the run dir, or null when there is no standing file. */
  path: string | null;
  /** The digest the launch stated and the frozen copy matched, or null. */
  sha256: string | null;
  /** The path the launch named, for the incident. */
  sourcePath: string | null;
  /** Why the named file was refused, or null. */
  rejected: string | null;
}

const NONE: StandingFreeze = { path: null, sha256: null, sourcePath: null, rejected: null };

/** Read, check and copy the standing registry file named by the launch into `runDir`. */
export function freezeStanding(
  line: StandingLine,
  runDir: string,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): StandingFreeze {
  if (line.kind === "none") return NONE;
  if (line.kind === "invalid") return { ...NONE, rejected: line.reason };
  const refuse = (rejected: string): StandingFreeze => ({ ...NONE, sourcePath: line.path, rejected });
  let bytes: Buffer;
  try {
    bytes = readFile(line.path);
  } catch {
    return refuse("the standing file cannot be read");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== line.sha256) {
    return refuse("the standing file sha256 does not match the launch line");
  }
  const path = join(runDir, STANDING_FILE);
  try {
    writeFileSync(path, bytes);
  } catch {
    return refuse("the standing file could not be copied into the run dir");
  }
  return { path, sha256: line.sha256, sourcePath: line.path, rejected: null };
}
