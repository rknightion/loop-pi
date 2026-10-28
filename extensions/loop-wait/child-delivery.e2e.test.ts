// End-to-end: a senior lane that launches a child gets the child's result back in the same lane
// run. pi-subagents gives a child runtime no completion notifier, and loop-pi turns its `bg_wait`
// off, so without loop-wait's lane delivery the senior settles still waiting and its work is lost.
// Real pinned pi CLI, real pi-subagents, faux provider; root -> senior -> scout (depth 2).
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAll,
  freshDir,
  readTextFile,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "../loop-guard/rpc-test-helpers.ts";

after(() => cleanupAll());

const SEED = "CHILD_SEED_4242";

function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function assistantRows(path: string): { text: string; at: number }[] {
  const rows: { text: string; at: number }[] = [];
  for (const line of readTextFile(path).split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    rows.push({ text: m.content.map((b: any) => (b?.type === "text" ? b.text : "")).join(""), at: Date.parse(row.timestamp) });
  }
  return rows;
}

const assistantTexts = (path: string) => assistantRows(path).map((r) => r.text);

function setupHome(): { agentDir: string; subagentTemp: string; cwd: string } {
  const agentDir = freshDir("loop-wait-child-delivery-agentdir-");
  const subagentTemp = freshDir("loop-wait-child-delivery-subtemp-");
  const cwd = freshDir("loop-wait-child-delivery-cwd-");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }),
  );
  // Same wait setting as the installed home: no `bg_wait` for any runtime.
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ waitTool: false, maxSubagentDepth: 2 }));
  const agent = (name: string, extra: string[]) =>
    writeFileSync(
      join(agentDir, "agents", `${name}.md`),
      ["---", `name: ${name}`, `description: faux ${name}`, ...extra, "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "", `You are a test ${name}.`].join("\n"),
    );
  agent("senior", ["tools: bash, subagent", "allowedAgents: scout", "maxSubagentDepth: 2"]);
  agent("scout", ["tools: bash"]);
  return { agentDir, subagentTemp, cwd };
}

const LAUNCH_SCOUT = { match: "SENIOR_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "scout", task: "SCOUT_GO report the seed" } }] };
const FINAL_REPORT = 'FINAL_REPORT\n```lane-return\n{"v":3,"lane":"L1","status":"complete","exit":0}\n```';

const SHAPES = [
  {
    name: "the child finishes before the senior ends its turn",
    order: "child-first",
    senior: [
      { match: `loop-pi: child run .*${SEED}`, text: `SENIOR_GOT ${SEED}` },
      { match: "Async: scout", delayMs: 4000, text: "WAITING_FOR_SCOUT" },
      LAUNCH_SCOUT,
    ],
    scoutMs: 0,
    marker: "WAITING_FOR_SCOUT",
    last: `SENIOR_GOT ${SEED}`,
  },
  {
    name: "the child finishes while the senior's end-of-run drain holds it",
    order: "senior-first",
    senior: [
      { match: `loop-pi: child run .*${SEED}`, text: `SENIOR_GOT ${SEED}` },
      { match: "Async: scout", text: "WAITING_FOR_SCOUT" },
      LAUNCH_SCOUT,
    ],
    scoutMs: 4000,
    marker: "WAITING_FOR_SCOUT",
    last: `SENIOR_GOT ${SEED}`,
  },
  {
    // The senior works on while the child runs and writes its return before settling: the result is
    // recorded but the run is not continued, so the root still receives that return.
    name: "the senior already wrote its return when the child result arrives",
    order: "child-first",
    senior: [
      { match: `loop-pi: child run .*${SEED}`, text: "AFTER_RETURN_REPLY" },
      { match: "Async: scout", toolCalls: [{ name: "bash", args: { command: "echo BASH_DONE; sleep 6" } }] },
      { match: "BASH_DONE", text: FINAL_REPORT },
      LAUNCH_SCOUT,
    ],
    scoutMs: 0,
    marker: "FINAL_REPORT",
    last: FINAL_REPORT,
  },
];

for (const shape of SHAPES) {
  test(`senior lane receives its child's result: ${shape.name}`, { timeout: 120_000 }, async () => {
    const { agentDir, subagentTemp, cwd } = setupHome();
    const fauxScript = writeFauxScript([
      // Root: launch the senior once, then acknowledge everything.
      { match: "LAUNCH_SENIOR", once: true, toolCalls: [{ name: "subagent", args: { agent: "senior", task: "SENIOR_GO delegate to a scout" } }] },
      { match: "Async: senior", text: "root ok" },
      ...shape.senior,
      // Scout: return the value only it knows.
      { match: "SCOUT_GO", delayMs: shape.scoutMs, text: SEED },
      { match: ".*", text: "ok" },
    ]);
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
      fauxScriptPath: fauxScript,
      agentDir,
      subagentTempRoot: subagentTemp,
      cwd,
      sessionArgs: [],
      extraArgs: ["--exclude-tools", "subagents_enable"],
    });
    try {
      session.send({ id: "p1", type: "prompt", message: "LAUNCH_SENIOR please" });
      const sessions = join(agentDir, "sessions");
      // What the root receives as the lane's result: its subagent-notify message, once the senior settles.
      const notices = () => session.events.map((e) => JSON.stringify(e)).filter((e) => e.includes("subagent-notify") && e.includes('"message_end"'));
      const notice = await waitForCondition(() => notices().find((e) => e.includes("senior")), 90_000, 300).catch(() => undefined);
      assert.ok(notice, "the root received the senior's completion");
      const seniorPath = sessionFiles(sessions).find((p) => assistantTexts(p).some((t) => t.includes(shape.marker)));
      const scoutPath = sessionFiles(sessions).find((p) => assistantTexts(p).some((t) => t.trim() === SEED));
      assert.ok(seniorPath, "the senior ran and launched its scout");
      assert.ok(scoutPath, "the scout really finished, or this test proves nothing about delivery");
      const texts = assistantTexts(seniorPath!);
      assert.equal(texts.at(-1), shape.last, `the senior's last word: ${JSON.stringify(texts)}`);
      assert.ok(notice!.includes(JSON.stringify(shape.last).slice(1, -1)), `the root received that last word: ${notice!.slice(0, 800)}`);
      // The timing each shape claims actually happened.
      const scoutDone = assistantRows(scoutPath!).find((r) => r.text.trim() === SEED)!.at;
      const seniorMarker = assistantRows(seniorPath!).find((r) => r.text.includes(shape.marker))!.at;
      if (shape.order === "child-first") assert.ok(scoutDone < seniorMarker, "the scout finished before the senior's turn ended");
      else assert.ok(scoutDone > seniorMarker, "the scout finished after the senior's turn ended");
      const delivered = readTextFile(seniorPath!).split("\n").filter((l) => l.includes('"customType":"loop-pi-child-result"'));
      assert.equal(delivered.length, 1, "the result was delivered exactly once");
      assert.ok(delivered[0].includes(SEED), "the delivered message carries the scout's output");
      for (const p of sessionFiles(sessions)) {
        const calls = readTextFile(p).split("\n").filter(Boolean).flatMap((line) => {
          try {
            const content = JSON.parse(line).message?.content;
            return Array.isArray(content) ? content.filter((part: any) => part?.type === "toolCall").map((part: any) => part.name) : [];
          } catch {
            return [];
          }
        });
        assert.equal(calls.includes("bg_wait"), false, `no runtime called bg_wait: ${p}`);
      }
    } finally {
      await session.close();
    }
  });
}
