// lane-worktrees through a fake ExtensionAPI against real git: the launch rewrite, undo on a blocked
// launch, removal on land and park (branch deleted only when merged), and the closeout sweep.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { after, test } from "node:test";
import laneWorktrees from "./index.ts";
import { relativeGitdir } from "./metadata.ts";
import { landParkEvents, laneBranch, lanePath, nativeLaneKey, parseLaneBrief, safeLaneId } from "./core.ts";

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
  const allocations = new Map<string, { path: string; branch: string }>();
  const api = {
    on: (n: string, h: any) => handlers.set(n, h),
    appendEntry: (customType: string, data: any) => {
      entries.push({ customType, data });
      for (const tree of data.trees ?? []) allocations.set(tree.lane, { path: tree.path, branch: tree.branch });
    },
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
    path: (lane: string) => allocations.get(lane)?.path ?? lanePath(runDir, lane),
    branch: (lane: string) => allocations.get(lane)?.branch ?? laneBranch(runDir, lane),
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
    const path = s.path("L1");
    assert.equal(result, undefined);
    assert.equal(input.cwd, path);
    assert.equal("isolation" in input, false);
    assert.equal(input.worktree, false, "native default allocation is explicitly suppressed");
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), s.branch("L1"));
    assert.equal(git(path, "rev-parse", "HEAD"), git(s.repo, "rev-parse", "HEAD"));

    const branchLanding = await s.launch(brief("L2", "T2", "pushes branch feature/x"));
    assert.equal(branchLanding.input.cwd, s.path("L2"));
  } finally {
    s.restore();
  }
});

test("other launches are left alone: no isolation, an unsupported landing, no brief header, no protocol marker", async () => {
  const s = setup();
  try {
    for (const [task, extra] of [
      [brief("L1", "T1"), {}],
      [brief("L1", "T1", "tracker-only"), { isolation: "worktree" }],
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
    assert.equal(existsSync(s.path("L1")), false);
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
    const p1 = s.path("L1");
    writeFileSync(join(p1, "one.txt"), "1");
    git(p1, "add", "one.txt");
    git(p1, "commit", "-qm", "one");
    git(s.repo, "merge", "-q", "--ff-only", s.branch("L1"));
    const p2 = s.path("L2");
    writeFileSync(join(p2, "two.txt"), "2");
    git(p2, "add", "two.txt");
    git(p2, "commit", "-qm", "two");

    await s.loopState({ ev: "land", task: "T1", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(p1), false);
    assert.deepEqual(branches(s.repo), [s.branch("L2")]);
    await s.loopState({ ev: "land", task: "T2", sha: "y", gate: "g", mode: "after-green" });
    assert.equal(existsSync(p2), false);
    assert.deepEqual(branches(s.repo), [s.branch("L2")], "unmerged: the branch is kept");
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
    assert.equal(existsSync(s.path("L1")), false);
    assert.deepEqual(branches(s.repo), [s.branch("L1")]);

    const b = await s.launch(brief("L2", "T2"));
    s.emit("subagent:async-started", { id: "run-2", sessionId: "/sessions/s.jsonl" });
    await s.end(b.id, { runId: "run-2" });
    await s.loopState({ ev: "land", task: "T2", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(s.path("L2")), true, "a live lane keeps its worktree");
    s.emit("subagent:async-complete", { runId: "run-2" });
    const deadline = Date.now() + 10_000;
    while (existsSync(s.path("L2")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(existsSync(s.path("L2")), false);
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
    assert.equal(existsSync(s.path("L1")), true);
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
    const p2 = s.path("L2");
    writeFileSync(join(p2, "two.txt"), "2");
    git(p2, "add", "two.txt");
    git(p2, "commit", "-qm", "two");
    s.emit("subagent:async-started", { id: "run-L3", sessionId: "/sessions/s.jsonl" });
    const lines: string[] = [];
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines, pending });
    await Promise.all(pending);

    assert.equal(existsSync(s.path("L1")), false);
    assert.equal(existsSync(p2), false);
    assert.equal(existsSync(s.path("L3")), true, "a live lane is kept");
    assert.deepEqual(branches(s.repo).sort(), [s.branch("L2"), s.branch("L3")].sort());
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`removed 2 worktree(s), deleted 1 merged branch(es); kept unmerged: ${s.branch("L2")}; kept live: L3`));
    assert.doesNotMatch(lines[0], /incident/);
  } finally {
    s.restore();
  }
});

test("neither quitting nor reloading releases a candidate; explicit closeout does", async () => {
  const s = setup();
  try {
    const l = await s.launch(brief("L1", "T1"));
    await s.end(l.id, { runId: "run-1" });
    await s.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, s.ctx);
    assert.equal(existsSync(s.path("L1")), true);
    await s.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, s.ctx);
    assert.equal(existsSync(s.path("L1")), true);
    const lines: string[] = [];
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines, pending });
    await Promise.all(pending);
    assert.equal(existsSync(s.path("L1")), false);
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
    writeFileSync(join(s.path("L1"), "wip.txt"), "uncommitted");
    const again = await s.launch(brief("L1", "T1"));
    assert.equal(again.input.cwd, s.path("L1"));
    assert.equal(existsSync(join(s.path("L1"), "wip.txt")), true, "the candidate's work is still there");
    const bad = await s.launch(brief("../x", "T9"));
    assert.equal(bad.result?.block, true);
  } finally {
    s.restore();
  }
});

test("helpers: brief landing, lane id safety, root land and park events after a seq", () => {
  assert.deepEqual(parseLaneBrief(brief("L1", "T1")), { lane: "L1", task: "T1", landing: "returns candidate" });
  assert.deepEqual(parseLaneBrief(brief("L1", "T1", "pushes branch fix/a")), { lane: "L1", task: "T1", landing: "pushes branch fix/a" });
  assert.deepEqual(parseLaneBrief(brief("L1", "T1", "lands-after-green")), { lane: "L1", task: "T1", landing: "lands-after-green" });
  assert.equal(parseLaneBrief(brief("L1", "T1", "tracker-only")), null);
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
    const p1 = s.path("L1");
    const p2 = s.path("L2");
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
    assert.deepEqual(branches(s.repo).sort(), [s.branch("L1"), s.branch("L2")].sort(), "a dirty lane's branch is kept");
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
    const p = (lane: string) => s.path(lane);
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


test("aliases, opaque allocation and relative gitdir preserve launch fences and original mapping", async () => {
  const s = setup();
  try {
    for (const [lane, landing, extra] of [
      ["L1", "lands-after-green", { worktree: true }],
      ["L2", "pushes branch feature/x", { isolation: "worktree", worktree: true }],
    ] as const) {
      const task = brief(lane, "T-" + lane, landing);
      const { input, result } = await s.launch(task, { ...extra, model: "pinned/model", timeoutMs: 1234, extensionBindings: { original: true } });
      assert.equal(result, undefined);
      assert.equal(input.cwd, s.path(lane));
      assert.equal(input.worktree, false);
      assert.equal(input.task, task);
      assert.equal(input.model, "pinned/model", "retention never removes guard-visible overrides");
      assert.equal(input.timeoutMs, 1234);
      assert.deepEqual(input.extensionBindings, { original: true }, "identity remains the guard's job");
      assert.match(s.branch(lane), /^loop\/r[0-9a-f]{32}\/l[0-9a-f]{32}$/);
      const pointer = readFileSync(join(s.path(lane), ".git"), "utf8").trim().slice(8);
      assert.equal(isAbsolute(pointer), false);
      assert.equal(realpathSync(resolve(s.path(lane), pointer)), realpathSync(git(s.path(lane), "rev-parse", "--absolute-git-dir")));
      const recorded = s.entries.at(-1)!.data.trees.find((t: any) => t.lane === lane);
      assert.equal(recorded.task, "T-" + lane);
      assert.equal(recorded.path, s.path(lane));
      assert.ok(recorded.gitdirPreimage.startsWith("gitdir: /"));
    }
  } finally {
    s.restore();
  }
});

test("conflicting inputs and workflow launches keep native validation; baseRef and cwd are not silently discarded", async () => {
  const s = setup();
  try {
    for (const extra of [
      { isolation: "worktree", worktree: false },
      { isolation: "none", worktree: true },
      { isolation: "worktree", workflow: "example" },
    ]) {
      const { input } = await s.launch(brief("L1", "T1"), extra);
      assert.equal(input.cwd, undefined);
      assert.deepEqual(input, { agent: "lane-worker", task: brief("L1", "T1"), ...extra });
    }
    const earlier = git(s.repo, "rev-parse", "HEAD");
    git(s.repo, "tag", "candidate-base");
    mkdirSync(join(s.repo, "sub"));
    writeFileSync(join(s.repo, "sub", "seed"), "seed");
    git(s.repo, "add", "sub/seed");
    git(s.repo, "commit", "-qm", "subdir");
    const launch = await s.launch(brief("L1", "T1"), { isolation: "worktree", baseRef: "candidate-base" });
    assert.equal(git(String(launch.input.cwd), "rev-parse", "HEAD"), earlier);
    await s.end(launch.id, { runId: "run-1" });
    const nested = await s.launch(brief("L2", "T2"), { isolation: "worktree", cwd: join(s.repo, "sub") });
    assert.equal(nested.input.cwd, join(s.path("L2"), "sub"));
    const invalid = await s.launch(brief("L3", "T3"), { isolation: "worktree", baseRef: "HEAD~1" });
    assert.equal(invalid.result?.block, true);
    assert.equal(existsSync(s.path("L3")), false);
  } finally {
    s.restore();
  }
});

test("pending and live lanes cannot share an allocation or race a root release; another task/repository is refused", async () => {
  const s = setup();
  try {
    const firstPromise = s.launch(brief("L1", "T1"));
    const siblingPromise = s.launch(brief("L1", "T1"));
    const [first, sibling] = await Promise.all([firstPromise, siblingPromise]);
    assert.equal(first.result, undefined);
    assert.equal(sibling.result?.block, true, "allocation is reserved before asynchronous Git setup");
    const duplicate = await s.launch(brief("L1", "T1"));
    assert.equal(duplicate.result?.block, true, "launch awaiting its result is live");
    await s.loopState({ ev: "land", task: "T1", sha: "x", gate: "g", mode: "after-green" });
    assert.equal(existsSync(s.path("L1")), true, "root release waits for launch result");
    await s.end(first.id, { runId: "run-1" });
    assert.equal(existsSync(s.path("L1")), false, "already-ended launch drains pending release");

    const other = await s.launch(brief("L2", "T2"));
    s.emit("subagent:async-started", { id: "run-2", sessionId: "/sessions/s.jsonl" });
    await s.end(other.id, { runId: "run-2" });
    const same = await s.launch(brief("L2", "T2"));
    assert.equal(same.result?.block, true);
    const resumeInput = { action: "resume", id: "run-2" };
    const resume = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "resume-live", input: resumeInput }, s.ctx);
    assert.equal(resume?.block, true);
    s.emit("subagent:async-complete", { runId: "run-2" });
    const taskMismatch = await s.launch(brief("L2", "OTHER"));
    assert.equal(taskMismatch.result?.block, true);
    const alien = fresh("lw-alien-");
    git(alien, "init", "-q", "-b", "main");
    const repoMismatch = await s.launch(brief("L2", "T2"), { isolation: "worktree", cwd: alien });
    assert.equal(repoMismatch.result?.block, true);
  } finally {
    s.restore();
  }
});

test("explicit closeout never removes an unrecorded worktree and failed reuse never deletes an existing candidate", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    const retry = await s.launch(brief("L1", "T1"));
    await s.end(retry.id, { isError: true });
    assert.equal(existsSync(s.path("L1")), true);
    const unrecorded = join(s.runDir, "worktrees", "unrecorded");
    git(s.repo, "worktree", "add", "-b", "unrecorded", unrecorded, "HEAD");
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines: [], pending });
    await Promise.all(pending);
    assert.equal(existsSync(unrecorded), true, "directory membership is not ownership authority");
    assert.equal(git(unrecorded, "branch", "--show-current"), "unrecorded");
  } finally {
    s.restore();
  }
});

test("relative gitdir verification failure restores exact metadata and HEAD", async () => {
  const s = setup();
  try {
    const path = s.path("L1");
    git(s.repo, "worktree", "add", "-b", "metadata-test", path, "HEAD");
    const original = readFileSync(join(path, ".git"), "utf8");
    const sha = git(path, "rev-parse", "HEAD");
    let calls = 0;
    await assert.rejects(relativeGitdir(path, async () => ++calls === 1 ? sha : "changed"), /changed target or HEAD/);
    assert.equal(readFileSync(join(path, ".git"), "utf8"), original);
    assert.equal(git(path, "rev-parse", "HEAD"), sha);
  } finally {
    s.restore();
  }
});


test("release preserves ignored artifacts from tracked, local and global ignore rules", async () => {
  for (const source of ["tracked", "local", "global"]) {
    const s = setup();
    try {
      if (source === "tracked") {
        writeFileSync(join(s.repo, ".gitignore"), "codex/\nunique-artifact/\n");
        git(s.repo, "add", ".gitignore");
        git(s.repo, "commit", "-qm", "ignore-output");
      } else if (source === "local") {
        writeFileSync(join(s.repo, ".git", "info", "exclude"), "unique-artifact/\n");
      } else {
        const globalIgnore = join(fresh("lw-ignore-"), "ignore");
        writeFileSync(globalIgnore, "unique-artifact/\n");
        git(s.repo, "config", "core.excludesFile", globalIgnore);
      }
      const a = await s.launch(brief("L1", "T1"));
      await s.end(a.id, { runId: "run-1" });
      const path = String(a.input.cwd);
      mkdirSync(join(path, "unique-artifact"));
      const artifact = join(path, "unique-artifact", "only-copy.bin");
      writeFileSync(artifact, "unique-output");
      assert.equal(git(path, "status", "--porcelain", "--untracked-files=all"), "", "ordinary status hides this output");
      await s.loopState({ ev: source === "local" ? "land" : "park", task: "T1", reason: "r", needs: "owner" });
      const lines: string[] = [];
      const pending: Promise<unknown>[] = [];
      s.emit("loop-closeout", { lines, pending });
      await Promise.all(pending);
      assert.ok(existsSync(artifact), `${source}: root release must preserve ignored unique artifacts`);
      assert.equal(readFileSync(artifact, "utf8"), "unique-output");
      assert.match(lines[0], /kept dirty: L1/);
    } finally { s.restore(); }
  }
});

test("release and failed-launch rollback refuse a replacement owner even with the same branch/common dir", async () => {
  for (const rollback of [false, true]) {
    const s = setup();
    try {
      const a = await s.launch(brief("L1", "T1"));
      if (!rollback) await s.end(a.id, { runId: "run-1" });
      const path = String(a.input.cwd);
      const originalBranch = git(path, "branch", "--show-current");
      const moved = join(fresh("lw-moved-"), "original");
      git(s.repo, "worktree", "move", path, moved);
      git(s.repo, "worktree", "add", "--force", path, originalBranch);
      const replacementGitdir = git(path, "rev-parse", "--absolute-git-dir");
      if (rollback) await s.end(a.id, { isError: true });
      else {
        const pending: Promise<unknown>[] = [];
        s.emit("loop-closeout", { lines: [], pending });
        await Promise.all(pending);
      }
      assert.ok(existsSync(path), "a replacement allocation is not the recorded owner");
      assert.equal(git(path, "rev-parse", "--absolute-git-dir"), replacementGitdir);
      assert.ok(existsSync(moved), "original allocation is preserved too");
    } finally { s.restore(); }
  }
});

test("allocation refuses a worktrees parent symlink before touching its external target", async () => {
  const s = setup();
  try {
    const outside = join(fresh("lw-outside-"), "worktrees");
    mkdirSync(outside);
    symlinkSync(outside, join(s.runDir, "worktrees"), "dir");
    const a = await s.launch(brief("L1", "T1"));
    assert.equal(a.result?.block, true, "canonical run confinement is mandatory");
    assert.equal(a.input.cwd, undefined);
    assert.deepEqual(branches(s.repo), [], "no allocation may escape through a preexisting parent link");
  } finally { s.restore(); }
});

test("release refuses a newly symlinked worktrees parent without deleting the moved candidate", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "run-1" });
    const path = String(a.input.cwd);
    const movedRoot = join(fresh("lw-parent-moved-"), "worktrees");
    const { renameSync } = await import("node:fs");
    renameSync(join(s.runDir, "worktrees"), movedRoot);
    symlinkSync(movedRoot, join(s.runDir, "worktrees"), "dir");
    const pending: Promise<unknown>[] = [];
    s.emit("loop-closeout", { lines: [], pending });
    await Promise.all(pending);
    assert.ok(existsSync(path), "symlink replacement must fail closed, not follow the parent link");
  } finally { s.restore(); }
});


test("released run tombstones survive reload and non-reused allocations prevent stale cwd adoption", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "released-run" });
    const oldPath = String(a.input.cwd);
    await s.loopState({ ev: "park", task: "T1", reason: "r", needs: "owner" });
    s.reload();
    const b = await s.launch(brief("L1", "T2"));
    await s.end(b.id, { runId: "replacement-run" });
    assert.notEqual(b.input.cwd, oldPath);
    for (const input of [{ action: "resume", id: "released-run" }, { action: "resume", runId: "released-" }, { action: "resume", dir: "/tmp/async-subagent-runs/released-run" }]) {
      const refused = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "old-resume", input }, s.ctx);
      assert.equal(refused?.block, true);
      assert.match(refused.reason, /explicitly released/);
    }
    assert.ok(existsSync(String(b.input.cwd)));
  } finally { s.restore(); }
});

test("nested cwd resume refuses links, non-directories and missing cwd evidence, including after reload", async () => {
  for (const reload of [false, true]) {
    for (const replacement of ["symlink", "committed-symlink", "file", "missing-evidence"]) {
      const s = setup();
      try {
        mkdirSync(join(s.repo, "sub", "nested"), { recursive: true });
        writeFileSync(join(s.repo, "sub", "nested", "seed"), "seed");
        git(s.repo, "add", "sub/nested/seed");
        git(s.repo, "commit", "-qm", "nested-cwd");
        const a = await s.launch(brief("L1", "T1"), { isolation: "worktree", cwd: join(s.repo, "sub", "nested") });
        assert.equal(a.result, undefined);
        await s.end(a.id, { runId: "nested-run" });
        const path = s.path("L1");
        if (replacement === "missing-evidence") {
          for (const entry of s.entries) for (const tree of entry.data.trees ?? []) delete tree.runCwds;
        } else {
          rmSync(join(path, "sub"), { recursive: true });
          if (replacement === "file") writeFileSync(join(path, "sub"), "not a directory");
          else {
            const outside = fresh("lw-external-cwd-");
            mkdirSync(join(outside, "nested"));
            symlinkSync(outside, join(path, "sub"), "dir");
            if (replacement === "committed-symlink") {
              git(path, "add", "sub");
              git(path, "commit", "-qm", "linked-cwd");
              assert.equal(git(path, "status", "--porcelain"), "");
            }
          }
        }
        // Even unchanged older state cannot guess the original cwd; reload enforces the same rule.
        if (reload || replacement === "missing-evidence") {
          const asyncDir = join(fresh("lw-resume-status-"), "nested-run");
          mkdirSync(asyncDir);
          writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
          for (const entry of s.entries) for (const tree of entry.data.trees ?? []) tree.asyncDirs = { "nested-run": asyncDir };
          s.reload();
        }
        const refused = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "nested-resume", input: { action: "resume", id: "nested-run" } }, s.ctx);
        assert.equal(refused?.block, true, `${replacement}, reload=${reload}: nested cwd must be checked before native resume`);
        assert.match(refused.reason, /cwd/);
        assert.ok(existsSync(path), "refusal must not remove the candidate");
      } finally { s.restore(); }
    }
  }
});

test("each run retains its own cwd and ambiguous resume prefixes are refused across and within lanes", async () => {
  const s = setup();
  try {
    mkdirSync(join(s.repo, "sub"));
    writeFileSync(join(s.repo, "sub", "seed"), "seed");
    git(s.repo, "add", "sub/seed");
    git(s.repo, "commit", "-qm", "subdir");
    const a = await s.launch(brief("L1", "T1"), { worktree: true, cwd: join(s.repo, "sub") });
    await s.end(a.id, { runId: "shared-a" });
    const b = await s.launch(brief("L1", "T1"));
    await s.end(b.id, { runId: "shared-b" });
    const sameLane = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "same-lane", input: { action: "resume", id: "shared-" } }, s.ctx);
    assert.equal(sameLane?.block, true);
    assert.match(sameLane.reason, /ambiguous/);
    const c = await s.launch(brief("L2", "T2"));
    await s.end(c.id, { runId: "shared-c" });
    for (const target of ["shared-", "shared-a"]) {
      if (target === "shared-a") rmSync(join(s.path("L1"), "sub"), { recursive: true });
      const refused = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: target, input: { action: "resume", id: target } }, s.ctx);
      assert.equal(refused?.block, true);
      assert.match(refused.reason, target === "shared-" ? /ambiguous/ : /cwd/);
    }
    const tree = s.entries.at(-1)!.data.trees.find((t: any) => t.lane === "L1");
    assert.deepEqual(tree.runCwds, { "shared-a": "sub", "shared-b": "" });
    // An exact root-cwd run remains resumable even though another run's nested cwd was removed.
    const allowed = await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "exact", input: { action: "resume", id: "shared-b" } }, s.ctx);
    assert.equal(allowed, undefined);
    await s.end("exact", { runId: "shared-b" });
    await s.loopState({ ev: "park", task: "T2", reason: "r", needs: "owner" });
  } finally { s.restore(); }
});

test("failed launch rollback preserves commits on its branch and only deletes an unchanged allocation base", async () => {
  for (const changed of [false, true]) {
    const s = setup();
    try {
      const a = await s.launch(brief("L1", "T1"));
      const path = s.path("L1");
      const branch = s.branch("L1");
      if (changed) {
        writeFileSync(join(path, "candidate"), "unique candidate");
        git(path, "add", "candidate");
        git(path, "commit", "-qm", "candidate");
      }
      const tip = git(path, "rev-parse", "HEAD");
      await s.end(a.id, { isError: true });
      assert.equal(existsSync(path), false);
      if (changed) assert.equal(git(s.repo, "rev-parse", branch), tip, "no-run-id error must not delete a committed candidate branch");
      else assert.deepEqual(branches(s.repo), []);
    } finally { s.restore(); }
  }
});

test("simultaneous resumes retain single-flight ownership during asynchronous identity verification", async () => {
  const s = setup();
  try {
    const a = await s.launch(brief("L1", "T1"));
    await s.end(a.id, { runId: "resumable-run" });
    const resume = (id: string) => s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input: { action: "resume", id: "resumable-run" } }, s.ctx);
    const results = await Promise.all([resume("resume-a"), resume("resume-b")]);
    assert.equal(results.filter((r: any) => r?.block).length, 1);
    assert.equal(results.filter((r: any) => r === undefined).length, 1);
  } finally { s.restore(); }
});

test("native naming is opaque, scoped and retains exact task/run identity through reload and revival", async () => {
  const s = setup();
  const task = ["H", "R", "N"].join("") + "-" + String(902).padStart(4, "0");
  const text = `Lane: N1 · Task: ${task} (private native identity) · Tier: guarded\nObjective: x`;
  try {
    for (const extra of [{}, { worktree: true }, { isolation: "worktree", lane: { version: 1, key: task, mode: "scout", claims: ["src/**"] } }]) {
      const a = await s.launch(text, extra);
      const metadata = a.input.lane as Record<string, unknown>;
      assert.equal(a.result, undefined);
      assert.equal(a.input.task, text, "do not redact the governed brief or context");
      assert.equal(a.input.cwd, undefined, "native/default allocations keep package-owned cwd binding");
      assert.equal(metadata.key, nativeLaneKey(realpathSync(s.runDir), "N1", task));
      assert.match(String(metadata.key), /^r[0-9a-f]{32}l[0-9a-f]{32}$/);
      if ("lane" in extra) {
        assert.equal(metadata.mode, "scout");
        assert.deepEqual(metadata.claims, ["src/**"]);
      }
      await s.end(a.id, { runId: `native-${a.id}` });
    }
    s.reload();
    const input = { action: "resume", id: "native-call-1" };
    assert.equal(await s.handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "revive-native", input }, s.ctx), undefined);
    await s.end("revive-native", { runId: "revived-native" });
    const names = s.entries.at(-1)!.data.nativeNames;
    assert.deepEqual(names, [{ key: nativeLaneKey(realpathSync(s.runDir), "N1", task), lane: "N1", task, runs: ["native-call-1", "native-call-2", "native-call-3", "revived-native"] }]);
    assert.notEqual(nativeLaneKey(s.runDir, "N1", task), nativeLaneKey(s.runDir, "N2", task));
    assert.notEqual(nativeLaneKey(s.runDir, "N1", task), nativeLaneKey(s.runDir, "N1", task + "x"));
    assert.notEqual(nativeLaneKey(s.runDir, "N1", task), nativeLaneKey(s.runDir + "x", "N1", task));
  } finally { s.restore(); }
});

test("native naming never repairs malformed lane metadata or changes explicit shared-cwd requests", async () => {
  const s = setup();
  const text = "Lane: N1 · Task: T1 · Tier: guarded\nObjective: x";
  try {
    for (const lane of [null, [], "bad", { version: 2, key: "valid" }, { version: 1, key: "bad/key" }, { version: 1, key: "" }]) {
      const a = await s.launch(text, { worktree: true, lane });
      assert.equal(a.result?.block, true);
      assert.deepEqual(a.input.lane, lane, "a refused input must not be healed");
    }
    for (const extra of [{ worktree: false }, { isolation: "none" }, { isolation: "worktree", worktree: false }, { workflow: "example" }]) {
      const a = await s.launch(text, extra);
      assert.deepEqual(a.input, { agent: "lane-worker", task: text, ...extra });
    }
    const extra = { version: 1, key: "valid", unexpected: true };
    const a = await s.launch(text, { worktree: true, lane: extra });
    assert.equal((a.input.lane as Record<string, unknown>).unexpected, true, "unknown fields remain for package rejection");
    assert.equal(existsSync(join(s.runDir, "worktrees")), false);
  } finally { s.restore(); }
});
