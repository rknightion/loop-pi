// Real pinned pi/faux lifecycle: native package patches are captured by the installed extension,
// reconciled on startup, then survive package retention of eligible scratch originals. No live model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";
import { patchCleanupAllowed, patchManifestPath, type PatchManifest } from "./retention.ts";
import laneWorktrees, { PATCH_DECISION_EVENT, PATCH_STATE_CUSTOM_TYPE } from "./index.ts";

// Internal installed API, deliberately loaded by file URL: no exported prune-hook API is claimed.
const retentionUrl = new URL("../../node_modules/pi-subagents/src/runs/background/async-retention.js", import.meta.url);
const { cleanupAsyncRetention } = await import(retentionUrl.href);
after(cleanupAll);
const HERE = dirname(fileURLToPath(import.meta.url));

test("installed lifecycle and restart capture survive pinned package pruning of scratch originals", { timeout: 150_000 }, async () => {
  const repo = realpathSync(freshDir("patch-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "seed"), "base\n");
  git("add", "seed");
  git("commit", "-qm", "base");
  const runDir = realpathSync(freshDir("patch-run-"));
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const agentDir = realpathSync(freshDir("patch-home-"));
  const subRoot = realpathSync(freshDir("patch-sub-"));
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(agentDir, "agents", "worker.md"), [
    "---", "name: worker", "description: Patch lifecycle fixture", "tools: bash", "extensions: []",
    `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker",
  ].join("\n"));
  const script = writeFauxScript([
    { match: "SPAWN_PATCH", once: true, toolCalls: [{ name: "subagent", args: {
      agent: "worker", task: "Lane: L1 · Task: T1 · Tier: routine\nLanding: tracker-only\nObjective: WRITE_PATCH", worktree: true,
    } }] },
    { match: "WRITE_PATCH", once: true, toolCalls: [{ name: "bash", args: { command: "printf 'candidate\\n' > seed && echo PATCH_WRITTEN" } }] },
    { match: "PATCH_WRITTEN", once: true, text: "PATCH_READY" },
    { match: ".*", text: "ok" },
  ]);
  const opts = { extensions: [FAUX_EXTENSION, join(HERE, "index.ts")], fauxScriptPath: script, agentDir,
    subagentTempRoot: subRoot, cwd: repo, sessionArgs: [] as string[],
    extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: runDir } };
  let session = startPiRpc(opts);
  try {
    session.send({ id: "spawn", type: "prompt", message: "SPAWN_PATCH" });
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 60_000);
    assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
    const details = (launch.result as { details: { runId?: string; asyncId?: string; asyncDir: string } }).details;
    const runId = details.runId ?? details.asyncId!;
    const asyncDir = details.asyncDir ?? join(subRoot, "async-subagent-runs", runId);
    const manifestPath = patchManifestPath(runDir, runId);
    await waitForCondition(() => {
      if (!existsSync(manifestPath)) return undefined;
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as PatchManifest;
      return m.patches.length ? m : undefined;
    }, 60_000);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PatchManifest;
    assert.equal(manifest.disposition, "pending");
    const patch = manifest.patches.find((p) => p.source.endsWith(".patch"))!;
    const original = join(asyncDir, patch.source);
    const durable = join(dirname(manifestPath), `${patch.sha256}.patch`);
    const originalBytes = readFileSync(original);
    assert.match(originalBytes.toString("utf8"), /\+candidate/);
    assert.deepEqual(readFileSync(durable), originalBytes);
    assert.equal(patchCleanupAllowed(runDir, runId), false, "child completion is not root acceptance");

    session.send({ id: "state", type: "get_state" });
    const state = await session.waitFor((e) => e.type === "response" && e.id === "state", 10_000);
    const sessionFile = (state.data as { sessionFile: string }).sessionFile;
    await session.close();
    // A late package patch in the disposable original tests startup reconciliation, not a helper call.
    writeFileSync(join(dirname(original), "late.patch"), "late checkpoint bytes\n");
    session = startPiRpc({ ...opts, sessionArgs: ["--session", sessionFile] });
    await waitForCondition(() => {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as PatchManifest;
      return m.patches.some((p) => p.source.endsWith("late.patch")) ? true : undefined;
    }, 30_000);
    await session.close();

    // Only this fresh scratch run is made eligible. Package guards for resumability/handoff are
    // independently valid; remove their references from scratch metadata, never session or patch files.
    const statusPath = join(asyncDir, "status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    delete status.sessionFile;
    // An absolute handoff path would become unreadable after the package's tombstone rename.
    // The local scratch handoff below remains complete and is still checked by the real pruner.
    delete status.parallelHandoff;
    for (const step of status.steps ?? []) delete step.sessionFile;
    writeFileSync(statusPath, JSON.stringify(status));
    const descriptorPath = join(asyncDir, "recovery-descriptor.json");
    if (existsSync(descriptorPath)) {
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      delete descriptor.sessionFile;
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
    }
    const handoffPath = join(asyncDir, "handoff.json");
    if (existsSync(handoffPath)) {
      const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
      for (const group of handoff.groups) group.cleanup = { state: "complete" };
      writeFileSync(handoffPath, JSON.stringify(handoff));
    }
    const result = await cleanupAsyncRetention({ asyncDirRoot: dirname(asyncDir), resultsDir: join(subRoot, "async-subagent-results"),
      now: () => Date.now() + 40 * 24 * 60 * 60 * 1000, signal: AbortSignal.timeout(15_000) });
    assert.equal(result.workerFailed, false, JSON.stringify(result));
    assert.deepEqual(result.errors, [], JSON.stringify(result));
    assert.equal(result.deletedRuns, 1, JSON.stringify(result));
    assert.equal(existsSync(original), false, "actual pinned package prune removed scratch original");
    assert.deepEqual(readFileSync(durable), originalBytes, "durable bytes survive independently of prunable package state");
    assert.equal(patchCleanupAllowed(runDir, runId), false, "pruning cannot authorise durable cleanup");
    const evidence = process.env.LOOP_PI_RETENTION_TEST_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "lifecycle.json"), JSON.stringify({ runId, manifestPath, patchHash: patch.sha256,
        originalRemoved: !existsSync(original), durablePresent: existsSync(durable), prune: result }, null, 2));
    }
  } finally {
    await session.close();
  }
});

test("sibling attempts ignore task-only land; only exact trusted run decision permits cleanup", () => {
  const root = realpathSync(freshDir("patch-siblings-"));
  const runDir = join(root, "durable");
  mkdirSync(runDir);
  const runs = ["attempt-old", "attempt-selected"].map((runId, index) => {
    const asyncDir = join(root, "async", runId);
    mkdirSync(join(asyncDir, "worktree-diffs"), { recursive: true });
    writeFileSync(join(asyncDir, "worktree-diffs", "one.patch"), `distinct candidate ${index}`);
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
    return { runId, lane: `L${index}`, task: "T1", asyncDir, afterSeq: 0 };
  });
  const report = join(root, "report-siblings.md");
  const log = join(root, "state-siblings.jsonl");
  writeFileSync(log, `${JSON.stringify({ seq: 1, by: "root", ev: "land", task: "T1", runId: "attempt-selected", lane: "L1" })}\n`);
  const handlers = new Map<string, (e: any, c: any) => any>();
  const bus = new Map<string, (d: any) => any>();
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  try {
    laneWorktrees({ on: (n: string, h: any) => handlers.set(n, h), appendEntry: () => undefined,
      events: { on: (n: string, h: any) => bus.set(n, h), emit: (n: string, d: any) => {
        if (n === "loop-continuation:query-launch") d.reply({ reportPath: report });
      } } } as any);
    handlers.get("session_start")!({}, { ui: { notify: () => undefined }, sessionManager: {
      getSessionId: () => "session", getBranch: () => [{ type: "custom", customType: PATCH_STATE_CUSTOM_TYPE, data: { runs } }],
    } });
    for (const run of runs) {
      assert.equal(JSON.parse(readFileSync(patchManifestPath(runDir, run.runId), "utf8")).disposition, "pending");
      assert.equal(patchCleanupAllowed(runDir, run.runId), false, "task-level log cannot identify the accepted attempt");
    }
    bus.get(PATCH_DECISION_EVENT)!({ runId: "attempt-selected", decision: "landed" });
    assert.equal(patchCleanupAllowed(runDir, "attempt-selected"), true);
    assert.equal(patchCleanupAllowed(runDir, "attempt-old"), false, "unselected sibling stays pending");
    const selected = JSON.parse(readFileSync(patchManifestPath(runDir, "attempt-selected"), "utf8")) as PatchManifest;
    writeFileSync(join(dirname(patchManifestPath(runDir, "attempt-selected")), `${selected.patches[0].sha256}.patch`), "changed bytes");
    assert.equal(patchCleanupAllowed(runDir, "attempt-selected"), false, "exact decision still requires durable content hash");
    assert.equal(patchCleanupAllowed(runDir, "attempt-old"), false);
  } finally {
    if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previous;
  }
});

test("session journal failure warns without preventing lifecycle byte capture", async () => {
  const runDir = realpathSync(freshDir("patch-journal-run-"));
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const asyncDir = join(realpathSync(freshDir("patch-journal-sub-")), "run-one");
  mkdirSync(join(asyncDir, "worktree-diffs"), { recursive: true });
  writeFileSync(join(asyncDir, "worktree-diffs", "one.patch"), "journal-independent bytes");
  const handlers = new Map<string, (e: any, c: any) => any>();
  const notes: string[] = [];
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  try {
    laneWorktrees({ on: (n: string, h: any) => handlers.set(n, h), appendEntry: () => { throw new Error("scratch journal failure"); },
      events: { on: () => () => undefined, emit: () => undefined } } as any);
    const ctx = { ui: { notify: (s: string) => notes.push(s) }, sessionManager: { getSessionId: () => "session", getBranch: () => [] } };
    handlers.get("session_start")!({}, ctx);
    await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "call-one", input: {
      agent: "worker", task: "Lane: L1 · Task: T1 · Tier: routine\nLanding: tracker-only", worktree: false,
    } }, ctx);
    await handlers.get("tool_execution_end")!({ toolName: "subagent", toolCallId: "call-one", result: {
      details: { runId: "run-one", asyncDir },
    } }, ctx);
    const path = patchManifestPath(runDir, "run-one");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as PatchManifest;
    assert.equal(readFileSync(join(dirname(path), `${manifest.patches[0].sha256}.patch`), "utf8"), "journal-independent bytes");
    handlers.get("session_shutdown")!({}, ctx);
    assert.ok(notes.some((n) => n.includes("patch correlation persistence failed")));
    assert.equal(patchCleanupAllowed(runDir, "run-one"), false);
  } finally {
    if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previous;
  }
});

test("root extension decision boundary rejects park/closeout inference and accepts exact explicit rejection", () => {
  const runDir = realpathSync(freshDir("patch-decision-run-"));
  const asyncDir = join(realpathSync(freshDir("patch-decision-sub-")), "run-one");
  mkdirSync(join(asyncDir, "worktree-diffs"), { recursive: true });
  writeFileSync(join(asyncDir, "worktree-diffs", "one.patch"), "candidate bytes");
  writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
  const run = { runId: "run-one", lane: "L1", task: "T1", asyncDir, afterSeq: 0 };
  const handlers = new Map<string, (e: any, c: any) => any>();
  const bus = new Map<string, (d: any) => any>();
  const entries: any[] = [];
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  try {
    laneWorktrees({ on: (n: string, h: any) => handlers.set(n, h), appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
      events: { on: (n: string, h: any) => bus.set(n, h), emit: () => undefined } } as any);
    handlers.get("session_start")!({}, { ui: { notify: () => undefined }, sessionManager: {
      getSessionId: () => "session", getBranch: () => [{ type: "custom", customType: PATCH_STATE_CUSTOM_TYPE, data: { runs: [run] } }],
    } });
    assert.equal(patchCleanupAllowed(runDir, run.runId), false);
    bus.get(PATCH_DECISION_EVENT)!({ runId: "unknown", decision: "rejected" });
    bus.get(PATCH_DECISION_EVENT)!({ runId: run.runId, decision: "park" });
    handlers.get("session_shutdown")!({}, {});
    assert.equal(patchCleanupAllowed(runDir, run.runId), false);
    bus.get(PATCH_DECISION_EVENT)!({ runId: run.runId, decision: "rejected" });
    assert.equal(patchCleanupAllowed(runDir, run.runId), true);
    assert.ok(existsSync(join(asyncDir, "worktree-diffs", "one.patch")));
    assert.ok(entries.some((e) => e.customType === PATCH_STATE_CUSTOM_TYPE));
  } finally {
    if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previous;
  }
});
