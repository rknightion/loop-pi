// End-to-end proof of the dispatcher on the real pinned pi CLI and pi-subagents, with the faux
// provider standing in for every lane's model:
// - the dispatcher session runs in print mode on its in-process idle model and never calls a
//   network model (every assistant message in its own session is `loop-dispatch/idle`);
// - three file-disjoint tasks run as async lanes through pi-subagents' RPC spawn, at most two at a
//   time, with loop-guard's lane extension required and the push identity bound;
// - each landed batch gets a composed gate through a gate-runner lane; accepted tasks are marked
//   Done through the backlog CLI; loop-pi-audit closeout runs, then `close`, then `loopPi.onClose`.
// loop-state, backlog and gh are stubs on PATH; git, the bare origin and loop-pi-audit are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";
import { CLI_PATH, FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

const HERE = import.meta.dirname;
const AUDIT = join(HERE, "..", "..", "bin", "loop-pi-audit");

after(() => cleanupAll());

function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function laneReturn(fields: Record<string, unknown>): string {
  const body = { v: 2, lane: "L0", status: "complete", sha: null, landed: false, base: "b", check: "true", exit: 0, tail: "", ci: null, coderabbit: null, questions: [], ...fields };
  return `done\n\`\`\`lane-return\n${JSON.stringify(body)}\n\`\`\``;
}

test("the dispatcher runs three disjoint tasks through RPC lanes, a composed gate, Done and close", { timeout: 180_000 }, () => {
  const base = freshDir("dispatcher-e2e-");
  const git = (args: string[], cwd: string) => sh("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], cwd);
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  git(["init", "-q", "--bare", origin], base);
  git(["clone", "-q", origin, repo], base);
  mkdirSync(join(repo, "codex"));
  for (const dir of ["a", "b", "c"]) {
    mkdirSync(join(repo, dir));
    writeFileSync(join(repo, dir, "x.txt"), dir);
  }
  writeFileSync(join(repo, "LOOP.md"), "# Loop: fixture\ntier: routine\ngate: true\nci-required: none\nrelease-on-push: no\ndeploy-on-push: no\n");
  git(["add", "--", "LOOP.md", "a/x.txt", "b/x.txt", "c/x.txt"], repo);
  git(["commit", "-qm", "init", "--", "LOOP.md", "a/x.txt", "b/x.txt", "c/x.txt"], repo);
  git(["push", "-q", "origin", "HEAD:main"], repo);
  git(["remote", "set-head", "origin", "main"], repo);
  const head = git(["rev-parse", "HEAD"], repo);

  const goal = join(repo, "codex", "goal-2026-10-03-loop1.md");
  const report = join(repo, "codex", "report-2026-10-03-loop1.md");
  const log = join(repo, "codex", "state-2026-10-03-loop1.jsonl");
  writeFileSync(
    goal,
    [
      "# Goal",
      "## Run",
      "tier: routine",
      "root: dispatcher - three disjoint routine tasks",
      "root-model: none",
      "concurrency: 2",
      "## Envelope",
      "| task | acceptance check | owned files | gate | landing | agent | tier |",
      "|---|---|---|---|---|---|---|",
      "| T1 | a changed | a/** | true | lands-after-green | lane-worker-push | routine |",
      "| T2 | b changed | b/** | true | lands-after-green | lane-worker-push | routine |",
      "| T3 | c changed | c/** | true | lands-after-green | lane-worker-push | routine |",
      "## Authority",
      "push agents: lane-worker-push",
      "ops: none",
      "secret paths: none",
      "credential creation: none",
      "## Decisions",
      "## Notes",
    ].join("\n"),
  );

  // Stubs: loop-state appends framed JSON; backlog answers titles and records edits; gh lists no releases.
  const agentDir = freshDir("dispatcher-e2e-agent-");
  const stubs = freshDir("dispatcher-e2e-bin-");
  mkdirSync(join(agentDir, "bin"));
  mkdirSync(join(agentDir, "agents"));
  executable(
    join(agentDir, "bin", "loop-state"),
    [
      "#!/usr/bin/env python3",
      "import json, sys",
      "args = sys.argv[1:]",
      "assert args[0] == 'append' and args[2] == '--by', args",
      "event = json.load(sys.stdin)",
      "with open(args[1], 'a') as fh:",
      "    fh.write(json.dumps({'by': args[3], **event}) + '\\n')",
    ].join("\n"),
  );
  const backlogCalls = join(base, "backlog-calls.txt");
  executable(
    join(stubs, "backlog"),
    `#!/bin/sh\necho "$*" >> '${backlogCalls}'\nif [ "$1" = task ] && [ "$3" = --plain ]; then echo "Task $2 - Title of $2"; fi\n` +
      `if [ "$1" = task ] && [ "$2" = edit ]; then mkdir -p backlog/tasks && echo "status: Done" > "backlog/tasks/$3.md"; fi\n`,
  );
  executable(join(stubs, "gh"), "#!/bin/sh\necho '[]'\n");
  const onCloseOut = join(base, "on-close.txt");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [PI_SUBAGENTS_PACKAGE_DIR],
      subagents: { agentExcludeDirs: ["~/.agents"] },
      loopPi: { onClose: [["sh", "-c", `echo "$0 $1" >> '${onCloseOut}'`, "{log}", "{report}"]] },
    }),
  );
  for (const name of ["lane-worker-push", "gate-runner"]) {
    writeFileSync(
      join(agentDir, "agents", `${name}.md`),
      ["---", `name: ${name}`, "description: fixture", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "Fixture agent."].join("\n"),
    );
  }
  const faux = writeFauxScript([
    // First: a gate brief's header also names its tasks.
    { match: "Run the composed gate once", text: laneReturn({ lane: "G", exit: 0 }) },
    { match: "Task: T1 ", once: true, toolCalls: [{ name: "bash", args: { command: "printenv PI_SUBAGENT_EXTENSION_BINDINGS" } }] },
    { match: "loop-pi\\.guard/1", once: true, delayMs: 1500, text: laneReturn({ lane: "L1", sha: head, landed: true }) },
    { match: "Task: T2 ", once: true, delayMs: 1500, text: laneReturn({ lane: "L2", sha: head, landed: true }) },
    { match: "Task: T3 ", once: true, text: laneReturn({ lane: "L3", sha: head, landed: true }) },
  ]);

  // Uncommitted work outside backlog/ must stay out of the dispatcher's commit.
  writeFileSync(join(repo, "a", "x.txt"), "local edit");
  const runDir = join(base, "run");
  mkdirSync(runDir);
  const env = hermeticPiEnv({
    PATH: `${stubs}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENTS_TEMP_ROOT: freshDir("dispatcher-e2e-sub-"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LOOP_PI_FAUX_SCRIPT: faux,
    LOOP_PI_RUN_DIR: runDir,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  sh(AUDIT, ["begin", repo], repo, env);

  const launch = `You are the root. Read ${goal} in full. Write ${report} as the terminal action.`;
  const r = spawnSync(
    process.execPath,
    [CLI_PATH, "-p", "--provider", "loop-dispatch", "--model", "idle", "--no-tools", "--extension", FAUX_EXTENSION, "--extension", join(HERE, "index.ts"), launch],
    { cwd: repo, env, encoding: "utf8", timeout: 150_000 },
  );
  assert.equal(r.status, 0, `dispatcher exited ${r.status} ${r.signal}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /closed nothing-admissible; T1=accepted T2=accepted T3=accepted/);

  const events = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.every((e) => e.by === "dispatcher"));
  assert.deepEqual(events.slice(0, 4).map((e) => e.ev), ["open", "admit", "admit", "admit"]);
  assert.equal(events[0].root, "dispatcher");
  assert.equal(events.at(-1).ev, "close");
  assert.equal(events.at(-1).reason, "nothing-admissible");
  const work = events.filter((e) => e.ev === "dispatch" && e.agent === "lane-worker-push");
  assert.deepEqual(work.map((e) => e.task).sort(), ["T1", "T2", "T3"]);
  let live = 0;
  let peak = 0;
  const workRuns = new Set(work.map((e) => e.run));
  for (const e of events) {
    if (e.ev === "dispatch" && workRuns.has(e.run)) peak = Math.max(peak, ++live);
    if (e.ev === "return" && workRuns.has(e.run)) live--;
  }
  assert.equal(peak, 2, "two lanes ran at once, never three");
  const gates = events.filter((e) => e.ev === "gate");
  assert.ok(gates.length >= 1 && gates.every((g) => g.scope === "composed" && g.sha === head && g.exit === 0));
  assert.deepEqual(events.filter((e) => e.ev === "accept").map((e) => [e.task, e.accepted]).sort(), [["T1", true], ["T2", true], ["T3", true]]);
  assert.ok(events.findIndex((e) => e.ev === "gate") < events.findIndex((e) => e.ev === "accept"), "accept only after a green composed gate");

  const calls = readFileSync(backlogCalls, "utf8");
  for (const id of ["T1", "T2", "T3"]) assert.match(calls, new RegExp(`^task edit ${id} -s Done$`, "m"));
  assert.equal(readFileSync(onCloseOut, "utf8").trim(), `${log} ${report}`);
  const committed = git(["show", "--name-only", "--format=%s", "HEAD"], repo).split("\n");
  assert.match(committed[0], /^backlog: mark T1, T2, T3 Done$/);
  assert.deepEqual(committed.slice(1).filter(Boolean).sort(), ["backlog/tasks/T1.md", "backlog/tasks/T2.md", "backlog/tasks/T3.md"]);
  assert.equal(git(["status", "--porcelain", "--", "a"], repo), "M a/x.txt", "a local edit outside backlog/ stays uncommitted");
  assert.equal(git(["rev-parse", "origin/main"], repo), head, "the backlog commit is not pushed");
  assert.equal(git(["ls-remote", origin, "refs/heads/main"], repo).split("\t")[0], head);
  assert.ok(existsSync(join(runDir, "audit-after.json")), "loop-pi-audit closeout ran");

  const sessions = walk(join(agentDir, "sessions")).filter((p) => p.endsWith(".jsonl"));
  const t1 = sessions.find((p) => p.endsWith("session.jsonl") && readFileSync(p, "utf8").includes("printenv PI_SUBAGENT_EXTENSION_BINDINGS"));
  assert.ok(t1, "T1's lane session exists");
  const t1Text = readFileSync(t1!, "utf8");
  assert.match(t1Text, /\\"loop-pi\.guard\/1\\":\{\\"agent\\":\\"lane-worker-push\\",\\"runDir\\":\\"[^"\\]+\\"\}/, "the push identity and run dir reached the lane");
  assert.ok(t1Text.includes(runDir.replace(/^\/private/, "")), "the bound run dir is this run's");
  const parent = sessions.find((p) => !p.includes("/run-") && !p.includes("subagent-artifacts"));
  assert.ok(parent, "the dispatcher's own session exists");
  const turns = readFileSync(parent!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).message).filter((m) => m?.role === "assistant");
  assert.ok(turns.length > 0, "completions trigger turns, which the idle model answers");
  for (const m of turns) assert.equal(`${m.provider}/${m.model}`, "loop-dispatch/idle", "the dispatcher never calls a model");
});
