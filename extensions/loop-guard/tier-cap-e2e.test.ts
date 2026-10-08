// Real-CLI proof on the faux provider of the per-loop SUPER/MEGASUPER dispatch cap: a root
// running loop-guard and loop-state launches two SUPER lanes and one MEGASUPER lane, the third
// SUPER and second MEGASUPER launches are refused, and a fresh root process on the same loop
// (a restart) is still refused, because the count comes from the loop's state log.
// `loop-continuation:query-launch` is answered by a stub naming the loop's report.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAll,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
  type PiRpcSession,
  type RpcEvent,
} from "./rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_EXTENSION = join(HERE, "..", "loop-state", "index.ts");
const BIN = join(HERE, "..", "..", "bin", "loop-state");
const CAP_REASON = "loop-guard: per-loop cap reached (2 SUPER, 1 MEGASUPER); park the task needs=owner";

after(() => cleanupAll());

function agentFile(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Test tier lane for the dispatch cap proof",
    "tools: bash",
    "timeoutMs: 60000",
    "extensions: []",
    `subagentOnlyExtensions: ${FAUX_EXTENSION}`,
    "model: faux/faux-1",
    "---",
    "",
    "You are a test lane.",
  ].join("\n");
}

function scaffold() {
  const repo = freshDir("tier-cap-e2e-repo-");
  const agentDir = freshDir("tier-cap-e2e-agent-");
  mkdirSync(join(repo, "codex"));
  mkdirSync(join(agentDir, "bin"));
  mkdirSync(join(agentDir, "agents"));
  symlinkSync(BIN, join(agentDir, "bin", "loop-state"));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }),
  );
  for (const name of ["super-worker", "megasuper-worker"]) writeFileSync(join(agentDir, "agents", `${name}.md`), agentFile(name));
  const report = join(repo, "codex", "report-camp-loop1.md");
  const log = join(repo, "codex", "state-camp-loop1.jsonl");
  const stub = join(freshDir("tier-cap-e2e-stub-"), "launch-stub.ts");
  writeFileSync(
    stub,
    `export default function (pi) { pi.events.on("loop-continuation:query-launch", (d) => d.reply({ reportPath: ${JSON.stringify(report)}, opsPath: null, ops: null })); }\n`,
  );
  return { repo, agentDir, log, stub };
}

const launch = (agent: string, lane: string) => ({
  name: "subagent",
  args: { agent, task: `Lane: ${lane} · Task: T${lane} · Tier: routine\nObjective: CHILD_TIER_MARKER` },
});

const BLOCK =
  '```lane-return\n{"v":2,"lane":"L","status":"complete","sha":null,"landed":false,"base":"b","check":"just check","exit":0,"tail":"ok","ci":null,"coderabbit":null,"questions":[]}\n```';

function startRoot(s: ReturnType<typeof scaffold>, trigger: string, calls: { name: string; args: Record<string, unknown> }[]): PiRpcSession {
  return startPiRpc({
    extensions: [FAUX_EXTENSION, STATE_EXTENSION, ROOT_EXTENSION, s.stub],
    fauxScriptPath: writeFauxScript([
      { match: trigger, once: true, toolCalls: calls },
      { match: "CHILD_TIER_MARKER", text: `Finished.\n${BLOCK}` },
      { match: ".*", text: "ok" },
    ]),
    agentDir: s.agentDir,
    subagentTempRoot: freshDir("tier-cap-e2e-sub-"),
    cwd: s.repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
  });
}

/** Every `subagent` call of the scripted message, in order, with its lane and its tool result. */
async function subagentOutcomes(session: PiRpcSession, count: number) {
  const ends = await waitForCondition(() => {
    const found = session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "subagent");
    return found.length >= count ? found : undefined;
  }, 60_000).catch((error: Error) => {
    throw new Error(`${error.message}\nstderr: ${session.stderr.join("").slice(0, 2000)}`);
  });
  const assistant = session.events.find((e) => {
    const m = e.message as { role?: string; content?: { type: string }[] } | undefined;
    return e.type === "message_end" && m?.role === "assistant" && (m.content ?? []).some((c) => c.type === "toolCall");
  }) as RpcEvent;
  const calls = ((assistant.message as { content: { type: string; id: string; arguments: { task: string } }[] }).content).filter((c) => c.type === "toolCall");
  return calls.map((call) => {
    const end = ends.find((e) => e.toolCallId === call.id)!;
    const text = JSON.stringify((end.result as { content?: unknown })?.content ?? end.result);
    return { lane: /^Lane: (\S+)/.exec(call.arguments.task)![1], refused: end.isError === true && text.includes(CAP_REASON), isError: end.isError === true, text };
  });
}

function dispatchRows(log: string): { agent: string; lane: string; run: string }[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ev === "dispatch");
  } catch {
    return [];
  }
}

test("per-loop cap: 2 SUPER and 1 MEGASUPER launch, the 3rd SUPER and 2nd MEGASUPER are refused, also after a root restart", { timeout: 150_000 }, async () => {
  const s = scaffold();
  const first = startRoot(s, "SPAWN_TIERS", [
    launch("super-worker", "L1"),
    launch("super-worker", "L2"),
    launch("megasuper-worker", "L3"),
    launch("super-worker", "L4"),
    launch("megasuper-worker", "L5"),
  ]);
  try {
    first.send({ id: "p1", type: "prompt", message: "SPAWN_TIERS please" });
    const outcomes = await subagentOutcomes(first, 5);
    assert.deepEqual(
      outcomes.map((o) => [o.lane, o.isError, o.refused]),
      [["L1", false, false], ["L2", false, false], ["L3", false, false], ["L4", true, true], ["L5", true, true]],
      JSON.stringify(outcomes.map((o) => o.text.slice(0, 300))),
    );
    const rows = await waitForCondition(() => {
      const found = dispatchRows(s.log);
      return found.length >= 3 ? found : undefined;
    }, 60_000, 250);
    assert.deepEqual(rows.map((r) => [r.lane, r.agent]).sort(), [["L1", "super-worker"], ["L2", "super-worker"], ["L3", "megasuper-worker"]]);
  } finally {
    await first.close();
  }

  // A restarted root keeps no in-memory count: only the state log carries the earlier launches.
  const second = startRoot(s, "SPAWN_AGAIN", [launch("super-worker", "L6"), launch("megasuper-worker", "L7")]);
  try {
    second.send({ id: "p2", type: "prompt", message: "SPAWN_AGAIN please" });
    const outcomes = await subagentOutcomes(second, 2);
    assert.deepEqual(outcomes.map((o) => [o.lane, o.refused]), [["L6", true], ["L7", true]], JSON.stringify(outcomes.map((o) => o.text.slice(0, 300))));
    assert.equal(dispatchRows(s.log).length, 3, "a refused launch records no dispatch");
  } finally {
    await second.close();
  }
});
