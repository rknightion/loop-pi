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

function diagnostic(...reasons: unknown[]) {
  return {
    type: "openai_input_transformations", timestamp: 5,
    details: { transformations: reasons.map((reason, i) => ({ type: "reasoning", id: "rs_secret_" + i, action: "removed", reason })) },
  };
}

test("a message without the dropped-reasoning diagnostic records no droppedReasoning", () => {
  const emit = emitter();
  emit("turn_start");
  const unrelated = { type: "other_diagnostic", timestamp: 5, details: { transformations: [{ type: "reasoning", reason: "x" }] } };
  const end = emit("message_end", { message: { ...assistant, diagnostics: [unrelated] } });
  assert.equal("droppedReasoning" in end.message.loopPiTiming, false);
  const plain = emitter();
  plain("turn_start");
  assert.equal("droppedReasoning" in plain("message_end", { message: assistant }).message.loopPiTiming, false);
});

test("dropped reasoning records only the count and reasons, summed across diagnostics", () => {
  const emit = emitter();
  emit("turn_start");
  const message = { ...assistant, diagnostics: [
    diagnostic("prefix_mismatch", "prefix_mismatch"), { type: "other_diagnostic", timestamp: 6 },
    diagnostic("organization_mismatch", "prefix_mismatch", undefined),
  ] };
  const end = emit("message_end", { message });
  assert.deepEqual(end.message.loopPiTiming.droppedReasoning, {
    count: 5, reasons: { prefix_mismatch: 3, organization_mismatch: 1, unknown: 1 },
  });
  assert.equal(JSON.stringify(end.message.loopPiTiming).includes("rs_secret"), false, "item ids are never copied");
  assert.equal(end.message.loopPiTiming.attempts, null);
});

test("a malformed dropped-reasoning diagnostic is ignored", () => {
  const emit = emitter();
  emit("turn_start");
  const end = emit("message_end", { message: { ...assistant, diagnostics: [
    { type: "openai_input_transformations", timestamp: 1 },
    { type: "openai_input_transformations", timestamp: 1, details: { transformations: "bad" } },
    { type: "openai_input_transformations", timestamp: 1, details: { transformations: [] } },
  ] } });
  assert.equal("droppedReasoning" in end.message.loopPiTiming, false);
});

test("dropped reasoning counts only removed reasoning items and bounds the reason keys", () => {
  const emit = emitter();
  emit("turn_start");
  const many = Array.from({ length: 20 }, (_, i) => "reason_" + i);
  const message = { ...assistant, diagnostics: [
    { type: "openai_input_transformations", timestamp: 7, details: { transformations: [
      { type: "message", id: "m1", action: "removed", reason: "prefix_mismatch" },
      { type: "reasoning", id: "r1", action: "kept", reason: "prefix_mismatch" },
      { type: "reasoning", id: "r2", action: "removed", reason: "x".repeat(200) },
    ] } },
    diagnostic(...many),
  ] };
  const end = emit("message_end", { message });
  const dropped = end.message.loopPiTiming.droppedReasoning;
  assert.equal(dropped.count, 21, "only removed reasoning items count");
  assert.equal(dropped.reasons["x".repeat(64)], 1, "a long reason is cut to 64 characters");
  assert.equal(Object.keys(dropped.reasons).length, 17, "16 distinct reasons, then other");
  assert.equal(dropped.reasons.other, 5);
});

test("a reason seen before the cap keeps its own key after the cap overflows, and literal other/unknown reasons share the overflow and missing buckets", () => {
  const emit = emitter();
  emit("turn_start");
  const many = Array.from({ length: 16 }, (_, i) => "reason_" + i);
  const message = { ...assistant, diagnostics: [
    diagnostic(...many),
    diagnostic("overflow_reason", "reason_0", "reason_0", "other", "unknown", undefined, "y".repeat(64) + "a", "y".repeat(64) + "b"),
  ] };
  const dropped = emit("message_end", { message }).message.loopPiTiming.droppedReasoning;
  assert.equal(dropped.reasons.reason_0, 3, "an early reason still counts under its own key after the cap");
  assert.equal(dropped.reasons.overflow_reason, undefined, "a new reason past the cap does not get a key");
  assert.equal(dropped.reasons.other, 6, "overflow, a literal other, a missing reason and two reasons sharing a prefix past the cap share other");
  assert.equal(dropped.reasons.unknown, undefined, "past the cap even unknown has no key of its own");
  assert.equal(dropped.count, 24);
  assert.equal((Object.values(dropped.reasons) as number[]).reduce((a, b) => a + b, 0), dropped.count, "totals stay right");
});

test("a literal unknown reason and a missing reason share the unknown key", () => {
  const emit = emitter();
  emit("turn_start");
  const end = emit("message_end", { message: { ...assistant, diagnostics: [diagnostic("unknown", undefined, "")] } });
  assert.deepEqual(end.message.loopPiTiming.droppedReasoning, { count: 3, reasons: { unknown: 3 } });
});

test("reasons sharing a 64-character prefix merge under one key", () => {
  const emit = emitter();
  emit("turn_start");
  const prefix = "z".repeat(64);
  const end = emit("message_end", { message: { ...assistant, diagnostics: [diagnostic(prefix + "1", prefix + "2", prefix)] } });
  assert.deepEqual(end.message.loopPiTiming.droppedReasoning, { count: 3, reasons: { [prefix]: 3 } });
});
