// The hard-stop list (hard-stop.ts) against pi-ai's own classifier. The real path through pi's retry
// machine is proved in native-retry.e2e.test.ts; this pins each row and the rewritten text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { hardStopFor, hardStopText } from "./hard-stop.ts";

const http = (status: number, code: string, type: string) =>
  `OpenAI API error (${status}): ${JSON.stringify({ code, type, message: "secret body" })}`;
const failed = (errorMessage: string) => ({ stopReason: "error", errorMessage });
const retryable = (errorMessage: string) => isRetryableAssistantError(failed(errorMessage) as never);

test("auth, policy and encrypted-content failures stop, even when pi would retry them", () => {
  const cases: [string, string, string | null, number | null][] = [
    [http(401, "invalid_api_key", "authentication_error"), "authentication", "invalid_api_key", 401],
    [http(403, "unsupported_country", "invalid_request_error"), "authentication", "unsupported_country", 403],
    [http(400, "permission_denied", "permission_error"), "authentication", "permission_denied", 400],
    [http(503, "cyber_policy", "server_error"), "policy", "cyber_policy", 503],
    [http(500, "content_policy_violation", "server_error"), "policy", "content_policy_violation", 500],
    [http(502, "mystery", "policy_error"), "policy", "mystery", 502],
    [http(400, "invalid_encrypted_content", "invalid_request_error"), "encrypted-content", "invalid_encrypted_content", 400],
    ["cyber_policy: This request was blocked", "policy", "cyber_policy", null],
    ["Error Code undefined: invalid_api_key", "authentication", "invalid_api_key", null],
    ["401 Unauthorized", "authentication", "401", null],
  ];
  for (const [text, category, code, status] of cases) {
    const stop = hardStopFor(failed(text));
    assert.deepEqual(stop && [stop.category, stop.code, stop.status], [category, code, status], text);
    const rewritten = hardStopText(stop!);
    assert.equal(retryable(rewritten), false, `pi must not retry: ${rewritten}`);
    assert.equal(isContextOverflow(failed(rewritten) as never, 0), false, rewritten);
    assert.doesNotMatch(rewritten, /secret body/);
  }
  assert.equal(retryable(http(503, "cyber_policy", "server_error")), true, "without the hard stop pi would retry a policy refusal at 503");
});

test("transient failures, quota and context overflow are left to pi", () => {
  for (const [text, piRetries] of [
    [http(503, "mystery_code", "mystery_type"), true],
    [http(429, "rate_limit_exceeded", "requests"), true],
    [http(500, "server_error", "server_error"), true],
    ["read ECONNRESET", true],
    ["Connection closed.", true],
    // pi-ai 1.6.1 retries Cloudflare's HTTP 525 natively (#12206); it carries no hard-stop token.
    ["OpenAI API error (525): <html>SSL handshake failed</html>", true],
    ["The provider is temporarily unavailable. Retry shortly.", true],
    ["stream_incomplete: Upstream websocket closed before response.completed", true],
    [http(429, "insufficient_quota", "insufficient_quota"), false],
    [http(429, "subscription_sharing_usage_limit_exceeded", "usage_limit_reached"), false],
    [http(400, "context_length_exceeded", "invalid_request_error"), false],
  ] as const) {
    assert.equal(hardStopFor(failed(text)), undefined, text);
    assert.equal(retryable(text), piRetries, text);
  }
  assert.ok(isContextOverflow(failed(http(400, "context_length_exceeded", "invalid_request_error")) as never, 0), "pi compacts for it");
  assert.equal(hardStopFor({ stopReason: "aborted", errorMessage: "invalid_api_key" }), undefined, "only errors");
});
