// The automatic root recovery table (root-recovery.ts). The real path through pi, the request
// ceiling and the retry recovery episode is proved in root-recovery-e2e.test.ts; this pins every
// row of the classification and the backoff arithmetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_LENGTH_ERROR } from "../request-ceiling/core.ts";
import { classifyRootStop, lastAssistantMessage, resumeDelayMs, rootRecoveryConfig, type SettleEvidence, boundedQuotaRecovery, quotaRetriesFromBranch, QUOTA_RETRY_ENTRY } from "./root-recovery.ts";

const none: SettleEvidence = { harnessAbort: null };
const managed = (reason: string, code: string | null = null, status: number | null = null) => ({
  role: "assistant", stopReason: "error", errorMessage: "loop-pi recovery required; automatic continuation declined",
  loopPiRecovery: { reason, code, status, disposition: "stop" },
});
const http = (status: number, code: string, type = "server_error") => ({
  role: "assistant", stopReason: "error", errorMessage: `Fixture API error (${status}): ${JSON.stringify({ error: { code, type, message: "secret body" } })}`,
});

test("healthy and operator-cancelled runs are left alone", () => {
  assert.deepEqual(classifyRootStop(null, none), { action: "none", why: "healthy" });
  for (const stopReason of ["stop", "toolUse", "length"]) {
    assert.deepEqual(classifyRootStop({ stopReason }, none), { action: "none", why: "healthy" }, stopReason);
  }
  assert.deepEqual(classifyRootStop({ stopReason: "aborted", errorMessage: "Request was aborted" }, none), { action: "none", why: "operator-cancelled" });
  assert.deepEqual(classifyRootStop(managed("operator-cancelled"), { harnessAbort: "recovery-abort" }), { action: "none", why: "operator-cancelled" });
});

test("authentication, quota, policy, context-length and configuration stop the run", () => {
  const cases: [string, unknown, SettleEvidence][] = [
    ["authentication", managed("upstream-auth-refusal", "invalid_api_key", 401), none],
    ["authentication", http(401, "unrecognized_code"), none],
    ["authentication", http(403, "permission_denied", "permission_error"), none],
    ["authentication", { stopReason: "error", errorMessage: "401 Unauthorized" }, none],
    ["policy", managed("upstream-policy-refusal", "cyber_policy", 400), none],
    ["policy", http(400, "content_filter", "invalid_request_error"), none],
    ["policy", { stopReason: "error", errorMessage: "inference refused" }, none],
    ["quota", http(429, "insufficient_quota", "rate_limit_error"), none],
    ["quota", { stopReason: "error", errorMessage: "You have hit your usage limit for this period" }, none],
    ["quota", managed("attempt-limit", "insufficient_quota", 429), none],
    ["context-length", http(400, "context_length_exceeded", "invalid_request_error"), none],
    ["context-length", { stopReason: "error", errorMessage: "prompt is too long: maximum context length exceeded" }, none],
    ["context-length", managed("opaque-summary-retry-not-authorized"), { harnessAbort: "recovery-abort" }],
    ["context-length", managed("summary-route-not-established"), none],
    ["configuration", managed("unobservable-provider-retries"), { harnessAbort: "recovery-abort" }],
  ];
  for (const [cause, message, evidence] of cases) {
    const decision = classifyRootStop(message as never, evidence);
    assert.equal(decision.action, "stop", JSON.stringify(message));
    assert.equal((decision as { cause: string }).cause, cause, JSON.stringify(message));
    assert.doesNotMatch((decision as { detail: string }).detail, /secret body/, "never an error body");
  }
});

test("provider errors, stalled requests and request-ceiling aborts resume", () => {
  const cases: [string, unknown, SettleEvidence][] = [
    ["provider-error", managed("attempt-limit", "stream_incomplete", 503), none],
    ["provider-error", managed("episode-expired"), { harnessAbort: "recovery-abort" }],
    ["provider-error", managed("protected-request", "stream_incomplete"), none],
    ["provider-error", managed("partial-output-not-replayable"), none],
    ["provider-error", managed("non-retryable-upstream", "unrecognized", 400), none],
    ["provider-error", http(503, "server_is_overloaded"), none],
    ["provider-error", { stopReason: "error", errorMessage: "fetch failed" }, none],
    ["provider-error", { stopReason: "error", errorMessage: "429 Too Many Requests" }, none],
    ["stalled-request", { stopReason: "aborted", errorMessage: "Request was aborted" }, { harnessAbort: "request-timeout", ceilingLimit: "inactivity" }],
    ["stalled-request", managed("timeout-not-replayable"), none],
    ["request-ceiling", { stopReason: "aborted", errorMessage: "Request was aborted" }, { harnessAbort: "request-timeout", ceilingLimit: "absolute" }],
    ["request-ceiling", { stopReason: "error", errorMessage: EMPTY_LENGTH_ERROR }, none],
  ];
  for (const [cause, message, evidence] of cases) {
    const decision = classifyRootStop(message as never, evidence);
    assert.deepEqual([decision.action, (decision as { cause?: string }).cause], ["resume", cause], JSON.stringify(message));
  }
});

test("backoff starts at the base, doubles, and caps; settings outside range use the defaults", () => {
  const config = rootRecoveryConfig({});
  assert.deepEqual(config, { enabled: true, baseDelayMs: 60_000, maxDelayMs: 900_000 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map((n) => resumeDelayMs(n, config)), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  assert.deepEqual(rootRecoveryConfig({ loopPi: { rootRecovery: { baseDelayMs: -1, maxDelayMs: "x" } } }), config);
  assert.deepEqual(rootRecoveryConfig({ loopPi: { rootRecovery: { baseDelayMs: 500, maxDelayMs: 100 } } }), { enabled: true, baseDelayMs: 500, maxDelayMs: 500 });
  assert.equal(rootRecoveryConfig({ loopPi: { rootRecovery: { enabled: false } } }).enabled, false);
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
