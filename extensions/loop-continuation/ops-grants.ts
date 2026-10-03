// Ops grants frozen at launch. The launch message may carry one line
//   Ops grants: <absolute path> sha256=<64 hex>
// naming a JSON file of ops grants. The file is read once, checked against the stated digest and
// shape, and the parsed content is kept in the continuation state, so a later edit of the file is
// ignored. Any problem yields no grants plus a reason the caller records as an incident.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const OPS_KINDS = ["deploy", "probe", "release", "secret-write", "credential-create"] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

export interface OpsEntry {
  surface: string;
  kind: OpsKind;
  allow: string[];
  secret_paths: string[];
}

export interface OpsGrants {
  v: 1;
  ops: OpsEntry[];
}

/** What a launch text says about ops grants. */
export type OpsLine =
  | { kind: "none" }
  | { kind: "line"; path: string; sha256: string }
  | { kind: "invalid"; reason: string };

const OPS_LINE_START_RE = /^Ops grants:/;
const OPS_LINE_RE = /^Ops grants:[ \t]+(.+?)[ \t]+sha256=([0-9a-fA-F]{64})[ \t]*$/;

/** Find the `Ops grants:` line in a launch text. One well-formed line is the only accepted form. */
export function parseOpsLine(text: string): OpsLine {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => OPS_LINE_START_RE.test(line));
  if (lines.length === 0) return { kind: "none" };
  if (lines.length > 1) return { kind: "invalid", reason: "the launch carries more than one Ops grants line" };
  const m = OPS_LINE_RE.exec(lines[0]);
  if (!m) return { kind: "invalid", reason: "the Ops grants line is not `Ops grants: <path> sha256=<64 hex>`" };
  if (!m[1].startsWith("/")) return { kind: "invalid", reason: "the Ops grants path is not absolute" };
  return { kind: "line", path: m[1], sha256: m[2].toLowerCase() };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate the ops file shape. Returns the grants, or the first reason it is invalid. */
export function validateOps(value: unknown): { ok: true; ops: OpsGrants } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "the ops file is not a JSON object" };
  }
  const root = value as Record<string, unknown>;
  if (root.v !== 1) return { ok: false, reason: "the ops file `v` is not 1" };
  if (!Array.isArray(root.ops)) return { ok: false, reason: "the ops file has no `ops` array" };
  const entries: OpsEntry[] = [];
  for (const [index, raw] of root.ops.entries()) {
    const where = `ops[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `${where} is not an object` };
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.surface !== "string" || entry.surface.length === 0) {
      return { ok: false, reason: `${where}.surface is not a non-empty string` };
    }
    if (typeof entry.kind !== "string" || !(OPS_KINDS as readonly string[]).includes(entry.kind)) {
      return { ok: false, reason: `${where}.kind is not one of ${OPS_KINDS.join("|")}` };
    }
    if (!isStringArray(entry.allow)) return { ok: false, reason: `${where}.allow is not an array of strings` };
    for (const pattern of entry.allow) {
      try {
        new RegExp(pattern);
      } catch {
        return { ok: false, reason: `${where}.allow holds a pattern that is not a valid regular expression` };
      }
    }
    if (!isStringArray(entry.secret_paths)) {
      return { ok: false, reason: `${where}.secret_paths is not an array of strings` };
    }
    entries.push({
      surface: entry.surface,
      kind: entry.kind as OpsKind,
      allow: [...entry.allow],
      secret_paths: [...entry.secret_paths],
    });
  }
  return { ok: true, ops: { v: 1, ops: entries } };
}

export type Freeze = { ops: OpsGrants | null; opsPath: string | null; rejected: string | null };

/**
 * Freeze the ops grants named by a launch's `Ops grants:` line. No line: no grants, nothing
 * rejected. A missing file, a digest mismatch or an invalid file: no grants, `rejected` says why.
 */
export function freezeOpsGrants(
  line: OpsLine,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): Freeze {
  if (line.kind === "none") return { ops: null, opsPath: null, rejected: null };
  if (line.kind === "invalid") return { ops: null, opsPath: null, rejected: line.reason };
  let bytes: Buffer;
  try {
    bytes = readFile(line.path);
  } catch {
    return { ops: null, opsPath: line.path, rejected: "the ops file cannot be read" };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== line.sha256) {
    return { ops: null, opsPath: line.path, rejected: "the ops file sha256 does not match the launch line" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ops: null, opsPath: line.path, rejected: "the ops file is not valid JSON" };
  }
  const checked = validateOps(parsed);
  if (!checked.ok) return { ops: null, opsPath: line.path, rejected: checked.reason };
  return { ops: checked.ops, opsPath: line.path, rejected: null };
}
