// The automatic root recovery table (root-recovery.ts). The real path through pi, the request
// ceiling and pi's native retry is proved in root-recovery-e2e.test.ts; this pins every row of the
// classification, the backoff arithmetic and the rolling resume cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_LENGTH_ERROR } from "../request-ceiling/core.ts";
import { hardStopFor, hardStopText } from "../request-ceiling/hard-stop.ts";
import { classifyRootStop, lastAssistantMessage, resumeDelayMs, resumesInWindow, resumeTimesFromBranch, rootRecoveryConfig, type SettleEvidence, boundedQuotaRecovery, quotaRetriesFromBranch, QUOTA_RETRY_ENTRY, RESUME_CUSTOM_TYPE } from "./root-recovery.ts";

const none: SettleEvidence = { harnessAbort: null };
const http = (status: number, code: string, type = "server_error") => ({
  role: "assistant", stopReason: "error", errorMessage: `Fixture API error (${status}): ${JSON.stringify({ error: { code, type, message: "secret body" } })}`,
});
/** The message as request-ceiling persists it after a hard stop. */
const stopped = (message: { stopReason: string; errorMessage: string }) => {
  const stop = hardStopFor(message)!;
  return { ...message, errorMessage: hardStopText(stop), loopPiHardStop: stop };
};

test("healthy and operator-cancelled runs are left alone", () => {
  assert.deepEqual(classifyRootStop(null, none), { action: "none", why: "healthy" });
  for (const stopReason of ["stop", "toolUse", "length"]) {
    assert.deepEqual(classifyRootStop({ stopReason }, none), { action: "none", why: "healthy" }, stopReason);
  }
  assert.deepEqual(classifyRootStop({ stopReason: "aborted", errorMessage: "Request was aborted" }, none), { action: "none", why: "operator-cancelled" });
});

test("authentication, policy, encrypted content, quota and context length stop the run", () => {
  const cases: [string, unknown, SettleEvidence][] = [
    ["authentication", stopped(http(401, "invalid_api_key", "authentication_error")), none],
    ["authentication", http(401, "unrecognized_code"), none],
    ["authentication", http(403, "permission_denied", "permission_error"), none],
    ["authentication", { stopReason: "error", errorMessage: "401 Unauthorized" }, none],
    ["policy", stopped(http(503, "cyber_policy")), none],
    ["policy", http(400, "content_policy_violation", "invalid_request_error"), none],
    ["policy", { stopReason: "error", errorMessage: "cyber_policy: blocked" }, none],
    ["encrypted-history", stopped(http(400, "invalid_encrypted_content", "invalid_request_error")), { harnessAbort: "request-timeout" }],
    ["quota", http(429, "insufficient_quota", "rate_limit_error"), none],
    ["quota", { stopReason: "error", errorMessage: "You have hit your usage limit for this period" }, none],
    ["context-length", http(400, "context_length_exceeded", "invalid_request_error"), none],
    ["context-length", { stopReason: "error", errorMessage: "prompt is too long: maximum context length exceeded" }, none],
  ];
  for (const [cause, message, evidence] of cases) {
    const decision = classifyRootStop(message as never, evidence);
    assert.equal(decision.action, "stop", JSON.stringify(message));
    assert.equal((decision as { cause: string }).cause, cause, JSON.stringify(message));
    assert.doesNotMatch((decision as { detail: string }).detail, /secret body/, "never an error body");
  }
});

test("a proxy tunnel refusal in a connection error's cause stops the run as authentication, while a refused connection resumes", () => {
  // A 403 from the proxy's CONNECT is a standing refusal the owner must fix; resuming would only repeat it.
  for (const errorMessage of ["Connection error. (cause: Proxy response (403) !== 200 when HTTP Tunneling)",
    "Connection error. (cause: tunneling socket could not be established, statusCode=403)"]) {
    const decision = classifyRootStop({ stopReason: "error", errorMessage } as never, none);
    assert.deepEqual([decision.action, (decision as { cause?: string }).cause], ["stop", "authentication"], errorMessage);
  }
  for (const errorMessage of ["Connection error.", "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:9)"]) {
    const decision = classifyRootStop({ stopReason: "error", errorMessage } as never, none);
    assert.deepEqual([decision.action, (decision as { cause?: string }).cause], ["resume", "provider-error"], errorMessage);
  }
});

test("provider errors, stalled requests and request-ceiling aborts resume", () => {
  const cases: [string, unknown, SettleEvidence][] = [
    ["provider-error", http(503, "mystery_code", "mystery_type"), none],
    ["provider-error", http(503, "server_is_overloaded"), none],
    ["provider-error", { stopReason: "error", errorMessage: "stream_incomplete: Upstream websocket closed before response.completed" }, none],
    ["provider-error", { stopReason: "error", errorMessage: "fetch failed" }, none],
    ["provider-error", { stopReason: "error", errorMessage: "429 Too Many Requests" }, none],
    ["provider-error", { stopReason: "error", errorMessage: "inference refused" }, none],
    ["stalled-request", { stopReason: "aborted", errorMessage: "Request was aborted" }, { harnessAbort: "request-timeout", ceilingLimit: "inactivity" }],
    ["request-ceiling", { stopReason: "aborted", errorMessage: "Request was aborted" }, { harnessAbort: "request-timeout", ceilingLimit: "absolute" }],
    ["request-ceiling", { stopReason: "error", errorMessage: EMPTY_LENGTH_ERROR }, none],
  ];
  for (const [cause, message, evidence] of cases) {
    const decision = classifyRootStop(message as never, evidence);
    assert.deepEqual([decision.action, (decision as { cause?: string }).cause], ["resume", cause], JSON.stringify(message));
  }
  const detail = (classifyRootStop(http(503, "mystery_code") as never, none) as { detail: string }).detail;
  assert.equal(detail, "upstream=mystery_code status=503");
});

test("backoff starts at the base, doubles, and caps; settings outside range use the defaults", () => {
  const config = rootRecoveryConfig({});
  assert.deepEqual(config, { enabled: true, baseDelayMs: 60_000, maxDelayMs: 900_000, maxResumes: 6, windowMs: 3_600_000 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map((n) => resumeDelayMs(n, config)), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  assert.deepEqual(rootRecoveryConfig({ loopPi: { rootRecovery: { baseDelayMs: -1, maxDelayMs: "x", maxResumes: 1.5, windowMs: 0 } } }), config);
  assert.deepEqual(rootRecoveryConfig({ loopPi: { rootRecovery: { baseDelayMs: 500, maxDelayMs: 100 } } }), { ...config, baseDelayMs: 500, maxDelayMs: 500 });
  assert.equal(rootRecoveryConfig({ loopPi: { rootRecovery: { enabled: false } } }).enabled, false);
});

test("the resume cap counts sent resumes in a rolling window, read back from the session branch", () => {
  const resume = (at: unknown) => ({ type: "custom_message", customType: RESUME_CUSTOM_TYPE, details: { attempt: 1, at } });
  const branch = [resume(1_000), resume(2_000), { type: "custom_message", customType: "loop-wake", details: { at: 2_500 } }, resume("x"), resume(3_000)];
  const times = resumeTimesFromBranch(branch);
  assert.deepEqual(times, [1_000, 2_000, 3_000]);
  assert.equal(resumesInWindow(times, 3_000, 10_000), 3);
  assert.equal(resumesInWindow(times, 12_500, 10_000), 1, "resumes older than the window no longer count");
});

test("the last assistant message is read from the session branch", () => {
  const branch = [
    { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "first" } },
    { type: "custom", customType: "loop-request-incident" },
    { type: "message", message: { role: "user", content: "x" } },
  ];
  assert.equal(lastAssistantMessage(branch)?.errorMessage, "first");
  assert.equal(lastAssistantMessage([]), null);
});

test("quota recovery is limited to two retries and persists until genuine owner input resets it", () => {
  const decision = classifyRootStop(http(429, "insufficient_quota", "rate_limit_error"), none);
  assert.equal(boundedQuotaRecovery(decision, 0).action, "resume");
  assert.equal(boundedQuotaRecovery(decision, 1).action, "resume");
  assert.deepEqual(boundedQuotaRecovery(decision, 2), decision);
  const entry = (attempts: unknown) => ({ type: "custom", customType: QUOTA_RETRY_ENTRY, data: { v: 1, attempts } });
  assert.equal(quotaRetriesFromBranch([entry(1), entry(2)]), 2);
  assert.equal(quotaRetriesFromBranch([entry(2), { type: "message", message: { role: "assistant", stopReason: "stop" } }]), 2);
  assert.equal(quotaRetriesFromBranch([entry(2), entry(0)]), 0);
  assert.equal(quotaRetriesFromBranch([entry(-1)]), 2);
  assert.equal(quotaRetriesFromBranch([entry("0")]), 2);
  assert.equal(quotaRetriesFromBranch([]), 0);
  const auth = classifyRootStop(http(401, "invalid_api_key"), none);
  assert.deepEqual(boundedQuotaRecovery(auth, 0), auth);
});

