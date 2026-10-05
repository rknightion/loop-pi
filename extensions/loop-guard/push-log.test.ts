// SEAMS S1 push log, end to end on the pinned pi CLI with the faux provider: a successful
// `git push` from the root (tool_execution_end) or from a lane (the lane guard's post-exec hook)
// appends one line per updated ref to `$LOOP_PI_RUN_DIR/push-log.jsonl`, with `old` read from the
// remote before the push. A failed push, or a run without the protocol marker, writes nothing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import laneExtension from "./lane.ts";
import { hiddenPush, planPushes, recordPushes, unloggedPushRefusal } from "./push-log.ts";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAll,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "./rpc-test-helpers.ts";

after(cleanupAll);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com"];

/** A repository with one commit and a bare `origin`, plus a run dir (with the marker unless legacy). */
function fixture(legacy = false) {
  const repo = freshDir("push-log-repo-");
  const remote = freshDir("push-log-remote-");
  const runDir = freshDir("push-log-run-");
  git(repo, "init", "-b", "main");
  git(remote, "init", "--bare");
  git(repo, ...IDENTITY, "commit", "--allow-empty", "-m", "one");
  git(repo, "remote", "add", "origin", remote);
  if (!legacy) writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  return { repo, remote, runDir, log: join(runDir, "push-log.jsonl") };
}

function readLog(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const ISO_SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

const EXEC_PUSHES = [
  "find . -exec git push origin main \\;",
  "find . -execdir sh -c 'git pu\\sh origin main' \\;",
  "git rebase -x 'git push origin main' HEAD~1",
  'git rebase --exec="git pu\\sh origin main" HEAD~1',
  `uv run python -c "import subprocess; subprocess.run(['git','push','origin','main'])"`,
  `deno eval "new Deno.Command('git', {args: ['push', 'origin', 'main']}).outputSync()"`,
  `awk 'BEGIN { system("git push origin main") }'`,
  "watch -n 1 git push origin main",
  "parallel git push origin ::: main",
];

test("root push log: one line per updated ref, old read before the push, nothing for a failed push", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const first = git(repo, "rev-parse", "HEAD");
  const script = writeFauxScript([
    { match: "PUSH_ONE", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
    {
      match: "PUSH_TWO",
      once: true,
      toolCalls: [{ name: "bash", args: { command: `git ${IDENTITY.join(" ")} commit --allow-empty -m two && git push origin main HEAD:refs/heads/feature` } }],
    },
    { match: "PUSH_FAILS", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin refs/heads/missing:refs/heads/other" } }] },
    { match: "PUSH_NOOP", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin main" } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  const bashEnds = () => session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
  const prompt = async (message: string, n: number) => {
    session.send({ id: message, type: "prompt", message });
    await waitForCondition(() => (bashEnds().length >= n ? true : undefined), 30_000);
    await session.waitFor((e) => e.type === "agent_end" && session.events.indexOf(e) > session.events.indexOf(bashEnds()[n - 1]), 30_000);
  };
  try {
    await prompt("PUSH_ONE", 1);
    assert.equal(bashEnds()[0].isError, false, JSON.stringify(bashEnds()[0]));
    let lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [one] = lines;
    assert.match(String(one.ts), ISO_SECONDS);
    assert.deepEqual(
      { ...one, ts: "" },
      { v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo), remote: "origin", ref: "refs/heads/main", old: null, new: first },
    );

    await prompt("PUSH_TWO", 2);
    assert.equal(bashEnds()[1].isError, false, JSON.stringify(bashEnds()[1]));
    const second = git(repo, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), second);
    lines = readLog(log);
    assert.equal(lines.length, 3, JSON.stringify(lines));
    const byRef = Object.fromEntries(lines.slice(1).map((l) => [l.ref, l]));
    assert.deepEqual([byRef["refs/heads/main"]?.old, byRef["refs/heads/main"]?.new], [first, second]);
    assert.deepEqual([byRef["refs/heads/feature"]?.old, byRef["refs/heads/feature"]?.new], [null, second]);

    await prompt("PUSH_FAILS", 3);
    assert.equal(bashEnds()[2].isError, true, "the push of a missing ref must fail");
    await prompt("PUSH_NOOP", 4);
    assert.equal(bashEnds()[3].isError, false);
    assert.equal(readLog(log).length, 3, "a failed push and an up-to-date push write nothing");
  } finally {
    await session.close();
  }
});

test("root push log: a run without the protocol marker writes no push log", { timeout: 60_000 }, async () => {
  const { repo, runDir, log } = fixture(true);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "PUSH_LEGACY", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "PUSH_LEGACY" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    assert.equal(existsSync(log), false);
  } finally {
    await session.close();
  }
});

/** An agent home whose `lane-worker-push` agent runs on the faux provider with only `bash`. */
function pushLaneHome(): string {
  const home = freshDir("push-log-lane-home-");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  const config = JSON.parse(readFileSync(new URL("../../home/extensions/subagent/config.json", import.meta.url), "utf8"));
  // The installer expands the home template; fixtures must use their own disposable root.
  config.worktreeBaseDir = freshDir("push-log-managed-worktrees-");
  writeFileSync(join(home, "extensions", "subagent", "config.json"), JSON.stringify(config));
  writeFileSync(
    join(home, "agents", "lane-worker-push.md"),
    ["---", "name: lane-worker-push", "description: Push log test", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "Test worker."].join("\n"),
  );
  return home;
}

test("lane push log: a push-granted async managed-worktree lane logs its pushes with its agent and lane id", { timeout: 90_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const before = git(repo, "rev-parse", "HEAD");
  const begin = runAudit(runDir, "begin", realpathSync(repo));
  assert.equal(begin.status, 0, begin.output);
  const home = pushLaneHome();
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "lane-worker-push", task: "Lane: L7 · Task: T-3 · Tier: routine\nCHILD_PUSH", async: true, worktree: true } }],
    },
    { match: "CHILD_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: `git ${[...IDENTITY, "-c", "commit.gpgsign=false"].join(" ")} commit --allow-empty -m lane-work && git push origin HEAD:refs/heads/main` } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: home,
    subagentTempRoot: freshDir(),
    cwd: repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "SPAWN_LANE" });
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
    const lines = await waitForCondition(() => {
      const found = readLog(log);
      return found.length ? found : undefined;
    }, 45_000);
    const head = git(remote, "rev-parse", "refs/heads/main");
    assert.notEqual(head, before, "the managed worktree pushed its own commit");
    assert.equal(git(repo, "rev-parse", "HEAD"), before, "the main checkout stayed on its original commit");
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      { ...lines[0], ts: "" },
      { v: 1, ts: "", actor: "lane", agent: "lane-worker-push", lane: "L7", repo: realpathSync(repo), remote: "origin", ref: "refs/heads/main", old: before, new: head },
    );
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 0, closeout.output);
    assert.doesNotMatch(closeout.output, /UNGRANTED/);
    assert.match(closeout.output, /refs\/heads\/main.*GRANTED/);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------------------------
// A push the push log cannot see must not land (the subprocess-push regression): a granted lane ran
// `git push` from a Python heredoc, the remote's default branch moved with no push-log line, and the
// closeout audit marked the move UNGRANTED. The lane guard refuses such a push and names the literal
// form; the lane's literal retry is logged, so the real audit passes.
// ---------------------------------------------------------------------------------------------

const AUDIT = fileURLToPath(new URL("../../bin/loop-pi-audit", import.meta.url));

/** Run the closeout audit CLI with a stub `gh` (these scratch remotes have no GitHub releases). */
function runAudit(runDir: string, ...args: string[]): { status: number; output: string } {
  const bin = freshDir("push-log-audit-bin-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("python3", [AUDIT, ...args, "--run-dir", runDir], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOOP_PI_RUN_DIR: runDir },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const COMMIT_TWO = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "two"];
const SUBPROCESS_PUSH = [
  "python3 - <<'PY'",
  "import subprocess",
  `subprocess.run([${["git", ...COMMIT_TWO].map((a) => `'${a}'`).join(",")}],check=True)`,
  "subprocess.run(['git','push','origin','main'],check=True)",
  "PY",
].join("\n");

test("lane push log: a granted lane's subprocess push is refused, so the closeout audit finds no unlogged move", { timeout: 90_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  const realRepo = realpathSync(repo);
  const begin = runAudit(runDir, "begin", realRepo);
  assert.equal(begin.status, 0, begin.output);
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "lane-worker-push", task: "Lane: L16 · Task: T-1 · Tier: routine\nCHILD_SUBPROCESS_PUSH", async: true } }],
    },
    { match: "CHILD_SUBPROCESS_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: SUBPROCESS_PUSH } }] },
    {
      match: "push log cannot see",
      once: true,
      toolCalls: [{ name: "bash", args: { command: `git ${COMMIT_TWO.join(" ")} && git push origin main` } }],
    },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: pushLaneHome(),
    subagentTempRoot: freshDir(),
    cwd: repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "SPAWN_LANE" });
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
    // The lane is done when the remote holds its commit and, for a logged push, the log has its line.
    await waitForCondition(() => (git(remote, "log", "-1", "--format=%s", "refs/heads/main") === "two" ? true : undefined), 45_000);
    await waitForCondition(() => (readLog(log).length ? true : undefined), 10_000).catch(() => undefined);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.doesNotMatch(closeout.output, /UNGRANTED/, closeout.output);
    assert.equal(closeout.status, 0, closeout.output);
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      [lines[0].agent, lines[0].lane, lines[0].ref, lines[0].new],
      ["lane-worker-push", "L16", "refs/heads/main", git(remote, "rev-parse", "refs/heads/main")],
    );
  } finally {
    await session.close();
  }
});

// Remaining root-only gap: root.ts is outside this lane's ownership. It calls planPushes but
// not unloggedPushRefusal for bash, and its watch tools plan no pushes. This replay proves the
// precise inline-interpreter case still lands without a ledger entry, but the audit refuses it.
test("remaining root gap: an inline-interpreter push lands unlogged and closeout refuses it", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const begin = runAudit(runDir, "begin", realpathSync(repo));
  assert.equal(begin.status, 0, begin.output);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "ROOT_HIDDEN_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: SUBPROCESS_PUSH } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-root-gap-home-"), subagentTempRoot: freshDir(), cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "ROOT_HIDDEN_PUSH" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    assert.equal(git(remote, "log", "-1", "--format=%s", "refs/heads/main"), "two");
    assert.equal(readLog(log).length, 0);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 1, closeout.output);
    assert.match(closeout.output, /UNGRANTED/);
  } finally {
    await session.close();
  }
});

test("push log: exec-wrapper pushes are hidden and refused on granted lanes", () => {
  for (const command of EXEC_PUSHES) {
    assert.equal(hiddenPush(command), true, command);
    assert.match(unloggedPushRefusal(command, "bash") ?? "", /push log cannot see it/, command);
    assert.match(unloggedPushRefusal(command, "watch_process") ?? "", /not recorded/, command);
  }
});

test("push log: a push the log cannot attribute is hidden; a literal push is not", () => {
  const hidden = [
    SUBPROCESS_PUSH,
    `python3 -c "import subprocess; subprocess.run(['git', 'push', 'origin', 'main'], check=True)"`,
    `node -e "require('child_process').execSync('git -C repo push origin HEAD')"`,
    `perl -e 'system("gh pr merge 7 --merge")'`,
    "git -c alias.ship='!git push origin main' ship",
  ];
  for (const command of hidden) assert.equal(hiddenPush(command), true, command);
  const attributed = [
    "git push origin main",
    'bash -c "git push origin main"',
    "env GIT_TRACE=1 git push",
    "cd sub && git push origin HEAD:refs/heads/main",
    'git commit -m "explain why git push was refused"',
    `python3 -c "import subprocess; subprocess.run(['git', 'status'])"`,
  ];
  for (const command of attributed) assert.equal(hiddenPush(command), false, command);
  assert.equal(unloggedPushRefusal("git push origin main", "bash"), undefined);
  assert.match(unloggedPushRefusal(SUBPROCESS_PUSH, "bash") ?? "", /push log cannot see it/);
  assert.match(unloggedPushRefusal("git push origin main", "watch_process") ?? "", /watch_process is not recorded/);
  assert.equal(unloggedPushRefusal("npm test", "watch_process"), undefined);
});

test("lane push log: the post-exec hook reads the run dir from the binding when the environment has none", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const saved = { run: process.env.LOOP_PI_RUN_DIR, bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS };
  delete process.env.LOOP_PI_RUN_DIR;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "loop-pi.guard/1": { agent: "complex-worker-push", runDir } });
  try {
    const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
    laneExtension({ on: (event: string, h: any) => void handlers.set(event, [...(handlers.get(event) ?? []), h]) } as any);
    const ctx = { cwd: repo, ui: { notify: () => {} } };
    const fire = async (event: string, payload: Record<string, unknown>) => {
      let last: any;
      for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...payload }, ctx);
      return last;
    };
    await fire("before_agent_start", { prompt: "Lane: C2 · Task: T-9 · Tier: guarded\nObjective: x", systemPrompt: "" });
    const watched = await fire("tool_call", { toolCallId: "watch", toolName: "watch_process", input: { command: "git pu\\sh origin HEAD:refs/heads/main" } });
    assert.equal(watched?.block, true, JSON.stringify(watched));
    assert.match(watched.reason, /watch_process is not recorded/);
    assert.equal(readLog(log).length, 0);
    for (const command of EXEC_PUSHES) {
      const refusal = await fire("tool_call", { toolCallId: "wrapped", toolName: "bash", input: { command } });
      assert.equal(refusal?.block, true, command);
      assert.match(refusal.reason, /push log cannot see it/, command);
    }
    unlinkSync(join(runDir, "loop-pi-proto"));
    const afterDeletion = await fire("tool_call", { toolCallId: "deleted", toolName: "watch_process", input: { command: "git push origin main" } });
    assert.equal(afterDeletion?.block, true, "observed protocol cannot be downgraded by marker deletion");
    assert.match(afterDeletion.reason, /watch_process is not recorded/);
    const command = "git push origin HEAD:refs/heads/main";
    const verdict = await fire("tool_call", { toolCallId: "t1", toolName: "bash", input: { command } });
    assert.equal(verdict?.block ?? false, false, verdict?.reason);
    git(repo, "push", "origin", "HEAD:refs/heads/main");
    await fire("tool_execution_end", { toolCallId: "t1", toolName: "bash", isError: false, result: { content: [] } });
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].actor, "lane");
    assert.equal(lines[0].agent, "complex-worker-push");
    assert.equal(lines[0].lane, "C2");
    assert.equal(lines[0].old, null);
    assert.equal(lines[0].new, git(repo, "rev-parse", "HEAD"));
  } finally {
    if (saved.run === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = saved.run;
    if (saved.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved.bindings;
  }
});

// ---------------------------------------------------------------------------------------------
// The logged range is the root's or lane's own push: `new` is the local commit the push sent, and
// a line is written only when the remote ref equals it afterwards (SEAMS S1, security review M1).
// ---------------------------------------------------------------------------------------------

const NO_SIGN = ["-c", "commit.gpgsign=false"];

test("root push log: a foreign push between the root's push and tool_execution_end is not inside the logged range", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const first = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "two");
  const other = freshDir("push-log-foreign-");
  git(other, "clone", "-q", remote, ".");
  // Runs after the root's push, inside the same bash call, where the guard cannot see it.
  const foreign = join(freshDir("push-log-foreign-script-"), "foreign.sh");
  writeFileSync(
    foreign,
    [
      "set -e",
      `cd '${other}'`,
      "git fetch -q origin",
      "git reset -q --hard origin/main",
      `git ${[...IDENTITY, ...NO_SIGN].join(" ")} commit -q --allow-empty -m foreign`,
      "git push -q origin HEAD:refs/heads/main",
    ].join("\n"),
  );
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "PUSH_RACE", once: true, toolCalls: [{ name: "bash", args: { command: `git push origin main && sh '${foreign}'` } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "PUSH_RACE" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    const foreignSha = git(other, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), foreignSha, "the foreign push landed after the root's");
    for (const line of readLog(log)) {
      assert.notEqual(line.new, foreignSha, JSON.stringify(line));
      const inRange = (() => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", foreignSha, String(line.new)], { cwd: remote, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      assert.equal(inRange, false, `the foreign commit is inside the logged range ${line.old}..${line.new}`);
    }
    assert.notEqual(first, foreignSha);
  } finally {
    await session.close();
  }
});

test("push log: the refspec forms resolve to the local commit each push sent", { timeout: 60_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const meta = { runDir, actor: "root" as const, agent: null, lane: null };
  const commit = (m: string) => {
    git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", m);
    return git(repo, "rev-parse", "HEAD");
  };
  const run = async (command: string) => {
    const before = readLog(log).length;
    const plans = await planPushes(command, repo);
    execFileSync("/bin/sh", ["-c", command], { cwd: repo, stdio: "ignore", timeout: 20_000 });
    await recordPushes(plans, meta);
    return readLog(log).slice(before).map((l) => [l.ref, l.old, l.new]);
  };
  const c1 = git(repo, "rev-parse", "HEAD");
  assert.deepEqual(await run("git push -q --set-upstream origin main"), [["refs/heads/main", null, c1]]);
  const c2 = commit("c2");
  assert.deepEqual(await run("git push -q"), [["refs/heads/main", c1, c2]]);
  const c3 = commit("c3");
  assert.deepEqual(await run("git push -q origin main"), [["refs/heads/main", c2, c3]]);
  const c4 = commit("c4");
  assert.deepEqual(await run("git push -q origin HEAD:main"), [["refs/heads/main", c3, c4]]);
  git(repo, "branch", "topic", c3);
  assert.deepEqual(await run("git push -q origin +topic:refs/heads/review"), [["refs/heads/review", null, c3]]);
  assert.deepEqual(await run("git push -q origin main"), [], "an up-to-date push logs nothing");
  // A commit made earlier in the same command is the commit the push sent.
  const quoted = [...IDENTITY, ...NO_SIGN].join(" ");
  const lines = await run(`git checkout -q -b fresh && git ${quoted} commit -q --allow-empty -m c5 && git push -q -u origin fresh`);
  assert.deepEqual(lines, [["refs/heads/fresh", null, git(repo, "rev-parse", "HEAD")]]);
});

test("push log: a push from a linked worktree records the main checkout as repo", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const wt = join(freshDir("push-log-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", "lane-branch", wt);
  git(wt, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "lane work");
  const plans = await planPushes("git push origin lane-branch", wt);
  git(wt, "push", "-q", "origin", "lane-branch");
  await recordPushes(plans, { runDir, actor: "lane", agent: "lane-worker-push", lane: "L1" });
  const lines = readLog(log);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].repo, realpathSync(repo));
  assert.equal(lines[0].new, git(wt, "rev-parse", "HEAD"));
});

test("push log: an escaped literal push is planned and recorded", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const command = "git pu\\sh origin HEAD:refs/heads/main";
  const plans = await planPushes(command, repo);
  assert.equal(plans.length, 1);
  execFileSync("/bin/sh", ["-c", command], { cwd: repo, timeout: 10_000 });
  assert.equal(await recordPushes(plans, { runDir, actor: "lane", agent: "lane-worker-push", lane: "L2" }), 1);
  assert.equal(readLog(log)[0].new, git(repo, "rev-parse", "HEAD"));
});

test("lane push log: a linked worktree push grants closeout under both snapshot paths", { timeout: 30_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const wt = join(freshDir("push-log-audit-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", "lane-work", wt);
  assert.equal(runAudit(runDir, "begin", wt).status, 0);
  assert.equal(runAudit(runDir, "add", realpathSync(repo)).status, 0);
  const saved = { ...process.env };
  delete process.env.LOOP_PI_RUN_DIR;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "loop-pi.guard/1": { agent: "lane-worker-push", runDir } });
  process.env.PI_CODING_AGENT_DIR = freshDir("push-log-audit-home-");
  try {
    const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
    laneExtension({ on: (event: string, h: any) => void handlers.set(event, [...(handlers.get(event) ?? []), h]) } as any);
    const fire = async (event: string, payload: Record<string, unknown>) => {
      let last: any;
      for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...payload }, { cwd: wt });
      return last;
    };
    await fire("before_agent_start", { prompt: "Lane: W1 · Tier: guarded\nfixture" });
    git(wt, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "worktree change");
    const command = "git push origin HEAD:refs/heads/main";
    const verdict = await fire("tool_call", { toolCallId: "wt-push", toolName: "bash", input: { command } });
    assert.equal(verdict?.block ?? false, false, verdict?.reason);
    git(wt, "push", "-q", "origin", "HEAD:refs/heads/main");
    await fire("tool_execution_end", { toolCallId: "wt-push", toolName: "bash", isError: false, result: { content: [] } });
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual([lines[0].repo, lines[0].agent, lines[0].lane, lines[0].new],
      [realpathSync(repo), "lane-worker-push", "W1", git(wt, "rev-parse", "HEAD")]);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 0, closeout.output);
    assert.doesNotMatch(closeout.output, /UNGRANTED/);
    assert.match(closeout.output, /refs\/heads\/main.*GRANTED/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ---------------------------------------------------------------------------------------------
// `gh pr merge` lands a pull request the same way a push does (security review M2a): old is the
// remote base branch before, new the PR's merge commit, logged only when the PR is MERGED and the
// remote base branch equals that commit. A fake `gh` on PATH stands in for GitHub.
// ---------------------------------------------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", ["-c", "user.name=gh", "-c", "user.email=gh@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: process.env.FAKE_GH_WORK, encoding: "utf8" }).trim();
if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1].split(",");
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((f) => [f, state[f] ?? null]))) + "\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  if (args.includes("--auto")) {
    process.stdout.write("auto-merge enabled\\n");
  } else {
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-B", state.baseRefName, "origin/" + state.baseRefName);
    git("merge", "-q", "--no-ff", "-m", "Merge pull request #" + state.number, "origin/" + state.headRefName);
    git("push", "-q", "origin", "HEAD:refs/heads/" + state.baseRefName);
    state.state = "MERGED";
    state.mergeCommit = { oid: git("rev-parse", "HEAD") };
    writeFileSync(statePath, JSON.stringify(state));
  }
} else {
  process.stderr.write("fake gh: unsupported " + args.join(" ") + "\\n");
  process.exit(1);
}
`;

/** The push-log fixture plus a pushed `main`, an open PR #7 from `feature`, and a fake `gh`. */
function prFixture() {
  const f = fixture();
  git(f.repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(f.repo, "checkout", "-q", "-b", "feature");
  git(f.repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "feature work");
  git(f.repo, "push", "-q", "origin", "feature");
  const bin = freshDir("push-log-gh-bin-");
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const work = freshDir("push-log-gh-work-");
  git(work, "clone", "-q", f.remote, ".");
  const state = join(freshDir("push-log-gh-state-"), "pr.json");
  writeFileSync(
    state,
    JSON.stringify({ number: 7, url: "https://github.com/acme/widget/pull/7", baseRefName: "main", headRefName: "feature", state: "OPEN", mergeCommit: null }),
  );
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_WORK: work };
  return { ...f, env, mainBefore: git(f.remote, "rev-parse", "refs/heads/main") };
}

test("root push log: a successful gh pr merge logs the base branch move to the PR's merge commit", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log, env, mainBefore } = prFixture();
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "MERGE_AUTO", once: true, toolCalls: [{ name: "bash", args: { command: "gh pr merge 7 --auto --merge" } }] },
      { match: "MERGE_NOW", once: true, toolCalls: [{ name: "bash", args: { command: "gh pr merge 7 --merge --delete-branch" } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir, ...env },
  });
  const bashEnds = () => session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
  const prompt = async (message: string, n: number) => {
    session.send({ id: message, type: "prompt", message });
    await waitForCondition(() => (bashEnds().length >= n ? true : undefined), 30_000);
    await session.waitFor((e) => e.type === "agent_end" && session.events.indexOf(e) > session.events.indexOf(bashEnds()[n - 1]), 30_000);
  };
  try {
    await prompt("MERGE_AUTO", 1);
    assert.equal(bashEnds()[0].isError, false, JSON.stringify(bashEnds()[0]));
    assert.deepEqual(readLog(log), [], "an auto-merge that has not merged yet logs nothing");
    await prompt("MERGE_NOW", 2);
    assert.equal(bashEnds()[1].isError, false, JSON.stringify(bashEnds()[1]));
    const merged = git(remote, "rev-parse", "refs/heads/main");
    assert.notEqual(merged, mainBefore);
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      { ...lines[0], ts: "" },
      { v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo), remote: "origin", ref: "refs/heads/main", old: mainBefore, new: merged },
    );
  } finally {
    await session.close();
  }
});

test("lane push log: an ops release lane's gh pr merge is logged with its agent and lane id", { timeout: 30_000 }, async () => {
  const { repo, remote, runDir, log, env, mainBefore } = prFixture();
  const entry = { surface: "release:widget", kind: "release", allow: ["gh pr merge [0-9]+ --merge"] };
  const saved = { ...process.env };
  Object.assign(process.env, env, {
    LOOP_PI_RUN_DIR: runDir,
    PI_CODING_AGENT_DIR: freshDir("push-log-lane-agent-"),
    LOOP_PI_OPS_LOCK_DIR: freshDir("push-log-ops-locks-"),
    PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "loop-pi.guard/1": { agent: "ops", surface: entry.surface, entry, runDir } }),
  });
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  try {
    laneExtension({ on: (event: string, h: any) => void handlers.set(event, [...(handlers.get(event) ?? []), h]) } as any);
    const ctx = { cwd: repo, ui: { notify: () => {} } };
    const fire = async (event: string, payload: Record<string, unknown>) => {
      let last: any;
      for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...payload }, ctx);
      return last;
    };
    await fire("before_agent_start", { prompt: "Lane: R1 · Task: T-4 · Tier: guarded\nObjective: merge", systemPrompt: "" });
    const command = "gh pr merge 7 --merge";
    const verdict = await fire("tool_call", { toolCallId: "m1", toolName: "bash", input: { command } });
    assert.equal(verdict?.block ?? false, false, verdict?.reason);
    execFileSync("/bin/sh", ["-c", command], { cwd: repo, stdio: "ignore", env: process.env, timeout: 20_000 });
    await fire("tool_execution_end", { toolCallId: "m1", toolName: "bash", isError: false, result: { content: [] } });
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      [lines[0].actor, lines[0].agent, lines[0].lane, lines[0].ref, lines[0].old, lines[0].new],
      ["lane", "ops", "R1", "refs/heads/main", mainBefore, git(remote, "rev-parse", "refs/heads/main")],
    );
  } finally {
    for (const h of handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown" }, {});
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
