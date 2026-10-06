// Real pi/faux regression: checkpoints under every retained landing form survive return and quit,
// resume the original context/candidate, then release only on explicit root closeout. Both extension
// orders are exercised. All homes, repositories and child state are disposable; no live model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

after(() => cleanupAll());
const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "loop-guard", "root.ts");
const WORKTREES = join(HERE, "index.ts");
const HELPERS = [join(HERE, "fixtures", "resume-helper.ts"), join(HERE, "fixtures", "release-helper.ts")];

for (const reload of [false, true]) {
  test(`nested cwd native resume refuses an externally linked committed parent (reload=${reload})`, { timeout: 120_000 }, async () => {
    const repo = freshDir("lw-nested-repo-");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "seed"), "seed");
    git(repo, "add", "sub/seed");
    git(repo, "commit", "-qm", "nested-base");
    const runDir = freshDir("lw-nested-run-");
    writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
    const out = freshDir("lw-nested-out-");
    const outside = freshDir("lw-nested-external-");
    const agentDir = freshDir("lw-nested-home-");
    const subRoot = freshDir("lw-nested-sub-");
    mkdirSync(join(agentDir, "agents"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
    writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
      "---", "name: lane-worker", "description: Nested cwd regression", "tools: bash", "extensions: []",
      `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker",
    ].join("\n"));
    const script = writeFauxScript([
      { match: "SPAWN_NESTED", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "Lane: L1 · Task: T1 · Tier: guarded\nLanding: returns candidate\nObjective: NESTED_WORK", worktree: true, cwd: join(repo, "sub") } }] },
      { match: "NESTED_WORK", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/cwd' && echo NESTED_STARTED` } }] },
      { match: "NESTED_STARTED", once: true, text: "NESTED_CHECKPOINT" },
      { match: "RESUME_NESTED", once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "LAST_RUN", message: "CHECK_NESTED_CWD" } }] },
      { match: "CHECK_NESTED_CWD", once: true, toolCalls: [{ name: "bash", args: { command: "pwd > escaped-resume && echo ESCAPED_CWD" } }] },
      { match: "ESCAPED_CWD", once: true, text: "UNSAFE_RESUME" },
      { match: ".*", text: "ok" },
    ]);
    const opts = { extensions: [FAUX_EXTENSION, ...HELPERS, WORKTREES], fauxScriptPath: script, agentDir, subagentTempRoot: subRoot, cwd: repo, sessionArgs: [] as string[], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: runDir } };
    let session = startPiRpc(opts);
    const evidence: Record<string, unknown> = { reload };
    try {
      session.send({ id: "spawn", type: "prompt", message: "SPAWN_NESTED" });
      await waitForCondition(() => session.events.some((e) => e.type === "message_end" && JSON.stringify(e.message).includes("NESTED_CHECKPOINT")) ? true : undefined, 60_000);
      await session.waitFor((e) => e.type === "agent_settled", 30_000);
      const cwd = readFileSync(join(out, "cwd"), "utf8").trim();
      const path = dirname(cwd);
      assert.equal(dirname(path), realpathSync(join(runDir, "worktrees")));
      const launch = session.events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent")!;
      const details = (launch.result as { details: { runId?: string; asyncId?: string } }).details;
      const runId = details.runId ?? details.asyncId;
      const status = JSON.parse(readFileSync(join(subRoot, "async-subagent-runs", runId!, "status.json"), "utf8"));
      const childSession = status.steps[0].sessionFile;
      const originalContext = readFileSync(childSession, "utf8");
      rmSync(cwd, { recursive: true });
      symlinkSync(outside, cwd, "dir");
      git(path, "add", "sub");
      git(path, "commit", "-qm", "linked-parent");
      assert.equal(git(path, "status", "--porcelain"), "", "even a clean committed symlink is unsafe");
      if (reload) {
        session.send({ id: "state", type: "get_state" });
        const state = await session.waitFor((e) => e.type === "response" && e.id === "state", 10_000);
        const sessionFile = (state.data as { sessionFile: string }).sessionFile;
        await session.close();
        session = startPiRpc({ ...opts, sessionArgs: ["--session", sessionFile] });
      }
      const start = session.events.length;
      session.send({ id: "resume", type: "prompt", message: "RESUME_NESTED" });
      const refused = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent" && session.events.indexOf(e) >= start, 60_000);
      Object.assign(evidence, { path, cwd, outside, runId, launch, refused });
      assert.equal(refused.isError, true, "real native resume must be blocked before pi-subagents follows the nested link");
      assert.match(JSON.stringify(refused.result), /cwd/);
      assert.equal(existsSync(join(outside, "escaped-resume")), false);
      assert.equal(readFileSync(childSession, "utf8"), originalContext, "refused resume cannot append to the native child context");
      assert.ok(existsSync(path), "refusal retains the candidate for recovery");
    } finally {
      const artifactRoot = process.env.LOOP_PI_WORKTREE_TEST_EVIDENCE;
      if (artifactRoot) {
        mkdirSync(artifactRoot, { recursive: true });
        writeFileSync(join(artifactRoot, `nested-resume-${reload}.json`), JSON.stringify({ ...evidence, events: session.events, stderr: session.stderr }, null, 2));
      }
      await session.close();
    }
  });
}

for (const order of ["guard-first", "worktrees-first"] as const) {
  for (const status of ["complete", "blocked"] as const) {
    test(`retained ${status} checkpoint: candidate/context resume, quit preservation and explicit release (${order})`, { timeout: 150_000 }, async () => {
      const repo = freshDir("lw-e2e-repo-");
      const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "test");
      git(repo, "config", "commit.gpgsign", "false");
      writeFileSync(join(repo, "seed"), "seed\n");
      git(repo, "add", "seed");
      git(repo, "commit", "-qm", "init");
      const base = git(repo, "rev-parse", "HEAD");
      const runDir = freshDir("lw-e2e-run-");
      writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
      const out = freshDir("lw-e2e-out-");
      const agentDir = freshDir("lw-e2e-home-");
      const subRoot = freshDir("lw-e2e-sub-");
      mkdirSync(join(agentDir, "agents"));
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"], worktree: true } }));
      writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
        "---", "name: lane-worker", "description: Candidate test lane", "tools: bash", "extensions: []",
        `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker",
      ].join("\n"));
      const block = '```lane-return\n' + JSON.stringify({ v: 2, lane: "L1", status, sha: null, landed: false, base, check: "test", exit: status === "complete" ? 0 : null, tail: "checkpoint", ci: null, coderabbit: null, questions: [] }) + '\n```';
      const landing = status === "blocked" ? "returns candidate" : "lands-after-green";
      const script = writeFauxScript([
        { match: "SPAWN_LANE", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: `Lane: L1 · Task: T1 · Tier: guarded\nLanding: ${landing}\nObjective: CHILD_WORK`, ...(order === "guard-first" ? { isolation: "worktree" } : { worktree: true }), extensionBindings: { "loop-pi.guard/1": { agent: "lane-worker-push" } } } }] },
        // The required lane guard must run despite extensions: []; forged parent bindings must not
        // turn this non-push lane into a push lane. A missing guard would reach Git, not this rule.
        { match: "CHILD_WORK", once: true, toolCalls: [{ name: "bash", args: { command: "git push" } }] },
        { match: "git push requires a push-granted lane identity", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/pwd' && printf %s "$PI_SUBAGENT_EXTENSION_BINDINGS" > '${out}/bindings' && echo candidate > candidate && git add candidate && git commit -qm lane-candidate && echo COMMITTED` } }] },
        { match: "COMMITTED", once: true, text: `CONTEXT_SENTINEL\n${block}` },
        { match: "RESUME_NOW", once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "LAST_RUN", message: "RESUME_CHECK" } }] },
        // faux matches history only via the latest user/tool text, so check the transcript on disk
        // below rather than hard-coding a model assertion about what it remembers.
        { match: "RESUME_CHECK", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/resume' && git rev-parse HEAD >> '${out}/resume' && echo RESUMED_IN` } }] },
        { match: "RESUMED_IN", once: true, text: "RESUMED_OK" },
        { match: "RELEASE_NOW", once: true, toolCalls: [{ name: "test_release", args: {} }] },
        { match: "SPAWN_REPLACEMENT", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "Lane: L1 · Task: T2 · Tier: guarded\nLanding: returns candidate\nObjective: REPLACEMENT_WORK", worktree: true } }] },
        { match: "REPLACEMENT_WORK", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${out}/replacement' && echo REPLACEMENT_DONE` } }] },
        { match: "REPLACEMENT_DONE", once: true, text: block },
        { match: "RESUME_RELEASED", once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "FIRST_RUN", message: "OLD_RESUME_CHECK" } }] },
        { match: ".*", text: "ok" },
      ]);
      const extensions = [FAUX_EXTENSION, ...HELPERS, ...(order === "guard-first" ? [GUARD, WORKTREES] : [WORKTREES, GUARD])];
      const opts = { extensions, fauxScriptPath: script, agentDir, subagentTempRoot: subRoot, cwd: repo, sessionArgs: [] as string[], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: runDir } };
      let session = startPiRpc(opts);
      const evidence: Record<string, unknown> = { status, order, base };
      const notify = () => session.events.filter((e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "subagent-notify");
      try {
        session.send({ id: "spawn", type: "prompt", message: "SPAWN_LANE" });
        await waitForCondition(() => notify().length ? true : undefined, 60_000);
        await session.waitFor((e) => e.type === "agent_settled", 30_000);
        const path = readFileSync(join(out, "pwd"), "utf8").trim();
        assert.ok(existsSync(path), `returned ${status} candidate cwd must survive`);
        assert.equal(dirname(path), realpathSync(join(runDir, "worktrees")), "native package allocation was suppressed, even with worktree default true");
        const branch = git(path, "branch", "--show-current");
        assert.match(branch, /^loop\/r[0-9a-f]{32}\/l[0-9a-f]{32}$/);
        assert.match(path.split("/").pop()!, /^l[0-9a-f]{32}$/);
        const pointer = readFileSync(join(path, ".git"), "utf8").trim().replace(/^gitdir: /, "");
        assert.equal(isAbsolute(pointer), false, "public scans never see an absolute gitdir pointer");
        assert.equal(realpathSync(resolve(path, pointer)), realpathSync(git(path, "rev-parse", "--absolute-git-dir")));
        assert.equal(JSON.parse(readFileSync(join(out, "bindings"), "utf8"))["loop-pi.guard/1"].agent, "lane-worker");
        const candidate = git(path, "rev-parse", "HEAD");
        const launch = session.events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent")!;
        const runId = (launch.result as { details: { runId?: string; asyncId?: string } }).details.runId ?? (launch.result as { details: { asyncId: string } }).details.asyncId;
        const statusFile = join(subRoot, "async-subagent-runs", runId!, "status.json");
        const nativeStatus = JSON.parse(readFileSync(statusFile, "utf8"));
        const childSession = nativeStatus.steps[0].sessionFile as string;
        assert.ok(childSession && existsSync(childSession), "native child context is retained");
        const originalContext = readFileSync(childSession, "utf8");
        assert.match(originalContext, /CONTEXT_SENTINEL/);
        assert.match(originalContext, /push-granted lane identity/);
        Object.assign(evidence, { path, branch, pointer, candidate, runId, childSession, originalContext, nativeStatus, launchEvents: session.events });
        session.send({ id: "state", type: "get_state" });
        const rootState = await session.waitFor((e) => e.type === "response" && e.id === "state", 10_000);
        const sessionFile = (rootState.data as { sessionFile: string }).sessionFile;
        assert.ok(sessionFile);

        await session.close();
        assert.ok(existsSync(path), "ordinary root quit must not release a candidate");
        // Restore the SAME root session and run id; no fresh child, protocol fallback or context reset.
        session = startPiRpc({ ...opts, sessionArgs: ["--session", sessionFile] });
        // resume-helper's latest run is reconstructed from the parent branch on restart.
        session.send({ id: "resume", type: "prompt", message: "RESUME_NOW" });
        const resumed = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 60_000);
        assert.equal(resumed.isError ?? false, false, JSON.stringify(resumed.result));
        await waitForCondition(() => notify().some((e) => JSON.stringify(e.message).includes("RESUMED_OK")) ? true : undefined, 60_000);
        const [where, sha] = readFileSync(join(out, "resume"), "utf8").trim().split("\n");
        assert.equal(where, path);
        assert.equal(sha, candidate);
        assert.ok(readFileSync(childSession, "utf8").includes(originalContext.trim()), "resume appends to the original child context");
        session.send({ id: "release", type: "prompt", message: "RELEASE_NOW" });
        const released = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "test_release", 30_000);
        assert.equal(released.isError ?? false, false);
        assert.match(JSON.stringify(released.result), /removed 1 worktree/);
        assert.equal(existsSync(path), false, "only explicit closeout releases the clean terminal worktree");
        assert.equal(git(repo, "rev-parse", branch), candidate, "unmerged candidate branch remains recoverable");
        Object.assign(evidence, { resume: { where, sha }, resumedContext: readFileSync(childSession, "utf8"), released, removed: !existsSync(path) });
        const beforeReplacement = session.events.length;
        session.send({ id: "replacement", type: "prompt", message: "SPAWN_REPLACEMENT" });
        await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent" && session.events.indexOf(e) >= beforeReplacement, 60_000);
        await waitForCondition(() => notify().length >= 2 ? true : undefined, 60_000);
        const replacementPath = readFileSync(join(out, "replacement"), "utf8").trim();
        const beforeOldResume = session.events.length;
        session.send({ id: "old-resume", type: "prompt", message: "RESUME_RELEASED" });
        const refused = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent" && session.events.indexOf(e) >= beforeOldResume, 60_000);
        assert.equal(refused.isError, true, "a released native run must not resume into another allocation owner");
        assert.notEqual(replacementPath, path, "allocation IDs are never reused after explicit release");
        assert.equal(existsSync(path), false);
        assert.equal(git(replacementPath, "rev-parse", "HEAD"), base);
        assert.equal(readFileSync(childSession, "utf8"), evidence.resumedContext, "refused old resume cannot append to the old native transcript");
        Object.assign(evidence, { replacementPath, oldResumeRefusal: refused });
      } finally {
        const artifactRoot = process.env.LOOP_PI_WORKTREE_TEST_EVIDENCE;
        if (artifactRoot) {
          mkdirSync(artifactRoot, { recursive: true });
          writeFileSync(join(artifactRoot, `${order}-${status}.json`), JSON.stringify({ ...evidence, events: session.events, stderr: session.stderr }, null, 2));
        }
        await session.close();
      }
    });
  }
}
