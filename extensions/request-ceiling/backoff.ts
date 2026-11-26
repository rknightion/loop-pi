// Pure logic for the retry backoff (SEAMS.md "Retry backoff"). No pi runtime imports, so this
// module is unit-testable without a live session.
//
// pi's own agent-level retry waits `retryDelayMs(settings.retry, attempt)`: baseDelayMs * 2^(n-1),
// capped at maxAgentDelayMs, with no jitter and no split by status. The extension cannot replace
// that wait, so it adds an extra wait before pi's: the total is pi's delay plus the extra.
//   - 429 (rate limit): rateLimitDelayMs (default 60 s) is a floor, plus bounded jitter.
//   - 5xx (server error): pi's delay plus a random extra of up to SERVER_JITTER_RATIO of it, so
//     lanes that failed together do not retry together.
//   - Anything else pi retries (network, timeout, stream drop): the same bounded jitter.
//   - A server's retry-after on the failed response lengthens any of these, up to RETRY_AFTER_MAX_MS.

/** Default total wait before retrying a rate-limited (429) request. */
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
/** Extra jitter is drawn from [0, ratio * the applicable delay floor). */
export const SERVER_JITTER_RATIO = 0.5;
/**
 * The longest wait a server's `retry-after` can ask for; a longer hint (a usage limit hours away) is
 * cut to this. Jitter is drawn on the larger of this and the class floor, so one wait is at most 1.5
 * times that plus pi's delay; a home whose `rateLimitDelayMs` is above this cap waits on its floor.
 * The request ceiling's timers do not run during the wait (they re-arm at `turn_start`);
 * pi's `retry.maxRetries` bounds the number of waits.
 */
export const RETRY_AFTER_MAX_MS = 300_000;
/** Node fires a longer setTimeout delay after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export type RetryErrorClass = "rate-limit" | "server" | "other";

// A provider error reads "<Provider> API error (<status>): <body>" or "<status>: <body>" (pi-ai
// formatProviderError); mid-stream failures carry only text. A 429 is checked first.
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests|rate increased too quickly/i;
// From "temporarily unavailable" on, these mirror the upstream failures pi-ai 1.6.1's
// isRetryableAssistantError retries natively (gateway, Codex-proxy and stream-relay wordings).
// Its 1.6.0 transport wordings ("Connection closed.", bare socket codes) stay "other" on purpose (SEAMS.md).
const SERVER_PATTERN = /\b5\d\d\b|overloaded|service.?unavailable|server.?error|internal.?error|bad.?gateway|temporarily unavailable|unable to forward upstream|upstream provider returned an error|upstream.?request.?failed|upstream_stream_read_error|stream was interrupted|http\/?2 stream failed|stream disconnected before completion|cut short after the reply had begun|"type"\s*:\s*"api_error"|admission ceiling|provider (?:finish_reason|stopped with): error|returned an empty response|stopped before completing the response|ended the response before it was complete|connection to the provider was reset|reported a failure while generating the response|repeat the request later/i;

export function classifyRetryError(errorMessage: string | undefined): RetryErrorClass {
  const text = errorMessage ?? "";
  if (RATE_LIMIT_PATTERN.test(text)) return "rate-limit";
  if (SERVER_PATTERN.test(text)) return "server";
  return "other";
}

export interface BackoffConfig {
  rateLimitDelayMs: number;
}

/** `loopPi.retryBackoff: {rateLimitDelayMs}` from a home's settings, else the default. */
export function backoffConfig(settings: unknown): BackoffConfig {
  const loopPi = (settings as { loopPi?: Record<string, any> } | undefined)?.loopPi ?? {};
  const raw = (loopPi.retryBackoff ?? {}) as Record<string, unknown>;
  const value = raw.rateLimitDelayMs;
  return {
    rateLimitDelayMs:
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS
        ? value
        : DEFAULT_RATE_LIMIT_DELAY_MS,
  };
}

export interface RetryPolicySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
}

/** pi's `settings.retry` with pi's own defaults (pi 1.0.4 SettingsManager.getRetrySettings). */
export function retryPolicy(settings: unknown): RetryPolicySettings {
  const raw = ((settings as { retry?: Record<string, unknown> } | undefined)?.retry ?? {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    enabled: raw.enabled !== false,
    maxRetries: num(raw.maxRetries, 3),
    baseDelayMs: num(raw.baseDelayMs, 2000),
    maxAgentDelayMs: num(raw.maxAgentDelayMs, 60_000),
  };
}

/**
 * The wait this extension adds before pi's own retry wait of `piDelayMs`.
 * `random` returns a value in [0, 1).
 */
export function extraRetryDelayMs(
  errorClass: RetryErrorClass,
  piDelayMs: number,
  config: BackoffConfig,
  random: () => number = Math.random,
  serverRetryAfterMs?: number,
): number {
  const floor = errorClass === "rate-limit" ? Math.max(piDelayMs, config.rateLimitDelayMs) : piDelayMs;
  // A server's hint only ever lengthens the wait, up to RETRY_AFTER_MAX_MS.
  const base = serverRetryAfterMs === undefined ? floor : Math.max(floor, Math.min(serverRetryAfterMs, RETRY_AFTER_MAX_MS));
  return Math.min(MAX_TIMER_MS, Math.max(0, base - piDelayMs) + Math.floor(random() * base * SERVER_JITTER_RATIO));
}

/**
 * A server's retry hint from an error response's headers, in ms: `retry-after-ms` (OpenAI), else
 * `retry-after` as whole seconds or an HTTP date (RFC 9110). A date in the past is 0. Anything else,
 * or no header, is undefined. Header names match case-insensitively.
 */
export function retryAfterMs(headers: Record<string, string>, now: number = Date.now()): number | undefined {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const ms = lower.get("retry-after-ms");
  if (ms !== undefined && /^\d+$/.test(ms)) return Number(ms);
  const value = lower.get("retry-after");
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[a-z]/i.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
