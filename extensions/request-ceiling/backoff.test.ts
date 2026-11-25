// Retry backoff: the delay function, then one end-to-end proof on the faux provider over RPC that
// the wait lands in front of pi's own retry (SEAMS.md "Retry backoff").

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, cleanupAll, freshDir, startPiRpc, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";
import { startResponsesServer } from "../call-timing/test-support/responses-server.ts";
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  RETRY_AFTER_MAX_MS,
  SERVER_JITTER_RATIO,
  backoffConfig,
  classifyRetryError,
  extraRetryDelayMs,
  retryAfterMs,
  retryPolicy,
} from "./backoff.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CEILING_EXTENSION = join(HERE, "index.ts");

after(cleanupAll);

test("retryable errors are classified by status: 429 first, then 5xx, else other", () => {
  const cases: [string | undefined, string][] = [
    ["OpenAI API error (429): Too Many Requests", "rate-limit"],
    ["429: {\"error\":{\"type\":\"rate_limit_error\"}}", "rate-limit"],
    ["Rate limit reached for requests", "rate-limit"],
    ["OpenAI API error (500): internal", "server"],
    ["OpenAI API error (503): Service Unavailable", "server"],
    ["502: bad gateway", "server"],
    ["The model is overloaded", "server"],
    // pi-ai retries these natively (utils/retry.js; the first from 1.2.0, the other two from 1.3.0); they are upstream server failures.
    ["The service is temporarily unavailable", "server"],
    ["Unable to forward upstream stream", "server"],
    ["The upstream provider returned an error", "server"],
    // pi-ai 1.4.0 also retries gateway and Codex-proxy upstream failures (utils/retry.js); node-fetch network errors stay "other".
    ["upstream_request_failed", "server"],
    ["upstream_stream_read_error", "server"],
    ["The stream was interrupted", "server"],
    ["HTTP/2 stream failed", "server"],
    ["stream disconnected before completion: stream closed before response.completed", "server"],
    // pi-ai 1.6.0 retries a Claude Code stream cut mid-reply (utils/retry.js, #11879).
    ["Claude Code's stream from Anthropic was cut short after the reply had begun", "server"],
    // pi-ai 1.6.1 retries these natively too (utils/retry.js: #12206, #12227, #12240, #12407).
    ["OpenAI API error (525): SSL handshake failed", "server"],
    ["The provider is temporarily unavailable. Retry shortly.", "server"],
    ["{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Unable to complete this request right now.\"}}", "server"],
    ["Request waited 73.4s in queue, reaching this model's admission ceiling of 60s", "server"],
    ["provider finish_reason: error", "server"],
    ["provider stopped with: error", "server"],
    ["Provider returned an empty response", "server"],
    ["Upstream error from Relace: The model stopped before completing the response.", "server"],
    ["The provider ended the response before it was complete.", "server"],
    ["The connection to the provider was reset", "server"],
    ["The provider reported a failure while generating the response", "server"],
    ["Unable to process request. Repeat the request later.", "server"],
    ["Request rate increased too quickly", "rate-limit"],
    ["request to https://oauth2.example.test/token failed, reason: ", "other"],
    ["fetch failed", "other"],
    ["Request timed out after 300000ms", "other"],
    ["socket hang up", "other"],
    [undefined, "other"],
  ];
  for (const [message, expected] of cases) assert.equal(classifyRetryError(message), expected, String(message));
});

test("all retry classes add bounded jitter without reducing rate-limit floor", () => {
  const config = { rateLimitDelayMs: DEFAULT_RATE_LIMIT_DELAY_MS };
  // pi's own delays for baseDelayMs 2000 capped at 60000: attempts 1, 3 and 7.
  for (const piDelay of [2000, 8000, 60_000]) {
    // Zero jitter retains the minimum 60 s total for a 429.
    assert.equal(piDelay + extraRetryDelayMs("rate-limit", piDelay, config, () => 0), 60_000, `429 at ${piDelay}`);
    assert.ok(extraRetryDelayMs("other", piDelay, config, () => 0.99) > 0, `other at ${piDelay}`);
    assert.ok(extraRetryDelayMs("rate-limit", piDelay, config, () => 0.99) > 60_000 - piDelay);
    const max = piDelay * SERVER_JITTER_RATIO;
    assert.equal(extraRetryDelayMs("server", piDelay, config, () => 0), 0, `5xx low at ${piDelay}`);
    const high = extraRetryDelayMs("server", piDelay, config, () => 0.999999);
    assert.ok(high > 0 && high < max, `5xx high at ${piDelay}: ${high} within [0, ${max})`);
  }
  const draws = new Set(Array.from({ length: 20 }, () => extraRetryDelayMs("server", 8000, config)));
  assert.ok(draws.size > 1, "5xx extras must vary between retries");
  // pi's delay already past the rate-limit total: no extra, never negative.
  assert.equal(extraRetryDelayMs("rate-limit", 90_000, config, () => 0), 0);
});

test("retry-after is read in seconds, as an HTTP date or as retry-after-ms, and nothing else", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(retryAfterMs({ "retry-after": "120" }, now), 120_000);
  assert.equal(retryAfterMs({ "Retry-After": " 7 " }, now), 7_000, "names match case-insensitively");
  assert.equal(retryAfterMs({ "retry-after": "Wed, 25 Nov 2026 12:00:30 GMT" }, now), 30_000);
  assert.equal(retryAfterMs({ "retry-after": "Wed, 25 Nov 2026 11:59:00 GMT" }, now), 0, "a past date means now");
  assert.equal(retryAfterMs({ "retry-after-ms": "2500" }, now), 2_500);
  assert.equal(retryAfterMs({ "retry-after-ms": "2500", "retry-after": "9" }, now), 2_500, "the millisecond header is more precise");
  for (const value of ["", "soon", "-5", "1.5e3x", "Infinity"]) assert.equal(retryAfterMs({ "retry-after": value }, now), undefined, value);
  assert.equal(retryAfterMs({}, now), undefined);
});

test("a server's retry-after raises the wait, never lowers the 429 floor, and is capped", () => {
  const config = { rateLimitDelayMs: DEFAULT_RATE_LIMIT_DELAY_MS };
  const none = () => 0;
  assert.equal(2000 + extraRetryDelayMs("rate-limit", 2000, config, none, 120_000), 120_000);
  assert.equal(2000 + extraRetryDelayMs("rate-limit", 2000, config, none, 5_000), 60_000, "the floor still applies");
  assert.equal(2000 + extraRetryDelayMs("server", 2000, config, none, 30_000), 30_000, "a 503 with retry-after waits for it too");
  assert.equal(2000 + extraRetryDelayMs("rate-limit", 2000, config, none, 24 * 3_600_000), RETRY_AFTER_MAX_MS);
  assert.equal(extraRetryDelayMs("other", 2000, config, none, undefined), 0, "no header, no change");
});

test("settings: rateLimitDelayMs and pi's retry block fall back to defaults when invalid", () => {
  assert.equal(backoffConfig({}).rateLimitDelayMs, DEFAULT_RATE_LIMIT_DELAY_MS);
  assert.equal(backoffConfig({ loopPi: { retryBackoff: { rateLimitDelayMs: "60000" } } }).rateLimitDelayMs, DEFAULT_RATE_LIMIT_DELAY_MS);
  assert.equal(backoffConfig({ loopPi: { retryBackoff: { rateLimitDelayMs: -1 } } }).rateLimitDelayMs, DEFAULT_RATE_LIMIT_DELAY_MS);
  assert.equal(backoffConfig({ loopPi: { retryBackoff: { rateLimitDelayMs: 30_000 } } }).rateLimitDelayMs, 30_000);
  assert.deepEqual(retryPolicy({}), { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 });
  assert.deepEqual(retryPolicy({ retry: { enabled: false, maxRetries: 60 } }), {
    enabled: false,
    maxRetries: 60,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60_000,
  });
});

test("a 429 from the model waits at least the rate-limit floor before pi's own retry starts", async () => {
  const home = freshDir("retry-backoff-home-");
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ retry: { maxRetries: 3, baseDelayMs: 100 }, loopPi: { retryBackoff: { rateLimitDelayMs: 3000 } } }),
  );
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, CEILING_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "GO", once: true, stopReason: "error", errorMessage: "OpenAI API error (429): Too Many Requests" },
      { match: "GO", text: "recovered" },
    ]),
    agentDir: home,
    subagentTempRoot: freshDir("retry-backoff-tmp-"),
    cwd: freshDir("retry-backoff-cwd-"),
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "GO" });
    await session.waitFor(
      (e) => e.type === "message_end" && (e.message as { stopReason?: string })?.stopReason === "error",
    );
    const failedAt = Date.now();
    const retry = await session.waitFor((e) => e.type === "auto_retry_start");
    const waited = Date.now() - failedAt;
    // pi still schedules its own 100 ms delay; the extension's 2900 ms ran before it.
    assert.equal(retry.delayMs, 100);
    assert.ok(waited >= 2500, `pi's retry started ${waited} ms after the 429; expected the rate-limit wait first`);
    const end = await session.waitFor((e) => e.type === "auto_retry_end");
    assert.equal(end.success, true);
  } finally {
    await session.close();
  }
});

test("a 429 with retry-after from the openai Responses route waits for the server's hint", async () => {
  // pi 1.6.1 fires after_provider_response for the 429 itself, so its retry-after reaches the wait.
  const ok = [
    { frame: { type: "response.created", sequence_number: 0, response: { id: "resp_ok", object: "response", created_at: 1, status: "in_progress", model: "fixture", output: [] } } },
    { frame: { type: "response.completed", sequence_number: 1, response: { id: "resp_ok", object: "response", created_at: 1, status: "completed", model: "fixture", output: [],
      usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } } },
  ];
  const server = await startResponsesServer([[{ httpError: 429, headers: { "retry-after": "3" } }]], ok);
  const home = freshDir("retry-after-home-");
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never",
    retry: { maxRetries: 3, baseDelayMs: 100, provider: { maxRetries: 0 } },
    loopPi: { retryBackoff: { rateLimitDelayMs: 500 } },
  }));
  const session = startPiRpc({
    extensions: [join(HERE, "../call-timing/test-support/responses-provider.ts"), CEILING_EXTENSION],
    fauxScriptPath: join(home, "unused.json"), agentDir: home,
    subagentTempRoot: freshDir("retry-after-tmp-"), cwd: freshDir("retry-after-cwd-"), sessionArgs: [],
    extraArgs: ["--provider", "progress-fixture", "--model", "fixture"],
    env: { LOOP_PI_PROGRESS_BASE_URL: server.baseUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "GO" });
    await session.waitFor((e) => e.type === "message_end" && (e.message as { stopReason?: string })?.stopReason === "error");
    const failedAt = Date.now();
    const retry = await session.waitFor((e) => e.type === "auto_retry_start");
    const waited = Date.now() - failedAt;
    assert.equal(retry.delayMs, 100);
    // The configured floor is 500 ms; the server asked for 3 s, so pi's retry starts after that.
    assert.ok(waited >= 2_700, `pi's retry started ${waited} ms after the 429; expected the server's 3 s retry-after first`);
    const end = await session.waitFor((e) => e.type === "auto_retry_end");
    assert.equal(end.success, true);
    assert.equal(server.requests(), 2);
  } finally {
    await session.close();
    await server.close();
  }
});
