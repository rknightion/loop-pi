// Real Pi root and native background child; inspect the displayed command messages, not helpers.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, freshDir, PI_SUBAGENTS_PACKAGE_DIR, startPiRpc, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";
after(cleanupAll);

test("root commands show native live child route and the answering model without a model turn", { timeout: 60000 }, async () => {
  const agentDir = freshDir("observe-home-"), repo = freshDir("observe-repo-");
  mkdirSync(join(agentDir, "agents"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(agentDir, "agents/worker.md"), `---\nname: worker\ndescription: Observation child\nmodel: faux/faux-1\nthinking: low\nsubagentOnlyExtensions: ${FAUX_EXTENSION}\n---\nReturn the requested marker.\n`);
  const pi = startPiRpc({ agentDir, cwd: repo, sessionArgs: [], subagentTempRoot: freshDir("observe-native-"),
    extensions: [FAUX_EXTENSION, join(import.meta.dirname, "index.ts")],
    fauxScriptPath: writeFauxScript([
      { match: "START_CHILD", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "CHILD_PRIVATE_MARKER", async: true } }] },
      { match: "CHILD_PRIVATE_MARKER", delayMs: 3000, text: "CHILD_PRIVATE_OUTPUT" },
      { match: ".*", text: "ok" },
    ]) });
  const observed = (e: any) => e.type === "message_end" && e.message?.customType === "loop-child-observation";
  const command = async (message: string) => {
    const since = pi.events.length;
    pi.send({ type: "prompt", message });
    return (await pi.waitFor(e => observed(e) && pi.events.indexOf(e) >= since, 10000)).message as any;
  };
  try {
    pi.send({ type: "prompt", message: "START_CHILD" });
    const launch: any = await pi.waitFor(e => e.type === "tool_execution_end" && e.toolName === "subagent" && Boolean((e.result as any)?.details?.asyncId), 20000);
    const id = launch.result.details.asyncId;
    await pi.waitFor(e => e.type === "agent_end");
    const live = await command("/loop-children");
    assert.match(live.content, /agent=worker · model=faux\/faux-1 · thinking=low/);
    await pi.waitFor(e => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify", 20000);
    // Let any native completion wake settle before counting assistant turns.
    pi.send({ type: "get_state", id: "settled" });
    await pi.waitFor(e => e.type === "response" && e.id === "settled");
    const inspect = await command(`/loop-inspect ${id}`);
    assert.match(inspect.content, /Requested model: faux\/faux-1/);
    assert.match(inspect.content, /Answering model: faux\/faux-1/);
    assert.doesNotMatch(inspect.content, /CHILD_PRIVATE/);
    assert.equal(inspect.display, true);
    const models = pi.events.filter(e => e.type === "message_start" && (e.message as any)?.role === "assistant").length;
    await command(`/loop-inspect ${id} step:0`);
    assert.equal(pi.events.filter(e => e.type === "message_start" && (e.message as any)?.role === "assistant").length, models);
  } finally { await pi.close(); }
});
