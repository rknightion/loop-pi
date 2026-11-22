import { test } from "node:test";
import assert from "node:assert/strict";
import { installRecovery } from "./recovery.ts";

// pi-ai 1.6.0 widened isRetryableAssistantError to transport wordings that carry no
// structured error: "Connection closed." (#12064) and bare Node socket codes (#12128).
// On the opted route an unstarted, portable request with such a failure is now a native
// retry from completed history instead of an unclassified-failure stop; partial output
// still stops because it cannot be replayed.
function harness(id: string) {
  const handlers = new Map<string, any>();
  const model = { provider: "fixture", id: "fixture", api: "openai-responses", baseUrl: "http://localhost", contextWindow: 100000 };
  const ctx = {
    model, sessionManager: { getSessionId: () => id }, isIdle: () => true,
    abort: () => undefined,
    modelRegistry: {
      getRegisteredProviderConfig: () => ({}), getProvider: () => ({ auth: {} }),
      find: () => model, getRegisteredNativeProvider: () => undefined, isUsingOAuth: () => false,
    },
  };
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), events: { on: () => undefined, emit: () => undefined }, sendMessage: () => undefined, appendEntry: () => undefined };
  installRecovery(pi as any, () => ({ loopPi: { retryRecovery: { providerIds: ["fixture"], episodeMs: 10000 } }, retry: { maxRetries: 60, provider: { maxRetries: 0 } } }));
  const fire = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return { fire };
}

const WORDINGS = ["Connection closed.", "read ECONNRESET", "write EPIPE", "connect ETIMEDOUT", "read ECONNABORTED", "connect ECONNREFUSED", "recv failure: Connection reset by peer"];

for (const errorMessage of WORDINGS) {
  test(`a transport failure "${errorMessage}" before any output retries the portable request`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const { fire } = harness(`transport-${errorMessage}`);
    fire("turn_start");
    fire("before_provider_request", { payload: { input: [{ role: "user", content: "hello" }] } });
    const result = fire("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage, usage: { input: 0, output: 0 } } });
    assert.equal(result.message.loopPiRecovery.disposition, "retry");
    assert.equal(result.message.loopPiRecovery.reason, "unstarted-request");
    assert.match(result.message.errorMessage, /^server error: \w+; unstarted-request; retrying from completed history$/);
    fire("session_shutdown");
  });

  test(`a transport failure "${errorMessage}" after partial output still stops`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const { fire } = harness(`partial-${errorMessage}`);
    fire("turn_start");
    fire("before_provider_request", { payload: { input: [{ role: "user", content: "hello" }] } });
    const result = fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "half an answer" }], stopReason: "error", errorMessage, usage: { input: 0, output: 0 } } });
    assert.equal(result.message.loopPiRecovery.disposition, "stop");
    assert.equal(result.message.loopPiRecovery.reason, "partial-output-not-replayable");
    fire("session_shutdown");
  });

  test(`a transport failure "${errorMessage}" after a local tool ran still stops`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const { fire } = harness(`tool-${errorMessage}`);
    fire("turn_start");
    fire("before_provider_request", { payload: { input: [{ role: "user", content: "hello" }] } });
    fire("tool_execution_start", { toolCallId: "call-1", toolName: "bash" });
    const result = fire("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage, usage: { input: 0, output: 0 } } });
    assert.equal(result.message.loopPiRecovery.disposition, "stop");
    assert.equal(result.message.loopPiRecovery.reason, "tool-execution-observed");
    fire("session_shutdown");
  });
}

test("transport failures stop at the shared attempt limit instead of retrying forever", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { fire } = harness("transport-attempt-limit");
  const dispositions: string[] = [];
  let last: any;
  for (let attempt = 0; attempt < 10 && last?.message.loopPiRecovery.disposition !== "stop"; attempt++) {
    fire("turn_start");
    fire("before_provider_headers", { headers: {} });
    fire("before_provider_request", { payload: { input: [{ role: "user", content: "hello" }] } });
    last = fire("message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection closed.", usage: { input: 0, output: 0 } } });
    dispositions.push(last.message.loopPiRecovery.disposition);
  }
  assert.equal(last.message.loopPiRecovery.disposition, "stop");
  assert.equal(last.message.loopPiRecovery.reason, "attempt-limit");
  assert.ok(dispositions.slice(0, -1).every((d) => d === "retry"), `retries before the limit: ${dispositions.join(",")}`);
  assert.equal(last.message.loopPiRecovery.attempts, last.message.loopPiRecovery.maxAttempts);
  assert.equal(last.message.loopPiRecovery.maxAttempts, 5, "the home's retry.maxRetries 60 leaves recovery's own 5-attempt cap");
  assert.deepEqual(dispositions, ["retry", "retry", "retry", "retry", "stop"]);
  fire("session_shutdown");
});
