// Protocol 2 refusals (SEAMS S0, S1, S8) at the extension entries: root.ts and lane.ts driven
// through a fake ExtensionAPI, with a scratch run dir. Every refusal here applies only when the run
// dir carries `loop-pi-proto`; the legacy cases pin that a run without it keeps today's verdict.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import rootExtension from "./root.ts";
import laneExtension from "./lane.ts";
import { HOOK_TEMPLATES_DIR } from "../test-support/hook-templates.ts";

type Handler = (event: any, ctx: any) => any;

let scratch: string;
let agentDir: string;
let runDir: string;
let legacyRunDir: string;
let cwd: string;
const AUTHORITY_FILE = join(homedir(), "repos", "agent-docs", "authority", "owner__repo.md");

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "loop-guard-proto-test-"));
  agentDir = join(scratch, "agent");
  runDir = join(scratch, "runs", "20261004T000000Z-repo-abc");
  legacyRunDir = join(scratch, "runs", "20261004T000000Z-repo-legacy");
  cwd = join(scratch, "repo");
  await mkdir(runDir, { recursive: true });
  await mkdir(legacyRunDir, { recursive: true });
  await mkdir(join(cwd, "codex"), { recursive: true });
  await writeFile(join(runDir, "loop-pi-proto"), "2\n");
  await cp(HOOK_TEMPLATES_DIR, join(agentDir, "scripts"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

beforeEach(() => {
  process.env.LOOP_PI_RUN_DIR = runDir;
  delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
});

after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.LOOP_PI_RUN_DIR;
  delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  await rm(scratch, { recursive: true, force: true });
});

function fakeApi() {
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => {};
      },
      emit(channel: string, data: unknown) {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    },
  };
  return { api, handlers };
}

const ctx = () => ({ cwd, ui: { notify: () => {} }, sessionManager: { getSessionId: () => "proto-session" } });

async function fire(handlers: Map<string, Handler[]>, event: string, payload: Record<string, unknown>) {
  let last: any;
  for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...payload }, ctx());
  return last;
}

function root() {
  const { api, handlers } = fakeApi();
  rootExtension(api as any);
  let n = 0;
  const call = (toolName: string, input: Record<string, unknown>) => fire(handlers, "tool_call", { toolCallId: `c${++n}`, toolName, input });
  return { handlers, call, fire: (event: string, payload: Record<string, unknown> = {}) => fire(handlers, event, payload) };
}

function lane(binding: unknown) {
  if (binding === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify(binding);
  const { api, handlers } = fakeApi();
  laneExtension(api as any);
  return (toolName: string, input: Record<string, unknown>) => fire(handlers, "tool_call", { toolCallId: "l1", toolName, input });
}

const blocked = (result: any) => result?.block === true;

// --- root: edit/write into the run dir and the authority registry -------------------------------

test("proto root: edit and write into the run dir are refused, through any spelling of the path", async () => {
  const r = root();
  await symlink(runDir, join(scratch, "run-link"));
  const real = await realpath(runDir);
  for (const [tool, path] of [
    ["write", join(runDir, "push-log.jsonl")],
    ["edit", join(runDir, "loop-pi-proto")],
    ["write", join(real, "audit-grants.json")],
    ["write", join(scratch, "run-link", "harness-facts.jsonl")],
    ["write", join(runDir, "returns", "run-1.md")],
    ["write", `@${join(runDir, "worktrees", "notes.md")}`],
  ]) {
    const result = await r.call(tool, { path, content: "x", edits: [] });
    assert.equal(blocked(result), true, `${tool} ${path}`);
    assert.match(result.reason, /run dir/);
  }
});

test("proto: files inside a lane worktree under the run dir (S9) stay writable for root and lanes", async () => {
  const inWorktree = join(runDir, "worktrees", "L1", "src", "x.ts");
  const r = root();
  const rootWrite = await r.call("write", { path: inWorktree, content: "x" });
  assert.equal(blocked(rootWrite), false, rootWrite?.reason);
  const call = lane({ "loop-pi.guard/1": { agent: "lane-worker", runDir } });
  assert.equal(blocked(await call("write", { path: inWorktree, content: "x" })), false);
  assert.equal(blocked(await call("bash", { command: `echo x > ${inWorktree}` })), false);
  // A link inside a worktree that points at a harness file is still the harness file.
  await mkdir(join(runDir, "worktrees", "L1"), { recursive: true });
  await symlink(join(runDir, "push-log.jsonl"), join(runDir, "worktrees", "L1", "log-link"));
  assert.equal(blocked(await call("write", { path: join(runDir, "worktrees", "L1", "log-link"), content: "x" })), true);
});

test("proto root: edit and write into the authority registry are refused (~ and absolute)", async () => {
  const r = root();
  for (const path of ["~/repos/agent-docs/authority/owner__repo.md", AUTHORITY_FILE]) {
    const result = await r.call("write", { path, content: "x" });
    assert.equal(blocked(result), true, path);
    assert.match(result.reason, /authority/);
  }
});

test("proto root: edit and write into codex/ops-*, grants-*, launch-* and goal-* are refused, through any spelling", async () => {
  const r = root();
  await mkdir(join(scratch, "links"), { recursive: true });
  await symlink(join(cwd, "codex"), join(scratch, "links", "codex-link"));
  for (const [tool, path] of [
    ["write", "codex/ops-2026-10-04-loop3.json"],
    ["edit", "codex/grants-2026-10-04-loop3.json"],
    ["write", join(cwd, "codex", "launch-2026-10-04-loop3.txt")],
    ["edit", `@${join(cwd, "codex", "goal-2026-10-04-loop3.md")}`],
    ["write", join(cwd, "codex", "GOAL-2026-10-04-loop3.md")],
    ["write", join(scratch, "links", "codex-link", "goal-2026-10-04-loop3.md")],
  ]) {
    const result = await r.call(tool, { path, content: "x", edits: [] });
    assert.equal(blocked(result), true, `${tool} ${path}`);
    assert.match(result.reason, /root may not write/, path);
  }
  const bash = await r.call("bash", { command: "echo x > codex/goal-2026-10-04-loop3.md" });
  assert.equal(blocked(bash), true);
  assert.match(bash.reason, /root may not write/);
  for (const path of ["codex/state-2026-10-04-loop3.jsonl", "codex/report-2026-10-04-loop3.md", "codex/notes-goal.md"]) {
    const result = await r.call("write", { path, content: "x" });
    assert.equal(blocked(result), false, `${path}: ${result?.reason}`);
  }
  process.env.LOOP_PI_RUN_DIR = legacyRunDir;
  const legacy = root();
  for (const path of ["codex/goal-2026-10-04-loop3.md", "codex/ops-2026-10-04-loop3.json"]) {
    const result = await legacy.call("write", { path, content: "x" });
    assert.equal(blocked(result), false, `legacy ${path}: ${result?.reason}`);
  }
});

test("proto root: writes elsewhere stay allowed", async () => {
  const r = root();
  for (const path of ["codex/report-repo-loop1.md", join(scratch, "runs", "other.md"), "LOOP.md"]) {
    const result = await r.call("write", { path, content: "x" });
    assert.equal(blocked(result), false, `${path}: ${result?.reason}`);
  }
});

test("legacy root (no marker, or no run dir): the same writes keep today's verdict", async () => {
  for (const env of [legacyRunDir, undefined]) {
    if (env === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = env;
    const r = root();
    for (const path of [join(env ?? runDir, "push-log.jsonl"), AUTHORITY_FILE]) {
      const result = await r.call("write", { path, content: "x" });
      assert.equal(blocked(result), false, `${env}: ${path}: ${result?.reason}`);
    }
  }
});

// --- root: bash --------------------------------------------------------------------------------

test("proto root: a bash timeout over 900 s is refused and points at watch_start", async () => {
  const r = root();
  const long = await r.call("bash", { command: "just test", timeout: 901 });
  assert.equal(blocked(long), true);
  assert.match(long.reason, /watch_start/);
  assert.equal(blocked(await r.call("bash", { command: "just test", timeout: 900 })), false);
  assert.equal(blocked(await r.call("bash", { command: "just test" })), false);
});

test("legacy root: a long bash timeout keeps today's verdict", async () => {
  process.env.LOOP_PI_RUN_DIR = legacyRunDir;
  assert.equal(blocked(await root().call("bash", { command: "just test", timeout: 14400 })), false);
});

test("proto root: bash loop-state with --by ext and a redirect into the run dir are refused", async () => {
  const r = root();
  const by = await r.call("bash", { command: "loop-state append codex/state-repo-loop1.jsonl land task=T-1 --by ext" });
  assert.equal(blocked(by), true);
  assert.match(by.reason, /--by/);
  const redirect = await r.call("bash", { command: `echo '{}' >> ${runDir}/push-log.jsonl` });
  assert.equal(blocked(redirect), true);
  const viaEnv = await r.call("bash", { command: "echo 2 > $LOOP_PI_RUN_DIR/loop-pi-proto" });
  assert.equal(blocked(viaEnv), true);
  assert.equal(blocked(await r.call("bash", { command: `cat ${runDir}/push-log.jsonl` })), false);
  process.env.LOOP_PI_RUN_DIR = legacyRunDir;
  assert.equal(blocked(await root().call("bash", { command: "loop-state append codex/state-repo-loop1.jsonl land task=T-1 --by ext" })), false);
});

// --- root: subagent status polling ---------------------------------------------------------------

test("proto root: a repeated subagent status with no wake since the last one is refused", async () => {
  const r = root();
  assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), false);
  const again = await r.call("subagent", { action: "status", id: "run-a" });
  assert.equal(blocked(again), true);
  assert.match(again.reason, /wake/);
  // Another run is its own first probe (re-probing every live lane after a resume).
  assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-b" })), false);
  assert.equal(blocked(await r.call("subagent", { action: "status" })), false);
  assert.equal(blocked(await r.call("subagent", { action: "status" })), true);
});

for (const [name, event, payload] of [
  ["a lane return (subagent-notify)", "message_end", { message: { role: "custom", customType: "subagent-notify", content: "done" } }],
  ["a loop-watch", "message_end", { message: { role: "custom", customType: "loop-watch", content: "exit" } }],
  ["a loop-wake", "message_end", { message: { role: "custom", customType: "loop-wake", content: "timer" } }],
  ["user input", "input", { text: "status?", source: "interactive" }],
  ["session start", "session_start", { reason: "resume" }],
  ["compaction", "session_compact", {}],
] as [string, string, Record<string, unknown>][]) {
  test(`proto root: ${name} is a wake that allows the next status call`, async () => {
    const r = root();
    assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), false);
    assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), true);
    await r.fire(event, payload);
    assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), false, name);
  });
}

test("proto root: a nudge or an unrelated custom message is not a wake", async () => {
  const r = root();
  await r.call("subagent", { action: "status", id: "run-a" });
  await r.fire("message_end", { message: { role: "custom", customType: "loop-continuation", content: "nudge" } });
  await r.fire("message_end", { message: { role: "assistant", content: [] } });
  assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), true);
});

test("legacy root: repeated status calls keep today's verdict", async () => {
  process.env.LOOP_PI_RUN_DIR = legacyRunDir;
  const r = root();
  for (let i = 0; i < 3; i++) assert.equal(blocked(await r.call("subagent", { action: "status", id: "run-a" })), false);
});

// --- root: binding runDir ------------------------------------------------------------------------

test("root binds the run dir into a lane's identity when LOOP_PI_RUN_DIR is set", async () => {
  const r = root();
  const input: Record<string, unknown> = { agent: "lane-worker-push", task: "Lane: L1 · Task: T-1 · Tier: routine" };
  assert.equal(blocked(await r.call("subagent", input)), false);
  assert.deepEqual(input.extensionBindings, { "loop-pi.guard/1": { agent: "lane-worker-push", runDir } });
});

// --- lanes -------------------------------------------------------------------------------------

test("proto lane (run dir from the binding): run dir, authority and codex/grants-* writes are refused", async () => {
  delete process.env.LOOP_PI_RUN_DIR;
  const call = lane({ "loop-pi.guard/1": { agent: "lane-worker", runDir } });
  for (const [tool, path, reason] of [
    ["write", join(runDir, "push-log.jsonl"), /run dir/],
    ["edit", join(runDir, "returns", "x.md"), /run dir/],
    ["write", "~/repos/agent-docs/authority/owner__repo.md", /authority/],
    ["write", "codex/grants-2026-10-04-loop3.json", /grants/],
    ["edit", join(cwd, "codex", "GRANTS-2026-10-04-loop3.json"), /grants/],
  ] as [string, string, RegExp][]) {
    const result = await call(tool, { path, content: "x", edits: [] });
    assert.equal(blocked(result), true, `${tool} ${path}`);
    assert.match(result.reason, reason, path);
  }
  for (const command of [`echo x > ${runDir}/push-log.jsonl`, "echo x > $LOOP_PI_RUN_DIR/push-log.jsonl", "cp /tmp/g.json codex/grants-2026-10-04-loop3.json", "gh pr merge 12 --squash"]) {
    const result = await call("bash", { command });
    assert.equal(blocked(result), true, command);
  }
  const loopMd = await call("write", { path: "LOOP.md", content: "x" });
  assert.equal(blocked(loopMd), false, `LOOP.md stays writable by lanes: ${loopMd?.reason}`);
  assert.equal(blocked(await call("bash", { command: "echo x > LOOP.md" })), false);
});

test("proto lane (run dir from the environment): the same refusals apply without a binding run dir", async () => {
  const call = lane({ "loop-pi.guard/1": { agent: "lane-worker" } });
  assert.equal(blocked(await call("write", { path: join(runDir, "push-log.jsonl"), content: "x" })), true);
  assert.equal(blocked(await call("write", { path: "codex/grants-2026-10-04-loop3.json", content: "x" })), true);
});

test("legacy lane (no marker, or no run dir anywhere): the same writes keep today's verdict", async () => {
  for (const [env, binding] of [
    [legacyRunDir, { "loop-pi.guard/1": { agent: "lane-worker" } }],
    [undefined, { "loop-pi.guard/1": { agent: "lane-worker" } }],
    [undefined, undefined],
  ] as [string | undefined, unknown][]) {
    if (env === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = env;
    const call = lane(binding);
    for (const path of ["codex/grants-2026-10-04-loop3.json", AUTHORITY_FILE, join(env ?? legacyRunDir, "push-log.jsonl")]) {
      const result = await call("write", { path, content: "x" });
      assert.equal(blocked(result), false, `${env} ${JSON.stringify(binding)} ${path}: ${result?.reason}`);
    }
    assert.equal(blocked(await call("bash", { command: "gh pr merge 12 --squash" })), false);
  }
});
