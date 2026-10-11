// pi-subagents 0.77.0 answers a silent completion turn from its own agent_before_settle handler: a
// `subagent-completion-unanswered` reminder that continues the run, then a terminal
// `subagent-completion-unhandled` notice. loop-continuation's nudge must never stack on the reminder,
// in either handler order. The package handler here is the installed package's real one.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import registerSubagentNotify, { createCompletionSendRegistry } from "../../node_modules/pi-subagents/src/runs/background/notify.js";
import { cleanupFixtures, fakePi, loopFixture } from "./test-fixture.ts";

after(cleanupFixtures);

type Handler = (event: any, ctx: any) => any;

/** The real package notify registration, fed one failed (non-batched, turn-triggering) completion. */
function packageNotify() {
  const handlers = new Map<string, Handler>();
  const bus = new Map<string, (data: any) => void>();
  const notices: { content: string }[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events: { on: (name: string, handler: (data: any) => void) => { bus.set(name, handler); return () => bus.delete(name); }, emit() {} },
    sendMessage: (message: { content: string }) => { notices.push(message); return true; },
    sendUserMessage() {},
  };
  registerSubagentNotify(pi as never, { currentSessionId: "s", completionOwnerId: "o" } as never, { sendRegistry: createCompletionSendRegistry() });
  bus.get("subagent:async-complete")!({ sessionId: "s", completionOwnerId: "o", agent: "lane-worker", runId: "r1", success: false, exitCode: 1, summary: "lane failed" });
  assert.equal(notices.length, 1, "the completion notice was sent");
  return { settle: () => handlers.get("agent_before_settle"), notice: notices[0].content };
}

/** pi's emitBoundary: handlers in order, each seeing the entries and `continue` so far. */
async function boundary(handlers: Handler[], contextMessages: unknown[], ctx: unknown) {
  let entries: any[] = [];
  let shouldContinue = false;
  for (const handler of handlers) {
    const result = await handler({ type: "agent_before_settle", outcome: "completed", entries, continue: shouldContinue, context: { contextMessages, pendingMessages: [] } }, ctx);
    if (result?.entries !== undefined) entries = result.entries;
    if (result?.continue !== undefined) shouldContinue = result.continue;
  }
  return { types: entries.map((e) => e.customType), continue: shouldContinue };
}

const silent = (notice: string) => [
  { role: "custom", customType: "subagent-notify", content: notice },
  { role: "assistant", content: [{ type: "text", text: "" }] },
];

test("package reminder first: the silent turn gets the reminder only; the next silent turn is nudged once", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    await pi.input(f.launch);
    const pkg = packageNotify();
    const loop = pi.handlers.get("agent_before_settle")!;
    const first = await boundary([pkg.settle()!, loop], silent(pkg.notice), pi.ctx());
    assert.deepEqual(first, { types: ["subagent-completion-unanswered"], continue: true });
    // The reminder is spent: the package only reports, so the loop's own nudge keeps the root going.
    const second = await boundary([pkg.settle() ?? (() => undefined), loop], silent(pkg.notice), pi.ctx());
    assert.deepEqual(second.types, ["subagent-completion-unhandled", "loop-continuation"]);
    assert.equal(second.continue, true);
    const nudge = pi.entries.filter((e) => e.customType === "loop-continuation-state").at(-1);
    assert.equal(nudge?.data?.nudgeCount, 1, "the skipped settle did not spend a nudge");
  } finally {
    pi.restore();
  }
});

test("loop nudge first: the package sees the run continuing and adds no reminder", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    await pi.input(f.launch);
    const pkg = packageNotify();
    const result = await boundary([pi.handlers.get("agent_before_settle")!, pkg.settle()!], silent(pkg.notice), pi.ctx());
    assert.deepEqual(result, { types: ["loop-continuation"], continue: true });
  } finally {
    pi.restore();
  }
});
