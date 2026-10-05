// Lane deadline timers (root.ts) and the loop-pi-runtime entry (root.ts and lane.ts), against a
// fake ExtensionAPI with a real event bus and every handler kept.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, describe, test } from "node:test";

import { briefDeadlineMs, laneTimerReason, payloadDeadlineMs, runIdFromReason, subagentArgsDeadlineMs } from "./lane-timers.ts";
import { readRuntimeEntry } from "./runtime-entry.ts";
import { cleanupAll, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, startPiRpc, writeFauxScript } from "./test-helpers.ts";

register("./test-support-resolve-nested-deps.mjs", import.meta.url);
after(cleanupAll);

describe("lane-timers helpers", () => {
  test("briefDeadlineMs reads a Deadline: line and takes the latest of several", () => {
    assert.equal(briefDeadlineMs("Lane: a\nDeadline: 2026-10-03T12:00:00Z\nObjective: x"), Date.parse("2026-10-03T12:00:00Z"));
    assert.equal(
      subagentArgsDeadlineMs({ tasks: [{ task: "Deadline: 2026-10-03T12:00Z" }, { task: "Deadline: 2026-10-03T13:00Z" }] }),
      Date.parse("2026-10-03T13:00Z"),
    );
    assert.equal(briefDeadlineMs("no deadline here\nDeadline: soon"), null);
    assert.equal(briefDeadlineMs("Wait. Deadline: 2026-10-03T12:00Z is mid-line"), null);
    assert.equal(subagentArgsDeadlineMs(undefined), null);
  });

  test("payloadDeadlineMs prefers deadlineAt, then timeoutMs, then the agent file", () => {
    const agentDir = freshDir("lane-timers-agentdir-");
    mkdirSync(join(agentDir, "agents"));
    writeFileSync(join(agentDir, "agents", "w.md"), "---\nname: w\ntimeoutMs: 60000\n---\nbody\n");
    assert.equal(payloadDeadlineMs({ deadlineAt: 5000, timeoutMs: 1 }, agentDir, 100), 5000);
    assert.equal(payloadDeadlineMs({ timeoutMs: 2000 }, agentDir, 100), 2100);
    assert.equal(payloadDeadlineMs({ agent: "w" }, agentDir, 100), 60100);
    assert.equal(payloadDeadlineMs({ agent: "../w" }, agentDir, 100), null);
    assert.equal(payloadDeadlineMs({}, agentDir, 100), null);
  });

  test("a lane reason round-trips its run id and no other reason does", () => {
    assert.equal(runIdFromReason(laneTimerReason("run-7", "lane-worker")), "run-7");
    assert.equal(runIdFromReason("lane run-7 something"), null);
    assert.equal(runIdFromReason("compaction-race-test"), null);
  });
});

type Handler = (event: any, ctx: any) => unknown;

async function loadRoot(agentDir: string, opts: { idle?: { idle: boolean }; sessionFile?: string } = {}) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const tools = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const entries: { customType: string; data: any }[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    events: {
      on: (name: string, h: (data: unknown) => void) => bus.set(name, [...(bus.get(name) ?? []), h]),
      emit: (name: string, data: unknown) => (bus.get(name) ?? []).forEach((h) => h(data)),
    },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
  };
  const rootModule = await import("./root.ts");
  rootModule.default(pi as never);
  const idleBox = opts.idle ?? { idle: true };
  const ctx = {
    cwd: agentDir,
    model: { id: "m-1" },
    isIdle: () => idleBox.idle,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionId: () => "sess-A",
      getSessionFile: () => opts.sessionFile,
      getBranch: () => [],
    },
  };
  const fire = (name: string, event: unknown) => handlers.get(name)?.forEach((h) => h(event, ctx));
  fire("session_start", {});
  const timers = (): { id: string; at: string; reason: string }[] => {
    let answer: any[] = [];
    pi.events.emit("loop-wait:query-timers", { reply: (t: any[]) => (answer = t) });
    return answer;
  };
  return { pi, tools, sent, entries, ctx, fire, timers, idleBox, restore: () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  } };
}

describe("lane deadline timers", () => {
  test("async-started for this session arms a timer at the payload deadline; another session's is ignored", async () => {
    const h = await loadRoot(freshDir("lane-timers-a-"));
    try {
      const at = Date.now() + 600_000;
      h.pi.events.emit("subagent:async-started", { id: "run-1", sessionId: "other", agent: "lane-worker", deadlineAt: at });
      assert.deepEqual(h.timers(), []);
      h.pi.events.emit("subagent:async-started", { id: "run-1", sessionId: "sess-A", agent: "lane-worker", deadlineAt: at });
      const [timer] = h.timers();
      assert.equal(timer.at, new Date(at).toISOString());
      assert.equal(runIdFromReason(timer.reason), "run-1");
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("the session file identity pi-subagents uses also matches", async () => {
    const h = await loadRoot(freshDir("lane-timers-b-"), { sessionFile: "/x/session.jsonl" });
    try {
      h.pi.events.emit("subagent:async-started", { id: "run-2", sessionId: "/x/session.jsonl", agent: "a", timeoutMs: 600_000 });
      assert.equal(h.timers().length, 1);
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("the launching call's brief Deadline: re-times the run once its result names the run id", async () => {
    const h = await loadRoot(freshDir("lane-timers-c-"));
    try {
      const payloadAt = Date.now() + 3_600_000;
      const briefAt = Date.parse("2099-01-01T00:00:00Z");
      h.fire("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "call-1",
        args: { agent: "lane-worker", task: "Lane: a\nDeadline: 2099-01-01T00:00:00Z\nObjective: x" },
      });
      h.pi.events.emit("subagent:async-started", { id: "run-3", sessionId: "sess-A", agent: "lane-worker", deadlineAt: payloadAt });
      assert.equal(h.timers()[0].at, new Date(payloadAt).toISOString());
      h.fire("tool_execution_end", { toolName: "subagent", toolCallId: "call-1", isError: false, result: { details: { runId: "run-3" } } });
      const timers = h.timers();
      assert.equal(timers.length, 1);
      assert.equal(timers[0].at, new Date(briefAt).toISOString());
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("async-complete cancels by run id and leaves the root's own timers alone", async () => {
    const h = await loadRoot(freshDir("lane-timers-d-"));
    try {
      const ctx = h.ctx;
      await h.tools.get("wake_at").execute("w", { at: new Date(Date.now() + 600_000).toISOString(), reason: "root timer run=run-4 x" }, undefined, undefined, ctx);
      h.pi.events.emit("subagent:async-started", { id: "run-4", sessionId: "sess-A", agent: "a", deadlineAt: Date.now() + 100 });
      h.pi.events.emit("subagent:async-started", { id: "run-5", sessionId: "sess-A", agent: "a", deadlineAt: Date.now() + 600_000 });
      assert.equal(h.timers().length, 3);
      h.pi.events.emit("subagent:async-complete", { runId: "run-4" });
      const left = h.timers().map((t) => runIdFromReason(t.reason) ?? t.reason);
      assert.deepEqual(left.sort(), ["root timer run=run-4 x", "run-5"]);
      await delay(250);
      assert.deepEqual(h.sent, [], "a cancelled lane timer never wakes the root");
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("async-complete drops a lane wake that fired while the root was busy", async () => {
    const idle = { idle: false };
    const h = await loadRoot(freshDir("lane-timers-e-"), { idle });
    try {
      h.pi.events.emit("subagent:async-started", { id: "run-6", sessionId: "sess-A", agent: "a", deadlineAt: Date.now() + 30 });
      await delay(150);
      assert.deepEqual(h.timers(), [], "the timer fired and left the live set");
      h.pi.events.emit("subagent:async-complete", { runId: "run-6" });
      idle.idle = true;
      h.fire("agent_settled", {});
      await delay(400);
      assert.deepEqual(h.sent, [], "the queued wake for the finished lane is dropped");
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("a fired lane timer wakes an idle root", async () => {
    const h = await loadRoot(freshDir("lane-timers-f-"));
    try {
      h.pi.events.emit("subagent:async-started", { id: "run-8", sessionId: "sess-A", agent: "a", deadlineAt: Date.now() + 30 });
      await delay(200);
      assert.equal(h.sent.length, 1);
      assert.equal(h.sent[0].message.customType, "loop-wake");
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });
});

describe("loop-pi-runtime entry", () => {
  test("readRuntimeEntry reads variant and service tiers, defaulting both", () => {
    const dir = freshDir("runtime-entry-");
    assert.deepEqual(readRuntimeEntry(dir), { v: 1, variant: "unknown", models: {} });
    writeFileSync(join(dir, ".loop-pi-managed.json"), JSON.stringify({ label: "x", variant: "fast" }));
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            modelOverrides: {
              "gpt-6.1-sol": { samplingParams: { service_tier: "priority" } },
              "gpt-6-luna": { contextWindow: 1 },
            },
          },
        },
      }),
    );
    assert.deepEqual(readRuntimeEntry(dir, "faux-1"), {
      v: 1,
      variant: "fast",
      models: {
        "gpt-6.1-sol": { service_tier: "priority" },
        "gpt-6-luna": { service_tier: "default" },
        "faux-1": { service_tier: "default" },
      },
    });
  });

  test("a malformed home receipt or models.json falls back instead of throwing", () => {
    const dir = freshDir("runtime-entry-bad-");
    writeFileSync(join(dir, ".loop-pi-managed.json"), "{not json");
    writeFileSync(join(dir, "models.json"), "[1,2");
    assert.deepEqual(readRuntimeEntry(dir), { v: 1, variant: "unknown", models: {} });
  });

  test("the root entry appends it at session_start", async () => {
    const dir = freshDir("runtime-entry-root-");
    writeFileSync(join(dir, ".loop-pi-managed.json"), JSON.stringify({ variant: "fast" }));
    const h = await loadRoot(dir);
    try {
      const entry = h.entries.find((e) => e.customType === "loop-pi-runtime");
      assert.deepEqual(entry?.data, { v: 1, variant: "fast", models: { "m-1": { service_tier: "default" } } });
    } finally {
      h.fire("session_shutdown", {});
      h.restore();
    }
  });

  test("the lane entry appends it at session_start", async () => {
    const dir = freshDir("runtime-entry-lane-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const handlers: Record<string, Handler> = {};
      const entries: { customType: string; data: any }[] = [];
      const laneModule = await import("./lane.ts");
      laneModule.default({
        registerTool: () => {},
        appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
        on: (name: string, h: Handler) => (handlers[name] = h),
      } as never);
      handlers.session_start({}, { model: { id: "m-2" } });
      assert.deepEqual(entries, [{ customType: "loop-pi-runtime", data: { v: 1, variant: "unknown", models: { "m-2": { service_tier: "default" } } } }]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

test("real pi session: async-started with the session FILE PATH arms a timer, async-complete cancels one", { timeout: 40_000 }, async () => {
  const projectDir = freshDir("lane-timers-e2e-project-");
  const storeDir = freshDir("lane-timers-e2e-store-");
  const script = writeFauxScript([{ match: ".*", text: "ack" }]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, join(import.meta.dirname, "test-support-async-started.ts")],
    fauxScriptPath: script,
    sessionArgs: ["--session-dir", storeDir, "--session-id", "lane-timer-e2e"],
    sessionDir: projectDir,
  });
  try {
    const wake = await session.waitFor(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake",
      15_000,
    );
    const content = (wake.message as { content?: string }).content ?? "";
    assert.match(content, /run=run-b /, "the surviving run's deadline wakes the root");
    await delay(600);
    const wakes = session.events.filter(
      (e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-wake",
    );
    assert.equal(wakes.length, 1, "run-a was completed before its deadline and never wakes the root");
  } finally {
    await session.close();
  }
});
