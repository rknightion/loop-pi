// Integration-style tests for root.ts: wire the real extension factory against
// a minimal fake ExtensionAPI/ExtensionContext and drive its captured
// "tool_call" handler directly. This proves root.ts actually calls into
// rules.ts + hooks.ts for every tool it claims to guard, without needing a
// live pi process (that proof is e2e.test.ts).
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import rootExtension from "./root.ts";
import { HOOK_TEMPLATES_DIR } from "../test-support/hook-templates.ts";

// The guard scripts to lay out in a scratch <agentDir>/scripts/: this checkout's shared guards
// when it carries them, else the sample guards in test-support (see hook-templates.ts).
const TEMPLATES_DIR = HOOK_TEMPLATES_DIR;

type Handler = (event: any, ctx: any) => any;

function fakeApi() {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    // pi.events: synchronous handlers, as in pi.
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = listeners.get(channel) ?? [];
        list.push(handler);
        listeners.set(channel, list);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    },
  };
  return { api, handlers, emit: api.events.emit, onEvent: api.events.on };
}

function fakeCtx(cwd: string, sessionId = "test-session") {
  const notifications: { message: string; type?: string }[] = [];
  return {
    ctx: {
      cwd,
      ui: {
        notify: (message: string, type?: string) => {
          notifications.push({ message, type });
        },
      },
      sessionManager: { getSessionId: () => sessionId },
    },
    notifications,
  };
}

let agentDir: string;

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "loop-guard-root-test-"));
  await cp(TEMPLATES_DIR, join(agentDir, "scripts"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

function toolCallHandler(handlers: Map<string, Handler[]>): Handler {
  const list = handlers.get("tool_call");
  assert.ok(list && list.length === 1, "root.ts must register exactly one tool_call handler");
  return list[0];
}

test("root tool_call: blocks a forbidden bash command (force push)", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git push --force" } }, ctx);
  assert.equal(result?.block, true);
});

test("root tool_call: allows an ordinary bash command", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls -la" } }, ctx);
  assert.equal(result?.block, undefined);
});

test("root tool_call: an adapter failure (missing hook scripts) is ignored for root, not a block (C4 item 1 asymmetry)", async () => {
  const brokenDir = await mkdtemp(join(tmpdir(), "loop-guard-root-broken-"));
  try {
    process.env.PI_CODING_AGENT_DIR = brokenDir; // no scripts/ dir at all, but both are required
    await writeFile(join(brokenDir, "settings.json"),
      JSON.stringify({ loopPi: { requiredHookScripts: ["backlog-guard.py", "staging-guard.py"] } }), "utf8");
    const { api, handlers } = fakeApi();
    rootExtension(api as any);
    const handler = toolCallHandler(handlers);
    const { ctx, notifications } = fakeCtx(brokenDir);
    const result = await handler(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls -la" } },
      ctx,
    );
    assert.equal(result?.block ?? false, false, "a hook adapter failure must not block the root");
    assert.ok(
      notifications.some((n) => n.type === "warning" && /adapter failure/.test(n.message)),
      "root must still log the adapter failure as a warning",
    );
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await rm(brokenDir, { recursive: true, force: true });
  }
});

test("root tool_call: absent guard scripts that are not required run nothing and warn nothing", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "loop-guard-root-bare-"));
  try {
    process.env.PI_CODING_AGENT_DIR = bareDir; // no scripts/ dir and no settings.json
    const { api, handlers } = fakeApi();
    rootExtension(api as any);
    const handler = toolCallHandler(handlers);
    const { ctx, notifications } = fakeCtx(bareDir);
    const result = await handler({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls -la" } }, ctx);
    assert.equal(result?.block ?? false, false);
    assert.deepEqual(notifications, []);
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await rm(bareDir, { recursive: true, force: true });
  }
});

test("root tool_call: hook script denial blocks bash even when rules.ts allows it", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "backlog task edit hrn-1 --notes hi" } },
    ctx,
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /append-notes/);
});

test("root tool_call: edit to a CLI-owned backlog path is blocked via the hook script", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: `${agentDir}/backlog/tasks/task-1.md` } },
    ctx,
  );
  assert.equal(result?.block, true);
});

test("root tool_call: subagent launch outside C3 is blocked", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "scout", task: "recon" } },
    ctx,
  );
  assert.equal(result?.block, true);
});

test("root tool_call: subagent launch in C3 is allowed", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "mapper", task: "recon" } },
    ctx,
  );
  assert.equal(result?.block ?? false, false);
});

test("root tool_call: bg_wait is always blocked", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler({ type: "tool_call", toolCallId: "1", toolName: "bg_wait", input: {} }, ctx);
  assert.equal(result?.block, true);
});

test("root tool_call: watch_process blocked while an async subagent run is active", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const toolExecStart = handlers.get("tool_execution_start")![0];
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);

  // Simulate a qualifying async subagent launch starting execution.
  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "mapper", task: "x" } }, ctx);

  const result = await handler({ type: "tool_call", toolCallId: "2", toolName: "watch_process", input: { command: "ls" } }, ctx);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /async subagent run is active/);
});

test("root tool_call: watch_process allowed again once its run's async-complete arrives", async () => {
  // pi-subagents 0.76.1 appends an idle root's subagent-notify with no extension message events,
  // so only the completion event can release the run.
  const fake = fakeApi();
  rootExtension(fake.api as any);
  const toolExecStart = fake.handlers.get("tool_execution_start")![0];
  const toolExecEnd = fake.handlers.get("tool_execution_end")![0];
  const handler = toolCallHandler(fake.handlers);
  const { ctx } = fakeCtx(agentDir);
  const watch = () => handler({ type: "tool_call", toolCallId: "w", toolName: "watch_process", input: { command: "ls" } }, ctx);

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "mapper", task: "x" } }, ctx);
  toolExecEnd({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", result: { details: { asyncId: "run-1" } }, isError: false }, ctx);
  assert.equal((await watch())?.block, true, "the started run is still active");

  fake.emit("subagent:async-complete", { runId: "other-run" });
  assert.equal((await watch())?.block, true, "another run's completion releases nothing");

  fake.emit("subagent:async-complete", { runId: "run-1" });
  assert.equal((await watch())?.block ?? false, false);
});

test("root tool_call: a completion that arrives before its launch's tool execution ends is not lost", async () => {
  const fake = fakeApi();
  rootExtension(fake.api as any);
  const toolExecStart = fake.handlers.get("tool_execution_start")![0];
  const toolExecEnd = fake.handlers.get("tool_execution_end")![0];
  const handler = toolCallHandler(fake.handlers);
  const { ctx } = fakeCtx(agentDir);

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "mapper", task: "x" } }, ctx);
  fake.emit("subagent:async-complete", { runId: "run-1" });
  toolExecEnd({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", result: { details: { asyncId: "run-1" } }, isError: false }, ctx);

  const result = await handler({ type: "tool_call", toolCallId: "w", toolName: "watch_process", input: { command: "ls" } }, ctx);
  assert.equal(result?.block ?? false, false);
});

test("root tool_call: an async launch that ends in error no longer counts as an active run", async () => {
  // A launch that fails starts no run, so no completion will ever release it.
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const toolExecStart = handlers.get("tool_execution_start")![0];
  const toolExecEnd = handlers.get("tool_execution_end")?.[0];
  assert.ok(toolExecEnd, "root must handle tool_execution_end to release a failed launch");
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "mapper", task: "x" } }, ctx);
  toolExecEnd({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", result: {}, isError: true }, ctx);
  // A repeated end for the same call must not release anything a second time.
  toolExecEnd({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", result: {}, isError: true }, ctx);

  const result = await handler({ type: "tool_call", toolCallId: "2", toolName: "watch_process", input: { command: "ls" } }, ctx);
  assert.equal(result?.block ?? false, false);
});

test("root tool_call: only a tracked failed launch releases the count, never an untracked or successful one", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const toolExecStart = handlers.get("tool_execution_start")![0];
  const toolExecEnd = handlers.get("tool_execution_end")?.[0];
  assert.ok(toolExecEnd, "root must handle tool_execution_end to release a failed launch");
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);

  // Launch A succeeds and is still running (its completion has not arrived).
  toolExecStart({ type: "tool_execution_start", toolCallId: "a", toolName: "subagent", args: { agent: "mapper", task: "x" } }, ctx);
  toolExecEnd({ type: "tool_execution_end", toolCallId: "a", toolName: "subagent", result: {}, isError: false }, ctx);
  // Failures of calls that were never counted: another tool, and an unknown subagent call id.
  toolExecEnd({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: {}, isError: true }, ctx);
  toolExecEnd({ type: "tool_execution_end", toolCallId: "c", toolName: "subagent", result: {}, isError: true }, ctx);
  // A repeated end for A, now with an error, must not release it after it already ended.
  toolExecEnd({ type: "tool_execution_end", toolCallId: "a", toolName: "subagent", result: {}, isError: true }, ctx);

  const result = await handler({ type: "tool_call", toolCallId: "2", toolName: "watch_process", input: { command: "ls" } }, ctx);
  assert.equal(result?.block, true);
});

test("root tool_call: watch_process still runs the shell-command gate on its own command", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "watch_process", input: { command: "git push --force" } },
    ctx,
  );
  assert.equal(result?.block, true);
});

test("root tool_call: watch_start (root-only tool) runs the shell-command gate", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const forbidden = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "watch_start", input: { command: "nohup ./x &" } },
    ctx,
  );
  assert.equal(forbidden?.block, true);
  const allowed = await handler(
    { type: "tool_call", toolCallId: "2", toolName: "watch_start", input: { command: "npm test", label: "tests" } },
    ctx,
  );
  assert.equal(allowed?.block ?? false, false);
});

test("session_start registers required child extensions; session_shutdown disposes them", async () => {
  const { registerRequiredChildExtensions } = await import("pi-subagents/required-child-extensions");
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const sessionStart = handlers.get("session_start")![0];
  const sessionId = `session-${Math.random()}`;
  const { ctx } = fakeCtx(agentDir, sessionId);
  await sessionStart({ type: "session_start", reason: "startup" }, ctx);

  // The registry (pi-subagents/required-child-extensions) refuses a second
  // registration for the same sessionId until it is disposed, so a throw here
  // proves root.ts's session_start already registered one. This checks the
  // public contract rather than reaching into pi-subagents' internal module.
  assert.throws(() => registerRequiredChildExtensions({ sessionId, extensions: [] }), /already registered/);

  const sessionShutdown = handlers.get("session_shutdown")![0];
  sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

  // After dispose, a fresh registration for the same sessionId must succeed.
  const fresh = registerRequiredChildExtensions({ sessionId, extensions: [] });
  fresh.dispose();
});

test("a registerRequiredChildExtensions failure fails closed: every subsequent subagent call is blocked", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const sessionStart = handlers.get("session_start")![0];
  const sessionShutdown = handlers.get("session_shutdown")![0];
  const handler = toolCallHandler(handlers);
  const sessionId = `session-${Math.random()}`;
  const { ctx, notifications } = fakeCtx(agentDir, sessionId);

  // First registration succeeds and is never disposed here, so the second
  // session_start's registerRequiredChildExtensions call for the SAME
  // sessionId throws "already registered" (the real pi-subagents contract
  // exercised in the test above) - this is root.ts's actual failure path,
  // not a mock.
  await sessionStart({ type: "session_start", reason: "startup" }, ctx);
  await sessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.ok(
    notifications.some((n) => n.type === "error" && /failed to register required child extensions/.test(n.message)),
    "root must still log the registration failure",
  );

  // Fail closed: a subagent launch, even naming a valid C3 agent, must now be
  // blocked with a clear reason, because children can no longer be trusted to
  // load loop-guard-lane.
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "mapper", task: "recon" } },
    ctx,
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /required child extension/i);

  // Cleanup: dispose the one registration that did succeed so later tests in
  // this file are not affected.
  sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("session_start registers loop-guard-lane pointing at an existing, importable file", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const sessionStart = handlers.get("session_start")![0];
  const sessionId = `session-${Math.random()}`;
  const { ctx, notifications } = fakeCtx(agentDir, sessionId);
  // registerRequiredChildExtensions itself calls fs.realpathSync/statSync on
  // every path and throws if any entry is not an importable file. root.ts
  // catches that and reports it via ctx.ui.notify("error", ...) instead of
  // throwing, so the real proof is "no error notification", not just
  // "did not throw".
  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(
    notifications.filter((n) => n.type === "error"),
    [],
    "loop-guard-lane (and loop-wait-lane, if present) must resolve to importable files",
  );
  const sessionShutdown = handlers.get("session_shutdown")![0];
  sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("root: a subagent call naming a model outside the gpt-6 family is blocked", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "mapper", task: "x", model: "openai/gpt-5.6-luna" } },
    ctx,
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /gpt-6 family route/);
  assert.ok(handlers.get("before_provider_request")?.length === 1 && handlers.get("model_select")?.length === 1);
});

// ---------------------------------------------------------------------------
// Ops grants (S6): the frozen ops come from loop-continuation's `query-launch` answer.
// ---------------------------------------------------------------------------

const OPS_ENTRY = { surface: "deploy:svc-worker", kind: "deploy", allow: ["^just deploy( .*)?$"] };
const OPS_FILE = { v: 1, ops: [OPS_ENTRY] };
const OPS_BRIEF = "Lane: L1 · Task: T-1 · Tier: guarded\nObjective: deploy\nOps surface: deploy:svc-worker\nGate: just deploy";

/** A root with a fake loop-continuation answering `query-launch` with `ops` (no answer when omitted). */
function opsRoot(ops?: unknown) {
  const fake = fakeApi();
  if (ops !== undefined) {
    fake.onEvent("loop-continuation:query-launch", (data) =>
      (data as { reply: (r: unknown) => void }).reply({ reportPath: "/r/report.md", opsPath: "/r/ops.json", ops }),
    );
  }
  rootExtension(fake.api as any);
  const { ctx } = fakeCtx(agentDir);
  const handler = toolCallHandler(fake.handlers);
  const end = fake.handlers.get("tool_execution_end")![0];
  const launch = (toolCallId: string, input: Record<string, unknown>) =>
    handler({ type: "tool_call", toolCallId, toolName: "subagent", input }, ctx);
  // The tool result shape pi-subagents 0.76.1 returns for a single async launch (async-execution.js).
  const started = (toolCallId: string, runId: string) =>
    end(
      {
        type: "tool_execution_end",
        toolCallId,
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: `Async: ops [${runId}]` }],
          details: { mode: "single", runId, results: [], asyncId: runId, asyncDir: `/tmp/${runId}` },
        },
      },
      ctx,
    );
  // The completion payload result-watcher.js emits: the result file's fields plus `runId`.
  const completed = (runId: string) =>
    fake.emit("subagent:async-complete", {
      id: runId,
      runId,
      sessionId: "/sessions/root.jsonl",
      agent: "ops",
      success: true,
      results: [{ agent: "ops", status: "complete" }],
      triggerTurn: true,
    });
  return { launch, started, completed, end, ctx };
}

test("root ops: a frozen surface is bound with agent, surface and the full entry", async (t) => {
  const previousRunDir = process.env.LOOP_PI_RUN_DIR;
  t.after(() => {
    if (previousRunDir === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previousRunDir;
  });
  // This fixture exercises the binding without a loop run dir, regardless of its caller.
  delete process.env.LOOP_PI_RUN_DIR;
  const { launch } = opsRoot(OPS_FILE);
  const input: Record<string, unknown> = {
    agent: "ops",
    task: OPS_BRIEF,
    extensionBindings: { "loop-pi.guard/1": { agent: "ops", surface: "deploy:svc-worker", entry: { ...OPS_ENTRY, allow: ["^.*$"] } } },
  };
  const result = await launch("1", input);
  assert.equal(result?.block ?? false, false, result?.reason);
  assert.deepEqual(input.extensionBindings, { "loop-pi.guard/1": { agent: "ops", surface: "deploy:svc-worker", entry: OPS_ENTRY } });
});

test("root ops: refused when no ops are frozen (null) or nothing answers query-launch", async () => {
  for (const root of [opsRoot(null), opsRoot()]) {
    const result = await root.launch("1", { agent: "ops", task: OPS_BRIEF });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /no ops grants are frozen/);
  }
});

test("root ops: a surface not in the frozen ops is refused", async () => {
  const { launch } = opsRoot(OPS_FILE);
  const result = await launch("1", { agent: "ops", task: OPS_BRIEF.replace("deploy:svc-worker", "deploy:other") });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /not in the frozen ops/);
});

test("root ops: an Ops surface line on any other agent is refused", async () => {
  const { launch } = opsRoot(OPS_FILE);
  const input: Record<string, unknown> = { agent: "lane-worker-push", task: OPS_BRIEF };
  const result = await launch("1", input);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /only valid in a brief for agent `ops`/);
  assert.equal(input.extensionBindings, undefined);
});

test("root ops: one active run per surface, released by its async-complete", async () => {
  const { launch, started, completed } = opsRoot(OPS_FILE);
  assert.equal((await launch("1", { agent: "ops", task: OPS_BRIEF }))?.block ?? false, false);
  // Still between tool_call and the tool result.
  const racing = await launch("2", { agent: "ops", task: OPS_BRIEF });
  assert.equal(racing?.block, true);
  assert.match(racing?.reason ?? "", /already active/);
  started("1", "run-a");
  assert.equal((await launch("3", { agent: "ops", task: OPS_BRIEF }))?.block, true, "the run is still active");
  completed("run-other");
  assert.equal((await launch("4", { agent: "ops", task: OPS_BRIEF }))?.block, true, "another run's completion releases nothing");
  completed("run-a");
  assert.equal((await launch("5", { agent: "ops", task: OPS_BRIEF }))?.block ?? false, false);
});

test("root ops: the run id is read from the started text when details lack it", async () => {
  const { launch, end, completed, ctx } = opsRoot(OPS_FILE);
  await launch("1", { agent: "ops", task: OPS_BRIEF });
  end({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "Async: ops [run-b]\nmore" }], details: {} } }, ctx);
  assert.equal((await launch("2", { agent: "ops", task: OPS_BRIEF }))?.block, true);
  completed("run-b");
  assert.equal((await launch("3", { agent: "ops", task: OPS_BRIEF }))?.block ?? false, false);
});

test("root ops: a launch that ends in error releases its surface; one with no run id never does", async () => {
  const { launch, end, ctx } = opsRoot(OPS_FILE);
  await launch("1", { agent: "ops", task: OPS_BRIEF });
  end({ type: "tool_execution_end", toolCallId: "1", toolName: "subagent", isError: true, result: { content: [], details: {} } }, ctx);
  assert.equal((await launch("2", { agent: "ops", task: OPS_BRIEF }))?.block ?? false, false);
  end({ type: "tool_execution_end", toolCallId: "2", toolName: "subagent", isError: false, result: { content: [], details: {} } }, ctx);
  assert.equal((await launch("3", { agent: "ops", task: OPS_BRIEF }))?.block, true);
});

test("root ops: a model-supplied binding is replaced on a single launch and dropped on any other shape", async (t) => {
  const previousRunDir = process.env.LOOP_PI_RUN_DIR;
  t.after(() => {
    if (previousRunDir === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previousRunDir;
  });
  // This fixture exercises the binding without a loop run dir, regardless of its caller.
  delete process.env.LOOP_PI_RUN_DIR;
  const { launch } = opsRoot(OPS_FILE);
  const forged = { "loop-pi.guard/1": { agent: "ops", surface: "deploy:svc-worker", entry: OPS_ENTRY } };
  const single: Record<string, unknown> = { agent: "lane-worker", task: "x", extensionBindings: forged };
  assert.equal((await launch("1", single))?.block ?? false, false);
  assert.deepEqual(single.extensionBindings, { "loop-pi.guard/1": { agent: "lane-worker" } });
  const management: Record<string, unknown> = { action: "status", id: "run-a", extensionBindings: forged };
  assert.equal((await launch("2", management))?.block ?? false, false);
  assert.equal(management.extensionBindings, undefined);
});
