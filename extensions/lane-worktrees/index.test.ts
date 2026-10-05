// lane-worktrees through a fake ExtensionAPI against real git: the launch rewrite, undo on a blocked
// launch, removal on land and park (branch deleted only when merged), and the closeout sweep.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import laneWorktrees from "./index.ts";
import { landParkEvents, parseLaneBrief, safeLaneId } from "./core.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup(opts: { marker?: boolean } = {}) {
  const repo = fresh("lw-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "codex/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-qm", "init");
  mkdirSync(join(repo, "codex"));
  const report = join(repo, "codex", "report-x-loop1.md");
  const log = join(repo, "codex", "state-x-loop1.jsonl");
  const runDir = fresh("lw-run-20261004T000000Z-");
  if (opts.marker !== false) writeFileSync(join(runDir, "loop-pi-proto"), "2\n");

  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  const handlers = new Map<string, (e: any, c: any) => any>();
  const bus = new Map<string, ((d: any) => void)[]>();
  const entries: { customType: string; data: any }[] = [];
  const notes: string[] = [];
  const api = {
    on: (n: string, h: any) => handlers.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    events: {
      on: (n: string, h: any) => {
        bus.set(n, [...(bus.get(n) ?? []), h]);
        return () => undefined;
      },
      emit: (n: string, d: any) => (bus.get(n) ?? []).forEach((h) => h(d)),
    },
  };
  api.events.on("loop-continuation:query-launch", (d: any) => d.reply({ reportPath: report }));
  laneWorktrees(api as any);
  const ctx = {
    cwd: repo,
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "s", getSessionFile: () => "/sessions/s.jsonl", getBranch: () => [] },
  };
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  let seq = 0;
  let calls = 0;
  const append = (event: Record<string, unknown>) => {
    writeFileSync(log, `${JSON.stringify({ v: 1, seq: ++seq, ts: "2026-10-04T00:00:00Z", by: "root", ...event })}\n`, { flag: "a" });
  };
  return {
    repo,
    runDir,
    log,
    entries,
    notes,
    handlers,
    emit: (n: string, d: any) => api.events.emit(n, d),
    append,
    /** A root subagent launch through tool_call; returns the (mutated) input and the call id. */
    async launch(task: string, extra: Record<string, unknown> = { isolation: "worktree" }) {
      const id = `call-${++calls}`;
      const input: Record<string, unknown> = { agent: "lane-worker", task, ...extra };
      const result = await handlers.get("tool_call")!({ type: "tool_call", toolName: "subagent", toolCallId: id, input }, ctx);
      return { id, input, result };
    },
    async end(id: string, opts: { runId?: string; isError?: boolean; toolName?: string; asyncDir?: string }) {
      const details = { ...(opts.runId ? { runId: opts.runId } : {}), ...(opts.asyncDir ? { asyncDir: opts.asyncDir } : {}) };
      await handlers.get("tool_execution_end")!(
        { type: "tool_execution_end", toolCallId: id, toolName: opts.toolName ?? "subagent", isError: opts.isError ?? false, result: { details } },
        ctx,
      );
    },
    /** A reload or resume: a new session_start over the persisted state entries. */
    reload() {
      const branch = entries.map((e) => ({ type: "custom", customType: e.customType, data: JSON.parse(JSON.stringify(e.data)) }));
      handlers.get("session_start")!({ type: "session_start", reason: "reload" }, { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => branch } });
    },
    /** The root runs `loop-state append ... land|park` in bash after `event` was appended to the log. */
    async loopState(event: Record<string, unknown>) {
      const id = `bash-${++calls}`;
      await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: id, input: { command: `loop-state append ${log} ${String(event.ev)} task=${String(event.task)}` } }, ctx);
      append(event);
      await handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: {} }, ctx);
    },
    restore() {
      if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
      else process.env.LOOP_PI_RUN_DIR = previous;
    },
    ctx,
  };
}

const brief = (lane: string, task: string, landing = "returns candidate") => `Lane: ${lane} · Task: ${task} · Tier: guarded\nLanding: ${landing}\nObjective: x`;
const branches = (repo: string) => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/loop/").split("\n").filter(Boolean);

test("a candidate launch with isolation worktree gets a loop-owned worktree, its cwd, and no isolation", async () => {
  const s = setup();
  try {
    const { input, result } = await s.launch(brief("L1", "T1"));
    const path = join(s.runDir, "worktrees", "L1");
    assert.equal(result, undefined);
    assert.equal(input.cwd, path);
    assert.equal("isolation" in input, false);
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), `loop/${basename(s.runDir)}/L1`);
    assert.equal(git(path, "rev-parse", "HEAD"), git(s.repo, "rev-parse", "HEAD"));

    const branchLanding = await s.launch(brief("L2", "T2", "pushes branch feature/x"));
    assert.equal(branchLanding.input.cwd, join(s.runDir, "worktrees", "L2"));
  } finally {
    s.restore();
  }
});

test("other launches are left alone: no isolation, an after-green landing, no brief header, no protocol marker", async () => {
  const s = setup();
  try {
    for (const [task, extra] of [
      [brief("L1", "T1"), {}],
      [brief("L1", "T1", "lands-after-green"), { isolation: "worktree" }],
      ["Objective: no header\nLanding: returns candidate", { isolation: "worktree" }],
    ] as const) {
      const { input } = await s.launch(task, { ...extra });
      assert.equal(input.cwd, undefined, task);
    }
    assert.equal(existsSync(join(s.runDir, "worktrees")), false);
  } finally {
    s.restore();
  }
  const legacy = setup({ marker: false });
  try {
    const { input } = await legacy.launch(brief("L1", "T1"));
    assert.equal(input.isolation, "worktree", "a legacy run keeps pi-subagents' own worktree");
  } finally {
    legacy.restore();
  }
});

test("a launch that is blocked after the rewrite gets its new worktree and branch removed", async () => {
  const s = setup();
  try {
    const { id } = await s.launch(brief("L1", "T1"));
    await s.end(id, { isError: true });
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), false);
    assert.deepEqual(branches(s.repo), []);
  } finally {
    s.restore();
  }
});

test("land removes the task's worktrees and deletes a merged branch; an unmerged branch is kept", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    const b = await s.launch(brief("L2", "T2"));
    await s.end(b.id, { runId: "run-2" });
    // L1's candidate is merged into main; L2's is not.
    const p1 = join(s.runDir, "worktrees", "L1");
    writeFileSync(join(p1, "one.txt"), "1");
    git(p1, "add", "one.txt");
    git(p1, "commit", "-qm", "one");
    git(s.repo, "merge", "-q", "--ff-only", `loop/${basename(s.runDir)}/L1`);
    const p2 = join(s.runDir, "worktrees", "L2");
    writeFileSync(join(p2, "two.txt"), "2");
    git(p2, "add", "two.txt");
    git(p2, "commit", "-qm", "two");

    await s.loopState({ ev: "land", task: "T1", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(p1), false);
    assert.deepEqual(branches(s.repo), [`loop/${basename(s.runDir)}/L2`]);
    await s.loopState({ ev: "land", task: "T2", sha: "y", gate: "g", mode: "after-green" });
    assert.equal(existsSync(p2), false);
    assert.deepEqual(branches(s.repo), [`loop/${basename(s.runDir)}/L2`], "unmerged: the branch is kept");
  } finally {
    s.restore();
  }
});

test("park removes the worktree and keeps the branch; a land while the lane is live waits for its run to end", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    await s.loopState({ ev: "park", task: "T1", reason: "r", needs: "owner" });
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), false);
    assert.deepEqual(branches(s.repo), [`loop/${basename(s.runDir)}/L1`]);

    const b = await s.launch(brief("L2", "T2"));
    s.emit("subagent:async-started", { id: "run-2", sessionId: "/sessions/s.jsonl" });
    await s.end(b.id, { runId: "run-2" });
    await s.loopState({ ev: "land", task: "T2", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(join(s.runDir, "worktrees", "L2")), true, "a live lane keeps its worktree");
    s.emit("subagent:async-complete", { runId: "run-2" });
    const deadline = Date.now() + 10_000;
    while (existsSync(join(s.runDir, "worktrees", "L2")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(existsSync(join(s.runDir, "worktrees", "L2")), false);
  } finally {
    s.restore();
  }
});

test("events before a worktree existed and events by others never release it", async () => {
  const s = setup();
  try {
    s.append({ ev: "park", task: "T1", reason: "earlier attempt", needs: "defect" });
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    await s.loopState({ ev: "judgement", text: "nothing" });
    writeFileSync(s.log, `${JSON.stringify({ v: 1, seq: 99, ts: "2026-10-04T00:00:00Z", by: "ext", ev: "land", task: "T1" })}\n`, { flag: "a" });
    await s.loopState({ ev: "judgement", text: "still nothing" });
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), true);
  } finally {
    s.restore();
  }
});

test("closeout removes what is left, deletes merged branches, keeps and lists unmerged and live ones", async () => {
  const s = setup();
  try {
    for (const lane of ["L1", "L2", "L3"]) {
      const l = await s.launch(brief(lane, `T-${lane}`));
      await s.end(l.id, { runId: `run-${lane}` });
    }
    const p2 = join(s.runDir, "worktrees", "L2");
    writeFileSync(join(p2, "two.txt"), "2");
    git(p2, "add", "two.txt");
    git(p2, "commit", "-qm", "two");
    s.emit("subagent:async-started", { id: "run-L3", sessionId: "/sessions/s.jsonl" });
    const lines: string[] = [];
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines, pending });
    await Promise.all(pending);
    const prefix = `loop/${basename(s.runDir)}`;
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), false);
    assert.equal(existsSync(p2), false);
    assert.equal(existsSync(join(s.runDir, "worktrees", "L3")), true, "a live lane is kept");
    assert.deepEqual(branches(s.repo).sort(), [`${prefix}/L2`, `${prefix}/L3`]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /removed 2 worktree\(s\), deleted 1 merged branch\(es\); kept unmerged: .*\/L2; kept live: L3/);
    assert.doesNotMatch(lines[0], /incident/);
  } finally {
    s.restore();
  }
});

test("a quitting session sweeps; a reload does not", async () => {
  const s = setup();
  try {
    const l = await s.launch(brief("L1", "T1"));
    await s.end(l.id, { runId: "run-1" });
    await s.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, s.ctx);
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), true);
    await s.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, s.ctx);
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1")), false);
    assert.deepEqual(branches(s.repo), []);
  } finally {
    s.restore();
  }
});

test("a relaunch of the same lane id reuses its worktree; an unsafe lane id is refused", async () => {
  const s = setup();
  try {
    const first = await s.launch(brief("L1", "T1"));
    await s.end(first.id, { runId: "run-1" });
    writeFileSync(join(s.runDir, "worktrees", "L1", "wip.txt"), "uncommitted");
    const again = await s.launch(brief("L1", "T1"));
    assert.equal(again.input.cwd, join(s.runDir, "worktrees", "L1"));
    assert.equal(existsSync(join(s.runDir, "worktrees", "L1", "wip.txt")), true, "the candidate's work is still there");
    const bad = await s.launch(brief("../x", "T9"));
    assert.equal(bad.result?.block, true);
  } finally {
    s.restore();
  }
});

test("helpers: brief landing, lane id safety, root land and park events after a seq", () => {
  assert.deepEqual(parseLaneBrief(brief("L1", "T1")), { lane: "L1", task: "T1", landing: "returns candidate" });
  assert.deepEqual(parseLaneBrief(brief("L1", "T1", "pushes branch fix/a")), { lane: "L1", task: "T1", landing: "pushes branch fix/a" });
  assert.equal(parseLaneBrief(brief("L1", "T1", "lands-after-green")), null);
  assert.equal(safeLaneId("app54"), true);
  for (const bad of ["..", "a/b", ".x", "x.lock", "", "x y"]) assert.equal(safeLaneId(bad), false, bad);
  const log = [
    { seq: 1, by: "root", ev: "land", task: "A" },
    { seq: 2, by: "ext", ev: "park", task: "B" },
    { seq: 3, by: "root", ev: "park", task: "C" },
  ].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(landParkEvents(log, 1), { events: [{ ev: "park", task: "C", seq: 3 }], maxSeq: 3 });
});

test("a worktree with uncommitted changes is never removed: park and the closeout sweep keep it and say kept dirty", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    const b = await s.launch(brief("L2", "T2"));
    await s.end(b.id, { runId: "run-2" });
    const p1 = join(s.runDir, "worktrees", "L1");
    const p2 = join(s.runDir, "worktrees", "L2");
    writeFileSync(join(p1, "wip.txt"), "uncommitted candidate work");
    writeFileSync(join(p2, ".gitignore"), "changed tracked file\n");

    await s.loopState({ ev: "park", task: "T1", reason: "r", needs: "owner" });
    assert.equal(existsSync(join(p1, "wip.txt")), true, "an untracked file keeps the worktree");
    assert.ok(s.notes.some((n) => /kept dirty: L1 .*uncommitted changes/.test(n)), JSON.stringify(s.notes));
    await s.loopState({ ev: "land", task: "T2", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(p2), true, "a modified tracked file keeps the worktree");

    const lines: string[] = [];
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines, pending });
    await Promise.all(pending);
    assert.equal(existsSync(join(p1, "wip.txt")), true);
    assert.equal(existsSync(p2), true);
    assert.deepEqual(branches(s.repo).sort(), [`loop/${basename(s.runDir)}/L1`, `loop/${basename(s.runDir)}/L2`], "a dirty lane's branch is kept");
    assert.match(lines[0], /removed 0 worktree\(s\).*kept dirty: L1, L2/);
  } finally {
    s.restore();
  }
});

test("after a reload a recorded run counts as live until pi-subagents' status file says it ended", async () => {
  const s = setup();
  const subRoot = fresh("lw-sub-");
  const previousRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = subRoot;
  const status = (dir: string, state: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: basename(dir), state, mode: "single", startedAt: 1 }));
  };
  try {
    // L1's launch result named its async dir; L2's did not, so its status is looked up under the temp root.
    const asyncDir1 = join(subRoot, "elsewhere", "run-1");
    const a = await s.launch(brief("L1", "T1"));
    s.emit("subagent:async-started", { id: "run-1", sessionId: "/sessions/s.jsonl" });
    await s.end(a.id, { runId: "run-1", asyncDir: asyncDir1 });
    status(asyncDir1, "running");
    const b = await s.launch(brief("L2", "T2"));
    s.emit("subagent:async-started", { id: "run-2", sessionId: "/sessions/s.jsonl" });
    await s.end(b.id, { runId: "run-2" });
    const c = await s.launch(brief("L3", "T3"));
    s.emit("subagent:async-started", { id: "run-3", sessionId: "/sessions/s.jsonl" });
    await s.end(c.id, { runId: "run-3" });
    // run-3 has no status file at all: its liveness cannot be determined.

    s.reload();
    const p = (lane: string) => join(s.runDir, "worktrees", lane);
    await s.loopState({ ev: "land", task: "T1", sha: "x", gate: "g", mode: "after-green" });
    await s.loopState({ ev: "park", task: "T2", reason: "r", needs: "owner" });
    await s.loopState({ ev: "park", task: "T3", reason: "r", needs: "owner" });
    assert.equal(existsSync(p("L1")), true, "status running: live");
    assert.equal(existsSync(p("L2")), true, "no status file yet: unknown, kept");
    assert.equal(existsSync(p("L3")), true, "no status file: unknown, kept");

    const lines: string[] = [];
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines, pending });
    await Promise.all(pending);
    assert.match(lines[0], /kept live: L1, L2, L3/);

    // pi-subagents records the ends; the waiting releases go through on the next state-log read.
    status(asyncDir1, "complete");
    status(join(subRoot, "async-subagent-runs", "run-2"), "paused");
    await s.loopState({ ev: "judgement", text: "later" });
    assert.equal(existsSync(p("L1")), false, "status complete: released");
    assert.equal(existsSync(p("L2")), false, "status paused (terminal for pi-subagents): released");
    assert.equal(existsSync(p("L3")), true, "still unknown: kept");
  } finally {
    if (previousRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previousRoot;
    s.restore();
  }
});
