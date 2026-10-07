// Keep governed private identity in the brief; naming safety belongs to the allocation seam,
// not to prompt redaction, task aliases or changing what the state log correlates.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { captureLanePatches, patchCleanupAllowed, patchManifestPath } from "../lane-worktrees/retention.ts";
import { gateBrief, renderBrief, taskBrief, triageBrief } from "./brief.ts";
import type { TaskSpec } from "./goal.ts";
import { parseBrief } from "../loop-state/core.ts";
import { nativeLaneKey } from "../lane-worktrees/core.ts";

test("candidate briefs state no commit/no push without widening branch authority", () => {
  const task: TaskSpec = { id: "T1", objective: "inspect the candidate", acceptance: "gate green", owned: ["src/**"], gate: "just check", landing: "returns candidate", agent: "lane-worker", tier: "guarded" };
  const candidate = taskBrief(task, "L1", "guarded");
  assert.match(candidate, /Landing: returns candidate\n/);
  assert.match(candidate, /leave changes uncommitted; no commit and no push/);
  assert.match(candidate, /sha=null, landed=false/);
  assert.doesNotMatch(candidate, /your landed candidate/);
  const custom = taskBrief({ ...task, stop: "Stop after proof." }, "L1", "guarded");
  assert.match(custom, /Stop rule: Stop after proof\. .*no commit and no push/);
  const revised = renderBrief({ lane: "L1", task: "T1", tier: "guarded", objective: "proof", owned: "src/**", acceptance: "green", gate: "just check", landing: "returns candidate", stop: "Stop after proof.", escalation: "Return blocked." });
  assert.match(revised, /no commit and no push/);
  const gate = gateBrief("G1", ["T1"], "guarded", "a".repeat(40), "just check");
  const triage = triageBrief("R1", task, "guarded", "L1", candidate, "failed", 1);
  for (const readOnly of [gate, triage.split("Failed brief:")[0]]) {
    assert.equal(readOnly.includes("sha=null"), false, "read-only returns keep their own evidence identity");
    assert.equal(readOnly.includes("no commit and no push"), false);
  }
  for (const landing of ["lands-after-green", "pushes branch feature/widget"]) {
    const branch = taskBrief({ ...task, landing }, "L1", "guarded");
    assert.equal(branch.includes("no commit and no push"), false);
    assert.ok(branch.includes(`Landing: ${landing}\n`));
  }
});

test("safe native naming does not redact dispatcher brief identity or title", () => {
  const id = ["H", "R", "N"].join("") + "-" + String(903).padStart(4, "0");
  const task: TaskSpec = { id, title: "preserve exact correlation", objective: "inspect the candidate", acceptance: "gate green", owned: ["src/**"], gate: "just check", landing: "returns candidate", agent: "lane-worker", tier: "guarded" };
  const rendered = taskBrief(task, "L1", "guarded");
  assert.equal(rendered.split("\n")[0], `Lane: L1 · Task: ${id} (${task.title}) · Tier: guarded`);
  assert.deepEqual(parseBrief(rendered), { lane: "L1", task: id, tier: "guarded" });
  const key = nativeLaneKey("/tmp/run", "L1", id);
  assert.match(key, /^r[0-9a-f]{32}l[0-9a-f]{32}$/);
  assert.equal(key.includes(id), false);
});

// Synthetic proof through the pinned native finalizer's implementation, not a hand-built patch.
// Imports are deliberately internal file URLs: no public prune-hook API is assumed.
test("uncommitted candidate survives native tree/branch deletion and scratch removal", { timeout: 60_000 }, async () => {
  const native = await import(new URL("../../node_modules/pi-subagents/src/runs/shared/worktree.js", import.meta.url).href);
  const handoffs = await import(new URL("../../node_modules/pi-subagents/src/runs/shared/parallel-handoff.js", import.meta.url).href);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-handoff-")));
  const repo = join(root, "repo");
  const runDir = join(root, "durable");
  const runId = "candidate-proof";
  const asyncDir = join(root, "async", runId);
  for (const dir of [repo, runDir, asyncDir]) mkdirSync(dir, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 10_000 }).trim();
  try {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "seed"), "base\n");
    writeFileSync(join(repo, "binary"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "removed"), "remove me\n");
    git(repo, "add", "--", "seed", "binary", "removed");
    git(repo, "commit", "-qm", "fixture base", "--", "seed", "binary", "removed");
    const base = git(repo, "rev-parse", "HEAD");
    const setup = await native.createWorktrees(repo, runId, 1, { provider: "native", baseDir: join(root, "trees"), deadlineAt: Date.now() + 30_000 });
    const tree = setup.worktrees[0];
    const binary = Buffer.from([0, 255, 128, 3, 4]);
    writeFileSync(join(tree.path, "seed"), "candidate\n");
    writeFileSync(join(tree.path, "binary"), binary);
    writeFileSync(join(tree.path, "untracked"), "new candidate file\n");
    rmSync(join(tree.path, "removed"));
    assert.equal(git(tree.path, "rev-parse", "HEAD"), base, "candidate lane has made no commit");
    const uncaptured = native.cleanupWorktrees(setup);
    assert.equal(uncaptured.state, "partial");
    assert.ok(existsSync(tree.path), "fail closed: no captured handoff means no deletion");
    const diffs = native.diffWorktrees(setup, ["lane-worker"], join(asyncDir, "worktree-diffs", "step-0"));
    assert.equal(diffs[0].error, undefined);
    assert.equal(diffs[0].filesChanged, 4);
    const manifestPath = handoffs.parallelHandoffPath(asyncDir);
    handoffs.writeParallelHandoffGroup({ manifestPath, runId, mode: "single", source: "async", cwd: repo,
      stepIndex: 0, flatStartIndex: 0, setup, diffs, results: [{ agent: "lane-worker", status: "completed", summary: "uncommitted candidate" }] });
    const cleanup = native.cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath: manifestPath });
    assert.equal(cleanup.state, "complete", JSON.stringify(cleanup));
    assert.equal(existsSync(tree.path), false);
    assert.equal(cleanup.tasks[0].branchRemoved, true);
    // The same durable capture that completion/startup/shutdown use runs AFTER native deletion.
    const manifest = captureLanePatches(runDir, { runId, lane: "L1", task: "T1", asyncDir });
    assert.equal(manifest.patches.length, 1);
    assert.equal(manifest.disposition, "pending");
    const patch = join(dirname(patchManifestPath(runDir, runId)), `${manifest.patches[0].sha256}.patch`);
    assert.deepEqual(readFileSync(patch), readFileSync(diffs[0].patchPath));
    rmSync(asyncDir, { recursive: true });
    assert.equal(patchCleanupAllowed(runDir, runId), false, "scratch deletion grants no durable cleanup");
    git(repo, "apply", "--check", "--binary", patch);
    git(repo, "apply", "--binary", patch);
    assert.equal(readFileSync(join(repo, "seed"), "utf8"), "candidate\n");
    assert.deepEqual(readFileSync(join(repo, "binary")), binary);
    assert.equal(readFileSync(join(repo, "untracked"), "utf8"), "new candidate file\n");
    assert.equal(existsSync(join(repo, "removed")), false);
    assert.equal(git(repo, "rev-parse", "HEAD"), base, "apply uses the exact base, no root reconstruction or commit");
    const evidence = process.env.LOOP_PI_COMMIT_POLICY_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "candidate-handoff.json"), JSON.stringify({ base, filesChanged: 4,
        treeRemoved: true, branchRemoved: true, scratchRemoved: true, candidateApplied: true,
        patchHash: manifest.patches[0].sha256, disposition: manifest.disposition }, null, 2));
    }
  } finally {
    // Only this test's private temporary fixture is removed, never a lane allocation.
    rmSync(root, { recursive: true, force: true });
  }
});
