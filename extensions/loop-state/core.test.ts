import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveLogPath, parseBrief, parseLaneReturn, returnEvent, runIdFromText } from "./core.ts";

test("parseBrief reads the header line and an optional Deadline line", () => {
  const brief = parseBrief("\nLane: L3 · Task: T-42.01 · Tier: guarded\nObjective: x\nDeadline: 2026-10-03T12:00:00Z\n");
  assert.deepEqual(brief, { lane: "L3", task: "T-42.01", tier: "guarded", deadline: "2026-10-03T12:00:00Z" });
  assert.deepEqual(parseBrief("Lane: A · Task: B · Tier: routine"), { lane: "A", task: "B", tier: "routine" });
});

test("parseBrief preserves an explicit ops Surface without inferring one", () => {
  assert.deepEqual(parseBrief("Lane: L1 · Task: T1 · Tier: guarded\nSurface: local-probe"), {
    lane: "L1", task: "T1", tier: "guarded", surface: "local-probe",
  });
});

test("parseBrief reads an Ops surface line, which takes precedence over Surface", () => {
  assert.equal(parseBrief("Lane: L1 · Task: T1 · Tier: guarded\nOps surface: deploy:svc")?.surface, "deploy:svc");
  assert.equal(parseBrief("Lane: L1 · Task: T1 · Tier: guarded\nSurface: other\nOps surface: deploy:svc")?.surface, "deploy:svc");
  assert.equal(parseBrief("Lane: L1 · Task: T1 · Tier: guarded\nOps surface:")?.surface, undefined);
});

test("parseBrief takes the bare task id when the header carries its title", () => {
  assert.deepEqual(parseBrief("Lane: L1 · Task: T-7 (stop the e2e lane test racing) · Tier: routine"), {
    lane: "L1",
    task: "T-7",
    tier: "routine",
  });
});

test("parseBrief rejects anything but the header on the first non-empty line", () => {
  assert.equal(parseBrief("Objective: x\nLane: L1 · Task: T1 · Tier: routine"), null);
  assert.equal(parseBrief("Lane: L1 · Task: T1 · Tier: sloppy"), null);
  assert.equal(parseBrief(undefined), null);
});

test("deriveLogPath (S3) swaps closeout- and .md for state- and .jsonl; a v2 report- name derives nothing", () => {
  assert.equal(deriveLogPath("/r/codex/closeout-camp-loop7.md"), "/r/codex/state-camp-loop7.jsonl");
  assert.equal(deriveLogPath("/r/codex/report-camp-loop7.md"), null);
  assert.equal(deriveLogPath("/r/codex/launch-camp-loop7.md"), null);
  assert.equal(deriveLogPath("/r/closeout-x.md.bak"), null);
});

test("runIdFromText reads the pi-subagents launch text", () => {
  assert.equal(runIdFromText("Async: lane-worker [a1b2c3d4]\nUse status."), "a1b2c3d4");
  assert.equal(runIdFromText("nothing here"), null);
});

test("parseLaneReturn takes the last valid v2 or legacy block", () => {
  const text = [
    "done",
    "```lane-return",
    '{"v":2,"lane":"L1","status":"partial"}',
    "```",
    "```lane-return",
    '{"v":2,"lane":"L1","status":"complete","exit":0}',
    "```",
  ].join("\n");
  assert.equal(parseLaneReturn(text)?.status, "complete");
  assert.equal(parseLaneReturn('```lane-return\n{"lane":"L1","status":"failed"}\n```')?.status, "failed");
  assert.equal(parseLaneReturn('```lane-return\n{"v":1,"status":"failed"}\n```'), null);
  assert.equal(parseLaneReturn("```lane-return\n{broken\n```"), null);
  assert.equal(parseLaneReturn("no block"), null);
});

test("parseLaneReturn takes a v3 block (lane.md), so a v3 lane's return is not recorded as failed", () => {
  const block = {
    v: 3, lane: "L1", task: "T-1", status: "complete", base: "a".repeat(40), worktree: "/w", patch: "/p/candidate.patch",
    patch_sha256: "b".repeat(64), check: "just check", exit: 0, tail: "ok", coderabbit: { ran: true, major: 0, unreviewed: 0 }, questions: [],
  };
  const parsed = parseLaneReturn("```lane-return\n" + JSON.stringify(block) + "\n```\nprose");
  assert.equal(parsed?.status, "complete");
  const ev = returnEvent("L1", "run-1", parsed);
  assert.deepEqual({ status: ev.status, exit: ev.exit, base: ev.base, check: ev.check }, { status: "complete", exit: 0, base: "a".repeat(40), check: "just check" });
});

test("returnEvent uses the block when present and drops fields that do not fit", () => {
  const ev = returnEvent("L1", "r1", {
    v: 2,
    status: "complete",
    sha: "abc",
    landed: false,
    base: "def",
    check: "just check",
    exit: 0,
    tail: "ignored",
    ci: 123,
    coderabbit: { ran: true, major: 0, unreviewed: 2 },
    questions: ["q"],
  });
  assert.deepEqual(ev, {
    ev: "return", lane: "L1", run: "r1", status: "complete", sha: "abc", landed: false, check: "just check",
    exit: 0, ci: "123", coderabbit: { ran: true, major: 0, unreviewed: 2 }, base: "def", questions: ["q"],
  });
  const bad = returnEvent("L1", "r1", { status: "great", exit: "zero", coderabbit: { ran: 1 }, questions: [1] });
  assert.deepEqual(bad, { ev: "return", lane: "L1", run: "r1", status: "failed" });
});

test("a run that finished without a usable lane-return block is recorded failed, as the dispatcher reads it", () => {
  assert.deepEqual(returnEvent("L1", "r1", null), { ev: "return", lane: "L1", run: "r1", status: "failed" });
  assert.equal(returnEvent("L1", "r1", { status: "great" }).status, "failed");
});

// Artifact metadata comes from the native completion, never the lane-authored block.
test("returnEvent retains a native absolute artifact and ignores lane path claims", () => {
  const event = (returnEvent as any)("L1", "r1", { status: "complete", artifact: "/wrong/body.md" }, "/fixture/full.md");
  assert.equal(event.artifact, "/fixture/full.md");
  assert.equal(returnEvent("L1", "r1", { status: "complete", artifact: "/wrong/body.md" }).artifact, undefined);
  for (const artifact of [null, "", "relative.md", "/nul" + String.fromCharCode(0), 1]) {
    assert.equal((returnEvent as any)("L1", "r1", null, artifact).artifact, undefined);
  }
});
