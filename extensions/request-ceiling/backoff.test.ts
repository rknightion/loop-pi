// Retry backoff: the delay function, then one end-to-end proof on the faux provider over RPC that
// the wait lands in front of pi's own retry (SEAMS.md "Retry backoff").

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAUX_EXTENSION, cleanupAll, freshDir, startPiRpc, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  SERVER_JITTER_RATIO,
  backoffConfig,
  classifyRetryError,
  extraRetryDelayMs,
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
    ["fetch failed", "other"],
    ["Request timed out after 300000ms", "other"],
    ["socket hang up", "other"],
    [undefined, "other"],
  ];
  for (const [message, expected] of cases) assert.equal(classifyRetryError(message), expected, String(message));
});

test("429 waits a flat total, 5xx adds bounded jitter, anything else adds nothing", () => {
  const config = { rateLimitDelayMs: DEFAULT_RATE_LIMIT_DELAY_MS };
  // pi's own delays for baseDelayMs 2000 capped at 60000: attempts 1, 3 and 7.
  for (const piDelay of [2000, 8000, 60_000]) {
    // The total for a 429 is pi's delay plus the extra: always 60 s.
    assert.equal(piDelay + extraRetryDelayMs("rate-limit", piDelay, config), 60_000, `429 at ${piDelay}`);
    assert.equal(extraRetryDelayMs("other", piDelay, config, () => 0.99), 0, `other at ${piDelay}`);
    const max = piDelay * SERVER_JITTER_RATIO;
    assert.equal(extraRetryDelayMs("server", piDelay, config, () => 0), 0, `5xx low at ${piDelay}`);
    const high = extraRetryDelayMs("server", piDelay, config, () => 0.999999);
    assert.ok(high > 0 && high < max, `5xx high at ${piDelay}: ${high} within [0, ${max})`);
  }
  const draws = new Set(Array.from({ length: 20 }, () => extraRetryDelayMs("server", 8000, config)));
  assert.ok(draws.size > 1, "5xx extras must vary between retries");
  // pi's delay already past the rate-limit total: no extra, never negative.
  assert.equal(extraRetryDelayMs("rate-limit", 90_000, config), 0);
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

test("a 429 from the model waits the flat rate-limit total before pi's own retry starts", async () => {
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
