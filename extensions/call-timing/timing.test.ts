import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, startPiRpc, waitForCondition } from "../loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PROVIDER = join(HERE, "test-support", "provider.ts");
const DISPATCHER = join(HERE, "..", "dispatcher", "index.ts");
after(cleanupAll);

function setup(script: object) {
  const home = freshDir("call-timing-home-");
  const cwd = freshDir("call-timing-cwd-");
  const path = join(home, "script.json");
  const trace = join(home, "trace.json");
  writeFileSync(path, JSON.stringify({ ...script, trace }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never", packages: [PI_SUBAGENTS_PACKAGE_DIR],
    subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  return { home, cwd, path, trace };
}

function assistants(home: string): any[] {
  const messages: any[] = [];
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(child, "utf8").split("\n").filter(Boolean)) {
          try {
            const r = JSON.parse(line);
            if (r.type === "message" && r.message?.role === "assistant") messages.push(r.message);
          } catch { /* an async child may still be appending the last line */ }
        }
      }
    }
  }
  if (existsSync(join(home, "sessions"))) walk(join(home, "sessions"));
  return messages;
}

async function run(script: object) {
  const f = setup(script);
  const session = startPiRpc({
    extensions: [PROVIDER, ENTRY], fauxScriptPath: f.path, agentDir: f.home,
    subagentTempRoot: join(f.home, "tmp"), cwd: f.cwd, sessionArgs: [],
    extraArgs: ["--provider", "timing-fixture", "--model", "fixture"],
    env: { LOOP_PI_TIMING_SCRIPT: f.path },
  });
  session.send({ id: "timing", type: "prompt", message: "Exercise scripted timing stream." });
  await session.waitFor((e) => e.type === "agent_settled");
  await session.close();
  return { ...f, message: assistants(f.home).at(-1), stderr: session.stderr.join("") };
}

for (const kind of ["text", "thinking"]) {
  test(`real pi persists first nonempty ${kind} delta and only allowed response headers`, async () => {
    const f = await run({ kind, responses: [
      { "x-request-id": "previous", "service-tier": "previous" },
      { "X-Request-Id": "synthetic-request", "X-Ratelimit-Remaining-Requests": "23",
        "x-ratelimit-reset-requests": "1s", "service-tier": "default", "OpenAI-Processing-Ms": "47",
        "authorization": "fixture-only", "set-cookie": "fixture-only", "other": "fixture-only" },
    ] });
    assert.ok(f.message?.loopPiTiming, `assistant timing must be persisted; stderr=${f.stderr}`);
    const timing = f.message.loopPiTiming;
    const trace = JSON.parse(readFileSync(f.trace, "utf8"));
    assert.ok(Number.isInteger(timing.firstTokenAt));
    assert.ok(timing.firstTokenAt >= trace.first && timing.firstTokenAt < trace.second,
      `firstTokenAt=${timing.firstTokenAt}, trace=${JSON.stringify(trace)}`);
    assert.ok(timing.firstTokenAt >= f.message.timestamp + 80, "start and empty deltas are not first tokens");
    assert.equal(timing.attempts, null, "multiple observed responses never imply an authoritative retry count");
    assert.equal(timing.processingMs, 47);
    assert.deepEqual(timing.headers, {
      "x-request-id": "synthetic-request", "x-ratelimit-remaining-requests": "23",
      "x-ratelimit-reset-requests": "1s", "service-tier": "default",
    });
    assert.equal(f.message.stopReason, "stop");
  });
}

test("empty stream has null first token and absent/invalid metadata is not invented", async () => {
  const f = await run({ kind: "empty", responses: [{ "openai-processing-ms": "47ms" }] });
  assert.deepEqual(f.message?.loopPiTiming, { firstTokenAt: null, attempts: null, processingMs: null, headers: {} });
});

for (const host of [ROOT_EXTENSION, DISPATCHER]) {
  test(`required timing extension reaches a real child from ${host === ROOT_EXTENSION ? "root" : "dispatcher"}`, async (t) => {
    // Keep native lightweight attestation enabled: the scripted final text must satisfy it.
    const report = {
      criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "Returned the scripted timing stream and its residual limitations." }],
      changedFiles: [], testsAddedOrUpdated: [], commandsRun: [],
      validationOutput: ["Emitted two nonempty text deltas through the offline fixture provider."],
      residualRisks: ["Offline scripted output does not validate live provider behaviour."],
      manualNotes: "Timing stream fixture only; no tools invoked or workspace files changed.",
    };
    const f = setup({
      responses: [{ "x-request-id": "child-request", "openai-processing-ms": "7" }],
      secondDelta: `second\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``,
    });
    mkdirSync(join(f.home, "agents"));
    writeFileSync(join(f.home, "agents", "lane-worker.md"), [
      "---", "name: lane-worker", "description: Timing stream fixture", "extensions: []",
      `subagentOnlyExtensions: ${PROVIDER}`, "tools: read", "model: timing-fixture/fixture", "---", "Exercise timing.",
    ].join("\n"));
    // Drive the same public RPC spawn bus as dispatcher. No parent model call, no direct timing
    // flag in the child; only the host's required-child registration can install the emitter.
    const probe = join(HERE, "test-support", "spawn.ts");
    const spawnResult = join(f.home, "spawn.json");
    const session = startPiRpc({
      extensions: [PROVIDER, probe, host], fauxScriptPath: f.path, agentDir: f.home,
      subagentTempRoot: join(f.home, "tmp"), cwd: f.cwd, sessionArgs: [],
      extraArgs: ["--provider", "timing-fixture", "--model", "fixture"],
      env: { LOOP_PI_TIMING_SCRIPT: f.path, LOOP_PI_TIMING_SPAWN_RESULT: spawnResult },
    });
    try {
      session.send({ id: "spawn", type: "prompt", message: "SPAWN_TIMING" });
      const message = await waitForCondition(() => assistants(f.home).find((m) => m.provider === "timing-fixture"), 30_000);
      assert.equal(message.loopPiTiming?.attempts, null, `child metadata missing; stderr=${session.stderr.join("")}`);
      assert.equal(message.loopPiTiming.processingMs, 7);
      assert.deepEqual(message.loopPiTiming.headers, { "x-request-id": "child-request" });
      assert.ok(Number.isInteger(message.loopPiTiming.firstTokenAt));
      const trace = JSON.parse(readFileSync(f.trace, "utf8"));
      assert.ok(message.loopPiTiming.firstTokenAt >= trace.first && message.loopPiTiming.firstTokenAt < trace.second);
      assert.ok(message.loopPiTiming.firstTokenAt >= message.timestamp + 80, "child start and empty deltas are not first tokens");
      assert.equal(message.stopReason, "stop");
      const reply = JSON.parse(readFileSync(spawnResult, "utf8"));
      const launched = reply.data.details;
      assert.equal(typeof reply.runnerProcessInstanceId, "string");
      assert.ok(reply.runnerProcessInstanceId.length > 0);
      const terminalPath = join(launched.asyncDir, "process-terminal.json");
      const runId = launched.runId ?? launched.asyncId;
      assert.equal(typeof runId, "string", "spawn reply must identify the exact child run");
      // The result/status is published before run-history and session disposal. The package's
      // process-terminal sidecar is published only after the matching runner actually closes.
      const completed = await waitForCondition(() => {
        if (!existsSync(terminalPath)) return undefined;
        const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
        if (terminal.runId !== runId || terminal.state !== "observed") return undefined;
        const status = JSON.parse(readFileSync(join(launched.asyncDir, "status.json"), "utf8"));
        return { terminal, status };
      }, 30_000);
      assert.equal(completed.status.state, "complete", `timing child must finish successfully before parent teardown: ${JSON.stringify({ error: completed.status.error, steps: completed.status.steps, stderr: session.stderr.join("") })}`);
      assert.equal(completed.status.runId, runId);
      assert.equal(completed.status.steps.length, 1);
      const acceptance = completed.status.steps[0].acceptance;
      assert.equal(acceptance.effectiveAcceptance.level, "attested");
      assert.equal(acceptance.explicit, false, "native default acceptance must remain enabled");
      assert.equal(acceptance.status, "attested");
      assert.equal(acceptance.evidenceStatus, "attested");
      assert.deepEqual(acceptance.childReport, report);
      assert.equal(completed.terminal.runnerProcessInstanceId, reply.runnerProcessInstanceId);
      const runner = completed.terminal.instances.find((instance: any) => instance.kind === "runner");
      assert.equal(runner?.processInstanceId, reply.runnerProcessInstanceId);
      assert.equal(runner.exitCode, 0);
      assert.equal(runner.signal, null);
      assert.ok(Number.isFinite(runner.closeObservedAt));
      assert.ok(runner.closeObservedAt <= Date.now(), "runner close must be observed before parent teardown");
      const historyPath = join(f.home, "run-history.jsonl");
      const historyBeforeClose = readFileSync(historyPath, "utf8");
      const history = historyBeforeClose.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(history.length, 1);
      assert.equal(history[0].agent, "lane-worker");
      assert.equal(history[0].outcome, "completed");
      assert.equal(history[0].status, "ok");
      await session.close();
      assert.equal(readFileSync(historyPath, "utf8"), historyBeforeClose, "parent teardown must not introduce a late child history write");
      t.diagnostic(JSON.stringify({ host: host === ROOT_EXTENSION ? "root" : "dispatcher", runId,
        runnerProcessInstanceId: runner.processInstanceId, exitCode: runner.exitCode, signal: runner.signal,
        closeObservedAt: runner.closeObservedAt, state: completed.status.state, acceptance: acceptance.status,
        historyRows: history.length, historyOutcome: history[0].outcome, noLateHistoryWrite: true }));
    } finally {
      await session.close();
    }
  });
}
