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

test("a real lane yields dispatch and return events through the subagent tool", async () => {
  const s = scaffold();
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
    { match: "CHILD_LANE_MARKER", once: true, text: `Finished.\n${block}` },
    { match: ".*", text: "ok" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub],
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
        return rows.some((r) => r.ev === "return") ? rows : undefined;
      } catch {
        return undefined;
      }
    }, 60_000, 250).catch((error: Error) => {
      throw new Error(`${error.message}\nstderr: ${session.stderr.join("").slice(0, 2000)}`);
    });
    const [dispatch, ret] = events;
    assert.equal(dispatch.ev, "dispatch");
    assert.deepEqual(
      { by: dispatch.by, lane: dispatch.lane, task: dispatch.task, agent: dispatch.agent },
      { by: "ext", lane: "L1", task: "T1", agent: "lane-worker" },
    );
    assert.match(dispatch.run, /\S/);
    assert.equal(ret.run, dispatch.run, "the return carries the run id the dispatch recorded");
    assert.deepEqual(
      { lane: ret.lane, status: ret.status, check: ret.check, exit: ret.exit },
      { lane: "L1", status: "complete", check: "just check", exit: 0 },
    );
    execFileSync(BIN, ["check", s.log]);
    const digest = execFileSync(BIN, ["digest", s.log], { encoding: "utf8" });
    assert.match(digest, /## Live lanes \(0\)/);
  } finally {
    await session.close();
  }
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
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, s.stub],
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
