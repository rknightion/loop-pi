// Block-only return repair binding. When a lane's final message lacks its lane-return block,
// loop-state resumes the lane once for the block alone. pi-subagents resumes a run with the
// original run's output binding unless the request names another, so a repair that names none
// overwrites the lane's bound report with the block. This module allocates the separate,
// extension-owned file the repair writes to instead, and reads it back safely.
//
// Layout: `<run dir>/return-repairs/r-<32 hex>/block.md`, allocated (directory created) before the
// resume is requested and persisted with the recovery entry. The run dir is harness-written only,
// so a lane cannot plant the file through its tools. A persisted binding stands on its own: every
// launcher start gets a fresh run dir, so a restarted root reads the binding its earlier process
// recorded, never one derived from its own run dir.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export const REPAIR_DIR = "return-repairs";
export const REPAIR_FILE = "block.md";
/** A lane-return block is a few hundred bytes; anything past this is not a block-only reply. */
export const MAX_REPAIR_BYTES = 1024 * 1024;
/** The original report is hashed for its identity only up to this size. */
export const MAX_IDENTITY_BYTES = 64 * 1024 * 1024;
const NAME_RE = /^r-[0-9a-f]{32}$/;

export interface RepairBinding {
  /** The canonical run dir the binding was allocated under. */
  root: string;
  /** `<root>/return-repairs/r-<32 hex>/block.md`. */
  output: string;
}

export interface ArtifactIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

function safeDir(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} is not owned by this user`);
  if (st.mode & 0o022) throw new Error(`${path} is group- or world-writable`);
}

/** A new, empty repair binding under `runDir`. Throws when there is no safe run dir. */
export function allocateRepair(runDir: string | undefined): RepairBinding {
  if (!runDir || !isAbsolute(runDir)) throw new Error("no run dir (LOOP_PI_RUN_DIR) for a separate repair output");
  const root = realpathSync(runDir);
  safeDir(root);
  const parent = join(root, REPAIR_DIR);
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  safeDir(parent);
  const dir = join(parent, `r-${randomUUID().replace(/-/g, "")}`);
  // Exclusive: an existing directory is never reused.
  mkdirSync(dir, { mode: 0o700 });
  return { root, output: join(dir, REPAIR_FILE) };
}

/** The binding when `value` has the exact allocated shape, else null. Independent of the current run dir. */
export function validBinding(value: unknown): RepairBinding | null {
  if (!value || typeof value !== "object") return null;
  const { root, output } = value as Record<string, unknown>;
  if (typeof root !== "string" || typeof output !== "string" || !isAbsolute(root) || normalize(root) !== root) return null;
  const name = basename(dirname(output));
  if (!NAME_RE.test(name) || output !== join(root, REPAIR_DIR, name, REPAIR_FILE)) return null;
  return { root, output };
}

/** The repair's saved text. Throws on an invalid binding, a moved or unsafe directory, a link,
 *  a non-regular, shared or oversized file, or bytes that are not UTF-8. */
export function readRepair(binding: RepairBinding): string {
  const valid = validBinding(binding);
  if (!valid) throw new Error("invalid repair binding");
  if (realpathSync(valid.root) !== valid.root) throw new Error("repair run dir moved");
  for (const dir of [valid.root, join(valid.root, REPAIR_DIR), dirname(valid.output)]) safeDir(dir);
  const fd = openSync(valid.output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("repair output is not a plain file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("repair output is not owned by this user");
    if (st.size > MAX_REPAIR_BYTES) throw new Error("repair output is oversized");
    const bytes = Buffer.alloc(MAX_REPAIR_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_REPAIR_BYTES) throw new Error("repair output is oversized");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}

export function identityOf(path: string, bytes: Buffer): ArtifactIdentity {
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The identity of a regular file, or null when it is absent, not a file or past the size bound. */
export function artifactIdentity(path: string): ArtifactIdentity | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_IDENTITY_BYTES) return null;
    return identityOf(path, readFileSync(path));
  } catch {
    return null;
  }
}

/** The identity when `value` has its shape, else null. */
export function validIdentity(value: unknown): ArtifactIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { path, bytes, sha256 } = value as Record<string, unknown>;
  if (typeof path !== "string" || !isAbsolute(path) || typeof bytes !== "number" || !Number.isInteger(bytes) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { path, bytes, sha256 };
}
