// Acceptance on the faux provider (S9): a candidate lane resumed after it returned still has its
// worktree, so the resume succeeds. pi-subagents alone removes a managed worktree when the run ends,
// and the resume then fails with "required managed worktree was removed". Run with loop-guard's root
// entry loaded before and after this extension: both rewrite the same `subagent` input (loop-guard
// the identity binding, this extension the cwd), and the lane must see both whichever runs first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_WORKTREES = join(HERE, "index.ts");
const GUARD_ROOT = join(HERE, "..", "loop-guard", "root.ts");
const RESUME_HELPER = join(HERE, "fixtures", "resume-helper.ts");

after(() => cleanupAll());

const BLOCK = '```lane-return\n{"v":2,"lane":"L1","status":"complete","sha":null,"landed":false,"base":"b","check":"c","exit":0,"tail":"ok","ci":null,"coderabbit":null,"questions":[]}\n```';

async function resumeAfterReturn(order: "guard-first" | "worktrees-first") {
  const repo = freshDir("lw-e2e-repo-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  const runDir = freshDir("lw-e2e-run-");
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const out = freshDir("lw-e2e-out-");
  const agentDir = freshDir("lw-e2e-agent-");
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(
    join(agentDir, "agents", "lane-worker.md"),
    ["---", "name: lane-worker", "description: Test candidate lane", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker"].join("\n"),
  );
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "Lane: L1 · Task: T1 · Tier: guarded\nLanding: returns candidate\nObjective: CHILD_WORK", isolation: "worktree" } }],
    },
    {
      match: "CHILD_WORK",
      once: true,
      toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/pwd.txt' && printf %s "$PI_SUBAGENT_EXTENSION_BINDINGS" > '${out}/bindings.txt' && echo x > lane.txt && git add lane.txt && git commit -qm lane-candidate && echo COMMITTED` } }],
    },
    { match: "COMMITTED", once: true, text: `done\n${BLOCK}` },
    { match: "RESUME_NOW", once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "LAST_RUN", message: "RESUME_CHECK" } }] },
    { match: "RESUME_CHECK", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/resume.txt' && git log -1 --format=%s >> '${out}/resume.txt' && echo RESUMED_IN` } }] },
    { match: "RESUMED_IN", once: true, text: "RESUMED_OK" },
    { match: ".*", text: "ok" },
  ]);
  const extensions = order === "guard-first" ? [FAUX_EXTENSION, RESUME_HELPER, GUARD_ROOT, LANE_WORKTREES] : [FAUX_EXTENSION, RESUME_HELPER, LANE_WORKTREES, GUARD_ROOT];
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  const session = startPiRpc({
    extensions,
    fauxScriptPath: script,
    agentDir,
    subagentTempRoot: freshDir("lw-e2e-sub-"),
    cwd: repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
  else process.env.LOOP_PI_RUN_DIR = previous;
  const notifies = () => session.events.filter((e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "subagent-notify");
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE" });
    await waitForCondition(() => (notifies().length >= 1 ? true : undefined), 60_000, 200);
    await session.waitFor((e) => e.type === "agent_settled", 30_000);
    const worktree = join(runDir, "worktrees", "L1");
    assert.equal(readFileSync(join(out, "pwd.txt"), "utf8").trim(), realpathSync(worktree), `${order}: the lane ran in the loop-owned worktree`);
    assert.equal(JSON.parse(readFileSync(join(out, "bindings.txt"), "utf8"))["loop-pi.guard/1"].agent, "lane-worker", `${order}: loop-guard's identity binding reached the lane`);
    assert.ok(existsSync(worktree), `${order}: the worktree outlives the run`);
    assert.equal(execFileSync("git", ["log", "-1", "--format=%s", `loop/${basename(runDir)}/L1`], { cwd: repo, encoding: "utf8" }).trim(), "lane-candidate");

    // The root takes a while to look at the candidate. pi-subagents removed its own worktree at run end,
    // so the gap's length never mattered; the worktree here is the loop's until land or park.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const before = session.events.length;
    session.send({ id: "p2", type: "prompt", message: "RESUME_NOW" });
    const resumed = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent" && session.events.indexOf(e) >= before, 60_000);
    assert.equal(resumed.isError ?? false, false, `${order}: the resume launched: ${JSON.stringify(resumed.result).slice(0, 400)}`);
    await waitForCondition(() => (notifies().some((e) => /RESUMED_OK/.test(String((e.message as { content?: unknown }).content))) ? true : undefined), 60_000, 200);
    const [where, last] = readFileSync(join(out, "resume.txt"), "utf8").trim().split("\n");
    assert.equal(where, realpathSync(worktree), `${order}: the resumed lane is back in its worktree`);
    assert.equal(last, "lane-candidate", `${order}: with its candidate commit`);
  } finally {
    await session.close();
  }
}

test("S9 acceptance: a candidate lane resumed after its return succeeds (loop-guard root loaded first)", async () => {
  await resumeAfterReturn("guard-first");
});

test("S9 acceptance: the same with lane-worktrees loaded before loop-guard's root", async () => {
  await resumeAfterReturn("worktrees-first");
});
