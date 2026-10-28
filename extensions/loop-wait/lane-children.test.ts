import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHILD_RESULT_CUSTOM_TYPE,
  MAX_STILL_RUNNING_NOTICES,
  capTail,
  childResultText,
  deliveredIds,
  finalAssistantText,
  isFinished,
  readChildStatus,
  registerChildResultDelivery,
} from "./lane-children.ts";

const assistant = (content: unknown[]) => JSON.stringify({ type: "message", message: { role: "assistant", content } });

test("finalAssistantText skips tool-call turns and returns the last plain reply", () => {
  const jsonl = [
    assistant([{ type: "text", text: "first" }]),
    assistant([{ type: "text", text: "reading" }, { type: "toolCall", name: "read" }]),
    "not json",
    assistant([{ type: "text", text: "final answer" }]),
    assistant([{ type: "toolCall", name: "bash" }]),
  ].join("\n");
  assert.equal(finalAssistantText(jsonl), "final answer");
  assert.equal(finalAssistantText(""), undefined);
});

test("capTail keeps the end of a long output and says how much it dropped", () => {
  assert.equal(capTail("short", 10), "short");
  const out = capTail("a".repeat(20) + "END", 5);
  assert.match(out, /^\[\.\.\. first 18 bytes omitted\]\n/);
  assert.ok(out.endsWith("aaEND"));
});

test("only queued and running children are live", () => {
  for (const state of ["queued", "running"]) assert.equal(isFinished(state), false, state);
  for (const state of ["complete", "failed", "stopped", "paused"]) assert.equal(isFinished(state), true, state);
});

test("an unreadable run record becomes a named error, not an exception", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-children-"));
  try {
    assert.match((readChildStatus(dir) as { error: string }).error, /status\.json is unreadable/);
    writeFileSync(join(dir, "status.json"), "{}");
    assert.match((readChildStatus(dir) as { error: string }).error, /has no state/);
    const text = childResultText({ id: "r1", agent: "scout", asyncDir: dir }, readChildStatus(dir));
    assert.match(text, /^loop-pi: child run r1 \(scout\) finished, but its result could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the result names the run, its state and the source, preferring the child's session over its log", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-children-"));
  try {
    const session = join(dir, "session.jsonl");
    const log = join(dir, "output-0.log");
    writeFileSync(session, assistant([{ type: "text", text: "SEED-1" }]));
    writeFileSync(log, "task text\nSEED-1\n");
    const run = { id: "r1", agent: "scout", asyncDir: dir };
    const fromSession = childResultText(run, { state: "complete", sessionFile: session, outputFile: log });
    assert.equal(fromSession, `loop-pi: child run r1 (scout) finished: complete.\n\nSEED-1\n\nFull output: ${session}`);
    const fromLog = childResultText(run, { state: "failed", sessionFile: join(dir, "missing.jsonl"), outputFile: log });
    assert.match(fromLog, /finished: failed\.\n\ntask text\nSEED-1\n\nFull output: .*output-0\.log$/);
    assert.match(childResultText(run, { state: "stopped" }), /No final output was found\.$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deliveredIds reads only this extension's custom messages", () => {
  const ids = deliveredIds([
    { type: "custom_message", customType: CHILD_RESULT_CUSTOM_TYPE, details: { runId: "a" } },
    { type: "custom_message", customType: CHILD_RESULT_CUSTOM_TYPE, details: { runId: "p", pending: true } },
    { type: "custom_message", customType: "other", details: { runId: "b" } },
    { type: "message" },
  ]);
  assert.deepEqual([...ids], ["a"]);
});

function fakePi(branch: any[] = []) {
  const handlers = new Map<string, any>();
  const bus = new Map<string, any>();
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    events: { on: (name: string, fn: any) => bus.set(name, fn) },
  };
  registerChildResultDelivery(pi);
  const ctx = { sessionManager: { getSessionFile: () => "/s/senior.jsonl", getSessionId: () => "sid", getBranch: () => branch } };
  handlers.get("session_start")({}, ctx);
  return {
    started: (data: unknown) => bus.get("subagent:async-started")(data),
    settle: (entries: any[] = [], outcome = "completed") =>
      handlers.get("agent_before_settle")({ type: "agent_before_settle", entries, continue: false, outcome }),
  };
}

test("settle appends one message per finished child after the existing entries, then never again", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-children-"));
  const live = mkdtempSync(join(tmpdir(), "lane-children-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "complete" }));
    writeFileSync(join(live, "status.json"), JSON.stringify({ state: "running" }));
    const h = fakePi();
    h.started({ id: "done", agent: "scout", asyncDir: dir, sessionId: "/s/senior.jsonl" });
    h.started({ id: "busy", agent: "worker", asyncDir: live, sessionId: "/s/senior.jsonl" });
    h.started({ id: "foreign", agent: "scout", asyncDir: dir, sessionId: "/s/other.jsonl" });
    const existing = { type: "custom", customType: "x" };
    const result = h.settle([existing]);
    assert.equal(result.continue, true);
    assert.equal(result.entries[0], existing, "entries already at the boundary are kept");
    assert.deepEqual(
      result.entries.slice(1).map((e: any) => [e.customType, e.details.runId, e.details.state, e.details.pending ?? false]),
      [[CHILD_RESULT_CUSTOM_TYPE, "done", "complete", false], [CHILD_RESULT_CUSTOM_TYPE, "busy", "running", true]],
      "a finished child is delivered; one still live after the drain gets a keep-waiting notice",
    );
    assert.match(result.entries[2].content, /is still running\. End your turn to keep waiting/);
    for (let i = 1; i < MAX_STILL_RUNNING_NOTICES; i++) assert.deepEqual(h.settle().entries.map((e: any) => e.details.runId), ["busy"]);
    assert.equal(h.settle(), undefined, "keep-waiting notices are bounded and a delivered child is not delivered again");
    writeFileSync(join(live, "status.json"), JSON.stringify({ state: "failed" }));
    assert.deepEqual(h.settle().entries.map((e: any) => [e.details.runId, e.details.state]), [["busy", "failed"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

test("a resumed lane does not redeliver a child already on its branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-children-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "complete" }));
    const h = fakePi([{ type: "custom_message", customType: CHILD_RESULT_CUSTOM_TYPE, details: { runId: "done" } }]);
    h.started({ id: "done", agent: "scout", asyncDir: dir, sessionId: "sid" });
    assert.equal(h.settle(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no children means settle is left alone", () => {
  assert.equal(fakePi().settle(), undefined);
});

test("an aborted or failed senior run is never continued", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-children-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "complete" }));
    const h = fakePi();
    h.started({ id: "done", agent: "scout", asyncDir: dir, sessionId: "sid" });
    assert.equal(h.settle([], "aborted"), undefined);
    assert.equal(h.settle([], "error"), undefined);
    assert.deepEqual(h.settle().entries.map((e: any) => e.details.runId), ["done"], "still delivered at the next completed settle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
