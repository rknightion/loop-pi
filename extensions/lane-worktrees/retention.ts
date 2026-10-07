// Package-independent patch authority. Originals are read only; this module never prunes files.
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PatchRun {
  runId: string;
  lane: string;
  task: string;
  asyncDir: string;
}
export interface PatchManifest {
  v: 1;
  runId: string;
  identity: string;
  disposition: "pending" | "landed" | "rejected";
  patches: { source: string; sha256: string; bytes: number }[];
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
const beneath = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** Check every existing ancestor, not just the leaf. This is an honest-mistake fence, not a sandbox. */
function directory(path: string, create = false): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) directory(parent, create);
  if (!existsSync(absolute) && create) mkdirSync(absolute, { mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("patch retention directory is missing or linked");
  return realpathSync(absolute);
}
function bytes(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("invalid or oversized patch retention file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function store(runDir: string, runId: string): string {
  if (!isAbsolute(runDir) || !validId(runId)) throw new Error("invalid patch retention identity");
  if (lstatSync(runDir).isSymbolicLink()) throw new Error("linked patch authority refused");
  return join(directory(realpathSync(runDir)), "lane-patches", hash(runId));
}
export function patchManifestPath(runDir: string, runId: string): string {
  return join(store(runDir, runId), "manifest.json");
}
function load(path: string, runId: string): PatchManifest | undefined {
  if (!existsSync(path)) return undefined;
  directory(dirname(path));
  const m = JSON.parse(bytes(path).toString("utf8")) as PatchManifest;
  if (m?.v !== 1 || m.runId !== runId || !/^[a-f0-9]{64}$/.test(m.identity)
    || !["pending", "landed", "rejected"].includes(m.disposition) || !Array.isArray(m.patches)
    || m.patches.length > 512 || m.patches.some((p) => !p || typeof p.source !== "string"
      || !p.source.startsWith("worktree-diffs/") || p.source.split("/").some((s) => !s || s === "." || s === "..")
      || !/^[a-f0-9]{64}$/.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 0)) {
    throw new Error("invalid patch retention manifest");
  }
  return m;
}
function durableWrite(path: string, data: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function save(path: string, manifest: PatchManifest): void {
  // Exclusive temp creation and atomic publication; failed writes leave previous authority intact.
  const temp = `${path}.${randomUUID()}.tmp`;
  durableWrite(temp, `${JSON.stringify(manifest)}\n`);
  renameSync(temp, path);
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function withStoreLock<T>(runDir: string, runId: string, action: () => T): T {
  const target = directory(store(runDir, runId), true);
  // Concurrent roots cannot lose captured versions or overwrite a root decision. A crashed holder
  // leaves a fail-closed lock for manual recovery; never guess that it is stale and reap it.
  const lock = join(target, ".capture.lock");
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
}

/** Copy package-generated worktree-diffs, including binary patch bytes, into the run's durable store.
 * Missing originals are not evidence of acceptance. Existing versions remain referenced forever.
 * No package lifecycle metadata (waits, sessions, refs) is fabricated or modified.
 */
export function captureLanePatches(runDir: string, run: PatchRun): PatchManifest {
  if (!isAbsolute(run.asyncDir) || dirname(run.asyncDir) === run.asyncDir || run.asyncDir.split(sep).at(-1) !== run.runId) {
    throw new Error("invalid async patch source identity");
  }
  // Resolve existing root aliases (e.g. an OS temp prefix) before comparing confinement.
  const asyncRoot = existsSync(dirname(run.asyncDir)) ? realpathSync(dirname(run.asyncDir)) : resolve(dirname(run.asyncDir));
  if (beneath(asyncRoot, realpathSync(runDir))) throw new Error("patch authority is inside the async tree");
  return withStoreLock(runDir, run.runId, () => capture(runDir, run));
}
function capture(runDir: string, run: PatchRun): PatchManifest {
  const target = store(runDir, run.runId);
  directory(target, true);
  const path = join(target, "manifest.json");
  const identity = hash(JSON.stringify([run.lane, run.task, run.runId]));
  const manifest = load(path, run.runId) ?? { v: 1, runId: run.runId, identity, disposition: "pending", patches: [] };
  if (manifest.identity !== identity) throw new Error("patch retention owner changed");
  // A terminal root decision cannot acquire later patches from a resumed/reused run.
  if (manifest.disposition !== "pending") return manifest;
  if (existsSync(run.asyncDir)) {
    const source = directory(join(directory(realpathSync(dirname(run.asyncDir))), run.runId));
    const diffs = join(source, "worktree-diffs");
    let seen = 0;
    const visit = (dir: string, depth: number) => {
      if (depth > 8) throw new Error("patch source depth exceeded");
      directory(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++seen > 512) throw new Error("patch source count exceeded");
        const file = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("linked patch source refused");
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".patch")) {
          const data = bytes(file);
          const sha256 = hash(data);
          const blob = join(target, `${sha256}.patch`);
          if (!existsSync(blob)) durableWrite(blob, data);
          if (!bytes(blob).equals(data)) throw new Error("durable patch content mismatch");
          const sourcePath = relative(source, file).split(sep).join("/");
          if (!manifest.patches.some((p) => p.source === sourcePath && p.sha256 === sha256)) {
            if (manifest.patches.length >= 512) throw new Error("patch manifest count exceeded");
            manifest.patches.push({ source: sourcePath, sha256, bytes: data.length });
          }
        }
      }
    };
    if (existsSync(diffs)) visit(diffs, 0);
  }
  save(path, manifest);
  return manifest;
}

/** Only the root may call this boundary, with an exact recorded run and an explicit decision.
 * Recording permission is not deletion: even authorised patches are left in place.
 */
export function decideLanePatches(runDir: string, runId: string, decision: "landed" | "rejected"): void {
  withStoreLock(runDir, runId, () => decide(runDir, runId, decision));
}
function decide(runDir: string, runId: string, decision: "landed" | "rejected"): void {
  if (decision !== "landed" && decision !== "rejected") throw new Error("explicit root patch decision required");
  const path = patchManifestPath(runDir, runId);
  const manifest = load(path, runId);
  if (!manifest) throw new Error("unknown patch retention run");
  if (manifest.disposition !== "pending" && manifest.disposition !== decision) throw new Error("patch decision conflicts with recorded authority");
  manifest.disposition = decision;
  save(path, manifest);
}

/** Guard for a future durable-copy cleanup caller. Missing/corrupt/linked authority always keeps. */
export function patchCleanupAllowed(runDir: string, runId: string): boolean {
  try {
    const manifest = load(patchManifestPath(runDir, runId), runId);
    if (!manifest || !["landed", "rejected"].includes(manifest.disposition)) return false;
    const dir = dirname(patchManifestPath(runDir, runId));
    return manifest.patches.every((p) => {
      const data = bytes(join(dir, `${p.sha256}.patch`));
      return data.length === p.bytes && hash(data) === p.sha256;
    });
  } catch {
    return false;
  }
}
