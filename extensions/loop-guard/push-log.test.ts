// SEAMS S1 push log, end to end on the pinned pi CLI with the faux provider: a successful
// `git push` from the root (tool_execution_end) or from a lane (the lane guard's post-exec hook)
// appends one line per updated ref to `$LOOP_PI_RUN_DIR/push-log.jsonl`, with `old` read from the
// remote before the push. A failed push, or a run without the protocol marker, writes nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import laneExtension from "./lane.ts";
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

test("lane push log: a push-granted async lane logs its pushes with its agent and lane id", { timeout: 90_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const home = freshDir("push-log-lane-home-");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  const config = JSON.parse(readFileSync(new URL("../../home/extensions/subagent/config.json", import.meta.url), "utf8"));
  writeFileSync(join(home, "extensions", "subagent", "config.json"), JSON.stringify(config));
  writeFileSync(
    join(home, "agents", "lane-worker-push.md"),
    ["---", "name: lane-worker-push", "description: Push log test", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "Test worker."].join("\n"),
  );
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "lane-worker-push", task: "Lane: L7 · Task: T-3 · Tier: routine\nCHILD_PUSH", async: true } }],
    },
    { match: "CHILD_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/loop/L7" } }] },
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
    const head = git(repo, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/loop/L7"), head);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      { ...lines[0], ts: "" },
      { v: 1, ts: "", actor: "lane", agent: "lane-worker-push", lane: "L7", repo: realpathSync(repo), remote: "origin", ref: "refs/heads/loop/L7", old: null, new: head },
    );
  } finally {
    await session.close();
  }
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
