import { test } from "node:test";
import assert from "node:assert/strict";
import { installRecovery, portableRequest, safeProxyRetry, recoveryConfig, WAKE_HOLD } from "./recovery.ts";
import { classifyRootStop } from "../loop-continuation/root-recovery.ts";

function harness(settings: unknown = { loopPi: { retryRecovery: { episodeMs: 30, providerIds: ["fixture"] } } }) {
  const handlers = new Map<string, Function[]>();
  const bus = new Map<string, Function[]>();
  let aborted = 0;
  const sequence: string[] = [];
  const notices: any[] = [];
  const model = { provider: "fixture", api: "openai-responses", id: "fixture", baseUrl: "http://localhost/v1" };
  const sessionManager = { getSessionId: () => "lifecycle-session" };
  const ctx = { model, sessionManager, modelRegistry: {
    find: () => model, getProvider: () => ({auth:{}}),
    getRegisteredProviderConfig: () => ({api:"openai-responses",baseUrl:model.baseUrl}),
    getRegisteredNativeProvider: () => undefined, isUsingOAuth: () => false,
  }, abort() { sequence.push("abort"); aborted++; } };
  installRecovery({ events: { on(name: string, fn: Function) { bus.set(name, [...(bus.get(name) ?? []), fn]); }, emit(name: string, event: unknown) { sequence.push(name); for (const fn of bus.get(name) ?? []) fn(event); } }, sendMessage(message: unknown) { notices.push(message); }, on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } } as any, () => settings);
  const dispatch = (name: string, event: any = {}) => handlers.get(name)?.map((fn) => fn(event, ctx)).at(-1);
  // The pinned SDK auth transform runs headers before the Agent payload callback.
  const emit = (name: string, event: any = {}) => {
    if (name === "before_provider_request") dispatch("before_provider_headers", { headers: {} });
    return dispatch(name, event);
  };
  const query = (name: string, event: unknown) => { for (const fn of bus.get(name) ?? []) fn(event); };
  const on = (name: string, fn: Function) => bus.set(name, [...(bus.get(name) ?? []), fn]);
  const wakeReservation = () => ((globalThis as any)[Symbol.for("pi.idle-wake.v1")] as WeakMap<object, any> | undefined)?.get(sessionManager);
  return { emit, query, on, ctx, sequence, notices, wakeReservation, get aborted() { return aborted; } };
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

test("recovery announces no harness abort when the owner already aborted the run", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness();
  h.emit("turn_start");
  h.emit("before_provider_request", { payload: { input: [] } });
  h.emit("message_end", failure);
  // The owner pressed Esc in this same run before the episode timer fired.
  (h.ctx as { signal?: AbortSignal }).signal = AbortSignal.abort();
  t.mock.timers.tick(30);
  assert.deepEqual(h.sequence, ["abort"], "no loop-recovery:abort for an owner-aborted run; the idempotent abort still runs");
  h.emit("session_shutdown");
});

const failure = { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "fetch failed" } };

test("five-attempt configuration is bounded and reconciled with the native retry cap", () => {
  assert.equal(recoveryConfig({}).maxAttempts, 5);
  for (const maxAttempts of [0, 6, 2.5, "5", NaN]) {
    assert.equal(recoveryConfig({ loopPi: { retryRecovery: { maxAttempts } } }).maxAttempts, 5);
  }
  assert.equal(recoveryConfig({ loopPi: { retryRecovery: { maxAttempts: 2 } } }).maxAttempts, 2);
  const h = harness();
  for (let attempt = 1; attempt <= 4; attempt++) {
    h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
    const result = h.emit("message_end", failure);
    assert.equal(result.message.loopPiRecovery.attempts, attempt);
    assert.equal(result.message.loopPiRecovery.maxAttempts, 4, "native default is three retries, four total attempts");
    if (attempt === 4) assert.equal(result.message.loopPiRecovery.reason, "attempt-limit");
    h.emit("agent_settled");
  }
  assert.deepEqual(h.emit("input", { source: "extension" }), { action: "handled" });
  assert.equal(h.notices.filter((m) => m.customType === "loop-recovery-exhausted").length, 1);
  h.emit("input", { source: "rpc" }); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  assert.equal(h.emit("message_end", failure).message.loopPiRecovery.attempts, 1);
  h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [] } });
  h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  assert.equal(h.emit("message_end", failure).message.loopPiRecovery.attempts, 1, "completed history resets consecutive failures");
  h.emit("session_shutdown");
});

test("timeout continuation starts its episode at the first recoverable failure", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  t.mock.timers.tick(20);
  h.query("loop-recovery:request-timeout", {});
  const message = { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", name: "bash", arguments: {} }], errorMessage: "Request was aborted" };
  const result = h.emit("message_end", { message });
  assert.equal(result.message.stopReason, "aborted", "native abort is terminal; do not pretend it is native retry");
  assert.equal(result.message.loopPiRecovery.reason, "safe-local-timeout");
  h.emit("agent_settled"); h.emit("input", { source: "extension" }); h.emit("turn_start");
  t.mock.timers.tick(29);
  assert.equal(h.aborted, 0, "healthy first-request time is outside the recovery episode");
  t.mock.timers.tick(1);
  assert.equal(h.aborted, 1, "follow-up retains the failure-established deadline");
  h.emit("agent_settled"); h.emit("session_shutdown");
});

test("policy halt and cancellation cannot turn into a second exhaustion notice on a stale wake", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  for (const cancelled of [false, true]) {
    const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
    h.emit("message_end", { message: cancelled ? { role: "assistant", stopReason: "aborted", content: [], errorMessage: "Request was aborted" }
      : { role: "assistant", stopReason: "error", content: [], errorMessage: 'fixture API error (503): {"error":{"code":"cyber_policy","type":"server_error","message":"do not retain"}}' } });
    h.emit("agent_settled"); t.mock.timers.tick(40);
    assert.deepEqual(h.emit("input", { source: "extension" }), { action: "handled" });
    assert.equal(h.notices.filter((m) => m.customType === "loop-recovery-exhausted").length, 0);
    assert.equal(h.notices.length, cancelled ? 0 : 1);
    h.emit("session_shutdown");
  }
});

test("observed tool execution and malformed tool declarations refuse timeout recovery", () => {
  assert.equal(portableRequest({ input: [], tools: {} }), false);
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
  h.emit("tool_execution_start"); h.query("loop-recovery:request-timeout", {});
  const result = h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [], errorMessage: "Request was aborted" } });
  assert.equal(result.message.loopPiRecovery.reason, "tool-execution-observed");
  h.emit("session_shutdown");
});

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
  const h=harness();h.emit("turn_start");h.emit("before_provider_request", {payload:{input:[]}});h.emit("message_end",failure);
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
  h.emit("before_provider_request", {payload:{input:[]}});
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
  assert.deepEqual(h.wakeReservation(), { sessionId: "lifecycle-session", sentAt: WAKE_HOLD }, "pi-subagents idle wakes are held");
  assert.deepEqual(h.emit("input", { source: "extension", text: "Subagent updates above." }), { action: "handled" });
  h.emit("input", { source: "rpc" });
  assert.equal(h.wakeReservation()?.sentAt, undefined, "genuine input releases the hold");
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

test("opaque summary stop is latched before abort attribution and settlement cannot reopen it", () => {
  const h = harness({retry:{maxRetries:60,provider:{maxRetries:0}},loopPi:{retryRecovery:{providerIds:["fixture"],episodeMs:100,maxAttempts:3}}});
  h.emit("turn_start"); h.emit("before_provider_request",{payload:{input:[]}});
  h.emit("message_end",{message:{role:"assistant",stopReason:"error",content:[],errorMessage:'OpenAI API error (400): {"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"maximum context length exceeded"}}'}});
  const preparation = {isSplitTurn:false,messagesToSummarize:[],turnPrefixMessages:[]};
  assert.equal(h.emit("session_before_compact",{preparation}),undefined);
  const first = {headers:{}};
  h.emit("before_provider_headers",first);
  let allowedAtAttribution = true;
  h.on("loop-recovery:abort", () => h.query("loop-recovery:may-follow-up",{reply:(value:boolean)=>{allowedAtAttribution=value;}}));
  h.emit("before_provider_headers",{headers:{}});
  assert.equal(allowedAtAttribution,false,"stop latch precedes attribution emission, not just ctx.abort");
  assert.deepEqual(h.sequence.slice(-2),["loop-recovery:abort","abort"]);
  let allowed = true;
  h.query("loop-recovery:may-follow-up",{reply:(value:boolean)=>{allowed=value;}});
  assert.equal(allowed,false,"synchronous latch is already closed before settlement");
  h.emit("session_compact_failed",{aborted:true}); h.emit("agent_settled");
  assert.equal(h.notices.length,1);
  assert.equal(h.notices[0].details.reason,"opaque-summary-retry-not-authorized");
  assert.equal(h.notices[0].details.attempts,2,"payload inspection must not charge a second admission");
  assert.deepEqual(h.emit("input",{source:"extension"}),{action:"handled"});
  h.emit("session_shutdown");
});

test("successful summary preserves the original episode deadline", (t) => {
  t.mock.timers.enable({apis:["Date","setTimeout"]});
  const h = harness(); h.emit("turn_start"); h.emit("before_provider_request",{payload:{input:[]}});
  h.emit("message_end",{message:{role:"assistant",stopReason:"error",content:[],errorMessage:"maximum context length exceeded"}});
  h.emit("session_before_compact",{preparation:{isSplitTurn:false,messagesToSummarize:[],turnPrefixMessages:[]}});
  t.mock.timers.tick(20); h.emit("before_provider_headers",{headers:{}}); h.emit("session_compact");
  h.emit("agent_settled"); h.emit("turn_start");
  t.mock.timers.tick(10);
  assert.equal(h.aborted,1,"summary completion must not start another thirty-millisecond budget");
  h.emit("agent_settled"); h.emit("session_shutdown");
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


test("late successful recovery completion cannot erase an expired episode before timer delivery", (t) => {
  t.mock.timers.enable({apis:["Date","setTimeout"],now:1000});
  const h=harness(); h.emit("turn_start");h.emit("before_provider_request",{payload:{input:[]}});
  h.emit("message_end",failure);h.emit("agent_settled");h.emit("turn_start");
  h.emit("before_provider_request",{payload:{input:[]}});
  t.mock.timers.setTime(Date.now()+31);
  const result=h.emit("message_end",{message:{role:"assistant",stopReason:"toolUse",content:[{type:"toolCall",name:"bash",arguments:{}}]}});
  assert.equal(result.message.stopReason,"error");
  assert.equal(result.message.loopPiRecovery.reason,"episode-expired");
  assert.equal(h.aborted,1);
  h.emit("agent_settled");assert.deepEqual(h.emit("input",{source:"extension"}),{action:"handled"});
  h.emit("session_shutdown");
});

for (const [cause, errorMessage] of [
  ["authentication", "invalid_api_key"],
  ["authentication", "401 Unauthorized"],
  ["policy", "cyber_policy"],
  ["quota", "You have hit your usage limit for this period"],
  ["quota", "You exceeded your current quota"],
] as const) {
  test(`managed rewriting preserves ${cause} refusal classification: ${errorMessage}`, () => {
    const h = harness();
    h.emit("turn_start");
    h.emit("before_provider_request", { payload: { input: [] } });
    const result = h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage } });
    h.emit("session_shutdown");
    assert.equal(result.message.loopPiRecovery.disposition, "stop");
    const decision = classifyRootStop(result.message, { harnessAbort: null });
    assert.equal(decision.action, "stop", "an owner-actionable refusal must not schedule another root call");
    assert.equal(decision.action === "stop" && decision.cause, cause);
  });
}

test("managed transport refusal remains eligible for provider recovery", () => {
  const h = harness();
  h.emit("turn_start");
  h.emit("before_provider_request", { payload: { input: [] } });
  const result = h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage: "Request failed: connection refused" } });
  h.emit("session_shutdown");
  const decision = classifyRootStop(result.message, { harnessAbort: null });
  assert.equal(decision.action, "resume");
});

for (const errorMessage of [
  "Network timeout during authentication",
  "Connection failed while loading policy",
  "Transport failed reading quota status",
]) {
  test(`unrelated transport diagnostic does not become refusal: ${errorMessage}`, () => {
    const h = harness(); h.emit("turn_start"); h.emit("before_provider_request", { payload: { input: [] } });
    const result = h.emit("message_end", { message: { role: "assistant", stopReason: "error", content: [], errorMessage } });
    h.emit("session_shutdown");
    assert.equal(classifyRootStop(result.message, { harnessAbort: null }).action, "resume");
  });
}
