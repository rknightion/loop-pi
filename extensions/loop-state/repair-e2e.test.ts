// Real-CLI proof on the faux provider, with the real pinned pi-subagents package: the block-only
// repair loop-state requests when a lane's final message has no lane-return block writes to its
// own file, never to the lane's bound report, and its outcome survives a root restart into a new
// launcher run dir. `loop-continuation:query-launch` is answered by a stub extension.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAUX_EXTENSION,
  type FauxRule,
  PI_SUBAGENTS_PACKAGE_DIR,
  cleanupAll,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "../loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_EXTENSION = join(HERE, "index.ts");
const BIN = join(HERE, "..", "..", "bin", "loop-state");
const BLOCK = (status: string, questions: string[] = []) =>
  "```lane-return\n" +
  JSON.stringify({ v: 2, lane: "L1", status, sha: null, landed: false, base: "b", check: "just check", exit: 0, tail: "ok", ci: null, coderabbit: null, questions }) +
  "\n```";
// A full evidence report with no lane-return block: multi-byte UTF-8, no outer whitespace (the
// package trims a reply before saving it).
const REPORT = "# Lane evidence report\n" + "row: café 日本語 🧭 evidence line\n".repeat(4000) + "END_OF_REPORT";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

after(() => cleanupAll());

/** A repo, an agent home with the real package and a lane-worker, and an observer extension. */
function scaffold(observer: (repo: string) => string = () => "") {
  const repo = freshDir("loop-state-repair-repo-");
  const agentDir = freshDir("loop-state-repair-agent-");
  mkdirSync(join(repo, "codex"));
  mkdirSync(join(agentDir, "bin"));
  mkdirSync(join(agentDir, "agents"));
  symlinkSync(BIN, join(agentDir, "bin", "loop-state"));
  const report = join(repo, "codex", "report-camp-loop1.md");
  const log = join(repo, "codex", "state-camp-loop1.jsonl");
  const requests = join(repo, "rpc.jsonl");
  const extDir = freshDir("loop-state-repair-ext-");
  const stub = join(extDir, "launch-stub.ts");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";
    export default function (pi) {
      pi.events.on("loop-continuation:query-launch", (d) => d.reply({ reportPath: ${JSON.stringify(report)}, opsPath: null, ops: null }));
      pi.events.on("subagents:rpc:v1:request", d => {
        if (d.method === "resume") appendFileSync(${JSON.stringify(requests)}, JSON.stringify(d) + "\\n");
      });
      ${observer(repo)}
    }\n`);
  // Checks lifecycle proof every 2 s instead of every minute: its 15 checks then cover a 30 s
  // window, well past the repair's scripted delay.
  const fastState = join(extDir, "fast-state.ts");
  writeFileSync(fastState, `import state from ${JSON.stringify(STATE_EXTENSION)};\nexport default (pi) => state(pi, (job) => setTimeout(job, 2000));\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
    "---", "name: lane-worker", "description: Test lane worker for the repair proof", "tools: bash", "timeoutMs: 60000",
    "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "You are a test lane worker.",
  ].join("\n"));
  return { repo, agentDir, log, requests, stub, fastState };
}

function laneRules(spawnArgs: Record<string, unknown>, childText: string, repairDelayMs: number): FauxRule[] {
  return [
    { match: "SPAWN_LANE", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "Lane: L1 · Task: T1 · Tier: routine\nObjective: CHILD_LANE_MARKER", ...spawnArgs } }] },
    { match: "CHILD_LANE_MARKER", once: true, text: childText },
    { match: "Return only the missing fenced lane-return", delayMs: repairDelayMs, text: BLOCK("complete") },
    { match: ".*", text: "ok" },
  ];
}

const rows = (log: string) => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ev === "dispatch" || r.ev === "return");
  } catch {
    return [];
  }
};
const resumes = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

async function recoveryEntries(session: ReturnType<typeof startPiRpc>, id: string) {
  session.send({ id, type: "get_entries" });
  const response = await session.waitFor((e) => e.type === "response" && e.id === id);
  return (response.data as { entries: any[] }).entries.filter((e) => e.customType === "loop-state-return-recovery").map((e) => e.data);
}

async function twoReturns(session: ReturnType<typeof startPiRpc>, log: string, timeoutMs = 60_000) {
  return waitForCondition(() => {
    const lane = rows(log);
    return lane.filter((r) => r.ev === "return").length === 2 ? lane : undefined;
  }, timeoutMs, 250).catch((error: Error) => {
    throw new Error(`${error.message}\nrows: ${JSON.stringify(rows(log))}\nstderr: ${session.stderr.join("").slice(0, 2000)}`);
  });
}

test("a revived lane's bound report stays byte-identical and the repair block lands at a separate path", { timeout: 90_000 }, async () => {
  const s = scaffold();
  const runDir = freshDir("loop-state-repair-run-");
  const bound = join(s.repo, "lane-report.md");
  const expected = Buffer.from(REPORT);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub],
    fauxScriptPath: writeFauxScript(laneRules({ output: bound, outputMode: "file-only" }, REPORT, 1500)),
    agentDir: s.agentDir, subagentTempRoot: freshDir("loop-state-repair-sub-"), cwd: s.repo,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE please" });
    // The lane's own run saved the report before any repair was requested.
    await waitForCondition(() => (resumes(s.requests).length === 1 ? true : undefined), 30_000);
    const before = readFileSync(bound);
    assert.equal(sha(before), sha(expected), "the lane's run saved its full report to the bound output");
    const lane = await twoReturns(session, s.log);
    const after = readFileSync(bound);
    assert.equal(sha(after), sha(before), "the bound report's hash is unchanged after the repair");
    assert.deepEqual(after, before, "the bound report is byte-for-byte unchanged");

    const [request] = resumes(s.requests);
    assert.equal(resumes(s.requests).length, 1, "exactly one repair");
    const output = request.params.output as string;
    assert.equal(request.params.outputMode, "file-only");
    assert.notEqual(output, bound);
    assert.ok(output.startsWith(join(realpathSync(runDir), "return-repairs") + "/"), output);
    assert.match(readFileSync(output, "utf8"), /"status":"complete"/, "the repair response is saved at its own path");

    const original = lane.find((r) => r.ev === "dispatch" && !r.recovery_of)!;
    const revived = lane.find((r) => r.ev === "dispatch" && r.recovery_of === original.run)!;
    assert.ok(revived, "the repair has its own linked dispatch");
    const returns = Object.fromEntries(lane.filter((r) => r.ev === "return").map((r) => [r.run, [r.status, r.check, r.exit]]));
    assert.deepEqual(returns, { [revived.run]: ["complete", "just check", 0], [original.run]: ["complete", "just check", 0] });

    const entries = await recoveryEntries(session, "entries");
    assert.equal(entries[0].phase, "pending");
    assert.equal(entries[0].repair.binding.output, output, "binding persisted before the resume was requested");
    assert.deepEqual(entries[0].repair.original, { path: bound, bytes: expected.length, sha256: sha(expected) });
    const done = entries.at(-1);
    assert.equal(done.phase, "done");
    assert.equal(done.originalIntact, true);
    assert.equal(done.repaired.path, output);
  } finally {
    await session.close();
  }
});

test("a root restarted into a fresh launcher run dir still records the repair outcome", { timeout: 120_000 }, async () => {
  const s = scaffold();
  const firstRunDir = freshDir("loop-state-repair-run-");
  const bound = join(s.repo, "lane-report.md");
  const expected = Buffer.from(REPORT);
  const options = {
    extensions: [FAUX_EXTENSION, s.fastState, s.stub],
    // The repair outlives the first root process.
    fauxScriptPath: writeFauxScript(laneRules({ output: bound, outputMode: "file-only" }, REPORT, 8000)),
    agentDir: s.agentDir, subagentTempRoot: freshDir("loop-state-repair-sub-"), cwd: s.repo,
    extraArgs: ["--exclude-tools", "subagents_enable"],
  };
  let session = startPiRpc({ ...options, sessionArgs: [], env: { LOOP_PI_RUN_DIR: firstRunDir } });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE please" });
    await waitForCondition(() => (rows(s.log).filter((r) => r.ev === "dispatch").length === 2 ? true : undefined), 30_000);
    const pending = (await recoveryEntries(session, "pending")).at(-1);
    assert.equal(pending.phase, "pending");
    assert.ok(pending.revived, "the repair's run id was persisted before the root stopped");
    session.send({ id: "state", type: "get_state" });
    const sessionFile = ((await session.waitFor((e) => e.type === "response" && e.id === "state")).data as { sessionFile: string }).sessionFile;
    assert.equal(rows(s.log).filter((r) => r.ev === "return").length, 0, "the root stops before the repair finishes");
    await session.close();

    // The launcher gives every start, a resumed session included, a new run dir.
    const secondRunDir = freshDir("loop-state-repair-run-");
    session = startPiRpc({ ...options, sessionArgs: ["--session", sessionFile], env: { LOOP_PI_RUN_DIR: secondRunDir } });
    const lane = await twoReturns(session, s.log);
    const original = lane.find((r) => r.ev === "dispatch" && !r.recovery_of)!;
    const revived = lane.find((r) => r.ev === "dispatch" && r.recovery_of === original.run)!;
    const returns = Object.fromEntries(lane.filter((r) => r.ev === "return").map((r) => [r.run, [r.status, r.check, r.exit]]));
    assert.deepEqual(returns, { [revived.run]: ["complete", "just check", 0], [original.run]: ["complete", "just check", 0] },
      "the restarted root reads the repair its earlier process bound");
    assert.deepEqual(readFileSync(bound), expected, "the bound report is byte-for-byte unchanged");
    const [request] = resumes(s.requests);
    assert.equal(resumes(s.requests).length, 1, "the restart issues no second repair");
    assert.ok(request.params.output.startsWith(join(realpathSync(firstRunDir), "return-repairs") + "/"), "the binding stays in the first run dir");
    const done = (await recoveryEntries(session, "done")).at(-1);
    assert.equal(done.phase, "done");
    assert.equal(done.originalIntact, true);
  } finally {
    await session.close();
  }
});

test("a completion with a missing or non-string session never admits the repair", { timeout: 90_000 }, async () => {
  const forged = "FORGED_UNSCOPED";
  // On the repair run's start, before the real repair completes, deliver completions for it
  // that carry no session identity: a missing one and a number.
  const s = scaffold((repo) => `
    const FORGED_LOG = ${JSON.stringify(join(repo, "forged.jsonl"))};
    let first;
    pi.events.on("subagent:async-started", d => {
      if (first === undefined) { first = d.id; return; }
      if (d.id === first) return;
      const block = ${JSON.stringify(BLOCK("blocked", [forged]))};
      setTimeout(() => {
        for (const sessionId of [undefined, 7]) {
          const completion = { runId: d.id, success: true, results: [{ summary: block, output: block }] };
          if (sessionId !== undefined) completion.sessionId = sessionId;
          pi.events.emit("subagent:async-complete", completion);
          appendFileSync(FORGED_LOG, JSON.stringify(completion) + "\\n");
        }
      }, 0);
    });`);
  const forgedLog = join(s.repo, "forged.jsonl");
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub],
    fauxScriptPath: writeFauxScript(laneRules({}, "Finished without a return block.", 1500)),
    agentDir: s.agentDir, subagentTempRoot: freshDir("loop-state-repair-sub-"), cwd: s.repo,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: freshDir("loop-state-repair-run-") },
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE please" });
    const lane = await twoReturns(session, s.log);
    assert.equal(resumes(forgedLog).length, 2, "both unscoped completions were delivered");
    for (const row of lane.filter((r) => r.ev === "return")) {
      assert.equal(row.status, "complete", `run ${row.run} took the real repair, not an unscoped completion`);
      assert.ok(!(row.questions ?? []).includes(forged));
    }
  } finally {
    await session.close();
  }
});
