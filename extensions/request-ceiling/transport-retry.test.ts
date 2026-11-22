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
  installRecovery(pi as any, () => ({ loopPi: { retryRecovery: { providerIds: ["fixture"], episodeMs: 10000 } }, retry: { provider: { maxRetries: 0 } } }));
  const fire = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return { fire };
}

for (const errorMessage of ["Connection closed.", "read ECONNRESET", "write EPIPE", "connect ETIMEDOUT"]) {
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
}
