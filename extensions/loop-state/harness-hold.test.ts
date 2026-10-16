import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import registerSubagentNotify, { createCompletionSendRegistry } from "../../node_modules/pi-subagents/src/runs/background/notify.js";
import loopState from "./index.ts";
import { HARNESS_HELD_ACTION, HARNESS_HOLD_STATE, HELD_COMPLETION_ACTION, registerHarnessHold } from "./harness-hold.ts";

type Handler = (event: any, ctx: any) => any;

/** The installed package's real completion notice, sent while its parent-wake hold is on. */
function heldNotice(timestamp: number) {
  const bus = new Map<string, (data: any) => void>();
  const sent: { content: string }[] = [];
  const pi = {
    on: () => () => undefined,
    events: { on: (name: string, h: (data: any) => void) => { bus.set(name, h); return () => bus.delete(name); }, emit() {} },
    sendMessage: (message: { content: string }) => { sent.push(message); return true; },
    sendUserMessage() {},
    isHeld: () => true,
  };
  registerSubagentNotify(pi as never, { currentSessionId: "s", completionOwnerId: "o" } as never, { sendRegistry: createCompletionSendRegistry() });
  bus.get("subagent:async-complete")!({ sessionId: "s", completionOwnerId: "o", agent: "worker", runId: `r${timestamp}`, success: false, exitCode: 1, summary: "lane done" });
  assert.equal(sent.length, 1);
  return { role: "custom", customType: "subagent-notify", content: sent[0].content, display: false, timestamp };
}

function root(branch: unknown[] = []) {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: {
      on: (name: string, h: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), h]); return () => undefined; },
      emit: (name: string, data: unknown) => { for (const h of listeners.get(name) ?? []) h(data); },
    },
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
    sendMessage: () => undefined,
  };
  loopState(pi as any, () => setTimeout(() => undefined, 0));
  const ctx = { cwd: "/nonexistent", sessionManager: { getBranch: () => branch, getSessionId: () => "s", getSessionFile: () => undefined }, ui: { notify() {}, setStatus() {} }, hasUI: false };
  const fire = (name: string, event: Record<string, unknown> = {}) => {
    let last: any;
    for (const h of handlers.get(name) ?? []) { try { last = h({ type: name, ...event }, ctx) ?? last; } catch { /* other loop-state handlers need a real run dir */ } }
    return last;
  };
  return { pi, fire, entries };
}

test("the pinned package still sends the held text this rewrite matches", () => {
  const src = readFileSync(new URL("../../node_modules/pi-subagents/src/runs/background/notify.js", import.meta.url), "utf8");
  assert.ok(src.includes(JSON.stringify(HELD_COMPLETION_ACTION)), "pi-subagents HELD_COMPLETION_ACTION changed: update harness-hold.ts");
  assert.ok(heldNotice(1).content.includes(HELD_COMPLETION_ACTION));
});

test("a held notice after a loop-pi abort reaches the model without the owner-stop instruction", () => {
  const r = root();
  r.fire("session_start");
  const before = Date.now();
  r.pi.events.emit("loop-recovery:request-timeout", { limitType: "inactivity" });
  const notice = heldNotice(Date.now() + 1);
  const user = { role: "user", content: "go", timestamp: before - 10 };
  const result = r.fire("context", { messages: [user, notice] });
  assert.ok(result?.messages, "the context hook rewrites the held notice");
  assert.equal(result.messages[0], user);
  assert.ok(!result.messages[1].content.includes(HELD_COMPLETION_ACTION));
  assert.ok(result.messages[1].content.includes(HARNESS_HELD_ACTION));
  assert.ok(result.messages[1].content.includes("lane done"), "the completion itself is kept");
  assert.deepEqual(r.entries.map((e) => e.customType), [HARNESS_HOLD_STATE], "the window is persisted for a resumed root");
});

test("an operator Esc keeps the package's held text verbatim", () => {
  const r = root();
  r.fire("session_start");
  const notice = heldNotice(Date.now());
  const result = r.fire("context", { messages: [notice] });
  assert.ok(result === undefined || result.messages[0].content.includes(HELD_COMPLETION_ACTION));
});

test("the next run closes the window: a later operator-Esc notice is not rewritten", async () => {
  const r = root();
  r.fire("session_start");
  r.pi.events.emit("loop-recovery:abort", {});
  const during = heldNotice(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 5));
  r.fire("agent_start");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = heldNotice(Date.now());
  const result = r.fire("context", { messages: [during, after] });
  assert.ok(result?.messages);
  assert.ok(result.messages[0].content.includes(HARNESS_HELD_ACTION));
  assert.ok(result.messages[1].content.includes(HELD_COMPLETION_ACTION));
});

test("a resumed root rebuilds its windows from the session branch", () => {
  const start = Date.now() - 1_000;
  const branch = [
    { type: "custom", customType: HARNESS_HOLD_STATE, data: { start } },
    { type: "custom", customType: HARNESS_HOLD_STATE, data: { start, end: start + 500 } },
  ];
  const r = root(branch);
  r.fire("session_start");
  const inside = heldNotice(start + 100);
  const outside = heldNotice(start + 900);
  const result = r.fire("context", { messages: [inside, outside] });
  assert.ok(result?.messages);
  assert.ok(result.messages[0].content.includes(HARNESS_HELD_ACTION));
  assert.ok(result.messages[1].content.includes(HELD_COMPLETION_ACTION));
});

/** One root process over a session branch that persists across processes, on an injected clock. */
function process(branch: { type: string; customType: string; data: unknown }[], clock: { now: number }) {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: { on: (name: string, h: (data: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), h]); return () => undefined; } },
    appendEntry: (customType: string, data: unknown) => void branch.push({ type: "custom", customType, data }),
  };
  const hold = registerHarnessHold(pi as any, () => clock.now);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const fire = (name: string) => { for (const h of handlers.get(name) ?? []) h({ type: name }, ctx); };
  const emit = (name: string) => { for (const h of listeners.get(name) ?? []) h({}); };
  return { hold, fire, emit };
}

test("a window open at exit is closed for good at the next resume: a later owner Esc is never rewritten", () => {
  const branch: { type: string; customType: string; data: unknown }[] = [];
  const clock = { now: 1_000 };
  // Process A: a recovery stop with no follow-up run, then the root exits mid-window.
  const a = process(branch, clock);
  a.fire("session_start");
  a.emit("loop-recovery:abort");
  // Process B: resumed later; the owner runs a turn and presses Esc; a held notice lands at 3000.
  clock.now = 2_000;
  const b = process(branch, clock);
  b.fire("session_start");
  clock.now = 2_500;
  b.fire("agent_start");
  const ownerStop = heldNotice(3_000);
  assert.equal(b.hold.rewrite([ownerStop]), undefined, "process B leaves the owner's stop alone");
  // Process C: resumed again. The owner's stop in B must still read as the owner's.
  clock.now = 4_000;
  const c = process(branch, clock);
  c.fire("session_start");
  assert.equal(c.hold.rewrite([ownerStop]), undefined, "process C must not widen A's window over B");
  // A's own held notice (inside A's window) is still rewritten after any number of resumes.
  const harnessHeld = c.hold.rewrite([heldNotice(1_500)]);
  assert.ok(harnessHeld && String((harnessHeld[0] as any).content).includes(HARNESS_HELD_ACTION));
});
