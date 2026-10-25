// The shipped home loads pi-subagents for its extension only. Its bundled skills teach `workflow`
// launches and `bg_wait`, which a loop root may not use (loop-guard refuses them), so the home's
// package entry loads none of them. Real pinned pi over RPC, faux provider.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupAll, FAUX_EXTENSION, freshDir, startPiRpc, writeFauxScript } from "./rpc-test-helpers.ts";

after(() => {
  cleanupAll();
});

const PREFIX = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const template = readFileSync(new URL("../../home/settings.json", import.meta.url), "utf8");

test("the home's pi-subagents package entry loads the extension and no bundled skill", async () => {
  const shipped = JSON.parse(template.replaceAll("{{PREFIX}}", PREFIX).replaceAll("{{HOME}}", "/nonexistent-home"));
  const agentDir = freshDir("loop-guard-home-skills-");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: shipped.packages, subagents: { agentExcludeDirs: ["~/.agents"] } }));
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION], fauxScriptPath: writeFauxScript([{ match: ".*", text: "ok" }]),
    agentDir, cwd: freshDir("loop-guard-home-skills-cwd-"), subagentTempRoot: freshDir("loop-guard-home-skills-sub-"),
  });
  try {
    session.send({ type: "get_commands", id: "commands" });
    const commands = ((await session.waitFor((e) => e.type === "response" && e.id === "commands")).data as any).commands as any[];
    const names = commands.map((c) => `${c.source}:${c.name}`);
    assert.ok(commands.some((c) => c.source === "extension" && /subagent/.test(c.name)), `pi-subagents' extension commands must load: ${names}`);
    assert.deepEqual(commands.filter((c) => c.source === "skill").map((c) => c.name), [], "no bundled pi-subagents skill reaches the root");
  } finally {
    await session.close();
  }
});
