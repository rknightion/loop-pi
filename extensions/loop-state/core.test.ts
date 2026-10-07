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

test("deriveLogPath swaps report- and .md for state- and .jsonl", () => {
  assert.equal(deriveLogPath("/r/codex/report-camp-loop7.md"), "/r/codex/state-camp-loop7.jsonl");
  assert.equal(deriveLogPath("/r/codex/launch-camp-loop7.md"), null);
  assert.equal(deriveLogPath("/r/report-x.md.bak"), null);
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
