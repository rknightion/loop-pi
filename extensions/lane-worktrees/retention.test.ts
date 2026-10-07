import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { captureLanePatches, decideLanePatches, patchCleanupAllowed, patchManifestPath } from "./retention.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "patch-retention-")));
  dirs.push(dir);
  const root = join(dir, "durable");
  const asyncDir = join(dir, "async-subagent-runs", "run-one");
  mkdirSync(root);
  mkdirSync(join(asyncDir, "worktree-diffs", "step-0"), { recursive: true });
  const patch = join(asyncDir, "worktree-diffs", "step-0", "task-0-worker.patch");
  const data = Buffer.from([0, 255, 10, 45, 43]);
  writeFileSync(patch, data);
  const run = { runId: "run-one", lane: "L1", task: "T1", asyncDir, afterSeq: 0 };
  return { root, asyncDir, patch, data, run };
}

test("pending and unknown retain bytes; explicit landed/rejected permit guarded lifecycle action without deleting", () => {
  for (const decision of ["landed", "rejected"] as const) {
    const f = fixture();
    assert.equal(patchCleanupAllowed(f.root, "unknown"), false);
    const manifest = captureLanePatches(f.root, f.run);
    assert.equal(manifest.disposition, "pending");
    assert.equal(patchCleanupAllowed(f.root, f.run.runId), false);
    const blob = join(dirname(patchManifestPath(f.root, f.run.runId)), `${manifest.patches[0].sha256}.patch`);
    assert.deepEqual(readFileSync(blob), f.data);
    decideLanePatches(f.root, f.run.runId, decision);
    assert.equal(patchCleanupAllowed(f.root, f.run.runId), true);
    assert.ok(existsSync(blob), "permission is not deletion");
    assert.ok(existsSync(f.patch), "capture never deletes original patches");
    assert.throws(() => decideLanePatches(f.root, f.run.runId, decision === "landed" ? "rejected" : "landed"), /conflicts/);
    writeFileSync(blob, "corrupt");
    assert.equal(patchCleanupAllowed(f.root, f.run.runId), false, "content hash binds cleanup authority");
  }
});

test("restart capture preserves all patch versions and cannot infer a root decision from missing originals", () => {
  const f = fixture();
  captureLanePatches(f.root, f.run);
  writeFileSync(f.patch, "new version");
  const second = captureLanePatches(f.root, f.run);
  assert.equal(second.patches.length, 2);
  const missing = { ...f.run, asyncDir: join(dirname(f.asyncDir), "absent", f.run.runId) };
  assert.equal(captureLanePatches(f.root, missing).patches.length, 2);
  assert.equal(patchCleanupAllowed(f.root, f.run.runId), false);
});

test("linked sources, linked authority and malformed manifests fail closed", () => {
  const f = fixture();
  const external = join(f.root, "external.patch");
  writeFileSync(external, "outside");
  symlinkSync(external, join(dirname(f.patch), "linked.patch"));
  assert.throws(() => captureLanePatches(f.root, f.run), /linked/);
  assert.equal(patchCleanupAllowed(f.root, f.run.runId), false);
  const clean = fixture();
  captureLanePatches(clean.root, clean.run);
  writeFileSync(patchManifestPath(clean.root, clean.run.runId), "{}");
  assert.throws(() => captureLanePatches(clean.root, clean.run), /invalid/);
  assert.equal(patchCleanupAllowed(clean.root, clean.run.runId), false);
  const linked = fixture();
  symlinkSync(f.root, join(linked.root, "lane-patches"));
  assert.throws(() => captureLanePatches(linked.root, linked.run), /linked/);
  assert.throws(() => captureLanePatches(dirname(f.asyncDir), f.run), /inside the async/);
});
