// Live v3 evidence validation belongs at ingestion, not in the legacy-compatible pure parser.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Null means valid. A diagnostic names the claim that must not be admitted to the state log. */
export function laneReturnError(block: Record<string, unknown> | null, cwd: string): string | null {
  if (!block || block.v !== 3) return null;
  // Validate scalar claims before touching artifacts: projection must not silently drop an
  // invalid exit and turn malformed evidence into an apparently clean complete outcome.
  if (block.exit !== null && block.exit !== undefined &&
      (typeof block.exit !== "number" || !Number.isFinite(block.exit) || !Number.isInteger(block.exit))) {
    return "exit must be a finite integer, null or omitted";
  }
  if (block.status === "complete" && typeof block.exit === "number" && block.exit !== 0) {
    return `exit ${block.exit} is inconsistent with status complete`;
  }
  // Read-only roles and senior commit-SHA returns need no candidate patch.
  if (block.patch === null || block.patch === undefined) return null;
  if (typeof block.patch !== "string" || !block.patch || block.patch.includes("\0")) {
    return "patch must name a readable regular file";
  }
  if (typeof block.patch_sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(block.patch_sha256)) {
    return "patch_sha256 must be a SHA-256 digest for the named patch";
  }
  const path = resolve(cwd, block.patch);
  let fd: number | undefined;
  try {
    // Nonblocking open avoids hanging the event queue on a FIFO. Stat and hash the same opened
    // file so replacing the pathname between those operations cannot validate different bytes.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return `patch must name a regular file: ${path}`;
    const actual = createHash("sha256").update(readFileSync(fd)).digest("hex");
    const claimed = block.patch_sha256.toLowerCase();
    if (actual !== claimed) return `patch_sha256 mismatch for named patch ${path}: claimed ${claimed}, actual ${actual}`;
    return null;
  } catch (error) {
    return `patch ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        return `patch close failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
}
