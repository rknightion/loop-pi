import { test } from "node:test";
import assert from "node:assert/strict";
import { installRecovery, portableRequest, safeProxyRetry, recoveryConfig } from "./recovery.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  let aborted = 0;
  const sequence: string[] = [];
  const notices: any[] = [];
  const ctx = { model: { provider: "fixture", api: "openai-responses" }, abort() { sequence.push("abort"); aborted++; } };
  installRecovery({ events: { on() {}, emit(name: string) { sequence.push(name); } }, sendMessage(message: unknown) { notices.push(message); }, on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } } as any, () => ({ loopPi: { retryRecovery: { episodeMs: 30, providerIds: ["fixture"] } } }));
  const emit = (name: string, event: any = {}) => handlers.get(name)?.map((fn) => fn(event, ctx)).at(-1);
  return { emit, ctx, sequence, notices, get aborted() { return aborted; } };
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

test("halted recovery absorbs extension input and reports why while genuine input can resume", () => {
  const h = harness();
  h.emit("turn_start");
  h.emit("before_provider_request", { payload: { input: [], previous_response_id: "bound" } });
  const result = h.emit("message_end", failure);
  assert.equal(result.message.loopPiRecovery.reason, "protected-request");
  assert.match(result.message.errorMessage, /protected-request/);
  h.emit("agent_settled");
  assert.deepEqual(h.emit("input", { source: "extension", text: "Subagent updates above." }), { action: "handled" });
  h.emit("input", { source: "rpc" });
  assert.equal(h.emit("input", { source: "extension" }), undefined);
  h.emit("session_shutdown");
});


test("portable history requires unique completed tool pairs and rejects hosted history", () => {
  const call = { type: "function_call", call_id: "call_one", name: "local", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "call_one", output: "done" };
  assert.equal(portableRequest({ input: [call, result] }), true);
  assert.equal(portableRequest({ input: [call] }), false);
  assert.equal(portableRequest({ input: [call, call, result] }), false);
  assert.equal(portableRequest({ input: [{ ...call, call_id: undefined }, { ...result, call_id: undefined }] }), false);
  assert.equal(portableRequest({ input: [{ type: "web_search_call" }] }), false);
});


test("unclassified nonretryable failure halts automatic wakes without changing user cancellation", () => {
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  const result = h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "inference refused" } });
  assert.equal(result.message.loopPiRecovery.disposition, "stop");
  h.emit("agent_settled");
  assert.deepEqual(h.emit("input", { source: "extension" }), { action: "handled" });
  h.emit("session_shutdown");
});

test("an idle episode crossing its deadline emits exhaustion once when a wake arrives", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  h.emit("message_end", failure); h.emit("agent_settled");
  t.mock.timers.tick(31);
  h.emit("input", { source: "extension" }); h.emit("input", { source: "extension" });
  assert.equal(h.notices.filter((m) => m.customType === "loop-recovery-exhausted").length, 1);
  h.emit("session_shutdown");
});

test("context overflow remains available to native compaction rather than halting recovery", () => {
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  const message = { role: "assistant", stopReason: "error", content: [], errorMessage: 'OpenAI API error (400): {"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"maximum context length exceeded"}}' };
  const result = h.emit("message_end", { message });
  assert.equal(result.message.errorMessage, message.errorMessage);
  assert.equal(result.message.loopPiRecovery.disposition, "unchanged");
  h.emit("agent_settled");
  assert.equal(h.emit("input", { source: "extension" }), undefined);
  h.emit("session_shutdown");
});

test("the request ceiling retains its bounded empty-output follow-up", async () => {
  const { EMPTY_LENGTH_ERROR } = await import("./core.ts");
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  const result = h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage: EMPTY_LENGTH_ERROR } });
  assert.equal(result.message.errorMessage, EMPTY_LENGTH_ERROR);
  assert.equal(result.message.loopPiRecovery.disposition, "unchanged");
  h.emit("agent_settled");
  assert.equal(h.emit("input", { source: "extension" }), undefined);
  h.emit("session_shutdown");
});
