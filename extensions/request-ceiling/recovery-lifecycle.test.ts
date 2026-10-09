import { test } from "node:test";
import assert from "node:assert/strict";
import { installRecovery, portableRequest, safeProxyRetry, recoveryConfig } from "./recovery.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  let aborted = 0;
  const sequence: string[] = [];
  const ctx = { model: { provider: "fixture" }, abort() { sequence.push("abort"); aborted++; } };
  installRecovery({ events: { on() {}, emit(name: string) { sequence.push(name); } }, sendMessage() {}, on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } } as any, () => ({ loopPi: { retryRecovery: { episodeMs: 30, providerIds: ["fixture"] } } }));
  const emit = (name: string, event: any = {}) => handlers.get(name)?.map((fn) => fn(event, ctx)).at(-1);
  return { emit, ctx, sequence, get aborted() { return aborted; } };
}
test("recovery abort attribution precedes timer, expired-turn, request-check and halted aborts", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness();
  h.emit("turn_start");
  h.emit("before_provider_request", { payload: { input: [] } });
  h.emit("message_end", failure);
  t.mock.timers.tick(30);
  assert.deepEqual(h.sequence, ["loop-recovery:abort", "abort"]);
  h.emit("agent_settled");
  h.sequence.length = 0;
  h.emit("turn_start");
  assert.deepEqual(h.sequence, ["loop-recovery:abort", "abort"], "expired synthetic turn");
  h.sequence.length = 0;
  h.emit("before_provider_request", { payload: { input: [] } });
  assert.deepEqual(h.sequence, ["loop-recovery:abort", "abort"], "request deadline check");
  h.emit("message_end", failure); h.emit("agent_settled");
  h.sequence.length = 0; h.emit("turn_start");
  assert.deepEqual(h.sequence, ["loop-recovery:abort", "abort"], "halted recovery restart");
  h.emit("session_shutdown");
});

const failure = { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "fetch failed" } };

test("episode survives synthetic settlement but resets on a genuine user input and success", async () => {
  const h = harness(); h.emit("turn_start"); h.emit("message_end", failure); h.emit("agent_settled");
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(h.aborted, 0, "settlement must not abort unrelated idle work");
  h.emit("input", { source: "extension" }); h.emit("turn_start");
  assert.equal(h.aborted, 1, "synthetic followup cannot reset the episode");
  h.emit("agent_settled"); h.emit("input", { source: "rpc" }); h.emit("turn_start");
  assert.equal(h.aborted, 1);
  h.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
  await new Promise((r) => setTimeout(r, 45)); assert.equal(h.aborted, 1);
  h.emit("session_shutdown");
});

test("portable request and proxy code allowlist preserve explicit anchors, files and unknown failures", () => {
  assert.equal(portableRequest({ input: [{ role: "user", content: "hello" }] }), true);
  assert.equal(portableRequest({ input: [], previous_response_id: "resp_bound" }), false);
  assert.equal(portableRequest({ input: [{ content: [{ type: "input_image", file_id: "file_bound" }] }] }), false);
  assert.equal(portableRequest({ input: [{ type: "function_call_output", call_id: "orphan", output: "value" }] }), false);
  assert.equal(portableRequest({ input: [], tools: [{ type: "code_interpreter" }] }), false);
  assert.equal(safeProxyRetry({ code: "stream_incomplete", type: "server_error", message: "unknown after dispatch" }), false);
  assert.equal(safeProxyRetry({ code: "continuity_recovery_required", type: "server_error" }), false);
  assert.deepEqual(recoveryConfig({}).providerIds, []);
});

test("user cancellation preserves aborted outcome even after partial output or a protected request", () => {
  const h=harness();h.emit("turn_start");
  h.emit("before_provider_request", {payload:{input:[],previous_response_id:"resp_bound"}});
  const result=h.emit("message_end",{message:{role:"assistant",stopReason:"aborted",content:[{type:"text",text:"partial"}],errorMessage:"Request was aborted"}});
  assert.equal(result.message.stopReason,"aborted");
  assert.equal(result.message.errorMessage,"Request was aborted");
  h.emit("agent_settled"); h.emit("session_shutdown");
});

test("switching away from an opted provider disposes exhausted recovery state", async () => {
  const h=harness();h.emit("turn_start");h.emit("message_end",failure);
  await new Promise((r) => setTimeout(r,45));
  assert.equal(h.aborted,1);h.emit("agent_settled");
  h.ctx.model.provider="ordinary";h.emit("model_select");h.emit("turn_start");
  const result=h.emit("message_end",failure);
  assert.equal(result,undefined);assert.equal(h.aborted,1);h.emit("session_shutdown");
});

test("queued genuine input preserves current request error observation and deadline", async () => {
  const h = harness();
  h.emit("turn_start");
  h.emit("before_provider_request", { payload: { input: [{ role: "user", content: "first" }] } });
  h.emit("input", { source: "rpc" });
  h.emit("provider_stream_event", { data: { type: "response.failed", response: { error: {
    code: "stream_incomplete", type: "server_error",
    message: "The previous response anchor was rejected upstream; retry the request.",
  } } } });
  const result = h.emit("message_end", failure);
  assert.equal(result.message.loopPiRecovery.disposition, "retry");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(h.aborted, 1, "queued input must not disable the active request deadline");
  h.emit("session_shutdown");
});

test("queued input preserves an existing recovery deadline", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness();
  h.emit("turn_start");
  h.emit("message_end", failure);
  t.mock.timers.tick(20);
  h.emit("input", { source: "rpc" });
  t.mock.timers.tick(20);
  assert.equal(h.aborted, 1, "queued input must not extend the active episode");
  h.emit("session_shutdown");
});
