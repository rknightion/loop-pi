// A landing tool names the run directory as an argument and appends to its ledger itself. The root's
// protected-path rule refuses a bash write into the run directory, never a command that only names it,
// so the tool runs under `watch_start` (which takes the same evaluateBashCommand verdict as `bash`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bashProtectedPath } from "./guard-paths.ts";
import { evaluateBashCommand } from "./rules.ts";

test("proto root: a landing command that names the run directory is not refused, a write into it still is", () => {
  const cwd = mkdtempSync(join(tmpdir(), "loop-land-run-dir-"));
  const runDir = join(cwd, "codex", "loop3");
  mkdirSync(runDir, { recursive: true });
  const ctx = { cwd, proto: true, protectedPath: bashProtectedPath("root", cwd, runDir) };
  const head = "a".repeat(40);
  try {
    for (const command of [
      `loop-land ready --repo ${cwd} --run-dir ${runDir} --pr 7 --head ${head} --issues 1,2`,
      `loop-land ready --repo ${cwd} --run-dir codex/loop3 --pr 7 --head ${head} --issues 1 --fix-forward "main is red"`,
      `loop-land verify --repo ${cwd} --run-dir ${runDir} --pr 7`,
      `loop-land abandon --repo ${cwd} --run-dir ${runDir} --pr 7 --reason "not merging"`,
      `loop-land summary --repo ${cwd} --run-dir ${runDir} --check`,
      `/opt/tools/bin/loop-land ready --repo ${cwd} --run-dir ${runDir} --pr 7 --head ${head} --issues 1`,
    ]) {
      const decision = evaluateBashCommand(command, "root", 0, ctx);
      assert.equal(decision.block, false, `${command}: ${decision.reason ?? ""}`);
    }
    for (const command of [
      `echo x >> ${runDir}/landings.jsonl`,
      `loop-land summary --repo ${cwd} --run-dir ${runDir} > ${runDir}/summary.txt`,
      `cp table.txt ${runDir}/landings.jsonl`,
    ]) {
      assert.equal(evaluateBashCommand(command, "root", 0, ctx).block, true, command);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
