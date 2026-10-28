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

function assistantTexts(path: string): string[] {
  const texts: string[] = [];
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
    texts.push(m.content.map((b: any) => (b?.type === "text" ? b.text : "")).join(""));
  }
  return texts;
}

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

for (const shape of [
  { name: "the child finishes before the senior ends its turn", seniorWaitMs: 4000, scoutMs: 0 },
  { name: "the child finishes while the senior's end-of-run drain holds it", seniorWaitMs: 0, scoutMs: 4000 },
]) {
  test(`senior lane receives its child's result: ${shape.name}`, { timeout: 120_000 }, async () => {
    const { agentDir, subagentTemp, cwd } = setupHome();
    const fauxScript = writeFauxScript([
      // Root: launch the senior once, then acknowledge everything.
      { match: "LAUNCH_SENIOR", once: true, toolCalls: [{ name: "subagent", args: { agent: "senior", task: "SENIOR_GO delegate to a scout" } }] },
      { match: "Async: senior", text: "root ok" },
      // Senior: launch the scout, say it is waiting, then build on the delivered result.
      { match: `loop-pi: child run .*${SEED}`, text: `SENIOR_GOT ${SEED}` },
      { match: "Async: scout", delayMs: shape.seniorWaitMs, text: "WAITING_FOR_SCOUT" },
      { match: "SENIOR_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "scout", task: "SCOUT_GO report the seed" } }] },
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
      // The scout must really finish, or this test proves nothing about delivery.
      await waitForCondition(
        () => sessionFiles(sessions).some((p) => assistantTexts(p).some((t) => t.trim() === SEED)) || undefined,
        60_000,
        300,
      );
      // The senior settles either way; wait for its last word.
      const senior = await waitForCondition(() => {
        const path = sessionFiles(sessions).find((p) => assistantTexts(p).some((t) => t.includes("WAITING_FOR_SCOUT")));
        if (!path) return undefined;
        const texts = assistantTexts(path);
        return texts.some((t) => t.includes("SENIOR_GOT")) ? { path, texts } : undefined;
      }, 45_000, 300).catch(() => {
        const path = sessionFiles(sessions).find((p) => assistantTexts(p).some((t) => t.includes("WAITING_FOR_SCOUT")));
        return { path, texts: path ? assistantTexts(path) : [] };
      });
      assert.ok(senior.path, "the senior ran and launched its scout");
      assert.equal(senior.texts.at(-1), `SENIOR_GOT ${SEED}`, `the senior built on the scout's result: ${JSON.stringify(senior.texts)}`);
      const delivered = readTextFile(senior.path!).split("\n").filter((l) => l.includes('"customType":"loop-pi-child-result"'));
      assert.equal(delivered.length, 1, "the result was delivered exactly once");
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
