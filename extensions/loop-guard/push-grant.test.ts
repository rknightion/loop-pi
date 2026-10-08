import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { evaluateBashCommand } from "./rules.ts";
import { hasLanePushGrant } from "./push-grant.ts";
import { FAUX_EXTENSION, LANE_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript } from "./rpc-test-helpers.ts";

after(cleanupAll);
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

function bashResult(dir: string): Record<string, unknown> | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = bashResult(path);
      if (result) return result;
    } else if (entry.name === "session.jsonl") {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        try {
          const message = JSON.parse(line).message;
          if (message?.role === "toolResult" && message.toolName === "bash") return message;
        } catch { /* a writer may be completing the last JSONL line */ }
      }
    }
  }
  return undefined;
}

for (const agent of ["lane-worker", "lane-worker-push"]) {
  test(`async push grant: ${agent}, spoofed bindings replaced, real local push outcome`, { timeout: 60_000 }, async () => {
    const home = freshDir("push-home-");
    const cwd = freshDir("push-repo-");
    const remote = freshDir("push-remote-");
    git(cwd, "init", "-b", "main");
    git(remote, "init", "--bare");
    git(cwd, "-c", "user.name=export", "-c", "user.email=export@example.com", "commit", "--allow-empty", "-m", "fixture");
    git(cwd, "remote", "add", "origin", remote);
    mkdirSync(join(home, "agents"), { recursive: true });
    mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
    // The shipped feature configuration must allow the root's injected binding.
    const config = JSON.parse(readFileSync(new URL("../../home/extensions/subagent/config.json", import.meta.url), "utf8"));
    writeFileSync(join(home, "extensions", "subagent", "config.json"), JSON.stringify(config));
    const capture = join(freshDir("push-capture-"), "capture.ts");
    writeFileSync(capture, `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {getAgentDir} from '@earendil-works/pi-coding-agent'; export default function(pi){pi.on('before_agent_start',()=>{writeFileSync(join(getAgentDir(),'binding.json'),process.env.PI_SUBAGENT_EXTENSION_BINDINGS||'null');});}`);
    writeFileSync(join(home, "agents", `${agent}.md`), ["---", `name: ${agent}`, "description: Push grant test", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}, ${capture}`, "model: faux/faux-1", "---", "Test worker."].join("\n"));
    const script = writeFauxScript([
      { match: "SPAWN_PUSH", once: true, toolCalls: [{ name: "subagent", args: { agent, task: "CHILD_PUSH", async: true, extensionBindings: { "loop-pi.guard/1": { agent: agent === "lane-worker" ? "lane-worker-push" : "lane-worker" }, "spoof/1": { grant: true } } } }] },
      { match: "CHILD_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
      { match: ".*", text: "done" },
    ]);
    const session = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script, agentDir: home, subagentTempRoot: freshDir(), cwd, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"] });
    try {
      session.send({ id: "p", type: "prompt", message: "SPAWN_PUSH" });
      const launch = await session.waitFor(e => e.type === "tool_execution_end" && e.toolName === "subagent");
      assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
      const result = await waitForCondition(() => bashResult(join(home, "sessions")), 30_000);
      assert.deepEqual(JSON.parse(readFileSync(join(home, "binding.json"), "utf8")), { "loop-pi.guard/1": { agent } });
      if (agent === "lane-worker") {
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /push requires a push-granted lane identity/);
        assert.throws(() => git(remote, "rev-parse", "refs/heads/main"));
      } else {
        assert.equal(result.isError, false);
        assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(cwd, "rev-parse", "HEAD"));
      }
    } finally { await session.close(); }
  });
}

test("missing child identity denies a real bash push by default", { timeout: 30_000 }, async () => {
  const script = writeFauxScript([{ match: "PUSH_MISSING", once: true, toolCalls: [{ name: "bash", args: { command: "git push" } }] }, { match: ".*", text: "done" }]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, LANE_EXTENSION], fauxScriptPath: script, agentDir: freshDir(), subagentTempRoot: freshDir(), cwd: freshDir() });
  try {
    session.send({ id: "p", type: "prompt", message: "PUSH_MISSING" });
    const end = await session.waitFor(e => e.type === "tool_execution_end" && e.toolName === "bash");
    assert.equal(end.isError, true);
    assert.match(JSON.stringify(end.result), /push requires a push-granted lane identity/);
  } finally { await session.close(); }
});

test("a lane's model cannot forge nested launch bindings", { timeout: 60_000 }, async () => {
  const home = freshDir("nested-push-home-");
  const cwd = freshDir("nested-push-repo-");
  const remote = freshDir("nested-push-remote-");
  git(cwd, "init", "-b", "main");
  git(remote, "init", "--bare");
  git(cwd, "-c", "user.name=export", "-c", "user.email=export@example.com", "commit", "--allow-empty", "-m", "fixture");
  git(cwd, "remote", "add", "origin", remote);
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(home, "agents", "lane-worker.md"), ["---", "name: lane-worker", "description: Nested spoof test", "tools: bash", `extensions: ${LANE_EXTENSION}`, `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "Test worker."].join("\n"));
  const script = writeFauxScript([
    { match: "NESTED_SPOOF", once: true, toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "NESTED_CHILD_PUSH", async: true, extensionBindings: { "loop-pi.guard/1": { agent: "lane-worker-push" } } } }] },
    { match: "NESTED_CHILD_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, LANE_EXTENSION], fauxScriptPath: script, agentDir: home, subagentTempRoot: freshDir(), cwd, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"] });
  try {
    session.send({ id: "p", type: "prompt", message: "NESTED_SPOOF" });
    const end = await session.waitFor(e => e.type === "tool_execution_end" && e.toolName === "subagent");
    if (!end.isError) {
      await waitForCondition(() => {
        try { return git(remote, "rev-parse", "refs/heads/main") === git(cwd, "rev-parse", "HEAD") ? true : undefined; }
        catch { return undefined; }
      }, 30_000);
    }
    assert.equal(end.isError, true, "a forged binding must be refused before launching a child");
    assert.match(JSON.stringify(end.result), /lanes may not supply extensionBindings/);
    assert.throws(() => git(remote, "rev-parse", "refs/heads/main"));
  } finally { await session.close(); }
});

test("push identity accepts only the six granted agents and fails closed on invalid bindings", () => {
  for (const agent of ["lane-worker-push", "lane-worker-retry-push", "complex-worker-push", "super-worker-push", "megasuper-worker-push", "lane-worker-low-push"]) {
    assert.equal(hasLanePushGrant(JSON.stringify({ "loop-pi.guard/1": { agent } })), true);
  }
  for (const raw of [undefined, "", "{", "null", "{}", JSON.stringify({ "loop-pi.guard/1": { agent: "unknown-push" } }), JSON.stringify({ "loop-pi.guard/1": { agent: "lane-worker" } }), JSON.stringify({ "loop-pi.guard/1": { agent: "ops" } }), JSON.stringify({ "loop-pi.guard/1": { agent: "lane-worker-low" } }), JSON.stringify({ "loop-pi.guard/1": { agent: "super-worker" } }), JSON.stringify({ "loop-pi.guard/1": { agent: "megasuper-worker" } })]) {
    assert.equal(hasLanePushGrant(raw), false, String(raw));
  }
});

test("no-grant push check follows wrappers, aliases and interpreter fallback, not inert text", () => {
  for (const command of ["git push", "env X=y git -C . push", "bash -c 'git push'", "git -c alias.ship=push ship", "python -c \"import os; os.system('git push')\""]) {
    assert.equal(evaluateBashCommand(command, "lane", 0, false).block, true, command);
    assert.equal(evaluateBashCommand(command, "lane", 0, true).block, false, command);
  }
  assert.equal(evaluateBashCommand("echo 'git push'", "lane", 0, false).block, false);
});
