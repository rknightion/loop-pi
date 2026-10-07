import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install, { processingMilliseconds, responseTiming } from "./index.ts";

test("processing milliseconds are strict recorded integers, including zero", () => {
  assert.equal(processingMilliseconds("0"), 0);
  assert.equal(processingMilliseconds(" 47 "), 47);
  assert.equal(processingMilliseconds("2147483647"), 2147483647);
  for (const value of [undefined, "", " ", "47ms", "47.5", "-1", "NaN", "Infinity", "1e3", "2147483648"]) {
    assert.equal(processingMilliseconds(value), null, String(value));
  }
});

test("allowlisted headers are copied without mutating the response", () => {
  const headers = Object.freeze({ "X-Request-Id": "fixture", "OpenAI-Processing-Ms": "0", "Other": "excluded" });
  assert.deepEqual(responseTiming(headers), { headers: { "x-request-id": "fixture" }, processingMs: 0 });
  assert.deepEqual(headers, { "X-Request-Id": "fixture", "OpenAI-Processing-Ms": "0", "Other": "excluded" });
});

function emitter() {
  const handlers = new Map<string, (event: any) => any>();
  install({ on: (event: string, handler: (event: any) => any) => { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  return (type: string, event: object = {}) => handlers.get(type)?.(event);
}
const assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 1 };

test("tool argument delta is a first token; later deltas do not overwrite it", () => {
  const emit = emitter();
  emit("turn_start");
  emit("message_update", { message: assistant, assistantMessageEvent: { type: "toolcall_start" } });
  emit("message_update", { message: assistant, assistantMessageEvent: { type: "toolcall_delta", delta: "" } });
  const before = Date.now();
  emit("message_update", { message: assistant, assistantMessageEvent: { type: "toolcall_delta", delta: "{" } });
  const after = Date.now();
  emit("message_update", { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "later" } });
  const end = emit("message_end", { message: assistant });
  assert.ok(end.message.loopPiTiming.firstTokenAt >= before && end.message.loopPiTiming.firstTokenAt <= after);
  assert.equal(end.message.loopPiTiming.attempts, null);
  assert.deepEqual(assistant, { role: "assistant", content: [], stopReason: "stop", timestamp: 1 });
});

test("boundaries and last response replacement prevent stale headers or timestamps", () => {
  const emit = emitter();
  emit("after_provider_response", { headers: { "x-request-id": "idle" } });
  assert.equal(emit("message_end", { message: assistant }), undefined);
  emit("turn_start");
  emit("after_provider_response", { headers: { "x-request-id": "first", "service-tier": "first", "openai-processing-ms": "1" } });
  emit("after_provider_response", { headers: { "x-request-id": "second" } });
  assert.equal(emit("message_end", { message: { role: "user" } }), undefined);
  const recorded = emit("message_end", { message: assistant }).message.loopPiTiming;
  assert.deepEqual(recorded, { firstTokenAt: null, attempts: null, processingMs: null, headers: { "x-request-id": "second" } });
  assert.equal(emit("message_end", { message: assistant }), undefined);
  emit("turn_end");
  emit("turn_start");
  assert.deepEqual(emit("message_end", { message: assistant }).message.loopPiTiming,
    { firstTokenAt: null, attempts: null, processingMs: null, headers: {} });
  assert.deepEqual(recorded.headers, { "x-request-id": "second" }, "stored metadata must remain unchanged");
  for (const boundary of ["session_start", "session_shutdown", "turn_end"]) {
    emit("turn_start");
    emit("after_provider_response", { headers: { "x-request-id": "stale" } });
    emit(boundary);
    assert.equal(emit("message_end", { message: assistant }), undefined);
  }
});
