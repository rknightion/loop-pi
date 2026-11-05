// pi-subagents 0.82.0 matches a required child extension by file identity: when an agent file
// names the lane guard through another spelling (here a symlink), pi loads it only once, under
// that spelling, and a startup failure must still refuse the child. 0.81.0 compared exact path
// strings, missed the alias and started the child unguarded.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript,
} from "./rpc-test-helpers.ts";
import { adoptNopushLauncher } from "../test-support/lane-agents.ts";

after(() => {
  cleanupAll();
});

test("a required lane guard named through a symlink alias still refuses the child when its startup throws", async () => {
  const agentDir = freshDir("loop-guard-alias-agentdir-");
  const cwd = freshDir("loop-guard-alias-cwd-");
  const fixture = freshDir("loop-guard-alias-extension-");
  for (const dir of ["loop-guard", "request-ceiling", "loop-state", "loop-continuation", "call-timing"]) {
    cpSync(join(dirname(ROOT_EXTENSION), "..", dir), join(fixture, "extensions", dir), { recursive: true });
  }
  symlinkSync(dirname(PI_SUBAGENTS_PACKAGE_DIR), join(fixture, "node_modules"), "dir");
  const startupMarker = join(cwd, "guard-started");
  const taskMarker = join(cwd, "task-ran");
  const lane = join(fixture, "extensions", "loop-guard", "lane.ts");
  writeFileSync(lane, [
    'import { writeFileSync } from "node:fs";',
    'export default function (pi) { pi.on("session_start", () => {',
    `writeFileSync(${JSON.stringify(startupMarker)}, "started");`,
    'throw new Error("FAULTY_ALIASED_LANE_GUARD");',
    '}); }',
  ].join("\n"));
  const alias = join(freshDir("loop-guard-alias-link-"), "lane-alias.ts");
  symlinkSync(lane, alias, "file");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR],
    subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  writeFileSync(join(agentDir, "agents", "worker.md"), [
    "---", "name: worker", "description: Test aliased lane guard", "tools: bash",
    "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}, ${alias}`, "model: faux/faux-1",
    "---", "Test lane worker.",
  ].join("\n"));
  adoptNopushLauncher(agentDir);
  const subagentTemp = freshDir("loop-guard-alias-subtemp-");
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, join(fixture, "extensions", "loop-guard", "root.ts")],
    fauxScriptPath: writeFauxScript([
      { match: "SPAWN_ALIASED_GUARD", once: true, toolCalls: [
        { name: "subagent", args: { agent: "worker", task: "ALIAS_CHILD_TASK" } },
      ] },
      { match: "ALIAS_CHILD_TASK", once: true, toolCalls: [
        { name: "bash", args: { command: `touch '${taskMarker}'` } },
      ] },
      { match: ".*", text: "ok" },
    ]),
    agentDir, cwd, subagentTempRoot: subagentTemp,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_ALIASED_GUARD" });
    // Root launches are pinned to the background-only nopush launcher: the refusal is the run's failure.
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent");
    assert.notEqual(launch.isError, true, `the background launch itself starts: ${JSON.stringify(launch)}`);
    const status = await waitForCondition(() => {
      const runs = join(subagentTemp, "async-subagent-runs");
      for (const run of existsSync(runs) ? readdirSync(runs).filter((name) => !name.startsWith(".")) : []) {
        try {
          const record = JSON.parse(readFileSync(join(runs, run, "status.json"), "utf8"));
          if (["failed", "complete", "completed", "stopped"].includes(record.state)) return record;
        } catch {
          // not written yet
        }
      }
      return undefined;
    }, 30_000, 200);
    assert.equal(existsSync(startupMarker), true, "the aliased guard's startup handler must have run");
    assert.equal(status.state, "failed", `an aliased faulty guard must refuse the child: ${JSON.stringify(status)}`);
    assert.match(JSON.stringify(status), /Required child extension failed during startup|Required child extension failed to load/);
    assert.equal(existsSync(taskMarker), false, "no child task may run after the aliased guard fails");
  } finally {
    await session.close();
  }
});
