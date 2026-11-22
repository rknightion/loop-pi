// Dropped-reasoning diagnostic seam: a real pi process streams from the local scripted Responses
// server through pi's own OpenAI client, which turns response.input_transformations into an
// assistant-message diagnostic that call-timing reduces to loopPiTiming.droppedReasoning.
// All content is synthetic; no item id from the wire frame may reach the persisted timing record.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc } from "../loop-guard/rpc-test-helpers.ts";
import { type Step, startResponsesServer } from "./test-support/responses-server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PROVIDER = join(HERE, "test-support", "responses-provider.ts");
after(cleanupAll);

const ITEM_IDS = ["rs_dropped_alpha", "rs_dropped_beta", "rs_dropped_gamma", "rs_dropped_delta", "rs_turn_boundary"];

/** One scripted Responses stream: a short text answer, then response.completed with the transformations. */
function stream(transformations?: unknown): Step[] {
  let sequence = 0;
  const frame = (type: string, body: Record<string, unknown>): Step => ({ frame: { type, sequence_number: sequence++, ...body } });
  const response = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "resp_fixture", object: "response", created_at: 1, status, model: "fixture", ...extra,
  });
  const text = "synthetic answer";
  const item = { id: "msg_0", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    frame("response.created", { response: response("in_progress", { output: [], usage: null }) }),
    frame("response.output_item.added", { output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", status: "in_progress", content: [] } }),
    frame("response.content_part.added", { item_id: "msg_0", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    frame("response.output_text.delta", { item_id: "msg_0", output_index: 0, content_index: 0, delta: text, logprobs: [] }),
    frame("response.output_text.done", { item_id: "msg_0", output_index: 0, content_index: 0, text, logprobs: [] }),
    frame("response.output_item.done", { output_index: 0, item }),
    frame("response.completed", { response: response("completed", {
      output: [item],
      usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 5 },
      ...(transformations === undefined ? {} : { input_transformations: transformations }),
    }) }),
  ];
}

function assistants(home: string): any[] {
  const found: any[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(child, "utf8").split("\n").filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.type === "message" && record.message?.role === "assistant") found.push(record.message);
        }
      }
    }
  };
  if (existsSync(join(home, "sessions"))) walk(join(home, "sessions"));
  return found;
}

/** Runs one real pi process for one prompt and returns its persisted assistant message. */
async function run(transformations?: unknown) {
  const server = await startResponsesServer([stream(transformations)], stream());
  const home = freshDir("call-dropped-home-");
  const cwd = freshDir("call-dropped-cwd-");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
  const session = startPiRpc({
    extensions: [PROVIDER, ENTRY], fauxScriptPath: join(home, "unused.json"), agentDir: home,
    subagentTempRoot: join(home, "tmp"), cwd, sessionArgs: [],
    extraArgs: ["--provider", "progress-fixture", "--model", "fixture"],
    env: { LOOP_PI_PROGRESS_BASE_URL: server.baseUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
  });
  try {
    session.send({ id: "dropped", type: "prompt", message: "Exercise the dropped reasoning diagnostic." });
    await session.waitFor((e) => e.type === "agent_settled");
  } finally {
    await session.close();
    await server.close();
  }
  const message = assistants(home)[0];
  assert.ok(message?.loopPiTiming, `assistant timing must be persisted; stderr=${session.stderr.join("")}`);
  assert.equal(message.stopReason, "stop");
  return message;
}

function assertNoItemId(message: any) {
  const timing = JSON.stringify(message.loopPiTiming);
  for (const id of ITEM_IDS) assert.ok(!timing.includes(id), `loopPiTiming must not copy item id ${id}`);
}

test("real pi records dropped reasoning from response.input_transformations as counts and reasons only", async () => {
  const message = await run([
    { type: "reasoning", id: ITEM_IDS[0], action: "removed", reason: "prefix_mismatch" },
    { type: "reasoning", id: ITEM_IDS[1], action: "removed", reason: "prefix_mismatch" },
    { type: "reasoning", id: ITEM_IDS[2], action: "removed", reason: "organization_mismatch" },
    // Not counted: pi-ai drops turn_boundary removals, and only removed reasoning items are diagnosed.
    { type: "reasoning", id: ITEM_IDS[4], action: "removed", reason: "turn_boundary" },
    { type: "reasoning", id: ITEM_IDS[3], action: "kept", reason: "prefix_mismatch" },
    { type: "message", id: "msg_unrelated", action: "removed", reason: "prefix_mismatch" },
  ]);
  assert.deepEqual(message.loopPiTiming.droppedReasoning, { count: 3, reasons: { prefix_mismatch: 2, organization_mismatch: 1 } });
  assert.equal(message.loopPiTiming.attempts, null);
  assert.ok(message.loopPiTiming.headers && typeof message.loopPiTiming.headers === "object");
  assertNoItemId(message);
  assert.ok(!JSON.stringify(message.loopPiTiming).includes("msg_unrelated"));
});

test("real pi records no droppedReasoning when the frame carries no reasoning removals", async () => {
  for (const [label, transformations] of [
    ["field absent", undefined],
    ["empty list", []],
    ["only turn_boundary removals", [{ type: "reasoning", id: ITEM_IDS[4], action: "removed", reason: "turn_boundary" }]],
  ] as const) {
    const message = await run(transformations);
    assert.equal("droppedReasoning" in message.loopPiTiming, false, label);
    assertNoItemId(message);
  }
});
