// Audit grants frozen at arm (frozen seam S2). The launch may carry one line
//   Audit grants: <absolute path> sha256=<64 hex>
// parsed exactly like `Ops grants:`. At arm the file is read once, checked against the stated
// digest, and copied to `$LOOP_PI_RUN_DIR/audit-grants.json`; the digest is held for the closeout
// audit (`--grants <copy> --grants-sha256 <digest>`). A missing file, a mismatch or a file that is
// not a JSON object means no audit grants and an incident under `incidents/ops/`.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIT_GRANTS_FILE = "audit-grants.json";
export const AUDIT_GRANTS_REJECTED_CLASS = "loop-audit-grants-rejected";

export type AuditLine =
  | { kind: "none" }
  | { kind: "line"; path: string; sha256: string }
  | { kind: "invalid"; reason: string };

const LINE_START_RE = /^Audit grants:/;
const LINE_RE = /^Audit grants:[ \t]+(.+?)[ \t]+sha256=([0-9a-fA-F]{64})[ \t]*$/;

/** Find the `Audit grants:` line in a launch text. One well-formed line is the only accepted form. */
export function parseAuditLine(text: string): AuditLine {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => LINE_START_RE.test(line));
  if (lines.length === 0) return { kind: "none" };
  if (lines.length > 1) return { kind: "invalid", reason: "the launch carries more than one Audit grants line" };
  const m = LINE_RE.exec(lines[0]);
  if (!m) return { kind: "invalid", reason: "the Audit grants line is not `Audit grants: <path> sha256=<64 hex>`" };
  if (!m[1].startsWith("/")) return { kind: "invalid", reason: "the Audit grants path is not absolute" };
  return { kind: "line", path: m[1], sha256: m[2].toLowerCase() };
}

export interface AuditFreeze {
  /** The frozen copy in the run dir, or null when there are no audit grants. */
  path: string | null;
  /** The digest held for the closeout audit, or null. */
  sha256: string | null;
  /** The path the launch named, for the incident. */
  sourcePath: string | null;
  /** Why the named file was refused, or null. */
  rejected: string | null;
}

const NONE: AuditFreeze = { path: null, sha256: null, sourcePath: null, rejected: null };

/** Read, check and copy the audit grants file named by the launch into `runDir`. */
export function freezeAuditGrants(
  line: AuditLine,
  runDir: string,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): AuditFreeze {
  if (line.kind === "none") return NONE;
  if (line.kind === "invalid") return { ...NONE, rejected: line.reason };
  const refuse = (rejected: string): AuditFreeze => ({ ...NONE, sourcePath: line.path, rejected });
  let bytes: Buffer;
  try {
    bytes = readFile(line.path);
  } catch {
    return refuse("the audit grants file cannot be read");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== line.sha256) {
    return refuse("the audit grants file sha256 does not match the launch line");
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse("the audit grants file is not a JSON object");
  } catch {
    return refuse("the audit grants file is not valid JSON");
  }
  const path = join(runDir, AUDIT_GRANTS_FILE);
  try {
    writeFileSync(path, bytes);
  } catch {
    return refuse("the audit grants file could not be copied into the run dir");
  }
  return { path, sha256: line.sha256, sourcePath: line.path, rejected: null };
}
