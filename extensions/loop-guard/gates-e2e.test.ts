// Runtime proof: a real pi process with the faux model drives naked and wrapped gates.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  cleanupAll, FAUX_EXTENSION, freshDir, LANE_EXTENSION, ROOT_EXTENSION, startPiRpc, writeFauxScript,
} from "./rpc-test-helpers.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../bin/loop-gate-lock");
after(cleanupAll);

for (const [role, extension] of [["root", ROOT_EXTENSION], ["lane", LANE_EXTENSION]]) {
  test(`${role}: real pi refuses naked gate and executes the public wrapper`, { timeout: 60_000 }, async () => {
    const cwd = freshDir("guard-gate-e2e-repo-");
    const agentDir = freshDir("guard-gate-e2e-home-");
    execFileSync("git", ["init", "-q"], { cwd, timeout: 10_000 });
    // Stable name shared between these sessions, with a unique proof file per repository.
    writeFileSync(join(cwd, "LOOP.md"), "## Mutexes\n- gate: runtime-proof | printf reached > gate-proof.json\n");
    const fauxScript = writeFauxScript([
      { match: "NAKED_GATE", once: true, toolCalls: [{ name: "bash", args: { command: "printf reached > gate-proof.json" } }] },
      { match: "WRAPPED_GATE", once: true, toolCalls: [{ name: "bash", args: { command: `'${cli}' runtime-proof` } }] },
      { match: ".*", text: "ok" },
    ]);
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, extension], fauxScriptPath: fauxScript, cwd, agentDir,
      subagentTempRoot: freshDir("guard-gate-e2e-subtemp-"),
      env: { LOOP_PI_GATE_LOCK_DIR: freshDir("guard-gate-e2e-locks-") },
    });
    try {
      session.send({ id: "naked", type: "prompt", message: "NAKED_GATE" });
      const naked = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash");
      assert.equal(naked.isError, true);
      assert.match(JSON.stringify(naked.result), /loop-gate-lock runtime-proof/);
      assert.equal(existsSync(join(cwd, "gate-proof.json")), false);
      await session.waitFor((e) => e.type === "agent_end");
      const previous = new Set(session.events);
      session.send({ id: "wrapped", type: "prompt", message: "WRAPPED_GATE" });
      const wrapped = await session.waitFor((e) => !previous.has(e) && e.type === "tool_execution_end" && e.toolName === "bash");
      assert.equal(wrapped.isError, false, JSON.stringify(wrapped.result));
      assert.equal(readFileSync(join(cwd, "gate-proof.json"), "utf8"), "reached");
    } finally { await session.close(); }
  });
}
