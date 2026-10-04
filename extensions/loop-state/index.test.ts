// Drives index.ts through a fake ExtensionAPI against the real bin/loop-state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import loopState from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const BIN = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));
const dirs: string[] = [];
let agentDir: string;
let savedPath: string | undefined;

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "loop-state-agent-"));
  dirs.push(agentDir);
  mkdirSync(join(agentDir, "bin"));
  symlinkSync(BIN, join(agentDir, "bin", "loop-state"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): { repo: string; head: string; log: string; report: string } {
  const repo = mkdtempSync(join(tmpdir(), "loop-state-repo-"));
  dirs.push(repo);
  mkdirSync(join(repo, "codex"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "f"), "x");
  git("add", "--", "f");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init", "--", "f");
  return {
    repo,
    head: git("rev-parse", "HEAD").trim(),
    log: join(repo, "codex", "state-camp-loop1.jsonl"),
    report: join(repo, "codex", "report-camp-loop1.md"),
  };
}

function harness(opts: { reportPath?: string | null; cwd: string; sessionId?: string }) {
  const handlers = new Map<string, Handler>();
  const bus = new Map<string, ((d: unknown) => void)[]>();
  const sent: { message: any; options: any }[] = [];
  const notes: { message: string; type?: string }[] = [];
  const api = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    sendMessage: (message: unknown, options: unknown) => void sent.push({ message, options }),
    events: {
      on: (channel: string, handler: (d: unknown) => void) => {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => undefined;
      },
      emit: (channel: string, data: unknown) => (bus.get(channel) ?? []).forEach((h) => h(data)),
    },
  };
  if (opts.reportPath !== null) {
    api.events.on("loop-continuation:query-launch", (d) =>
      (d as { reply: (r: unknown) => void }).reply({ reportPath: opts.reportPath, opsPath: null, ops: null }),
    );
  }
  loopState(api as any);
  const ctx = {
    cwd: opts.cwd,
    ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
    sessionManager: { getSessionId: () => "sess-id", getSessionFile: () => opts.sessionId ?? "/homes/sessions/sess-1.jsonl" },
  };
  return {
    sent,
    notes,
    ctx,
    start: () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    compact: () => handlers.get("session_compact")!({ type: "session_compact" }, ctx),
    call: (toolCallId: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ type: "tool_call", toolCallId, toolName: "subagent", input }, ctx),
    result: (toolCallId: string, text: string, details: unknown = undefined, isError = false) =>
      handlers.get("tool_result")!(
        { type: "tool_result", toolCallId, toolName: "subagent", input: {}, content: [{ type: "text", text }], details, isError },
        ctx,
      ),
    emit: api.events.emit,
    on: api.events.on,
  };
}

async function until<T>(poll: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = poll();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the log");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function events(log: string): Record<string, any>[] {
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

const SESS = "/homes/sessions/sess-1.jsonl";
const BRIEF = "Lane: L1 · Task: T1 · Tier: routine\nObjective: do it\nDeadline: 2026-10-03T12:00:00Z";
const LANE_RETURN = (status: string) =>
  `All done.\n\`\`\`lane-return\n{"v":2,"lane":"L1","status":"${status}","sha":null,"landed":false,"base":"b","check":"just check","exit":0,"tail":"ok","ci":null,"coderabbit":{"ran":true,"major":0,"unreviewed":0},"questions":[]}\n\`\`\``;

test("dispatch then return are appended with by=ext, base from git and the lane-return fields", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  assert.equal(h.call("tc1", { agent: "lane-worker", task: BRIEF }), undefined);
  h.emit("subagent:async-started", { id: "run1", sessionId: SESS, agent: "lane-worker", deadlineAt: Date.UTC(2026, 9, 3, 11, 30, 0) });
  h.result("tc1", "Async: lane-worker [run1]\nrunning", { mode: "single", runId: "run1" });
  h.emit("subagent:async-complete", {
    runId: "run1", sessionId: SESS, toolCallId: "tc1", success: true,
    results: [{ agent: "lane-worker", status: "completed", summary: LANE_RETURN("complete") }],
  });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.equal(log[0].ev, "dispatch");
  assert.deepEqual(
    { by: log[0].by, lane: log[0].lane, task: log[0].task, agent: log[0].agent, run: log[0].run, base: log[0].base, deadline: log[0].deadline },
    { by: "ext", lane: "L1", task: "T1", agent: "lane-worker", run: "run1", base: r.head, deadline: "2026-10-03T11:30:00Z" },
  );
  assert.equal(log[1].ev, "return");
  assert.deepEqual(
    { by: log[1].by, lane: log[1].lane, run: log[1].run, status: log[1].status, sha: log[1].sha, exit: log[1].exit, check: log[1].check },
    { by: "ext", lane: "L1", run: "run1", status: "complete", sha: null, exit: 0, check: "just check" },
  );
  assert.equal(log[1].tail, undefined);
  assert.equal(execFileSync(BIN, ["check", r.log]).length, 0);
  assert.deepEqual(h.notes, []);
});

test("the run id is read from the launch text when details carry none, and Deadline comes from the brief", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.result("tc1", "Async: lane-worker [abc123]");
  const log = await until(() => events(r.log).length >= 1 && events(r.log));
  assert.equal(log[0].run, "abc123");
  assert.equal(log[0].deadline, "2026-10-03T12:00:00Z");
});

test("a completion that beats its launch result is flushed after the dispatch", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.emit("subagent:async-complete", {
    runId: "run1", sessionId: SESS,
    results: [{ status: "failed", summary: "crashed, no block" }],
  });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.deepEqual(log.map((e) => e.ev), ["dispatch", "return"]);
  assert.equal(log[1].status, "failed");
});

test("a run pi-subagents calls completed but that returned no lane-return block is recorded failed", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  h.emit("subagent:async-complete", { runId: "run1", sessionId: SESS, success: true, results: [{ status: "completed", summary: "All done, trust me." }] });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.equal(log[1].ev, "return");
  assert.equal(log[1].status, "failed");
});

test("a run that failed or timed out is recorded failed whatever its lane-return block says, keeping its landed claim", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  const block = LANE_RETURN("complete").replace('"sha":null,"landed":false', '"sha":"abc1234","landed":true');
  h.emit("subagent:async-complete", { runId: "run1", sessionId: SESS, success: false, results: [{ success: false, timedOut: true, output: block }] });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.equal(log[1].ev, "return");
  assert.equal(log[1].status, "failed");
  assert.equal(log[1].landed, true, "the landed claim stays, so the digest does not re-admit the task");
  assert.equal(log[1].sha, "abc1234", "the reported SHA stays as evidence");
  const digest = JSON.parse(execFileSync(BIN, ["digest", r.log, "--json"], { encoding: "utf8" }));
  assert.equal(digest.admissible.includes("T1"), false, "a task whose failed lane may have pushed is not admissible again");
});

test("invalid lane-return fields are dropped and the rest recorded", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  h.emit("subagent:async-complete", {
    runId: "run1", sessionId: SESS,
    results: [{ status: "completed", summary: '```lane-return\n{"v":2,"status":"blocked","landed":"maybe","questions":["q"]}\n```' }],
  });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.equal(log[1].status, "blocked");
  assert.equal(log[1].landed, undefined);
  assert.deepEqual(log[1].questions, ["q"]);
});

test("a brief without the header, another session's run, and an unknown launch write nothing", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "mapper", task: "Objective: look around" });
  h.result("tc1", "Async: mapper [run9]", { runId: "run9" });
  h.call("tc2", { agent: "lane-worker", task: BRIEF });
  h.emit("subagent:async-complete", { runId: "run2", sessionId: "/homes/sessions/other.jsonl", results: [{ status: "completed", summary: "x" }] });
  h.emit("subagent:async-complete", { runId: "run9", sessionId: SESS, results: [{ status: "completed", summary: "x" }] });
  await new Promise((r2) => setTimeout(r2, 500));
  assert.deepEqual(events(r.log), []);
});

test("without a launch (query-launch unanswered) nothing is written and nothing throws", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: null, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  await new Promise((r2) => setTimeout(r2, 500));
  assert.deepEqual(events(r.log), []);
  assert.deepEqual(h.notes, []);
});

test("a failing append warns and leaves the tool call untouched", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: join(r.repo, "no-such-dir", "codex", "report-x-loop1.md"), cwd: r.repo });
  // An unwritable log directory makes the CLI fail.
  writeFileSync(join(r.repo, "no-such-dir"), "a file where a directory should be");
  h.start();
  assert.equal(h.call("tc1", { agent: "lane-worker", task: BRIEF }), undefined);
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  const note = await until(() => h.notes[0]);
  assert.equal(note.type, "warning");
  assert.match(note.message, /dispatch for run run1 not recorded/);
});

test("session_compact injects the digest as a custom message without triggering a turn", async () => {
  const r = makeRepo();
  execFileSync(BIN, ["append", r.log, "open", "goal_sha256=" + "a".repeat(64), "tier=routine", "root=llm", "root_model=m", 'envelope=["T1"]']);
  execFileSync(BIN, ["append", r.log, "admit", "task=T1", "source=envelope", "owned=x", "accept=ok"]);
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  const first = await until(() => h.sent[0]);
  assert.equal(first.message.customType, "loop-state-digest", "session_start injects when the log exists");
  h.compact();
  const second = await until(() => h.sent[1]);
  assert.equal(second.message.customType, "loop-state-digest");
  assert.match(second.message.content, /# Loop state/);
  assert.match(second.message.content, /## Admissible \(1\)\nT1/);
  assert.equal(second.options.triggerTurn, false);
});

test("no digest is injected when the log does not exist", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.compact();
  await new Promise((r2) => setTimeout(r2, 500));
  assert.deepEqual(h.sent, []);
});

// A run id dispatched again after an unrecorded dispatch must not inherit that attempt's started
// deadline or its early completion.
test("a dispatch skipped for want of a launch leaves no started deadline behind", async () => {
  const r = makeRepo();
  let reportPath: string | null = null;
  const h = harness({ reportPath: null, cwd: r.repo });
  h.on("loop-continuation:query-launch", (d) => (d as { reply: (x: unknown) => void }).reply({ reportPath, opsPath: null, ops: null }));
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.emit("subagent:async-started", { id: "run1", sessionId: SESS, deadlineAt: Date.UTC(2026, 9, 3, 11, 30, 0) });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  await new Promise((r2) => setTimeout(r2, 300));
  assert.deepEqual(events(r.log), []);
  reportPath = r.report;
  h.call("tc2", { agent: "lane-worker", task: BRIEF });
  h.result("tc2", "Async: lane-worker [run1]", { runId: "run1" });
  const log = await until(() => events(r.log).length >= 1 && events(r.log));
  assert.equal(log[0].deadline, "2026-10-03T12:00:00Z", "the brief's Deadline, not the skipped attempt's");
});

test("a dispatch whose append fails leaves no started deadline or pending completion behind", async () => {
  const r = makeRepo();
  const blocker = join(r.repo, "no-such-dir");
  const h = harness({ reportPath: join(blocker, "codex", "report-x-loop1.md"), cwd: r.repo });
  writeFileSync(blocker, "a file where a directory should be");
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.emit("subagent:async-started", { id: "run1", sessionId: SESS, deadlineAt: Date.UTC(2026, 9, 3, 11, 30, 0) });
  h.emit("subagent:async-complete", { runId: "run1", sessionId: SESS, results: [{ status: "failed", summary: "early" }] });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  await until(() => h.notes.find((n) => /dispatch for run run1 not recorded/.test(n.message)));
  rmSync(blocker);
  mkdirSync(join(blocker, "codex"), { recursive: true });
  const log = join(blocker, "codex", "state-x-loop1.jsonl");
  h.call("tc2", { agent: "lane-worker", task: BRIEF });
  h.result("tc2", "Async: lane-worker [run1]", { runId: "run1" });
  const written = await until(() => events(log).length >= 1 && events(log));
  await new Promise((r2) => setTimeout(r2, 500));
  assert.deepEqual(events(log).map((e) => e.ev), ["dispatch"], "the failed attempt's completion is not flushed");
  assert.equal(written[0].deadline, "2026-10-03T12:00:00Z", "the brief's Deadline, not the failed attempt's");
});

test("a recorded dispatch drops its started deadline, so a later dispatch of the run id does not reuse it", async () => {
  const r = makeRepo();
  const h = harness({ reportPath: r.report, cwd: r.repo });
  h.start();
  h.call("tc1", { agent: "lane-worker", task: BRIEF });
  h.emit("subagent:async-started", { id: "run1", sessionId: SESS, deadlineAt: Date.UTC(2026, 9, 3, 11, 30, 0) });
  h.result("tc1", "Async: lane-worker [run1]", { runId: "run1" });
  const first = await until(() => events(r.log).length >= 1 && events(r.log));
  assert.equal(first[0].deadline, "2026-10-03T11:30:00Z");
  h.call("tc2", { agent: "lane-worker", task: BRIEF });
  h.result("tc2", "Async: lane-worker [run1]", { runId: "run1" });
  const log = await until(() => events(r.log).length >= 2 && events(r.log));
  assert.equal(log[1].deadline, "2026-10-03T12:00:00Z", "the brief's Deadline, not the earlier dispatch's");
});
