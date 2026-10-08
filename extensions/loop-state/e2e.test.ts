// Real-CLI proof on the faux provider: the digest message appears after a forced compaction, and a
// real pi-subagents lane produces dispatch and return events. `loop-continuation:query-launch` is
// answered by a stub extension, since the real provider is a different lane's extension.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  cleanupAll,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "../loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_EXTENSION = join(HERE, "index.ts");
const GUARD_ROOT_EXTENSION = join(HERE, "..", "loop-guard", "root.ts");
const BIN = join(HERE, "..", "..", "bin", "loop-state");

after(() => cleanupAll());

/** A repo with codex/, an agent home with bin/loop-state, and a stub answering query-launch. */
function scaffold() {
  const repo = freshDir("loop-state-e2e-repo-");
  const agentDir = freshDir("loop-state-e2e-agent-");
  mkdirSync(join(repo, "codex"));
  mkdirSync(join(agentDir, "bin"));
  symlinkSync(BIN, join(agentDir, "bin", "loop-state"));
  const report = join(repo, "codex", "report-camp-loop1.md");
  const log = join(repo, "codex", "state-camp-loop1.jsonl");
  const stubDir = freshDir("loop-state-e2e-stub-");
  const stub = join(stubDir, "launch-stub.ts");
  writeFileSync(
    stub,
    `export default function (pi) { pi.events.on("loop-continuation:query-launch", (d) => d.reply({ reportPath: ${JSON.stringify(report)}, opsPath: null, ops: null })); }\n`,
  );
  return { repo, agentDir, report, log, stub };
}

const append = (log: string, ...args: string[]) => execFileSync(BIN, ["append", log, ...args], { stdio: "pipe" });

test("a forced compaction is followed by a fresh loop-state-digest message", async () => {
  const s = scaffold();
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 20 } }));
  append(s.log, "open", "goal_sha256=" + "a".repeat(64), "tier=routine", "root=llm", "root_model=m", 'envelope=["T1"]');
  append(s.log, "admit", "task=T1", "source=envelope", "owned=x", "accept=ok");
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub],
    fauxScriptPath: writeFauxScript([{ match: ".*", text: "FAUX reply" }]),
    agentDir: s.agentDir,
    subagentTempRoot: freshDir("loop-state-e2e-sub-"),
    cwd: s.repo,
    sessionArgs: [],
  });
  const digests = () =>
    session.events.filter((e) => {
      const m = e.message as { role?: string; customType?: string } | undefined;
      return e.type === "message_end" && m?.role === "custom" && m.customType === "loop-state-digest";
    });
  try {
    session.send({ id: "p1", type: "prompt", message: "first message" });
    await session.waitFor((e) => e.type === "agent_end");
    session.send({ id: "p2", type: "prompt", message: "second message" });
    await session.waitFor((e) => e.type === "agent_end" && session.events.filter((x) => x.type === "agent_end").length === 2);
    await waitForCondition(() => (digests().length >= 1 ? true : undefined));
    const beforeCompact = digests().length;
    append(s.log, "judgement", "text=marker-after-start-" + "z".repeat(5));

    session.send({ id: "c1", type: "compact" });
    const response = await session.waitFor((e) => e.type === "response" && e.id === "c1");
    assert.equal(response.success, true, JSON.stringify(response).slice(0, 400));
    await waitForCondition(() => (digests().length > beforeCompact ? true : undefined));

    session.send({ id: "m1", type: "get_messages" });
    const reply = await session.waitFor((e) => e.type === "response" && e.id === "m1");
    const messages = (reply.data as { messages: { role: string; customType?: string; content?: unknown }[] }).messages;
    const summaryAt = messages.findIndex((m) => m.role === "compactionSummary");
    const digestAt = messages.map((m) => m.role === "custom" && m.customType === "loop-state-digest").lastIndexOf(true);
    assert.ok(summaryAt >= 0, "the compaction left a summary in context");
    assert.ok(digestAt > summaryAt, `the digest follows the compaction summary (summary ${summaryAt}, digest ${digestAt})`);
    assert.match(JSON.stringify(messages[digestAt].content), /marker-after-start-zzzzz/, "the digest is regenerated, not the session_start one");
  } finally {
    await session.close();
  }
});

for (const outcome of ["valid", "recovered", "missing-again", "resume-failed", "original-failed"] as const) {
test(`each real package recovery has its own dispatch and return: ${outcome}`, async () => {
  const s = scaffold();
  const requests = join(s.repo, "rpc.jsonl");
  const completions = join(s.repo, "completions.jsonl");
  const observer = join(dirname(s.stub), "observer.ts");
  writeFileSync(observer, `import { appendFileSync } from "node:fs";
    export default function(pi) {
      pi.events.on("subagents:rpc:v1:request", d => {
        if (d.method === "resume") appendFileSync(${JSON.stringify(requests)}, JSON.stringify(d) + "\\n");
      });
      const seen = new Set();
      pi.events.on("subagent:async-complete", d => {
        if (seen.has(d.runId)) return;
        seen.add(d.runId);
        appendFileSync(${JSON.stringify(completions)}, JSON.stringify(d) + "\\n");
        setTimeout(() => pi.events.emit("subagent:async-complete", d), 20);
      });
    }`);
  writeFileSync(s.stub, readFileSync(s.stub, "utf8").replace("export default function (pi) {", "export default function (pi) { observe(pi);") + `\nimport observe from ${JSON.stringify(observer)};\n`);
  mkdirSync(join(s.agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(s.agentDir, "settings.json"),
    JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }),
  );
  writeFileSync(
    join(s.agentDir, "agents", "lane-worker.md"),
    [
      "---",
      "name: lane-worker",
      "description: Test lane worker for the loop-state e2e proof",
      "tools: bash",
      "timeoutMs: 60000",
      "extensions: []",
      `subagentOnlyExtensions: ${FAUX_EXTENSION}`,
      "model: faux/faux-1",
      "---",
      "",
      "You are a test lane worker.",
    ].join("\n"),
  );
  const block =
    '```lane-return\n{"v":2,"lane":"L1","status":"complete","sha":null,"landed":false,"base":"b","check":"just check","exit":0,"tail":"ok","ci":null,"coderabbit":null,"questions":[]}\n```';
  const fauxScript = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [
        {
          name: "subagent",
          args: { agent: "lane-worker", task: "Lane: L1 · Task: T1 · Tier: routine\nObjective: CHILD_LANE_MARKER" },
        },
      ],
    },
    { match: "CHILD_LANE_MARKER", once: true, text: outcome === "valid" ? `Finished.\n${block}` : "Finished without a return block.", ...(outcome === "original-failed" ? { stopReason: "error" as const, errorMessage: "scripted implementation failure" } : {}) },
    { match: "Return only the missing fenced lane-return", delayMs: 1500, text: outcome === "recovered" || outcome === "original-failed" ? block : "Still missing.", ...(outcome === "resume-failed" ? { stopReason: "error" as const, errorMessage: "scripted child failure" } : {}) },
    { match: ".*", text: "ok" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub, join(HERE, "..", "loop-wait", "root.ts")],
    fauxScriptPath: fauxScript,
    agentDir: s.agentDir,
    subagentTempRoot: freshDir("loop-state-e2e-sub-"),
    cwd: s.repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE please" });
    const events = await waitForCondition(() => {
      try {
        const rows = readFileSync(s.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const laneRows = rows.filter(r => r.ev === "dispatch" || r.ev === "return");
        return laneRows.filter((r) => r.ev === "return").length === (outcome === "valid" ? 1 : 2) ? laneRows : undefined;
      } catch {
        return undefined;
      }
    }, 60_000, 250).catch((error: Error) => {
      throw new Error(`${error.message}\nstderr: ${session.stderr.join("").slice(0, 2000)}`);
    });
    const dispatch = events[0];
    const ret = events.find(r => r.ev === "return" && r.run === dispatch.run)!;
    assert.equal(dispatch.ev, "dispatch");
    assert.deepEqual(
      { by: dispatch.by, lane: dispatch.lane, task: dispatch.task, agent: dispatch.agent },
      { by: "ext", lane: "L1", task: "T1", agent: "lane-worker" },
    );
    assert.match(dispatch.run, /\S/);
    assert.equal(ret.run, dispatch.run, "the return carries the run id the dispatch recorded");
    assert.deepEqual(
      { lane: ret.lane, status: ret.status, check: ret.check, exit: ret.exit },
      outcome === "missing-again" || outcome === "resume-failed"
        ? { lane: "L1", status: "failed", check: undefined, exit: undefined }
        : { lane: "L1", status: outcome === "original-failed" ? "failed" : "complete", check: "just check", exit: 0 },
    );
    await new Promise(r => setTimeout(r, 500));
    const rpc = (() => { try { return readFileSync(requests, "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } })();
    assert.equal(rpc.length, outcome === "valid" ? 0 : 1, "exactly one authoritative resume only when missing");
    if (rpc.length) {
      assert.equal(rpc[0].params.id, dispatch.run);
      assert.match(rpc[0].params.message, /lane L1/);
      const finished = readFileSync(completions, "utf8").trim().split("\n").map(l => JSON.parse(l));
      assert.equal(finished.length, 2);
      assert.notEqual(finished[1].runId, dispatch.run, "package resume allocates a new run identity");
      if (outcome === "recovered") assert.match(finished[1].results[0].summary, /"v":2/);
    }
    const laneRows = readFileSync(s.log, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.ev === "dispatch" || r.ev === "return");
    assert.equal(laneRows.length, outcome === "valid" ? 2 : 4, "each distinct run is accounted exactly once despite replayed completions");
    if (rpc.length) {
      const finished = readFileSync(completions, "utf8").trim().split("\n").map(l => JSON.parse(l));
      const revived = finished[1].runId;
      assert.deepEqual(laneRows.filter(r => r.run === revived).map(r => [r.ev, r.lane, r.task]),
        [["dispatch", "L1", "T1"], ["return", "L1", undefined]]);
      assert.equal(laneRows.find(r => r.ev === "dispatch" && r.run === revived).recovery_of, dispatch.run);
      if (outcome === "original-failed") {
        assert.equal(laneRows.find(r => r.ev === "return" && r.run === revived).status, "complete", "recovery successfully generated the block");
      }
    }
    execFileSync(BIN, ["check", s.log]);
    const digest = execFileSync(BIN, ["digest", s.log], { encoding: "utf8" });
    assert.match(digest, /## Live lanes \(0\)/);
    const summary = JSON.parse(execFileSync(BIN, ["digest", s.log, "--json"], { encoding: "utf8", timeout: 10_000 }));
    const unfinished = ["original-failed", "missing-again", "resume-failed"].includes(outcome);
    assert.deepEqual(summary.admissible, unfinished ? ["T1"] : [], "recovery lifecycle success must not falsely drain failed work");
    assert.match(digest, new RegExp(`T1: returned status=${unfinished ? "failed" : "complete"} lane=L1 run=${dispatch.run}`));
    const watches = readFileSync(s.log, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.ev === "watch");
    assert.equal(watches.length, outcome === "valid" ? 2 : 4, "package recovery and completion replays never duplicate deadline watches");
    assert.equal(new Set(watches.map(r => r.what)).size, outcome === "valid" ? 1 : 2);
  } finally {
    await session.close();
  }
});

}

test("ordinary native resumes each retain their own identity and stay live past an earlier return", { timeout: 90_000 }, async () => {
  const s = scaffold();
  mkdirSync(join(s.agentDir, "agents"), { recursive: true });
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(s.agentDir, "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Test reviewer", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker"].join("\n"));
  const block = (lane: string) => '```lane-return\n' + JSON.stringify({ v: 2, lane, status: "complete", sha: null, landed: false, check: "fixture", exit: 0 }) + '\n```';
  const observed = join(s.repo, "starts.jsonl");
  writeFileSync(s.stub, readFileSync(s.stub, "utf8") + `
    import { appendFileSync } from "node:fs";
    export const install = (pi) => {
      let latest;
      pi.events.on("subagent:async-started", d => { latest = d.id; appendFileSync(${JSON.stringify(observed)}, JSON.stringify(d) + "\\n"); });
      pi.on("tool_call", e => { if (e.toolName === "subagent" && e.input.id === "LATEST_TEST_RUN") e.input.id = latest; });
    };
  `);
  writeFileSync(s.stub, readFileSync(s.stub, "utf8").replace("export default function (pi) {", "export default function (pi) { install(pi);"));
  const script = writeFauxScript([
    { match: "SPAWN_ORIGINAL", once: true, toolCalls: [{ name: "subagent", args: { agent: "reviewer", task: "Lane: L1 · Task: T1 · Tier: guarded\nObjective: ORIGINAL_CHILD" } }] },
    ...([1, 2] as const).flatMap(index => [
      { match: `ROOT_FOLLOWUP_${index}`, once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "LATEST_TEST_RUN", timeoutMs: 30_000, message: index === 1 ? "FOLLOWUP_1" : "Lane: L2 · Task: T2 · Tier: guarded\nObjective: FOLLOWUP_2" } }] },
      { match: `FOLLOWUP_${index}`, delayMs: 3000, text: block(index === 1 ? "L1" : "L2") },
    ]),
    { match: "ORIGINAL_CHILD", text: block("L1") },
    { match: ".*", text: "ok" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, STATE_EXTENSION, join(HERE, "..", "loop-wait", "root.ts")], fauxScriptPath: script,
    agentDir: s.agentDir, subagentTempRoot: freshDir("loop-state-e2e-sub-"), cwd: s.repo,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"] });
  const rows = () => { try { return readFileSync(s.log, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => ["dispatch", "return"].includes(r.ev)); } catch { return []; } };
  const digest = () => execFileSync(BIN, ["digest", s.log], { encoding: "utf8" });
  try {
    session.send({ id: "original", type: "prompt", message: "SPAWN_ORIGINAL" });
    await waitForCondition(() => rows().length === 2 ? true : undefined, 30_000);
    const original = rows()[0].run;
    let source = original;
    for (const [index, lane, task] of [[1, "L1", "T1"], [2, "L2", "T2"]] as const) {
      const marker = `FOLLOWUP_${index}`;
      session.send({ id: marker, type: "prompt", message: `ROOT_${marker}` });
      const native = await waitForCondition(() => {
        const starts = readFileSync(observed, "utf8").trim().split("\n").map(l => JSON.parse(l));
        return starts[index];
      }, 20_000);
      assert.notEqual(native.id, source, "native resume exposes a new run identity");
      const revived = await waitForCondition(() => rows().find(r => r.ev === "dispatch" && r.run === native.id), 10_000)
        .catch(() => { throw new Error(`native resumed identity ${native.id} has no dispatch: ${JSON.stringify(rows())}`); });
      assert.equal(revived.lane, lane);
      assert.equal(revived.task, task);
      assert.equal(revived.agent, "reviewer");
      assert.equal(revived.deadline, new Date(native.deadlineAt).toISOString().replace(/\.\d{3}Z$/, "Z"), "the resumed deadline comes from this native run");
      assert.match(digest(), /## Live lanes \(1\)/);
      append(s.log, "return", "lane=L1", `run=${original}`, "status=complete");
      assert.match(digest(), /## Live lanes \(1\)/, "an earlier reviewer return cannot terminate the revived run");
      assert.match(digest(), new RegExp(`${task}: dispatched lane=${lane} run=${revived.run}`));
      await waitForCondition(() => rows().some(r => r.ev === "return" && r.run === revived.run) ? true : undefined, 20_000);
      source = revived.run;
    }
    const lifecycle = rows().filter(r => r.by === "ext");
    assert.equal(lifecycle.length, 6);
    for (const run of new Set(lifecycle.map(r => r.run))) assert.deepEqual(lifecycle.filter(r => r.run === run).map(r => r.ev), ["dispatch", "return"]);
    assert.match(digest(), /## Live lanes \(0\)/);
    const watches = readFileSync(s.log, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.ev === "watch");
    assert.equal(watches.length, 6, "one deadline watch start/stop for each native run, no replay attempts");
    assert.equal(new Set(watches.map(r => r.what)).size, 3);
    execFileSync(BIN, ["check", s.log]);
  } finally { await session.close(); }
});

test("S6: a 3.37 MB lane return reaches the root at 16 KB or less with its lane-return block, and the return event keeps its fields", async () => {
  const s = scaffold();
  const runDir = freshDir("loop-state-e2e-run-");
  mkdirSync(join(s.agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(s.agentDir, "settings.json"),
    JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }),
  );
  writeFileSync(
    join(s.agentDir, "agents", "lane-worker.md"),
    ["---", "name: lane-worker", "description: Test lane worker", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", "worker"].join("\n"),
  );
  const block =
    '```lane-return\n{"v":2,"lane":"L9","status":"complete","sha":null,"landed":false,"base":"b","check":"just check","exit":0,"tail":"ok","ci":null,"coderabbit":null,"questions":[]}\n```';
  // The block comes first and every gate log after it, as in the oversized return that overflowed a root.
  const huge = `Finished.\n${block}\n${"gate output line 0123456789 abcdefghijklmnopqrstuvwxyz\n".repeat(62_000)}END_OF_RETURN`;
  assert.ok(Buffer.byteLength(huge) > 3_370_000);
  const fauxScript = writeFauxScript([
    { match: "SPAWN_LANE", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "Lane: L9 · Task: T9 · Tier: routine\nObjective: CHILD_HUGE_MARKER" } }] },
    { match: "CHILD_HUGE_MARKER", once: true, text: huge },
    { match: ".*", text: "ok" },
  ]);
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  const session = startPiRpc({
    // loop-guard's root registers its lane entry in every child; the lane caps its own return,
    // since an idle root's notify reaches no extension message_end (pi-subagents 0.76.1).
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, GUARD_ROOT_EXTENSION, s.stub],
    fauxScriptPath: fauxScript,
    agentDir: s.agentDir,
    subagentTempRoot: freshDir("loop-state-e2e-sub-"),
    cwd: s.repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
  else process.env.LOOP_PI_RUN_DIR = previous;
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_LANE please" });
    const notify = await session.waitFor(
      (e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "subagent-notify",
      90_000,
    );
    const content = (notify.message as { content: string }).content;
    assert.equal(typeof content, "string");
    assert.ok(Buffer.byteLength(content) <= 16_384, `the root received ${Buffer.byteLength(content)} bytes`);
    assert.ok(content.includes(block), "the lane-return block is intact");
    assert.ok(content.includes("END_OF_RETURN"), "the tail is kept");
    const marker = /^\[\.\.\. (\d+) bytes omitted; full return: (\S+) \.\.\.\]$/m.exec(content);
    assert.ok(marker, "the marker line names the omitted bytes and the full return");
    const full = readFileSync(marker[2], "utf8");
    assert.ok(full.includes(huge), "the full return is kept on disk");
    assert.ok(marker[2].startsWith(join(runDir, "returns") + "/"), marker[2]);

    session.send({ id: "m1", type: "get_messages" });
    const reply = await session.waitFor((e) => e.type === "response" && e.id === "m1");
    const kept = (reply.data as { messages: { role: string; customType?: string; content?: unknown }[] }).messages.find(
      (m) => m.role === "custom" && m.customType === "subagent-notify",
    );
    assert.ok(kept && Buffer.byteLength(String(kept.content)) <= 16_384, "the session keeps the capped message, not the full one");

    const ret = await waitForCondition(() => {
      try {
        const rows = readFileSync(s.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        return rows.find((r) => r.ev === "return");
      } catch {
        return undefined;
      }
    }, 30_000, 250);
    assert.deepEqual(
      { lane: ret.lane, status: ret.status, check: ret.check, exit: ret.exit, landed: ret.landed },
      { lane: "L9", status: "complete", check: "just check", exit: 0, landed: false },
    );
  } finally {
    await session.close();
  }
});
