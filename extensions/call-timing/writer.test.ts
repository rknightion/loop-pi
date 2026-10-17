// Writer identity and loaded policy on progress checkpoints (SEAMS.md "Request progress seam").
// A real pi process with the request ceiling and call-timing streams from a local scripted
// Responses server; settings on disk are changed while it runs, as a live upgrade would.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc, waitForCondition } from "../loop-guard/rpc-test-helpers.ts";
import { type Step, startResponsesServer } from "./test-support/responses-server.ts";
import {
  loadedCeilingPolicy, processStartedAt, publishCeilingPolicy, requestPolicy, resetCeilingPolicyForTest,
} from "./writer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const CEILING = join(HERE, "..", "request-ceiling", "index.ts");
const PROVIDER = join(HERE, "test-support", "responses-provider.ts");
after(cleanupAll);

function done(): Step[] {
  let n = 0;
  const frame = (type: string, body: Record<string, unknown> = {}): Step => ({ frame: { type, sequence_number: n++, ...body } });
  const response = (status: string, output: unknown[] = []) => ({
    id: "resp_writer", object: "response", created_at: 1, status, model: "fixture", output,
    usage: status === "completed"
      ? { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
      : null,
  });
  const item = { id: "msg_0", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  return [
    frame("response.created", { response: response("in_progress") }),
    frame("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    frame("response.content_part.added", { item_id: "msg_0", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    frame("response.output_text.delta", { item_id: "msg_0", output_index: 0, content_index: 0, delta: "ok", logprobs: [] }),
    frame("response.output_text.done", { item_id: "msg_0", output_index: 0, content_index: 0, text: "ok", logprobs: [] }),
    frame("response.output_item.done", { output_index: 0, item }),
    frame("response.completed", { response: response("completed", [item]) }),
  ];
}

function settings(home: string, inactivityMs: number, absoluteMs: number, checkpointIntervalMs: number) {
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never",
    loopPi: { requestCeiling: { inactivityMs, absoluteMs }, progress: { checkpointIntervalMs } },
  }));
}

function checkpoints(home: string): any[] {
  const dir = join(home, "progress");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** Kernel start of a pid from `ps -o etime=` ([[dd-]hh:]mm:ss), to one second. */
function kernelStartMs(pid: number): number {
  const text = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Date.now() - ((Number(days) * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

test("a live settings change leaves the checkpoint naming the limits the process loaded", async () => {
  const server = await startResponsesServer([], done());
  const home = freshDir("call-writer-home-");
  const cwd = freshDir("call-writer-cwd-");
  settings(home, 1_200_000, 4_800_000, 250);
  const session = startPiRpc({
    extensions: [PROVIDER, CEILING, ENTRY], fauxScriptPath: join(home, "unused.json"), agentDir: home,
    subagentTempRoot: join(home, "tmp"), cwd, sessionArgs: [],
    extraArgs: ["--provider", "progress-fixture", "--model", "fixture"],
    env: { LOOP_PI_PROGRESS_BASE_URL: server.baseUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
  });
  try {
    const settled = () => session.events.filter((e) => e.type === "agent_settled").length;
    session.send({ id: "one", type: "prompt", message: "first" });
    await waitForCondition(() => settled() >= 1 || undefined, 30_000);
    const first = checkpoints(home)[0];
    assert.deepEqual(first.policy, { inactivityMs: 1_200_000, absoluteMs: 4_800_000, checkpointIntervalMs: 250 });

    // A live upgrade rewrites the home settings; the running process keeps what it loaded.
    settings(home, 600_000, 1_800_000, 5_000);
    session.send({ id: "two", type: "prompt", message: "second" });
    await waitForCondition(() => settled() >= 2 || undefined, 30_000);
    const second = checkpoints(home)[0];
    assert.equal(second.turn, 2);
    assert.deepEqual(second.policy, { inactivityMs: 1_200_000, absoluteMs: 4_800_000, checkpointIntervalMs: 250 },
      "the policy is the loaded one, never re-read from disk");

    const pid = session.child.pid!;
    assert.equal(second.pid, pid);
    assert.equal(typeof second.pidStartedAt, "number");
    const kernel = kernelStartMs(pid);
    assert.ok(Math.abs(second.pidStartedAt - kernel) < 5_000,
      `pidStartedAt ${second.pidStartedAt} matches the writer's kernel start ${kernel}`);
    assert.ok(second.pidStartedAt <= second.startedAt);
  } finally {
    await session.close();
    await server.close();
  }
});

test("a process without the request ceiling records unknown limits, not defaults", async () => {
  const server = await startResponsesServer([], done());
  const home = freshDir("call-writer-bare-");
  const cwd = freshDir("call-writer-bare-cwd-");
  settings(home, 1_200_000, 4_800_000, 250);
  const session = startPiRpc({
    extensions: [PROVIDER, ENTRY], fauxScriptPath: join(home, "unused.json"), agentDir: home,
    subagentTempRoot: join(home, "tmp"), cwd, sessionArgs: [],
    extraArgs: ["--provider", "progress-fixture", "--model", "fixture"],
    env: { LOOP_PI_PROGRESS_BASE_URL: server.baseUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
  });
  try {
    session.send({ id: "one", type: "prompt", message: "first" });
    await session.waitFor((e) => e.type === "agent_settled", 30_000);
    const record = checkpoints(home)[0];
    assert.deepEqual(record.policy, { inactivityMs: null, absoluteMs: null, checkpointIntervalMs: 250 });
  } finally {
    await session.close();
    await server.close();
  }
});

test("conflicting ceiling installs in one process publish unknown limits", () => {
  resetCeilingPolicyForTest();
  try {
    assert.equal(loadedCeilingPolicy(), null);
    publishCeilingPolicy({ inactivityMs: 1, absoluteMs: 2 });
    publishCeilingPolicy({ inactivityMs: 1, absoluteMs: 2 });
    assert.deepEqual(requestPolicy(5_000), { inactivityMs: 1, absoluteMs: 2, checkpointIntervalMs: 5_000 });
    publishCeilingPolicy({ inactivityMs: 3, absoluteMs: 2 });
    assert.equal(loadedCeilingPolicy(), null);
    assert.deepEqual(requestPolicy(5_000), { inactivityMs: null, absoluteMs: null, checkpointIntervalMs: 5_000 });
  } finally {
    resetCeilingPolicyForTest();
  }
  assert.ok(processStartedAt() <= Date.now() && Number.isInteger(processStartedAt()));
});
