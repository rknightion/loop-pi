// RPC test for loop-wait/lane.ts: the lane entry registers watch_process only, and it must
// block until exit or deadline, return exit code / deadline_hit / tail, and be killable via abort.
// Uses the faux provider (no live model, no network).
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { register } from "node:module";
import { after, test } from "node:test";

import { cleanupAll, freshDir, LANE_EXTENSION, FAUX_EXTENSION, startPiRpc, writeFauxScript } from "./test-helpers.ts";

// Only the direct-unit-call test below needs this: see test-support-resolve-nested-deps.mjs for
// why importing lane.ts outside the real pi CLI needs a resolution hook for "typebox".
register("./test-support-resolve-nested-deps.mjs", import.meta.url);

after(cleanupAll);

test("watch_process runs a command to completion and returns exit code, deadline_hit and tail", async () => {
  const script = writeFauxScript([
    {
      match: "RUN_WATCH",
      once: true,
      toolCalls: [{ name: "watch_process", args: { command: "printf 'hello\\nworld\\n'; exit 0", deadline_s: 5, tail_lines: 5 } }],
    },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, LANE_EXTENSION], fauxScriptPath: script });
  try {
    session.send({ id: "p1", type: "prompt", message: "RUN_WATCH" });
    await session.waitForResponse("p1");
    const toolEnd = await session.waitFor(
      (e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "watch_process",
    );
    const result = toolEnd.result as { details: { exit_code: number | null; deadline_hit: boolean; tail: string[] } };
    assert.equal(result.details.exit_code, 0);
    assert.equal(result.details.deadline_hit, false);
    assert.deepEqual(result.details.tail, ["hello", "world"]);
    await session.waitFor((e) => e.type === "agent_settled");
  } finally {
    await session.close();
  }
});

test("watch_process runs in ctx.cwd, not the extension host's own process.cwd()", async () => {
  // Direct unit call against the tool definition registerWatchProcess registers, bypassing the
  // RPC harness entirely: the bug is that execute() ignored the ctx argument pi always passes,
  // so the surest proof is driving execute() with a ctx.cwd that provably differs from this test
  // runner's own process.cwd() (the repo checkout), rather than relying on the RPC harness's CLI
  // subprocess cwd (which would happen to equal ctx.cwd either way and mask the bug).
  const workDir = freshDir("loop-wait-watch-cwd-");
  const { registerWatchProcess } = await import("./lane.ts");
  type CapturedTool = { execute: (...args: unknown[]) => Promise<{ details: { tail: string[] } }> };
  let captured: CapturedTool | undefined;
  registerWatchProcess({
    registerTool: (def: unknown) => {
      captured = def as CapturedTool;
    },
  } as never);
  assert.ok(captured, "registerWatchProcess must register a tool");
  const result = await captured!.execute("tc1", { command: "pwd", deadline_s: 5, tail_lines: 5 }, undefined, undefined, { cwd: workDir });
  assert.equal(result.details.tail.length, 1);
  assert.equal(realpathSync(result.details.tail[0]), realpathSync(workDir));
  assert.notEqual(realpathSync(result.details.tail[0]), realpathSync(process.cwd()));
});

test("watch_process kills a runaway command and reports deadline_hit", async () => {
  const script = writeFauxScript([
    { match: "RUN_SLOW", once: true, toolCalls: [{ name: "watch_process", args: { command: "sleep 30", deadline_s: 1, tail_lines: 5 } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, LANE_EXTENSION], fauxScriptPath: script });
  try {
    session.send({ id: "p1", type: "prompt", message: "RUN_SLOW" });
    await session.waitForResponse("p1");
    const toolEnd = await session.waitFor(
      (e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "watch_process",
      10_000,
    );
    const result = toolEnd.result as { details: { deadline_hit: boolean; exit_code: number | null } };
    assert.equal(result.details.deadline_hit, true);
    assert.notEqual(result.details.exit_code, 0);
  } finally {
    await session.close();
  }
});
