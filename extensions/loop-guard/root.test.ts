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

test("root tool_call: subagent launch outside the roster is blocked", async () => {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  const handler = toolCallHandler(handlers);
  const { ctx } = fakeCtx(agentDir);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "mapper", task: "recon" } },
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
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "scout", task: "recon" } },
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
  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "scout", task: "x" } }, ctx);

  const result = await handler({ type: "tool_call", toolCallId: "2", toolName: "watch_process", input: { command: "ls" } }, ctx);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /async subagent run is active/);
});

test("root tool_call: watch_process allowed again once its run's async-complete arrives", async () => {
  // A held root's subagent-notify reaches no extension message event, so only the completion
  // event can release the run.
  const fake = fakeApi();
  rootExtension(fake.api as any);
  const toolExecStart = fake.handlers.get("tool_execution_start")![0];
  const toolExecEnd = fake.handlers.get("tool_execution_end")![0];
  const handler = toolCallHandler(fake.handlers);
  const { ctx } = fakeCtx(agentDir);
  const watch = () => handler({ type: "tool_call", toolCallId: "w", toolName: "watch_process", input: { command: "ls" } }, ctx);

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "scout", task: "x" } }, ctx);
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

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "scout", task: "x" } }, ctx);
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

  toolExecStart({ type: "tool_execution_start", toolCallId: "1", toolName: "subagent", args: { agent: "scout", task: "x" } }, ctx);
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
  toolExecStart({ type: "tool_execution_start", toolCallId: "a", toolName: "subagent", args: { agent: "scout", task: "x" } }, ctx);
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
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "scout", task: "recon" } },
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
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "scout", task: "x", model: "openai/gpt-5.6-luna" } },
    ctx,
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /gpt-6 family route/);
  let payload: any = { model: "gpt-5.6-sol" };
  for (const listener of handlers.get("before_provider_request") ?? []) {
    payload = (await listener({ payload }, { model: { provider: "openai", id: "gpt-5.6-sol" } })) ?? payload;
  }
  assert.equal(payload.model, "loop-pi-refused:gpt-5.6-sol");
});

// ---------------------------------------------------------------------------
// Lane identity binding: the root replaces any model-supplied binding.
// ---------------------------------------------------------------------------

test("root: a model-supplied binding is replaced on a single launch and dropped on any other shape", async (t) => {
  const previousRunDir = process.env.LOOP_PI_RUN_DIR;
  t.after(() => {
    if (previousRunDir === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previousRunDir;
  });
  // This fixture exercises the binding without a loop run dir, regardless of its caller.
  delete process.env.LOOP_PI_RUN_DIR;
  const fake = fakeApi();
  rootExtension(fake.api as any);
  const { ctx } = fakeCtx(agentDir);
  const handler = toolCallHandler(fake.handlers);
  const launch = (toolCallId: string, input: Record<string, unknown>) =>
    handler({ type: "tool_call", toolCallId, toolName: "subagent", input }, ctx);
  const forged = { "loop-pi.guard/1": { agent: "senior", runDir: "/elsewhere" }, "spoof/1": { grant: true } };
  const single: Record<string, unknown> = { agent: "worker", task: "x", extensionBindings: forged };
  assert.equal((await launch("1", single))?.block ?? false, false);
  assert.deepEqual(single.extensionBindings, { "loop-pi.guard/1": { agent: "worker" } });
  const management: Record<string, unknown> = { action: "status", id: "run-a", extensionBindings: forged };
  assert.equal((await launch("2", management))?.block ?? false, false);
  assert.equal(management.extensionBindings, undefined);
  // pi-subagents 0.77.0 also takes extensionBindings inside `options`: strip it there on both shapes.
  const optSingle: Record<string, unknown> = { agent: "worker", task: "x", options: { extensionBindings: forged } };
  assert.equal((await launch("3", optSingle))?.block ?? false, false);
  assert.deepEqual(optSingle.extensionBindings, { "loop-pi.guard/1": { agent: "worker" } });
  assert.equal((optSingle.options as Record<string, unknown>).extensionBindings, undefined);
  const optManagement: Record<string, unknown> = { action: "status", id: "run-a", options: { extensionBindings: forged } };
  assert.equal((await launch("4", optManagement))?.block ?? false, false);
  assert.equal((optManagement.options as Record<string, unknown>).extensionBindings, undefined);
});

// ---------------------------------------------------------------------------
// Brief header: a launch whose first line the state log cannot parse is refused.
// ---------------------------------------------------------------------------

test("root: a launch whose first line fails the brief header parse is refused with the exact form (armed runs only)", async (t) => {
  const previousRunDir = process.env.LOOP_PI_RUN_DIR;
  const runDir = await mkdtemp(join(tmpdir(), "loop-guard-brief-run-"));
  t.after(async () => {
    if (previousRunDir === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previousRunDir;
    await rm(runDir, { recursive: true, force: true });
  });
  process.env.LOOP_PI_RUN_DIR = runDir;
  const { ctx } = fakeCtx(agentDir);
  const make = () => {
    const fake = fakeApi();
    rootExtension(fake.api as any);
    const handler = toolCallHandler(fake.handlers);
    return (input: Record<string, unknown>) => handler({ type: "tool_call", toolCallId: "1", toolName: "subagent", input }, ctx);
  };
  const drifted = [
    "Lane identity · Task T-387 · Tier: routine",
    "Lane x · Task Y · Tier: routine",
    "Lane: x · Tier: routine",
    "Lane: x · Task: Y · Tier: urgent",
    "Do the thing",
  ];
  const good = "Lane: w1 · Task: T-1 (add the thing) · Tier: routine\nWhy: x";

  // Without the run marker nothing is a loop brief: ordinary use is untouched.
  const unarmed = make();
  for (const task of drifted) assert.equal((await unarmed({ agent: "worker", task }))?.block ?? false, false, task);

  await writeFile(join(runDir, "loop-pi-proto"), "2\n", "utf8");
  const armed = make();
  for (const agent of ["worker", "senior", "senior-escalation", "reviewer", "scout"]) {
    for (const task of drifted) {
      const result = await armed({ agent, task });
      assert.equal(result?.block, true, `${agent}: ${task}`);
      assert.match(result?.reason ?? "", /Lane: <id> · Task: <ID> \(<title>\) · Tier: routine\|guarded/);
    }
    assert.equal((await armed({ agent, task: good }))?.block ?? false, false, agent);
    assert.equal((await armed({ agent, task: `\n\n  ${good}` }))?.block ?? false, false, `${agent}: leading blank lines`);
  }
  // The merged `options` view is read; management calls are not launches.
  assert.equal((await armed({ agent: "worker", options: { task: drifted[1] } }))?.block, true);
  assert.equal((await armed({ action: "status", id: "run-a" }))?.block ?? false, false);
  assert.equal((await armed({ action: "resume", id: "run-a", message: "carry on" }))?.block ?? false, false);
});
