import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseLaneReturn, parseTriage, retryAgent, taskBrief } from "./brief.ts";
import { globsIntersect, guardedHits, ownedOverlap, ownedWithin } from "./glob.ts";
import { dispatcherEligible, parseGoal, parseLoopMd, preGreenEligible, type TaskSpec } from "./goal.ts";
import { backlogTitle, completionText, onCloseCommands, runFailed } from "./index.ts";
import { parseLaunch, stateLogFor } from "./launch.ts";
import { parseBrief } from "../loop-state/core.ts";
import { Dispatcher, type Ports } from "./scheduler.ts";

// ---------------------------------------------------------------- globs

test("owned globs overlap exactly when some path matches both", () => {
  assert.equal(globsIntersect("src/**", "**/auth/**"), true);
  assert.equal(globsIntersect("src/a/**", "src/b/**"), false);
  assert.equal(globsIntersect("src/*.ts", "src/x/y.ts"), false);
  assert.equal(globsIntersect("src/**/*.ts", "src/x/y.ts"), true);
  assert.equal(globsIntersect("docs/{a,b}.md", "docs/b.md"), true);
  assert.equal(ownedOverlap(["lib/"], ["lib/x.ts"]), true, "a trailing slash owns what is under it");
  assert.equal(ownedOverlap(["lib"], ["lib/x.ts"]), false, "a bare entry is one file");
  assert.equal(ownedOverlap(["a.ts", "b/**"], ["c/**"]), false);
});

test("guarded paths are found through globs, and LOOP.md adds its own", () => {
  assert.deepEqual(guardedHits(["src/**"]), [], "a wide glob is not guarded by itself");
  assert.deepEqual(guardedHits(["src/**"], [], ["src/auth/login.ts", "src/oauth.ts", "README.md"]), ["**/auth/**", "**/*auth*.*"]);
  assert.deepEqual(guardedHits(["src/auth/**"]), ["**/auth/**"]);
  assert.deepEqual(guardedHits(["src/util/strings.ts"]), []);
  assert.deepEqual(guardedHits(["infra/wrangler.toml"]), ["wrangler.toml"]);
  assert.deepEqual(guardedHits(["db/001.sql"]), ["**/*.sql"]);
  assert.deepEqual(guardedHits(["vendor/x.ts"], ["vendor/**"]), ["vendor/**"]);
  assert.deepEqual(guardedHits(["src/{auth,util}/**"]), ["**/auth/**"], "a brace alternative is guarded with no files on disk");
  assert.deepEqual(guardedHits(["src/{util,lib}/**"]), []);
});

test("owned entries are normalised before the guarded and overlap checks; entries leaving the repo fail closed", () => {
  assert.deepEqual(guardedHits(["src/../.github/workflows/ci.yml"]), [".github/workflows/**"]);
  assert.deepEqual(guardedHits(["./src//auth/x.ts"]), ["**/auth/**"]);
  assert.equal(ownedOverlap(["a/../b.ts"], ["b.ts"]), true);
  assert.equal(ownedOverlap(["src//x.ts"], ["src/x.ts"]), true);
  assert.equal(ownedWithin("docs/a..b.md", ["docs/**"]), true, "two dots inside a name stay in the repo");
  for (const bad of ["../x.ts", "a/../../b.ts", "/etc/hosts", "src/{a,../../b}.ts"]) {
    assert.notDeepEqual(guardedHits([bad]), [], `${bad} is refused by the guarded check`);
    assert.equal(ownedOverlap([bad], ["unrelated/z.ts"]), true, `${bad} overlaps everything`);
    assert.equal(ownedWithin(bad, ["**"]), false, `${bad} is inside nothing`);
  }
});

test("a split subtask's globs must lie inside the parent's", () => {
  assert.equal(ownedWithin("src/a/x.ts", ["src/a/**"]), true);
  assert.equal(ownedWithin("src/a/*.ts", ["src/a/**"]), true);
  assert.equal(ownedWithin("src/b/x.ts", ["src/a/**"]), false);
  assert.equal(ownedWithin("src/**", ["src/*"]), false);
});

// ---------------------------------------------------------------- goal and eligibility

function goalText(rows: string[], opts: { ops?: string; header?: string } = {}): string {
  return [
    "# Goal",
    "## Run",
    "tier: routine",
    "root: dispatcher - three disjoint routine tasks",
    "root-model: none",
    "concurrency: 2",
    "## Envelope",
    opts.header ?? "| task | acceptance check | owned files | gate | landing | agent | tier |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "## Authority",
    "push agents: lane-worker-push",
    `ops: ${opts.ops ?? "none"}`,
    "secret paths: none",
    "credential creation: none",
    "## Decisions",
    "## Notes",
  ].join("\n");
}

const row = (id: string, owned: string, landing = "lands-after-green", agent = "lane-worker-push", tier = "routine") =>
  `| ${id} | \`just test\` passes | ${owned} | \`just check \\| tail\` | ${landing} | ${agent} | ${tier} |`;
const ROUTINE_LOOP = "# Loop: x\ntier: routine\ngate: just check\nci-required: none\nrelease-on-push: no\ndeploy-on-push: no\n";

test("the Envelope table parses into tasks; an escaped pipe stays in its cell", () => {
  const g = parseGoal(goalText([row("T-1", "src/a/**, docs/{a,b}.md")]));
  assert.deepEqual(g.errors, []);
  assert.equal(g.run.concurrency, "2");
  assert.equal(g.authority.ops, "none");
  assert.deepEqual(g.tasks[0], {
    id: "T-1",
    objective: "",
    acceptance: "`just test` passes",
    owned: ["src/a/**", "docs/{a,b}.md"],
    gate: "just check | tail",
    landing: "lands-after-green",
    agent: "lane-worker-push",
    tier: "routine",
  });
});

test("a titled task cell keeps the bare id and puts the title in the brief header", () => {
  const g = parseGoal(goalText([row("T-1 (fix the widget parser)", "src/a/**")]));
  assert.deepEqual(g.errors, []);
  assert.equal(g.tasks[0].id, "T-1");
  assert.equal(g.tasks[0].title, "fix the widget parser");
  const header = taskBrief(g.tasks[0], "L1", "routine").split("\n")[0];
  assert.equal(header, "Lane: L1 · Task: T-1 (fix the widget parser) · Tier: routine");
  assert.deepEqual(parseBrief(header), { lane: "L1", task: "T-1", tier: "routine" });
});

test("dispatcherEligible holds for three routine, landing, disjoint-or-not tasks", () => {
  const v = dispatcherEligible(goalText([row("T1", "a/**"), row("T2", "b/**"), row("T3", "a/x.ts")]), ROUTINE_LOOP);
  assert.deepEqual(v, { eligible: true, reasons: [] });
});

test("dispatcherEligible refuses each failing condition with a reason", () => {
  const three = [row("T1", "a/**"), row("T2", "b/**"), row("T3", "c/**")];
  const reasons = (text: string, loop = ROUTINE_LOOP) => dispatcherEligible(text, loop).reasons.join("\n");
  assert.match(reasons(goalText(three.slice(0, 2))), /needs at least 3/);
  assert.match(reasons(goalText(three, { ops: "/r/codex/ops-x-loop1.json sha256=ab" })), /grants ops/);
  assert.match(reasons(goalText([...three.slice(0, 2), row("T3", "src/auth/**")])), /T3: owned files touch guarded paths/);
  assert.match(reasons(goalText([...three.slice(0, 2), row("T3", "c/**", "returns candidate")])), /T3: landing is 'returns candidate'/);
  assert.match(reasons(goalText([...three.slice(0, 2), row("T3", "c/**", "lands-after-green", "lane-worker")])), /needs a -push agent/);
  assert.match(reasons(goalText([...three.slice(0, 2), row("T3", "c/**", "lands-after-green", "lane-worker-push", "guarded")])), /T3: tier guarded/);
  assert.match(reasons(goalText([...three.slice(0, 2), row("T3", "c/**", "lands-pre-green")]), "tier: routine\nrelease-on-push: yes\n"), /not land-before-green eligible/);
  assert.match(reasons(goalText(three), `${ROUTINE_LOOP}baseline-red: T9 - main fails the lint leg\n`), /LOOP\.md carries `baseline-red:/);
  assert.match(reasons(goalText(three, { header: "| task | owned files | gate |" })), /Envelope columns/);
  assert.match(reasons(goalText([...three.slice(0, 2), "| T3 | x | c/** |"])), /row has 3 cells/);
});

const LOOP_STATE = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));

test("the dispatcher and loop-state read LOOP.md identically for a pre-green land", () => {
  const variants = [
    ROUTINE_LOOP,
    ROUTINE_LOOP.replace("release-on-push: no", "release-on-push: no (tags only)"),
    ROUTINE_LOOP.replace("deploy-on-push: no", "deploy-on-push: no  # for now"),
    ROUTINE_LOOP.replace("tier: routine", "tier : routine"),
    ROUTINE_LOOP.replace("deploy-on-push: no", "Deploy-On-Push: no"),
    `${ROUTINE_LOOP}\n## Traps\nrelease-on-push: yes\n`,
    ROUTINE_LOOP.replace("release-on-push: no", "release-on-push: yes"),
    `${ROUTINE_LOOP}baseline-red: T9 - main fails the lint leg\n`,
  ];
  for (const text of variants) {
    const repo = mkdtempSync(join(tmpdir(), "loop-md-parity-"));
    try {
      mkdirSync(join(repo, "codex"));
      writeFileSync(join(repo, "LOOP.md"), text);
      const log = join(repo, "codex", "state-x-loop1.jsonl");
      const r = spawnSync("python3", [LOOP_STATE, "append", log, "land", "task=T1", "sha=abc", "gate=g", "mode=pre-green"], { encoding: "utf8" });
      assert.equal(preGreenEligible(parseLoopMd(text)), r.status === 0, `LOOP.md:\n${text}\nloop-state: exit ${r.status} ${r.stderr}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------- briefs and returns

const spec = (id: string, owned: string[], extra: Partial<TaskSpec> = {}): TaskSpec => ({
  id,
  objective: `Complete backlog task ${id}: do it`,
  acceptance: "tests pass",
  owned,
  gate: "just check",
  landing: "lands-after-green",
  agent: "lane-worker-push",
  tier: "routine",
  ...extra,
});

test("a task brief is exactly the S3 lines", () => {
  assert.equal(
    taskBrief(spec("T1", ["a/**", "b.ts"]), "L1", "routine"),
    [
      "Lane: L1 · Task: T1 · Tier: routine",
      "Objective: Complete backlog task T1: do it",
      "Owned files: a/**, b.ts",
      "Acceptance check: tests pass",
      "Gate: just check",
      "Landing: lands-after-green",
      "Stop rule: Stop when the acceptance check and the gate pass on your landed candidate, or when the next step needs a file outside Owned files.",
      "Escalation: Return status blocked with the question in `questions`; do not guess.",
    ].join("\n"),
  );
});

function ret(fields: Record<string, unknown>): string {
  const body = { v: 2, lane: "L1", status: "complete", sha: null, landed: false, base: "b", check: "just check", exit: 0, tail: "", ci: null, coderabbit: null, questions: [], ...fields };
  return `done\n\`\`\`lane-return\n${JSON.stringify(body)}\n\`\`\``;
}

test("the last lane-return block wins; a missing or wrong-version block reads as failed", () => {
  const r = parseLaneReturn(`${ret({ status: "partial" })}\n${ret({ status: "complete", sha: "abc", landed: true })}`);
  assert.equal(r.status, "complete");
  assert.equal(r.sha, "abc");
  assert.equal(r.landed, true);
  assert.equal(parseLaneReturn("no block").status, "failed");
  assert.equal(parseLaneReturn(ret({ v: 1 })).status, "failed");
});

const brief7 = (objective: string, owned: string, acceptance = "it works") =>
  ["Lane: L9 · Task: T1 · Tier: routine", `Objective: ${objective}`, `Owned files: ${owned}`, `Acceptance check: ${acceptance}`, "Gate: rm -rf /", "Landing: returns candidate", "Stop rule: s", "Escalation: e"].join("\n");
const triage = (o: Record<string, unknown>) => `ok\n\`\`\`triage\n${JSON.stringify({ v: 1, lane: "L2", reason: "r", ...o })}\n\`\`\``;

test("triage blocks parse into retry, park or split; gate and landing are never read from a brief", () => {
  const r = parseTriage(triage({ decision: "retry", brief: brief7("Do it better", "a/x.ts, a/y.ts") }));
  assert.deepEqual(r, { action: "retry", reason: "r", brief: { objective: "Do it better", owned: ["a/x.ts", "a/y.ts"], acceptance: "it works", stop: "s", escalation: "e" } });
  assert.deepEqual(parseTriage(triage({ decision: "park", needs: "owner" })), { action: "park", needs: "owner", reason: "r" });
  assert.equal(parseTriage(triage({ decision: "park", needs: "someday" })).action, "none");
  assert.equal(parseTriage(triage({ decision: "retry" })).action, "none");
  const braced = parseTriage(triage({ decision: "retry", brief: brief7("Do it", "src/{auth,util}/**, a/y.ts") }));
  assert.deepEqual(braced.action === "retry" && braced.brief.owned, ["src/{auth,util}/**", "a/y.ts"], "a comma inside braces stays in one owned glob");
  assert.equal(parseTriage(triage({ decision: "split", split: [brief7("a", "x"), brief7("b", "y")] })).action, "split");
  assert.equal(parseTriage(triage({ decision: "split", split: [brief7("a", "")] })).action, "none");
  assert.equal(parseTriage(triage({ v: 2, decision: "park", needs: "owner" })).action, "none");
  assert.equal(parseTriage("nothing").action, "none");
  assert.equal(retryAgent("lane-worker-push"), "lane-worker-retry-push");
  assert.equal(retryAgent("lane-worker-low"), "lane-worker-retry");
  assert.equal(retryAgent("complex-worker-push"), "complex-worker-push");
});

// ---------------------------------------------------------------- scheduler

/** A scheduler bug can leave `closed` pending forever; fail instead of hanging. */
const SCHED = { timeout: 10_000 };

class FakePorts implements Ports {
  events: Record<string, any>[] = [];
  spawns: { agent: string; brief: string; runId: string }[] = [];
  live = new Set<string>();
  maxLive = 0;
  done: string[] = [];
  calls: string[] = [];
  refuse = new Set<string>();
  fetchFails = false;
  tip = "tip";
  /** When set, a spawn moves main to this SHA at once: a lane that pushes before its dispatch is recorded. */
  pushOnSpawn?: string;
  /** Files changed on main between two SHAs; keyed "base..tip". */
  changed = new Map<string, string[]>();
  notOnMain = new Set<string>();
  refusePreGreen = false;
  private n = 0;
  async append(event: Record<string, unknown>) {
    if (this.refusePreGreen && event.ev === "land" && event.mode === "pre-green") throw new Error("loop-state refused land: LOOP.md needs `release-on-push: no`");
    this.events.push(event);
    this.calls.push(`append:${event.ev}`);
  }
  async spawn(agent: string, brief: string) {
    if (this.refuse.has(agent)) return { error: `${agent} refused` };
    const runId = `r${++this.n}`;
    if (this.pushOnSpawn) this.tip = this.pushOnSpawn;
    this.spawns.push({ agent, brief, runId });
    this.live.add(runId);
    this.maxLive = Math.max(this.maxLive, [...this.live].filter((id) => this.byRun(id).agent !== "gate-runner").length);
    return { runId };
  }
  async remoteSha() {
    if (this.fetchFails) throw new Error("fetch failed");
    return this.tip;
  }
  async changedFiles(base: string, tip: string) {
    return this.changed.get(`${base}..${tip}`) ?? [];
  }
  async isAncestor(sha: string) {
    return !this.notOnMain.has(sha);
  }
  async backlogDone(task: string) {
    this.done.push(task);
    return { ok: true, detail: "" };
  }
  async closeout() {
    this.calls.push("closeout");
    return { ok: true, detail: "" };
  }
  async commitBacklog(tasks: string[]) {
    this.calls.push(`commitBacklog:${tasks.join(",")}`);
    return { ok: true, detail: "" };
  }
  async onClose() {
    this.calls.push("onClose");
  }
  log() {}
  byRun(runId: string) {
    return this.spawns.find((s) => s.runId === runId)!;
  }
  ofEv(ev: string) {
    return this.events.filter((e) => e.ev === ev);
  }
}

function plan(tasks: TaskSpec[], cap = 2) {
  return {
    tasks,
    tiers: Object.fromEntries(tasks.map((t) => [t.id, "routine"])),
    runTier: "routine",
    cap,
    composedGate: "just check",
    guardedExtra: [],
    files: [],
    goalSha256: "0".repeat(64),
    rootModel: "loop-dispatch/idle",
  };
}

async function finish(d: Dispatcher, ports: FakePorts, runId: string, text: string) {
  ports.live.delete(runId);
  d.complete(runId, text);
  await d.settled();
}

const landed = (sha: string) => ret({ status: "complete", sha, landed: true });
const greenGate = ret({ status: "complete", exit: 0 });

test("disjoint tasks run up to the cap, then one composed gate per landed batch, then accept and Done", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])]), ports);
  const closed = d.start();
  await d.settled();
  assert.deepEqual(ports.spawns.map((s) => s.agent), ["lane-worker-push", "lane-worker-push"], "cap 2 holds the third task back");
  await finish(d, ports, "r1", landed("s1"));
  // T3 starts, and T1's landing forms the first batch.
  assert.deepEqual(ports.spawns.slice(2).map((s) => s.agent), ["lane-worker-push", "gate-runner"]);
  assert.match(ports.spawns[3].brief, /^Lane: L4 · Task: T1 · Tier: routine/);
  await finish(d, ports, "r2", landed("s2"));
  await finish(d, ports, "r3", landed("s3"));
  assert.equal(ports.spawns.length, 4, "a batch waits while a gate runs");
  await finish(d, ports, "r4", greenGate);
  assert.equal(ports.spawns[4].agent, "gate-runner");
  assert.match(ports.spawns[4].brief, /Task: T2,T3/);
  await finish(d, ports, "r5", greenGate);
  assert.equal(await closed, "nothing-admissible");
  assert.equal(ports.maxLive, 2);
  assert.deepEqual(ports.done, ["T1", "T2", "T3"]);
  assert.deepEqual(ports.ofEv("accept").map((e) => [e.task, e.accepted]), [["T1", true], ["T2", true], ["T3", true]]);
  assert.deepEqual(ports.ofEv("gate").map((e) => [e.scope, e.sha, e.exit]), [["composed", "tip", 0], ["composed", "tip", 0]]);
  assert.deepEqual(ports.ofEv("land").map((e) => [e.task, e.mode]), [["T1", "after-green"], ["T2", "after-green"], ["T3", "after-green"]]);
  assert.deepEqual(ports.calls.slice(-4), ["closeout", "append:close", "commitBacklog:T1,T2,T3", "onClose"]);
  assert.deepEqual(ports.events[0].ev, "open");
  assert.deepEqual(ports.events.slice(1, 4).map((e) => [e.ev, e.task, e.source]), [["admit", "T1", "envelope"], ["admit", "T2", "envelope"], ["admit", "T3", "envelope"]]);
});

test("a task overlapping an earlier unfinished one waits for it to land", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["a/x.ts"]), spec("T3", ["c/**"])], 3), ports);
  d.start();
  await d.settled();
  assert.deepEqual(ports.spawns.map((s) => s.brief.split("\n")[0]), ["Lane: L1 · Task: T1 · Tier: routine", "Lane: L2 · Task: T3 · Tier: routine"]);
  await finish(d, ports, "r1", landed("s1"));
  assert.ok(ports.spawns.some((s) => /Task: T2 /.test(s.brief)), "T2 starts once T1 landed");
});

test("a non-complete return gets a triager; retry re-dispatches on the retry route with the revised objective", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  d.start();
  await d.settled();
  await finish(d, ports, "r1", ret({ status: "blocked", questions: ["which?"] }));
  assert.equal(ports.spawns[1].agent, "triager");
  assert.match(ports.spawns[1].brief, /Lane L1 did not complete task T1 \(1 of 4 attempts used\)/);
  assert.match(ports.spawns[1].brief, /Failed brief:\n```\nLane: L1 · Task: T1/);
  assert.deepEqual(ports.ofEv("return")[0].questions, ["which?"]);
  assert.equal(ports.spawns.length, 2, "the triager holds the task's slot");
  await finish(d, ports, "r2", triage({ decision: "retry", brief: brief7("Try the other parser", "a/parser/**", "parser tests pass") }));
  assert.equal(ports.spawns[2].agent, "lane-worker-retry-push");
  assert.match(ports.spawns[2].brief, /^Objective: Try the other parser$/m);
  assert.match(ports.spawns[2].brief, /^Owned files: a\/parser\/\*\*$/m);
  assert.match(ports.spawns[2].brief, /^Gate: just check$/m, "the gate stays the Envelope's");
  assert.match(ports.spawns[2].brief, /^Landing: lands-after-green$/m);
  assert.match(ports.spawns[2].brief, /^Lane: L3 · Task: T1/);
});

test("triage park records the needs class; split admits subtasks and accepts the parent after them", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 3), ports);
  const closed = d.start();
  await d.settled();
  await finish(d, ports, "r1", ret({ status: "failed" }));
  await finish(d, ports, "r4", triage({ decision: "park", needs: "owner" }));
  assert.deepEqual(ports.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "owner"]]);
  await finish(d, ports, "r2", ret({ status: "partial" }));
  await finish(d, ports, "r5", triage({ decision: "split", split: [brief7("part one", "b/one/**", "one ok"), brief7("part two", "b/two.ts", "two ok")] }));
  assert.deepEqual(ports.ofEv("admit").slice(3).map((e) => [e.task, e.source]), [["T2.1", "loop-created"], ["T2.2", "loop-created"]]);
  const children = ports.spawns.filter((s) => /Task: T2\.\d/.test(s.brief));
  assert.equal(children.length, 2);
  await finish(d, ports, "r3", landed("s3"));
  for (const c of children) await finish(d, ports, c.runId, landed(`s-${c.runId}`));
  for (const g of ports.spawns.filter((s) => s.agent === "gate-runner")) if (ports.live.has(g.runId)) await finish(d, ports, g.runId, greenGate);
  for (const g of ports.spawns.filter((s) => s.agent === "gate-runner")) if (ports.live.has(g.runId)) await finish(d, ports, g.runId, greenGate);
  assert.equal(await closed, "nothing-admissible");
  assert.deepEqual(ports.done.sort(), ["T2", "T3"], "split children are not backlog tasks; the parent is");
  assert.equal(d.snapshot().T1.status, "parked");
});

test("a split leaving the task's owned files is refused and parks the task", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  d.start();
  await d.settled();
  await finish(d, ports, "r1", ret({ status: "failed" }));
  await finish(d, ports, "r2", triage({ decision: "split", split: [brief7("o", "z/**")] }));
  assert.match(ports.ofEv("park")[0].reason, /split rejected/);
});

test("the attempt ceiling parks a task after its fourth failed attempt without another triager", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  d.start();
  await d.settled();
  const retry = triage({ decision: "retry", brief: brief7("again", "a/**") });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const work = ports.spawns.filter((s) => /Task: T1 /.test(s.brief) && s.agent !== "triager").at(-1)!;
    await finish(d, ports, work.runId, ret({ status: "failed" }));
    if (attempt < 4) await finish(d, ports, ports.spawns.at(-1)!.runId, retry);
  }
  assert.equal(ports.spawns.filter((s) => s.agent === "triager").length, 3);
  assert.equal(ports.spawns.filter((s) => /Task: T1 /.test(s.brief) && s.agent !== "triager").length, 4);
  assert.match(ports.ofEv("park")[0].reason, /attempt ceiling 4/);
});

test("a red composed gate rejects its batch, stops new work and closes blocked", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  await finish(d, ports, "r1", landed("s1"));
  const gate = ports.spawns.find((s) => s.agent === "gate-runner")!;
  const t2 = ports.spawns.find((s) => /Task: T2 /.test(s.brief))!;
  await finish(d, ports, gate.runId, ret({ status: "failed", exit: 2 }));
  assert.deepEqual(ports.ofEv("gate").map((e) => e.exit), [2]);
  assert.deepEqual(ports.ofEv("accept").map((e) => [e.task, e.accepted]), [["T1", false]]);
  await finish(d, ports, t2.runId, landed("s2"));
  assert.equal(await closed, "blocked");
  assert.equal(ports.spawns.some((s) => /Task: T3 /.test(s.brief)), false, "no new work after a red gate");
  assert.deepEqual(ports.done, []);
  assert.deepEqual(ports.ofEv("park").map((e) => e.task), ["T1", "T2"]);
});

test("a composed gate is green only for a parsed complete return with exit 0 on the gated SHA", SCHED, async () => {
  const cases: [string, string, unknown, string][] = [
    ["exit null", ret({ status: "complete", exit: null }), null, "tip"],
    ["no lane-return block", "The gate passed.", null, "tip"],
    ["another SHA", ret({ status: "complete", exit: 0, sha: "elsewhere" }), 0, "elsewhere"],
  ];
  for (const [name, text, exit, sha] of cases) {
    const ports = new FakePorts();
    const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
    const closed = d.start();
    await d.settled();
    await finish(d, ports, "r1", landed("s1"));
    const gate = ports.spawns.find((s) => s.agent === "gate-runner")!;
    await finish(d, ports, gate.runId, text);
    assert.deepEqual(ports.ofEv("accept").map((e) => [e.task, e.accepted]), [["T1", false]], name);
    assert.deepEqual(ports.ofEv("gate").map((e) => [e.sha, e.exit]), [[sha, exit]], `${name}: the gate event carries what the lane reported`);
    const t2 = ports.spawns.find((s) => /Task: T2 /.test(s.brief))!;
    await finish(d, ports, t2.runId, landed("s2"));
    assert.equal(await closed, "blocked", name);
    assert.deepEqual(ports.done, [], name);
  }
});

test("a pre-green land loop-state refuses is still recorded, as an after-green land plus a park, and stops new work", SCHED, async () => {
  const ports = new FakePorts();
  ports.refusePreGreen = true;
  const d = new Dispatcher(plan([spec("T1", ["a/**"], { landing: "lands-pre-green" }), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  await finish(d, ports, "r1", landed("s1"));
  assert.deepEqual(ports.ofEv("land").map((e) => [e.task, e.sha, e.mode]), [["T1", "s1", "after-green"]]);
  assert.deepEqual(ports.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "owner"]]);
  assert.match(ports.ofEv("park")[0].reason, /pre-green/);
  assert.equal(await closed, "blocked");
  assert.equal(ports.spawns.length, 1, "no new work after the refusal");
});

test("a refused spawn parks the task; a landed SHA missing from main parks instead of gating", SCHED, async () => {
  const ports = new FakePorts();
  ports.notOnMain.add("ghost");
  const d = new Dispatcher(plan([spec("T1", ["a/**"], { agent: "rogue" }), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 2), ports);
  ports.refuse.add("rogue");
  const closed = d.start();
  await d.settled();
  assert.match(ports.ofEv("park")[0].reason, /spawn refused for rogue/);
  const [t2, t3] = ports.spawns;
  await finish(d, ports, t2.runId, landed("ghost"));
  assert.match(ports.ofEv("park")[1].reason, /ghost is not on the default branch/);
  await finish(d, ports, t3.runId, landed("s3"));
  await finish(d, ports, ports.spawns.at(-1)!.runId, greenGate);
  assert.equal(await closed, "nothing-admissible");
  assert.deepEqual(ports.done, ["T3"]);
});

test("a run that failed or timed out never counts as complete, even with a complete lane-return block", SCHED, async () => {
  const work = new FakePorts();
  const w = new Dispatcher(plan([spec("T1", ["a/**"])], 1), work);
  w.start();
  await w.settled();
  work.live.delete("r1");
  w.complete("r1", ret({ status: "complete" }), true);
  await w.settled();
  assert.deepEqual(work.ofEv("land"), [], "no land from a failed run");
  assert.equal(work.spawns[1].agent, "triager");
  assert.equal(work.ofEv("return")[0].status, "failed");
  work.live.delete("r2");
  w.complete("r2", triage({ decision: "split", split: [brief7("part one", "a/one/**", "one ok")] }), true);
  await w.settled();
  assert.deepEqual(work.ofEv("admit").filter((e) => e.source === "loop-created"), [], "a failed triager's split is not acted on");
  assert.deepEqual(work.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "defect"]]);
  assert.equal(work.spawns.length, 2, "no retry or split lane after a failed triager");

  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  await finish(d, ports, "r1", landed("s1"));
  const gate = ports.spawns.find((s) => s.agent === "gate-runner")!;
  ports.live.delete(gate.runId);
  d.complete(gate.runId, greenGate, true);
  await d.settled();
  assert.deepEqual(ports.ofEv("accept").map((e) => [e.task, e.accepted]), [["T1", false]], "a timed-out gate is red");
  assert.deepEqual(ports.ofEv("gate").map((e) => e.exit), [null], "its block's exit 0 is not recorded as the gate exit");
  const t2 = ports.spawns.find((s) => /Task: T2 /.test(s.brief))!;
  await finish(d, ports, t2.runId, landed("s2"));
  assert.equal(await closed, "blocked");
  assert.deepEqual(ports.done, []);
});

test("a failed run that reports a landed SHA parks for its owner: never gated, never retried", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"])], 1), ports);
  d.start();
  await d.settled();
  ports.live.delete("r1");
  d.complete("r1", landed("s1"), true);
  await d.settled();
  assert.deepEqual(ports.ofEv("land"), []);
  assert.deepEqual(ports.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "owner"]]);
  assert.match(String(ports.ofEv("park")[0].reason), /s1/);
  assert.equal(ports.spawns.some((s) => s.agent === "triager"), false, "no triager or retry onto the same files");
  assert.match(String(ports.ofEv("park")[0].reason), /\(on main at tip\)/);

  const ghost = new FakePorts();
  ghost.notOnMain.add("s9");
  const g = new Dispatcher(plan([spec("T1", ["a/**"])], 1), ghost);
  g.start();
  await g.settled();
  ghost.live.delete("r1");
  g.complete("r1", landed("s9"), true);
  await g.settled();
  assert.match(String(ghost.ofEv("park")[0].reason), /\(not on main at tip\)/);
});

test("an owner park after a failed landed lane stops new work, so no overlapping task builds on the ungated commit", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["a/x/**"])], 2), ports);
  const closed = d.start();
  await d.settled();
  ports.live.delete("r1");
  d.complete("r1", landed("s1"), true);
  await d.settled();
  assert.equal(ports.spawns.some((s) => /Task: T2 /.test(s.brief)), false, "T2 is never dispatched onto T1's files");
  assert.equal(await closed, "blocked");
  assert.deepEqual(ports.done, []);
});

test("a failed completion that arrives before its spawn reply keeps its failure", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  d.complete("r1", ret({ status: "complete" }), true);
  d.start();
  await d.settled();
  assert.deepEqual(ports.ofEv("land"), []);
  assert.equal(ports.ofEv("return")[0].status, "failed");
});

test("an owner park whose fetch fails says main was not checked and still stops new work", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  ports.fetchFails = true;
  ports.live.delete("r1");
  d.complete("r1", landed("s1"), true);
  await d.settled();
  assert.match(String(ports.ofEv("park")[0].reason), /main not checked: fetch failed/);
  assert.equal(await closed, "blocked");
});

test("a partial or blocked return that claims a landed SHA parks for its owner instead of a retry", SCHED, async () => {
  for (const status of ["partial", "blocked"]) {
    const ports = new FakePorts();
    const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["a/x/**"])], 2), ports);
    const closed = d.start();
    await d.settled();
    await finish(d, ports, "r1", ret({ status, sha: "s1", landed: true }));
    assert.deepEqual(ports.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "owner"]], status);
    assert.equal(ports.spawns.some((s) => s.agent === "triager"), false, status);
    assert.equal(ports.spawns.some((s) => /Task: T2 /.test(s.brief)), false, `${status}: nothing builds on the pushed SHA`);
    assert.equal(await closed, "blocked", status);
  }
});

test("a return with no landed claim parks for its owner when its owned files changed on main since dispatch", SCHED, async () => {
  const ports = new FakePorts();
  ports.changed.set("tip..tip", ["a/pushed.ts", "z/other-lane.ts"]);
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  await finish(d, ports, "r1", "the lane died before writing a block");
  assert.deepEqual(ports.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "owner"]]);
  assert.match(String(ports.ofEv("park")[0].reason), /a\/pushed\.ts/);
  assert.equal(ports.spawns.some((s) => s.agent === "triager"), false);
  assert.equal(await closed, "blocked");

  const fast = new FakePorts();
  fast.pushOnSpawn = "t1";
  fast.changed.set("tip..t1", ["a/fast.ts"]);
  const f = new Dispatcher(plan([spec("T1", ["a/**"])], 1), fast);
  f.start();
  await f.settled();
  await finish(f, fast, "r1", "the lane died before writing a block");
  assert.deepEqual(fast.ofEv("dispatch").map((e) => e.base), ["tip"], "the base is main before the spawn");
  assert.match(String(fast.ofEv("park")[0]?.reason), /a\/fast\.ts/, "a push made right after the spawn is still seen");

  const other = new FakePorts();
  other.changed.set("tip..tip", ["z/other-lane.ts"]);
  const o = new Dispatcher(plan([spec("T1", ["a/**"])], 1), other);
  o.start();
  await o.settled();
  await finish(o, other, "r1", "the lane died before writing a block");
  assert.equal(other.spawns[1].agent, "triager", "another lane's files on main do not park this task");
});

test("a fetch that fails before a spawn refuses that spawn instead of leaving the loop open", SCHED, async () => {
  const work = new FakePorts();
  work.fetchFails = true;
  const w = new Dispatcher(plan([spec("T1", ["a/**"])], 1), work);
  const wClosed = w.start();
  assert.equal(await wClosed, "nothing-admissible", "a refused spawn parks its task, as any refused spawn does");
  assert.equal(work.spawns.length, 0, "no lane starts without a dispatch base");
  assert.deepEqual(work.ofEv("park").map((e) => [e.task, e.needs]), [["T1", "defect"]]);

  // The gate lane reuses the tip dispatchGate fetched; a second fetch would fail here and must not be made.
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"])], 1), ports);
  const closed = d.start();
  await d.settled();
  let calls = 0;
  const real = ports.remoteSha.bind(ports);
  ports.remoteSha = async () => (++calls > 1 ? Promise.reject(new Error("fetch failed")) : real());
  await finish(d, ports, "r1", landed("s1"));
  const gate = ports.spawns.find((s) => s.agent === "gate-runner");
  assert.ok(gate, "the gate lane starts on the tip dispatchGate fetched");
  assert.equal(calls, 1);
  await finish(d, ports, gate.runId, greenGate);
  assert.equal(await closed, "nothing-admissible");
  assert.deepEqual(ports.done, ["T1"]);
});

test("a completion that arrives before its spawn reply is kept and handled", SCHED, async () => {
  const ports = new FakePorts();
  const d = new Dispatcher(plan([spec("T1", ["a/**"]), spec("T2", ["b/**"]), spec("T3", ["c/**"])], 1), ports);
  d.complete("r1", landed("s1"));
  d.start();
  await d.settled();
  assert.deepEqual(ports.ofEv("land").map((e) => e.task), ["T1"]);
});

// ---------------------------------------------------------------- launch and extension helpers

test("the launch message names the goal and report; the log sits beside the report", () => {
  const msg = [
    "cmd: loop-pi-dispatch",
    "You are the root. Read /r/x/contract.md and /r/repo/codex/goal-2026-10-03-loop2.md in full. Write /r/repo/codex/report-2026-10-03-loop2.md as the terminal action.",
  ].join("\n");
  const l = parseLaunch(msg, () => undefined);
  assert.ok(!("error" in l));
  assert.equal(l.goal, "/r/repo/codex/goal-2026-10-03-loop2.md");
  assert.equal(l.log, "/r/repo/codex/state-2026-10-03-loop2.jsonl");
  assert.equal(l.repo, "/r/repo");
  assert.equal(l.opsLine, false);
  const viaFile = parseLaunch("/r/repo/codex/launch-loop2.txt", (p) => (p.endsWith("launch-loop2.txt") ? `${msg}\nOps grants: /r/o.json sha256=aa` : undefined));
  assert.ok(!("error" in viaFile) && viaFile.opsLine);
  assert.ok("error" in parseLaunch("You are the root.", () => undefined));
  assert.equal(stateLogFor("/a/codex/report-c-loop9.md"), "/a/codex/state-c-loop9.jsonl");
});

test("onClose argv arrays get {log} and {report}; malformed entries are dropped", () => {
  const settings = { loopPi: { onClose: [["loop-report", "{log}", "{report}"], "not-argv", [], ["wave-notify", "--report={report}"]] } };
  assert.deepEqual(onCloseCommands(settings, "/l.jsonl", "/r.md"), [["loop-report", "/l.jsonl", "/r.md"], ["wave-notify", "--report=/r.md"]]);
  assert.deepEqual(onCloseCommands({}, "/l", "/r"), []);
});

test("completion text prefers the run's output, then the summary; backlog titles parse", () => {
  assert.equal(completionText({ results: [{ output: "OUT" }], summary: "S" }), "OUT");
  assert.equal(completionText({ results: [{}], summary: "S" }), "S");
  assert.equal(runFailed({ success: true, results: [{ success: true }] }), false);
  assert.equal(runFailed({ results: [{ output: "OUT" }] }), false, "no outcome fields: not failed");
  assert.equal(runFailed({ success: false, results: [{ success: true }] }), true);
  assert.equal(runFailed({ results: [{ success: false }] }), true);
  assert.equal(runFailed({ results: [{ timedOut: true }] }), true);
  assert.equal(runFailed({ results: [{ success: true, outputPartial: true }] }), true);
  assert.equal(backlogTitle("File: x\n\nTask T-1 - Fix the thing\n=====\n"), "Fix the thing");
  assert.equal(backlogTitle("nothing"), undefined);
});
