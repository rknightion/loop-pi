// Pure logic for the retry backoff (SEAMS.md "Retry backoff"). No pi runtime imports, so this
// module is unit-testable without a live session.
//
// pi's own agent-level retry waits `retryDelayMs(settings.retry, attempt)`: baseDelayMs * 2^(n-1),
// capped at maxAgentDelayMs, with no jitter and no split by status. The extension cannot replace
// that wait, so it adds an extra wait before pi's: the total is pi's delay plus the extra.
//   - 429 (rate limit): the total is a flat `rateLimitDelayMs` (default 60 s), whatever the attempt.
//   - 5xx (server error): pi's delay plus a random extra of up to SERVER_JITTER_RATIO of it, so
//     lanes that failed together do not retry together.
//   - Anything else pi retries (network, timeout, stream drop): no extra; pi's delay unchanged.

/** Default total wait before retrying a rate-limited (429) request. */
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
/** The 5xx extra is drawn from [0, ratio * pi's delay). */
export const SERVER_JITTER_RATIO = 0.5;
/** Node fires a longer setTimeout delay after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export type RetryErrorClass = "rate-limit" | "server" | "other";

// A provider error reads "<Provider> API error (<status>): <body>" or "<status>: <body>" (pi-ai
// formatProviderError); mid-stream failures carry only text. A 429 is checked first.
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i;
const SERVER_PATTERN = /\b5\d\d\b|overloaded|service.?unavailable|server.?error|internal.?error|bad.?gateway/i;

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

/** pi's `settings.retry` with pi's own defaults (pi 1.0.2 SettingsManager.getRetrySettings). */
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
): number {
  if (errorClass === "rate-limit") return Math.max(0, config.rateLimitDelayMs - piDelayMs);
  if (errorClass === "server") return Math.floor(random() * piDelayMs * SERVER_JITTER_RATIO);
  return 0;
}
