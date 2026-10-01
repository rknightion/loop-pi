// Integration-style tests for lane.ts, mirroring root.test.ts's approach: wire
// the real extension factory against a fake ExtensionAPI/ExtensionContext and
// drive the captured "tool_call" handler directly.
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import laneExtension from "./lane.ts";
import { HOOK_TEMPLATES_DIR } from "../test-support/hook-templates.ts";

// The guard scripts to lay out in a scratch <agentDir>/scripts/: this checkout's shared guards
// when it carries them, else the sample guards in test-support (see hook-templates.ts).
const TEMPLATES_DIR = HOOK_TEMPLATES_DIR;

type Handler = (event: any, ctx: any) => any;

function fakeApi() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  return { api, handlers };
}

function fakeCtx(cwd: string) {
  return { cwd, ui: { notify: () => {} } };
}

let agentDir: string;

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "loop-guard-lane-test-"));
  await cp(TEMPLATES_DIR, join(agentDir, "scripts"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

function toolCallHandler(handlers: Map<string, Handler[]>): Handler {
  const list = handlers.get("tool_call");
  assert.ok(list && list.length === 1, "lane.ts must register exactly one tool_call handler");
  return list[0];
}

test("lane tool_call: blocks a forbidden bash command (force push)", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git push --force" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
});

test("lane tool_call: blocks a lane-only forbidden command (gh secret set)", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "gh secret set X --body y" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
});

test("lane tool_call: allows an ordinary bash command", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git status" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block ?? false, false);
});

test("lane tool_call: a bound push-granted identity allows a plain non-force git push", async () => {
  const { api, handlers } = fakeApi();
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  try {
    process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "loop-pi.guard/1": { agent: "lane-worker-push" } });
    laneExtension(api as any);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
  }
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git push" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block ?? false, false);
});

test("lane tool_call: allows a harmless unparseable command (fallback scan, no fail-closed)", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "echo 'unterminated" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block ?? false, false);
});

test("lane tool_call: blocks an unparseable command whose text contains nohup", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "nohup ./x.sh 'unterminated" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
});

test("lane tool_call: watch_process runs the same shell-command gate as bash", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const forbidden = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "watch_process", input: { command: "nohup ./x &" } },
    fakeCtx(agentDir),
  );
  assert.equal(forbidden?.block, true);
  const allowed = await handler(
    { type: "tool_call", toolCallId: "2", toolName: "watch_process", input: { command: "npm test" } },
    fakeCtx(agentDir),
  );
  assert.equal(allowed?.block ?? false, false);
  const noGrantPush = await handler(
    { type: "tool_call", toolCallId: "3", toolName: "watch_process", input: { command: "git push" } },
    fakeCtx(agentDir),
  );
  assert.equal(noGrantPush?.block, true);
  assert.match(noGrantPush?.reason ?? "", /push requires a push-granted lane identity/);
});

test("lane tool_call: hook script denial blocks bash even when rules.ts allows it", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "backlog task edit hrn-1 --notes hi" } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /append-notes/);
});

test("lane tool_call: edit to a CLI-owned backlog path is blocked via the hook script", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: `${agentDir}/backlog/tasks/task-1.md` } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
});

test("lane tool_call: adapter failure (missing hook script) blocks the call for lanes", async () => {
  const brokenDir = await mkdtemp(join(tmpdir(), "loop-guard-lane-broken-"));
  try {
    process.env.PI_CODING_AGENT_DIR = brokenDir; // no scripts/ dir at all, but both are required
    await writeFile(join(brokenDir, "settings.json"),
      JSON.stringify({ loopPi: { requiredHookScripts: ["backlog-guard.py", "staging-guard.py"] } }), "utf8");
    const { api, handlers } = fakeApi();
    laneExtension(api as any);
    const handler = toolCallHandler(handlers);
    const result = await handler(
      { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } },
      fakeCtx(brokenDir),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /hook adapter failure blocks lanes/);
    const edit = await handler(
      { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: `${brokenDir}/README.md` } },
      fakeCtx(brokenDir),
    );
    assert.equal(edit?.block, true);
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await rm(brokenDir, { recursive: true, force: true });
  }
});

test("lane tool_call: absent guard scripts that are not required do not block", async () => {
  const bareDir = await mkdtemp(join(tmpdir(), "loop-guard-lane-bare-"));
  try {
    process.env.PI_CODING_AGENT_DIR = bareDir; // no scripts/ dir and no settings.json
    const { api, handlers } = fakeApi();
    laneExtension(api as any);
    const handler = toolCallHandler(handlers);
    for (const [toolName, input] of [["bash", { command: "ls" }], ["edit", { path: `${bareDir}/README.md` }]] as const) {
      const result = await handler({ type: "tool_call", toolCallId: "1", toolName, input }, fakeCtx(bareDir));
      assert.equal(result?.block ?? false, false, toolName);
    }
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await rm(bareDir, { recursive: true, force: true });
  }
});

test("lane.ts does not register subagent/watch_start/bg_wait root-only rules", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  // subagent, watch_start and bg_wait are not among the toolName branches
  // lane.ts checks; the handler must return undefined (allow-through) rather
  // than a root-only verdict, since those tools are not part of a lane's
  // resolved tool set in the first place (SEAMS.md "Names and paths").
  for (const toolName of ["subagent", "watch_start", "bg_wait"]) {
    const result = await handler({ type: "tool_call", toolCallId: "1", toolName, input: {} }, fakeCtx(agentDir));
    assert.equal(result, undefined, `lane.ts must not special-case ${toolName}`);
  }
});

test("lane: a subagent call naming a model outside the gpt-6 family is blocked", async () => {
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  const handler = toolCallHandler(handlers);
  const result = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "subagent", input: { tasks: [{ agent: "mapper", model: "gpt-5.6-sol" }] } },
    fakeCtx(agentDir),
  );
  assert.equal(result?.block, true);
  assert.ok(handlers.get("before_provider_request")?.length === 1 && handlers.get("model_select")?.length === 1);
});
