// RPC tests for loop-wait/root.ts: idle-wake via watch_start and via wake_at with zero assistant
// messages in between, the compaction-safe delivery race, and reconciliation after a restart.
// Faux provider only; no live models, no network, every spawned process is killed.
import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import {
  assistantMessageCount,
  cleanupAll,
  FAUX_EXTENSION,
  freshDir,
  ROOT_EXTENSION,
  startPiRpc,
  writeFauxScript,
} from "./test-helpers.ts";

import { AUTO_ARM_REASON, TIME_PARK_ARM_REASON } from "../loop-continuation/state.ts";

const CEILING_EXTENSION = join(import.meta.dirname, "..", "request-ceiling", "index.ts");
const RACE_TRIGGER_EXTENSION = join(import.meta.dirname, "test-support-race-trigger.ts");

// Only the direct-unit-call test below needs this: see test-support-resolve-nested-deps.mjs for
// why importing root.ts outside the real pi CLI needs a resolution hook for "typebox".
register("./test-support-resolve-nested-deps.mjs", import.meta.url);

after(cleanupAll);

test("loop-wait:arm-timer replies nothing (never a stub id) before session_start creates the TimerManager", async () => {
  // Direct unit call against root.ts's default export with a minimal fake ExtensionAPI,
  // bypassing the RPC harness entirely: the only reliable way to observe the pre-session_start
  // window is to never fire session_start at all, which a live pi CLI session cannot do (it
  // always fires session_start immediately). SEAMS.md: a missing reply means "provider
  // unavailable", so callers must be able to tell that apart from an armed timer's real id.
  const rootModule = await import("./root.ts");
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const noop = () => {};
  const fakePi = {
    registerTool: noop,
    registerCommand: noop,
    appendEntry: noop,
    sendMessage: noop,
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        eventHandlers.set(name, handler);
      },
    },
    on: noop,
  };
  rootModule.default(fakePi as never);

  const armTimerHandler = eventHandlers.get("loop-wait:arm-timer");
  assert.ok(armTimerHandler, "root.ts must register a loop-wait:arm-timer handler at load time");

  let replied = false;
  let replyValue: unknown;
  armTimerHandler!({
    at: new Date(Date.now() + 60_000).toISOString(),
    reason: "unit-test-unavailable",
    reply: (r: unknown) => {
      replied = true;
      replyValue = r;
    },
  });
  assert.equal(replied, false, `must not reply before the TimerManager exists (got ${JSON.stringify(replyValue)})`);
});

// Direct-unit harness (no RPC, no live pi process) for root.ts's wiring between TimerManager and
// DeliveryQueue: batched flush delivery and dropping a queued wake for an already-fired-but-
// cancelled timer. The RPC harness above proves end-to-end session behaviour; this pins down the
// exact deliver-call sequence root.ts produces, which real turn/streaming timing makes awkward to
// observe precisely through RPC alone.
interface FakeToolDef {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

interface FakeSentMessage {
  message: { customType: string; content: string; details: unknown };
  options: { triggerTurn?: boolean };
}

async function loadRootWithFakePi(): Promise<{
  tools: Map<string, FakeToolDef>;
  lifecycle: Map<string, (event: unknown, ctx: unknown) => void>;
  sent: FakeSentMessage[];
  stateEvents: { ev: string; op: string; what: string; deadline: string }[];
  busHandlers: Map<string, (data: unknown) => void>;
  entries: { type: "custom"; customType: string; data: unknown }[];
}> {
  const rootModule = await import("./root.ts");
  const tools = new Map<string, FakeToolDef>();
  const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
  const sent: FakeSentMessage[] = [];
  const stateEvents: { ev: string; op: string; what: string; deadline: string }[] = [];
  const busHandlers = new Map<string, (data: unknown) => void>();
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const fakePi = {
    registerTool: (tool: FakeToolDef & { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: unknown, options: unknown) =>
      sent.push({ message: message as FakeSentMessage["message"], options: options as FakeSentMessage["options"] }),
    events: {
      on: (name: string, handler: (data: unknown) => void) => busHandlers.set(name, handler),
      emit: (name: string, request: { event: typeof stateEvents[number]; reply: (r: Promise<boolean>) => void }) => {
        if (name !== "loop-wait:state-event") return;
        stateEvents.push(request.event);
        request.reply(Promise.resolve(true));
      },
    },
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => lifecycle.set(name, handler),
  };
  rootModule.default(fakePi as never);
  return { tools, lifecycle, sent, stateEvents, busHandlers, entries };
}

function fakeCtx(agentDir: string, idleBox: { idle: boolean }, branch: unknown[] = []) {
  return {
    sessionManager: { getSessionId: () => "fake-session", getBranch: () => branch },
    isIdle: () => idleBox.idle,
    cwd: agentDir,
    ui: { notify: () => {} },
  };
}

async function withFakeAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = freshDir("loop-wait-fakepi-agentdir-");
  const previousEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run(agentDir);
  } finally {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousEnv;
  }
}

test("root.ts: one flush after a busy turn delivers every pending message, with only the last triggering a turn", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const wakeAt = tools.get("wake_at")!;
    await wakeAt.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "first" }, undefined, undefined, ctx);
    await wakeAt.execute("t2", { at: new Date(Date.now() + 45).toISOString(), reason: "second" }, undefined, undefined, ctx);
    await wakeAt.execute("t3", { at: new Date(Date.now() + 60).toISOString(), reason: "third" }, undefined, undefined, ctx);

    // Let all three timers fire while still busy: their wake messages queue instead of delivering.
    // assert.equal, not deepEqual against a `[]` literal: node's assert types narrow `sent` to
    // `never[]` after a `deepEqual(sent, [])` call, which then breaks the `.map()` calls below.
    await delay(200);
    assert.equal(sent.length, 0, "root is busy: nothing delivered yet");

    idleBox.idle = true;
    lifecycle.get("agent_settled")!(undefined, ctx);
    // scheduleFlush's retry ladder tops out at 250ms.
    await delay(400);

    assert.equal(sent.length, 3, "one flush must deliver every pending message, not one per turn");
    assert.deepEqual(
      sent.map((s) => s.options.triggerTurn),
      [false, false, true],
      "only the last delivery in the batch starts a turn",
    );
    assert.deepEqual(
      sent.map((s) => s.message.content.match(/first|second|third/)?.[0]),
      ["first", "second", "third"],
      "arrival order is preserved",
    );
  });
});

test("root.ts: wake_cancel drops a queued wake for a timer that fired while busy but was not yet delivered", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent, stateEvents } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const wakeAt = tools.get("wake_at")!;
    const armed = await wakeAt.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "stale-test" }, undefined, undefined, ctx);
    const id = (armed.details as { id: string }).id;

    // Let it fire while busy: the wake message queues instead of delivering.
    await delay(150);
    assert.deepEqual(sent, []);

    const wakeCancel = tools.get("wake_cancel")!;
    const result = await wakeCancel.execute("t2", { id }, undefined, undefined, ctx);
    assert.match((result.content[0] as { text: string }).text, /already fired|dropped its queued wake/);
    assert.equal((result.details as { cancelled: boolean }).cancelled, true);
    assert.deepEqual(stateEvents.map(e => e.op), ["start", "stop"], "fire records stop even while busy; dropping its queued wake does not double-log");
    assert.equal(stateEvents[0].what, stateEvents[1].what);
    assert.equal(stateEvents[0].deadline, stateEvents[1].deadline);

    idleBox.idle = true;
    lifecycle.get("agent_settled")!(undefined, ctx);
    await delay(400);

    assert.deepEqual(sent, [], "a wake_cancel'd timer's wake must never be delivered, even if it had already fired");
  });
});

test("root.ts: wake_cancel cancels an armed timer by a unique 8+ char id prefix", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent } = await loadRootWithFakePi();
    const idleBox = { idle: true };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const wakeAt = tools.get("wake_at")!;
    const armed = await wakeAt.execute(
      "t1",
      { at: new Date(Date.now() + 150).toISOString(), reason: "prefix-cancel-test" },
      undefined,
      undefined,
      ctx,
    );
    const id = (armed.details as { id: string }).id;
    const prefix = id.slice(0, 8);

    const wakeCancel = tools.get("wake_cancel")!;
    const result = await wakeCancel.execute("t2", { id: prefix }, undefined, undefined, ctx);
    assert.deepEqual(result.details, { cancelled: true, id, droppedQueued: false });

    await delay(400);
    assert.deepEqual(sent, [], "the timer must never fire once cancelled by prefix");
  });
});

test("root.ts: wake_cancel with no match lists the currently armed timers", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle } = await loadRootWithFakePi();
    const idleBox = { idle: true };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const wakeAt = tools.get("wake_at")!;
    const armed = await wakeAt.execute(
      "t1",
      { at: new Date(Date.now() + 60_000).toISOString(), reason: "still-armed" },
      undefined,
      undefined,
      ctx,
    );
    const id = (armed.details as { id: string }).id;

    const wakeCancel = tools.get("wake_cancel")!;
    const result = await wakeCancel.execute("t2", { id: "no-such-timer-id" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /no armed timer matching/);
    assert.ok(text.includes(id), "the still-armed timer's id must be listed for recovery");
    assert.match(text, /still-armed/);

    // Clean up the still-armed timer so nothing lingers past this test.
    await wakeCancel.execute("t3", { id }, undefined, undefined, ctx);
  });
});

test("watch_start wakes an idle root with zero assistant messages in between", async () => {
  const script = writeFauxScript([
    {
      match: "ARM_WATCH",
      once: true,
      toolCalls: [{ name: "watch_start", args: { command: "printf 'hi\\n'; sleep 0.2; exit 0", deadline_s: 30, interval_s: 1, label: "idle-wake-watch" } }],
    },
    { match: ".*", text: "ack" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script });
  try {
    session.send({ id: "p1", type: "prompt", message: "ARM_WATCH" });
    await session.waitForResponse("p1");
    await session.waitFor((e) => e.type === "agent_settled");
    const firstSettledIndex = session.events.findIndex((e) => e.type === "agent_settled");
    assert.notEqual(firstSettledIndex, -1, "the arming turn must settle");

    const watchMessage = await session.waitFor(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-watch",
      15_000,
    );
    const watchIndex = session.events.indexOf(watchMessage);
    assert.ok(watchIndex > firstSettledIndex);

    // Zero assistant messages between the arming turn's settle and the loop-watch message that
    // starts the wake turn: the root did nothing on its own while idle.
    assert.equal(assistantMessageCount(session.events, firstSettledIndex + 1, watchIndex), 0);

    const content = (watchMessage.message as { content?: string }).content ?? "";
    assert.match(content, /phase=done exit_code=0/);

    await session.waitFor((e) => e.type === "agent_settled" && session.events.indexOf(e) > watchIndex);
  } finally {
    await session.close();
  }
});

test("wake_at wakes an idle root with zero assistant messages in between", async () => {
  const script = writeFauxScript([
    {
      match: "ARM_WAKE",
      once: true,
      toolCalls: [{ name: "wake_at", args: { at: new Date(Date.now() + 300).toISOString(), reason: "idle-wake-timer" } }],
    },
    { match: ".*", text: "ack" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script });
  try {
    session.send({ id: "p1", type: "prompt", message: "ARM_WAKE" });
    await session.waitForResponse("p1");
    await session.waitFor((e) => e.type === "agent_settled");
    const firstSettledIndex = session.events.findIndex((e) => e.type === "agent_settled");
    assert.notEqual(firstSettledIndex, -1);

    const wakeMessage = await session.waitFor(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake",
      15_000,
    );
    const wakeIndex = session.events.indexOf(wakeMessage);
    assert.ok(wakeIndex > firstSettledIndex);
    assert.equal(assistantMessageCount(session.events, firstSettledIndex + 1, wakeIndex), 0);

    const content = (wakeMessage.message as { content?: string }).content ?? "";
    assert.match(content, /idle-wake-timer/);
  } finally {
    await session.close();
  }
});

test("a wake arriving during compaction does not start a concurrent run", async () => {
  const script = writeFauxScript([
    { match: "TURN1", once: true, text: "ok1" },
    { match: "context checkpoint summary", once: true, delayMs: 800, text: "summary-done" },
    { match: ".*", text: "ack" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, RACE_TRIGGER_EXTENSION],
    fauxScriptPath: script,
    // Lower the recent-token allowance so this tiny conversation is still compactable
    // (pi's default 20k-token allowance would make "nothing to compact" true here).
    settings: { compaction: { keepRecentTokens: 1, reserveTokens: 1 } },
  });
  try {
    session.send({ id: "t1", type: "prompt", message: "TURN1" });
    await session.waitForResponse("t1");
    await session.waitFor((e) => e.type === "agent_settled");

    // The race-trigger companion extension arms a loop-wait timer (150ms) the instant
    // session_before_compact fires, via the SEAMS.md loop-wait:arm-timer channel — deterministic,
    // in-process, no wall-clock race against an RPC round trip.
    session.send({ id: "c1", type: "compact" });
    await session.waitForResponse("c1", 20_000);
    // Give the deferred delivery's retry schedule (up to 250ms) time to flush.
    await session.waitFor((e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake", 5_000);

    const compactionStart = session.events.findIndex((e) => e.type === "compaction_start");
    const compactionEnd = session.events.findIndex((e) => e.type === "compaction_end");
    assert.ok(compactionStart >= 0 && compactionEnd > compactionStart);

    // No agent run starts while compaction is in flight.
    const agentStartsDuringCompaction = session.events
      .slice(compactionStart + 1, compactionEnd)
      .filter((e) => e.type === "agent_start" || e.type === "turn_start");
    assert.deepEqual(agentStartsDuringCompaction, []);

    // The deferred wake is delivered only after compaction actually finished.
    const wakeMessage = session.events.find(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake",
    );
    assert.ok(wakeMessage);
    assert.ok(session.events.indexOf(wakeMessage) > compactionEnd);
  } finally {
    await session.close();
  }
});

test("reconciliation after a restart re-arms a timer and reports an orphan watcher", async () => {
  const script = writeFauxScript([
    {
      match: "ARM_FUTURE",
      once: true,
      toolCalls: [{ name: "wake_at", args: { at: new Date(Date.now() + 60_000).toISOString(), reason: "restart-test-timer" } }],
    },
    {
      match: "START_WATCH",
      once: true,
      // Long enough to still be "running" when session1 is killed a moment later, short enough
      // that it has exited on its own (no lingering process) by the time session2 checks its pid.
      toolCalls: [{ name: "watch_start", args: { command: "sleep 2; exit 0", deadline_s: 30, interval_s: 1, label: "restart-orphan" } }],
    },
    { match: ".*", text: "ack" },
  ]);
  const sessionStoreDir = freshDir("loop-wait-sessionstore-");
  const projectDir = freshDir("loop-wait-project-");
  const sessionArgs = ["--session-dir", sessionStoreDir, "--session-id", "restart-run"];

  const session1 = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script, sessionArgs, sessionDir: projectDir });
  try {
    session1.send({ id: "p1", type: "prompt", message: "ARM_FUTURE" });
    await session1.waitForResponse("p1");
    await session1.waitFor((e) => e.type === "agent_settled");

    session1.send({ id: "p2", type: "prompt", message: "START_WATCH" });
    await session1.waitForResponse("p2");
    // Kill right after the watch is armed (its "starting" receipt and state snapshot are already
    // persisted by then) rather than waiting for it to finish, so the persisted state still says
    // running/starting when session1 dies — simulating a crash, not a clean shutdown.
    await session1.waitFor((e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "watch_start");
  } finally {
    session1.child.kill("SIGKILL");
    await new Promise((resolve) => {
      if (session1.child.exitCode !== null || session1.child.signalCode !== null) {
        resolve(undefined);
        return;
      }
      session1.child.once("exit", () => resolve(undefined));
    });
  }
  // Let the detached dummy process exit on its own (it outlives the killed parent): by the time
  // session2 reconciles, its pid is genuinely gone, so no process is left running past this test.
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  const script2Path = writeFauxScript([{ match: ".*", text: "ack" }]);
  const session2 = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script2Path,
    sessionArgs,
    sessionDir: projectDir,
    agentDir: session1.agentDir,
  });
  try {
    const orphanReport = await session2.waitFor(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-watch",
      15_000,
    );
    const content = (orphanReport.message as { content?: string }).content ?? "";
    assert.match(content, /phase=failed/);
    assert.match(content, /orphan/);

    const entriesReqId = "e1";
    session2.send({ id: entriesReqId, type: "get_entries" });
    const response = await session2.waitForResponse(entriesReqId);
    const entries = (response.data as { entries: { type: string; customType?: string; data?: unknown }[] }).entries;
    const stateEntries = entries.filter((e) => e.type === "custom" && e.customType === "loop-wait-state");
    assert.ok(stateEntries.length > 0);
    const latest = stateEntries[stateEntries.length - 1].data as {
      timers: { id: string; at: string; reason: string }[];
      watchers: { id: string; phase: string }[];
    };
    assert.ok(latest.timers.some((t) => t.reason === "restart-test-timer"), "the future timer must be re-armed after restart");
    assert.equal(
      latest.watchers.filter((w) => w.phase === "starting" || w.phase === "running").length,
      0,
      "the orphaned watcher must not still be tracked as running",
    );
  } finally {
    await session2.close();
  }
});

for (const fired of [false, true]) {
  test(`root.ts: a stop removes ${fired ? "fired queued" : "armed"} continuation clocks but preserves lane, ops and root timers`, async () => {
    await withFakeAgentDir(async (agentDir) => {
      const { tools, lifecycle, sent, stateEvents } = await loadRootWithFakePi();
      const idleBox = { idle: false };
      const ctx = fakeCtx(agentDir, idleBox);
      lifecycle.get("session_start")!(undefined, ctx);
      const otherReasons = ["lane run=keep agent=ops deadline", "ops clock", "root clock"];
      for (const reason of [TIME_PARK_ARM_REASON, AUTO_ARM_REASON, ...otherReasons]) {
        await tools.get("wake_at")!.execute("arm", { at: new Date(Date.now() + 100).toISOString(), reason }, undefined, undefined, ctx);
      }
      if (fired) await delay(250);
      lifecycle.get("agent_before_settle")!({ outcome: "completed", context: { contextMessages: [{ role: "assistant", content: "PAUSED: operator stop" }] } }, ctx);
      await delay(250);
      assert.equal(sent.length, 0, "busy root still has not delivered wakes");
      idleBox.idle = true;
      lifecycle.get("agent_settled")!(undefined, ctx);
      await delay(400);
      assert.deepEqual(sent.map((s) => (s.message.details as { reason: string }).reason).sort(), [...otherReasons].sort(), "exactly the unrelated timers remain, independent of delivery order");
      assert.deepEqual(sent.map((s) => s.options.triggerTurn), [false, false, true], "remaining wakes still batch into one turn");
      for (const reason of [TIME_PARK_ARM_REASON, AUTO_ARM_REASON]) {
        assert.equal(stateEvents.filter((event) => event.op === "stop" && event.what.endsWith(`: ${reason}`)).length, 1, "cancel records one lifecycle stop, not duplicate stops");
      }
      await lifecycle.get("session_shutdown")!(undefined, ctx);
    });
  });
}

test("root.ts: wake_cancel by a unique prefix also drops a fired wake still queued behind a busy root", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const armed = await tools.get("wake_at")!.execute(
      "t1", { at: new Date(Date.now() + 30).toISOString(), reason: "prefix-queued" }, undefined, undefined, ctx);
    const id = (armed.details as { id: string }).id;
    await delay(150);

    const result = await tools.get("wake_cancel")!.execute("t2", { id: id.slice(0, 8) }, undefined, undefined, ctx);
    assert.equal((result.details as { cancelled: boolean }).cancelled, true);

    idleBox.idle = true;
    lifecycle.get("agent_settled")!(undefined, ctx);
    await delay(400);
    assert.deepEqual(sent, []);
  });
});

// Operator Esc: agent_settled carries aborted:true, and
// wakes that already fired stay queued until the owner's next input instead of restarting the root.
test("root.ts: wakes that fired before an operator abort stay queued until the owner's next input", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);

    const wakeAt = tools.get("wake_at")!;
    await wakeAt.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "fired-before-esc" }, undefined, undefined, ctx);
    await tools.get("watch_start")!.execute(
      "w1", { command: "exit 0", deadline_s: 30, interval_s: 1, label: "watch-before-esc" }, undefined, undefined, ctx);
    await delay(300);
    assert.equal(sent.length, 0, "root is busy: nothing delivered yet");

    idleBox.idle = true;
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
    await delay(400);
    assert.equal(sent.length, 0, "an operator abort must not flush fired wakes");

    // A wake that fires after the Esc, while idle, is held too rather than restarting the root.
    await wakeAt.execute("t2", { at: new Date(Date.now() + 30).toISOString(), reason: "fired-after-esc" }, undefined, undefined, ctx);
    await delay(200);
    assert.equal(sent.length, 0, "an idle root after Esc must not be restarted by a new wake");

    // Owner input releases the hold; delivery then happens at the settle that input produces.
    lifecycle.get("input")!({ type: "input", text: "continue", source: "interactive" }, ctx);
    await wakeAt.execute("t3", { at: new Date(Date.now() + 30).toISOString(), reason: "fired-after-input" }, undefined, undefined, ctx);
    await delay(150);
    assert.equal(sent.length, 0, "until the input's own turn settles, nothing may open a concurrent turn");
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
    await delay(400);
    assert.deepEqual(
      sent.map((s) => s.message.customType).sort(),
      ["loop-wake", "loop-wake", "loop-wake", "loop-watch"],
      "every held wake is delivered once, after the owner's input",
    );
    assert.deepEqual(sent.map((s) => s.options.triggerTurn), [false, false, false, true], "held wakes still batch into one turn");
    await lifecycle.get("session_shutdown")!(undefined, ctx);
  });
});

test("root.ts: input from an extension does not release held wakes; a non-aborted settle still flushes", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);
    await tools.get("wake_at")!.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "held" }, undefined, undefined, ctx);
    await delay(150);
    idleBox.idle = true;
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
    lifecycle.get("input")!({ type: "input", text: "synthetic", source: "extension" }, ctx);
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
    await delay(400);
    assert.equal(sent.length, 0, "an extension-sourced input is not the owner");

    lifecycle.get("input")!({ type: "input", text: "owner", source: "rpc" }, ctx);
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx);
    await delay(400);
    assert.equal(sent.length, 1);
    await lifecycle.get("session_shutdown")!(undefined, ctx);
  });
});

test("root.ts: an abort the request ceiling caused still flushes, and the next plain abort holds again", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent, busHandlers } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);
    const wakeAt = tools.get("wake_at")!;
    await wakeAt.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "ceiling-case" }, undefined, undefined, ctx);
    await delay(150);

    // request-ceiling emits this just before ctx.abort() (SEAMS.md "Request ceiling").
    busHandlers.get("loop-recovery:request-timeout")!({});
    idleBox.idle = true;
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
    await delay(400);
    assert.equal(sent.length, 1, "a ceiling-caused abort is not the operator: delivery is unchanged");

    sent.length = 0;
    idleBox.idle = false;
    await wakeAt.execute("t2", { at: new Date(Date.now() + 30).toISOString(), reason: "later-esc" }, undefined, undefined, ctx);
    await delay(150);
    idleBox.idle = true;
    lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
    await delay(400);
    assert.equal(sent.length, 0, "the ceiling exception covers one abort only");
    await lifecycle.get("session_shutdown")!(undefined, ctx);
  });
});

test("root.ts: a recovery abort delivers fired wakes but exempts only one settle", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const { tools, lifecycle, sent, busHandlers } = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    lifecycle.get("session_start")!(undefined, ctx);
    try {
      await tools.get("wake_at")!.execute("r1", { at: new Date(Date.now() + 30).toISOString(), reason: "recovery-expiry" }, undefined, undefined, ctx);
      await delay(150);
      assert.equal(sent.length, 0, "wake fired while busy");
      busHandlers.get("loop-recovery:abort")!({});
      idleBox.idle = true;
      lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
      await delay(400);
      assert.equal(sent.length, 1, "recovery abort must deliver, not hold");
      assert.equal(sent[0].options.triggerTurn, true);
      sent.length = 0; idleBox.idle = false;
      await tools.get("wake_at")!.execute("r2", { at: new Date(Date.now() + 30).toISOString(), reason: "next-operator-abort" }, undefined, undefined, ctx);
      await delay(150);
      idleBox.idle = true;
      lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
      await delay(400);
      assert.equal(sent.length, 0, "the next plain abort must still hold");
    } finally {
      await lifecycle.get("session_shutdown")!(undefined, ctx);
    }
  });
});

test("RPC: a real operator abort holds a fired wake until the next prompt", async () => {
  const script = writeFauxScript([
    { match: "ARM_THEN_HANG", once: true, toolCalls: [{ name: "wake_at", args: { at: new Date(Date.now() + 400).toISOString(), reason: "esc-held-wake" } }] },
    { match: "timer-id=", once: true, hang: true },
    { match: ".*", text: "ack" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script });
  try {
    session.send({ id: "p1", type: "prompt", message: "ARM_THEN_HANG" });
    await session.waitForResponse("p1");
    await delay(1_200); // the wake fires at ~400ms while the root hangs on its next request
    session.send({ id: "a1", type: "abort" });
    await session.waitFor((e) => e.type === "agent_settled" && e.aborted === true);
    await delay(1_000);
    const isWake = (e: { type: string; message?: unknown }) =>
      e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake";
    assert.equal(session.events.filter(isWake).length, 0, "Esc must not release the fired wake");

    session.send({ id: "p2", type: "prompt", message: "OWNER_NEXT" });
    const wake = await session.waitFor(isWake, 15_000);
    assert.match((wake.message as { content?: string }).content ?? "", /esc-held-wake/);
    const ownerInput = session.events.findIndex(
      (e) => e.type === "message_start" && (e.message as { role?: string })?.role === "user" && JSON.stringify(e.message).includes("OWNER_NEXT"),
    );
    assert.ok(ownerInput !== -1 && ownerInput < session.events.indexOf(wake), "the wake follows the owner's input");
  } finally {
    await session.close();
  }
});

test("RPC: a request-ceiling abort still delivers the incident follow-up and the fired wake", async () => {
  const script = writeFauxScript([
    { match: "ARM_CEILING", once: true, toolCalls: [{ name: "wake_at", args: { at: new Date(Date.now() + 400).toISOString(), reason: "ceiling-queued-wake" } }] },
    { match: "timer-id=", once: true, hang: true },
    { match: ".*", text: "recovered" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, CEILING_EXTENSION],
    fauxScriptPath: script,
    settings: { loopPi: { requestCeiling: { wallClockMs: 1_500, maxFollowUps: 2 } } },
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "ARM_CEILING" });
    const isCustom = (type: string) => (e: { type: string; message?: unknown }) =>
      e.type === "message_start" && (e.message as { customType?: string })?.customType === type;
    const incident = await session.waitFor(isCustom("loop-request-incident"), 20_000);
    const wake = await session.waitFor(isCustom("loop-wake"), 20_000);
    assert.match((wake.message as { content?: string }).content ?? "", /ceiling-queued-wake/);
    assert.ok(session.events.indexOf(incident) !== -1);
  } finally {
    await session.close();
  }
});

test("root.ts: a wake held after Esc survives a session restart and is delivered after the owner's next input", async () => {
  await withFakeAgentDir(async (agentDir) => {
    const first = await loadRootWithFakePi();
    const idleBox = { idle: false };
    const ctx = fakeCtx(agentDir, idleBox);
    first.lifecycle.get("session_start")!(undefined, ctx);
    await first.tools.get("wake_at")!.execute("t1", { at: new Date(Date.now() + 30).toISOString(), reason: "queued-before-esc" }, undefined, undefined, ctx);
    await delay(150); // fires while busy: queued
    idleBox.idle = true;
    first.lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: true }, ctx);
    await first.tools.get("wake_at")!.execute("t2", { at: new Date(Date.now() + 30).toISOString(), reason: "fired-while-held" }, undefined, undefined, ctx);
    await delay(200);
    assert.equal(first.sent.length, 0);

    // /reload or quit-and-resume: shutdown must neither deliver nor lose the held messages.
    await first.lifecycle.get("session_shutdown")!(undefined, ctx);
    assert.equal(first.sent.length, 0, "teardown must not deliver held wakes");

    const second = await loadRootWithFakePi();
    const ctx2 = fakeCtx(agentDir, { idle: true }, first.entries);
    second.lifecycle.get("session_start")!(undefined, ctx2);
    await delay(400);
    assert.equal(second.sent.length, 0, "restored wakes stay held until the owner types");
    second.lifecycle.get("input")!({ type: "input", text: "continue", source: "interactive" }, ctx2);
    second.lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx2);
    await delay(400);
    assert.deepEqual(
      second.sent.map((s) => (s.message.details as { reason: string }).reason).sort(),
      ["fired-while-held", "queued-before-esc"],
      "both held wakes are delivered once",
    );
    assert.deepEqual(second.sent.map((s) => s.options.triggerTurn), [false, true]);

    // Delivered wakes are cleared from the snapshot: a later restart does not replay them.
    const third = await loadRootWithFakePi();
    const ctx3 = fakeCtx(agentDir, { idle: true }, second.entries);
    third.lifecycle.get("session_start")!(undefined, ctx3);
    third.lifecycle.get("input")!({ type: "input", text: "again", source: "interactive" }, ctx3);
    third.lifecycle.get("agent_settled")!({ type: "agent_settled", aborted: false }, ctx3);
    await delay(400);
    assert.equal(third.sent.length, 0, "delivered wakes are not replayed");
    await second.lifecycle.get("session_shutdown")!(undefined, ctx2);
    await third.lifecycle.get("session_shutdown")!(undefined, ctx3);
  });
});
