// Real pinned-pi proof of native naming and concurrent retained siblings. Secret-shaped task IDs
// are assembled at runtime; briefs stay intact in native child context, never in managed refs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

after(() => cleanupAll());
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WORKTREES = join(HERE, "index.ts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
const privateTask = (n: number) => ["H", "R", "N"].join("") + "-" + String(n).padStart(4, "0");

function fixture() {
  const repo = freshDir("naming-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed"), "seed\n");
  git(repo, "add", "seed");
  git(repo, "commit", "-qm", "base");
  const runDir = freshDir("naming-run-");
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const agentDir = freshDir("naming-home-");
  const subRoot = freshDir("naming-sub-");
  const out = freshDir("naming-out-");
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR] }));
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ agentExcludeDirs: ["~/.agents"], worktree: true, worktreeProvider: "native", worktreeBaseDir: freshDir("naming-native-") }));
  writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
    "---", "name: lane-worker", "description: Naming proof", "tools: bash", "extensions: []",
    `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker",
  ].join("\n"));
  return { repo, runDir, agentDir, subRoot, out };
}

const syntheticPrivateTerm = ["synthetic", "naming", "restricted"].join("-");

function scan(repo: string, mode: "--history" | "--path") {
  // Only disposable synthetic repositories are scanned here. Supply their own nonempty private
  // policy, independent of the developer's estate or CI secrets; public patterns still load from
  // the unchanged scanner root. Do not export this term source to the real repository leak gate.
  const env: NodeJS.ProcessEnv = { ...process.env, LEAK_TERMS: [
    `naming-fixture-private\tlit:${syntheticPrivateTerm}`,
    `naming-fixture-task-id\tre:${["H", "R", "N"].join("")}-[0-9]{4,}`,
  ].join("\n") };
  delete env.LEAK_TERMS_FILE;
  const r = spawnSync("python3", [join(ROOT, "bin", "leak-scan"), mode, ...(mode === "--path" ? [repo] : [])], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  return { exit: r.status, output: r.stdout + r.stderr };
}
function evidence(name: string, data: unknown) {
  const root = process.env.LOOP_PI_WORKTREE_TEST_EVIDENCE;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name + ".json"), JSON.stringify(data, null, 2));
}

test("synthetic scanner policy still rejects private task-ID refs and public patterns", { timeout: 30_000 }, () => {
  const publicFixture = fixture();
  const taskFixture = fixture();
  const privateFixture = fixture();
  for (const f of [publicFixture, taskFixture, privateFixture]) {
    const clean = scan(f.repo, "--history");
    assert.equal(clean.exit, 0, clean.output);
  }
  // Separate disposable refs prove each policy source is active, not merely that scanning exits 0.
  // Tracker shapes belong to private terms, whereas network-address shapes are public policy.
  git(publicFixture.repo, "update-ref", `refs/heads/ip-${[192, 168, 4, 7].join(".")}`, "HEAD");
  git(taskFixture.repo, "update-ref", `refs/heads/${privateTask(999)}`, "HEAD");
  git(privateFixture.repo, "update-ref", `refs/heads/${syntheticPrivateTerm}`, "HEAD");
  const publicRed = scan(publicFixture.repo, "--history");
  const taskRed = scan(taskFixture.repo, "--history");
  const privateRed = scan(privateFixture.repo, "--history");
  evidence("synthetic-scanner-policy", { publicRed, taskRed, privateRed });
  assert.equal(publicRed.exit, 1, publicRed.output);
  assert.match(publicRed.output, /rfc1918-192/);
  assert.equal(taskRed.exit, 1, taskRed.output);
  assert.match(taskRed.output, /naming-fixture-task-id/);
  assert.equal(privateRed.exit, 1, privateRed.output);
  assert.match(privateRed.output, /naming-fixture-private/);
});

test("native governed default allocation keeps the full private brief out of refs", { timeout: 90_000 }, async () => {
  const f = fixture();
  const task = `Lane: N1 · Task: ${privateTask(901)} (native naming proof) · Tier: guarded\nObjective: NATIVE_WORK`;
  // No Landing or explicit worktree flag: native package defaults, not retained-cwd rewriting.
  const script = writeFauxScript([
    { match: "SPAWN_NATIVE", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task } }] },
    { match: "NATIVE_WORK", once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${f.out}/cwd' && echo NATIVE_READY` } }] },
    { match: "NATIVE_READY", once: true, delayMs: 8_000, text: "NATIVE_DONE" },
    { match: ".*", text: "ok" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, WORKTREES], fauxScriptPath: script, agentDir: f.agentDir, subagentTempRoot: f.subRoot, cwd: f.repo, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: f.runDir } });
  const proof: Record<string, unknown> = {};
  try {
    session.send({ id: "spawn", type: "prompt", message: "SPAWN_NATIVE" });
    await waitForCondition(() => existsSync(join(f.out, "cwd")) ? true : undefined, 60_000);
    const cwd = readFileSync(join(f.out, "cwd"), "utf8").trim();
    const branch = git(cwd, "branch", "--show-current");
    const launch = session.events.find((e) => e.type === "tool_execution_end" && e.toolName === "subagent")!;
    const details = (launch.result as { details: { runId: string; asyncDir: string } }).details;
    const status = JSON.parse(readFileSync(join(details.asyncDir, "status.json"), "utf8"));
    const history = scan(f.repo, "--history");
    Object.assign(proof, { cwd, branch, launch, status, history, refs: git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)") });
    assert.equal(status.steps[0].provider, "native", "exercise pinned package allocation, not root retention");
    assert.equal(history.exit, 0, history.output);
    assert.ok(!branch.includes(privateTask(901)), "native ref cannot contain the private task identity");
    assert.match(status.lane.key, /^r[0-9a-f]{32}l[0-9a-f]{32}$/);
    assert.ok(readFileSync(status.steps[0].sessionFile, "utf8").includes(JSON.stringify(task).slice(1, -1)), "native context retains the exact brief");
    session.send({ id: "state", type: "get_state" });
    const state = await session.waitFor((e) => e.type === "response" && e.id === "state", 10_000);
    const rootFile = (state.data as { sessionFile: string }).sessionFile;
    const mapping = readFileSync(rootFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((e) => e.type === "custom" && e.customType === "lane-worktrees-state").at(-1).data.nativeNames;
    assert.deepEqual(mapping, [{ key: status.lane.key, lane: "N1", task: privateTask(901), runs: [details.runId] }]);
    proof.mapping = mapping;
    await waitForCondition(() => session.events.some((e) => JSON.stringify(e).includes("NATIVE_DONE")) ? true : undefined, 30_000);
  } finally {
    evidence("native-naming", { ...proof, events: session.events, stderr: session.stderr });
    await session.close();
  }
});

test("concurrent private-brief siblings share clean refs and resume without changing each other", { timeout: 150_000 }, async () => {
  const f = fixture();
  const tasks = [1, 2].map((n) => `Lane: S${n} · Task: ${privateTask(910 + n)} (sibling proof) · Tier: guarded\nLanding: returns candidate\nObjective: SIBLING_${n}`);
  const rules = [
    { match: "SPAWN_SIBLINGS", once: true, toolCalls: tasks.map((task) => ({ name: "subagent", args: { agent: "lane-worker", task, worktree: true } })) },
    ...[1, 2].flatMap((n) => [
      { match: `SIBLING_${n}`, once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${f.out}/cwd-${n}' && echo sibling-${n} > candidate && git add candidate && git commit -qm sibling-${n} && echo READY_${n}` } }] },
      { match: `READY_${n}`, once: true, delayMs: 1_000, text: `CHECKPOINT_${n}` },
    ]),
    { match: ".*", text: "ok" },
  ];
  const script = writeFauxScript(rules);
  const opts = { extensions: [FAUX_EXTENSION, WORKTREES], fauxScriptPath: script, agentDir: f.agentDir, subagentTempRoot: f.subRoot, cwd: f.repo, sessionArgs: [] as string[], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: f.runDir } };
  let session = startPiRpc(opts);
  const proof: Record<string, unknown> = {};
  try {
    session.send({ id: "spawn", type: "prompt", message: "SPAWN_SIBLINGS" });
    await waitForCondition(() => [1, 2].every((n) => session.events.some((e) => JSON.stringify(e).includes(`CHECKPOINT_${n}`))) ? true : undefined, 60_000);
    await session.waitFor((e) => e.type === "agent_settled", 30_000);
    const launches = session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "subagent");
    assert.equal(launches.length, 2);
    const siblings = [1, 2].map((n) => {
      const cwd = readFileSync(join(f.out, `cwd-${n}`), "utf8").trim();
      const entries = launches.map((e) => (e.result as { details: { runId: string; asyncDir: string } }).details);
      const details = entries.find((d) => readFileSync(JSON.parse(readFileSync(join(d.asyncDir, "status.json"), "utf8")).steps[0].sessionFile, "utf8").includes(JSON.stringify(tasks[n - 1]).slice(1, -1)))!;
      const status = JSON.parse(readFileSync(join(details.asyncDir, "status.json"), "utf8"));
      const context = readFileSync(status.steps[0].sessionFile, "utf8");
      assert.ok(context.includes(JSON.stringify(tasks[n - 1]).slice(1, -1)));
      assert.equal(git(cwd, "status", "--porcelain"), "");
      return { n, cwd, branch: git(cwd, "branch", "--show-current"), sha: git(cwd, "rev-parse", "HEAD"), ...details, startedAt: status.startedAt, endedAt: status.steps[0].endedAt, sessionFile: status.steps[0].sessionFile, context };
    });
    assert.notEqual(siblings[0].cwd, siblings[1].cwd);
    assert.ok(Math.max(...siblings.map((s) => s.startedAt)) < Math.min(...siblings.map((s) => s.endedAt)), "native lifecycle timestamps prove concurrent sibling execution");
    const refs = git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const registration = git(f.repo, "worktree", "list", "--porcelain");
    const scans = [scan(f.repo, "--path"), ...siblings.map((s) => scan(s.cwd, "--path")), scan(f.repo, "--history")];
    Object.assign(proof, { siblings, refs, registration, scans, launchEvents: session.events });
    for (const result of scans) assert.equal(result.exit, 0, result.output);
    session.send({ id: "state", type: "get_state" });
    const state = await session.waitFor((e) => e.type === "response" && e.id === "state", 10_000);
    const rootSession = (state.data as { sessionFile: string }).sessionFile;
    await session.close();
    writeFileSync(script, JSON.stringify({ rules: [
      ...siblings.flatMap((sibling) => [
        { match: `RESUME_${sibling.n}`, once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: sibling.runId, message: `CHECK_CWD_${sibling.n}` } }] },
        { match: `CHECK_CWD_${sibling.n}`, once: true, toolCalls: [{ name: "bash", args: { command: `pwd > '${f.out}/resume-${sibling.n}' && git rev-parse HEAD >> '${f.out}/resume-${sibling.n}' && echo RESUMED_${sibling.n}` } }] },
        { match: `RESUMED_${sibling.n}`, once: true, text: `RESUME_DONE_${sibling.n}` },
      ]),
      { match: ".*", text: "ok" },
    ] }));
    session = startPiRpc({ ...opts, sessionArgs: ["--session", rootSession] });
    for (const sibling of siblings) {
      const other = siblings.find((s) => s.n !== sibling.n)!;
      const otherContext = readFileSync(other.sessionFile, "utf8");
      const start = session.events.length;
      session.send({ id: `resume-${sibling.n}`, type: "prompt", message: `RESUME_${sibling.n}` });
      const resumed = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent" && session.events.indexOf(e) >= start, 60_000);
      assert.equal(resumed.isError ?? false, false, JSON.stringify(resumed));
      await waitForCondition(() => session.events.slice(start).some((e) => JSON.stringify(e).includes(`RESUME_DONE_${sibling.n}`)) ? true : undefined, 60_000);
      assert.deepEqual(readFileSync(join(f.out, `resume-${sibling.n}`), "utf8").trim().split("\n"), [sibling.cwd, sibling.sha]);
      assert.ok(readFileSync(sibling.sessionFile, "utf8").includes(sibling.context.trim()));
      assert.equal(readFileSync(other.sessionFile, "utf8"), otherContext, "one resume must not append to its sibling");
      assert.equal(git(other.cwd, "rev-parse", "HEAD"), other.sha);
      assert.equal(git(f.repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
      assert.equal(git(f.repo, "worktree", "list", "--porcelain"), registration);
    }
    const finalScan = scan(f.repo, "--history");
    proof.finalScan = finalScan;
    assert.equal(finalScan.exit, 0, finalScan.output);
  } finally {
    evidence("shared-sibling-naming", { ...proof, events: session.events, stderr: session.stderr });
    await session.close();
  }
});
