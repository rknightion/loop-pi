// Pure logic for the per-request ceiling (SEAMS.md "Request ceiling"). No pi runtime imports, so
// this module is unit-testable without a live session.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Custom message type of the follow-up that tells a session its last model request failed. */
export const INCIDENT_CUSTOM_TYPE = "loop-request-incident";

/** Below the 15-minute mark at which the watchdog reads a silent turn as stalled. */
export const DEFAULT_WALL_CLOCK_MS = 14 * 60 * 1000;
/** Follow-up turns allowed in a row before the session is left to stop. */
export const DEFAULT_MAX_FOLLOW_UPS = 2;
/** Node fires a longer setTimeout delay after 1 ms, which would abort every request at once. */
const MAX_TIMER_MS = 2_147_483_647;

export type IncidentKind = "wall-clock" | "empty-length";

export const INCIDENT_CLASS: Record<IncidentKind, string> = {
  "wall-clock": "loop-request-wall-clock-ceiling",
  "empty-length": "loop-request-empty-length-stop",
};

/**
 * Error text for an empty length stop rewritten as an error. It must match neither pi's retryable
 * provider-error patterns nor its context-overflow patterns, so pi neither retries the identical
 * request nor compacts for it: no digits, and none of "timeout", "terminated", "token limit".
 */
export const EMPTY_LENGTH_ERROR =
  "loop-pi request ceiling: the model reached its output budget (max_output_tokens) with no text and no tool call";

export interface CeilingConfig {
  wallClockMs: number;
  maxFollowUps: number;
}

/** `loopPi.requestCeiling: {wallClockMs, maxFollowUps}` from a home's settings, else the defaults. */
export function ceilingConfig(settings: unknown): CeilingConfig {
  const loopPi = (settings as { loopPi?: Record<string, any> } | undefined)?.loopPi ?? {};
  const raw = (loopPi.requestCeiling ?? {}) as Record<string, unknown>;
  const wall = raw.wallClockMs;
  const follow = raw.maxFollowUps;
  return {
    wallClockMs:
      typeof wall === "number" && Number.isFinite(wall) && wall > 0 && wall <= MAX_TIMER_MS ? wall : DEFAULT_WALL_CLOCK_MS,
    maxFollowUps:
      typeof follow === "number" && Number.isInteger(follow) && follow >= 0 ? follow : DEFAULT_MAX_FOLLOW_UPS,
  };
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/** A length stop that produced no visible text and no tool call: the whole budget went to reasoning. */
export function isEmptyLengthStop(message: { role?: unknown; stopReason?: unknown; content?: unknown }): boolean {
  if (message.role !== "assistant" || message.stopReason !== "length") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return true;
  return !content.some((block: ContentBlock) => {
    if (block?.type === "toolCall") return true;
    return block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "";
  });
}

export interface Incident {
  kind: IncidentKind;
  model: string;
  elapsedMs: number;
  wallClockMs: number;
}

/** The follow-up message body. `attempt` counts follow-ups in the current unbroken chain. */
export function incidentText(incident: Incident, attempt: number, maxFollowUps: number, continuing: boolean): string {
  const seconds = Math.round(incident.elapsedMs / 1000);
  const what =
    incident.kind === "wall-clock"
      ? [
          "## Model request incident: wall-clock ceiling",
          "",
          `Your last model request (${incident.model}) ran for ${seconds} s without finishing and was aborted at the ` +
            `loop-pi request ceiling of ${Math.round(incident.wallClockMs / 1000)} s. Its partial output was discarded: ` +
            "no tool call from it ran.",
        ]
      : [
          "## Model request incident: empty output-budget stop",
          "",
          `Your last model request (${incident.model}) spent its whole output budget (max_output_tokens) on ` +
            "reasoning after " +
            `${seconds} s and returned no text and no tool call. Nothing from it ran.`,
        ];
  const next = continuing
    ? [
        "",
        `This is follow-up ${attempt} of at most ${maxFollowUps} in a row. Continue the run from where you were: ` +
          "take a smaller next step with less deliberation (one tool call, or split the decision). If the same step " +
          "keeps failing this way, record it as an incident in your run notes and report, then move on to work that " +
          "does not depend on it.",
      ]
    : [
        "",
        `The limit of ${maxFollowUps} follow-ups in a row is reached, so this session is not prompted again. ` +
          "When you next run, record this as an incident in your run notes and report before anything else.",
      ];
  return [...what, ...next].join("\n");
}

/**
 * Record a request incident beside the continuation incidents, in a subdirectory the watchdog's
 * continuation-incident reader does not scan. Bookkeeping must never trap the session.
 */
export function writeRequestIncident(
  agentDir: string,
  sessionId: string,
  cwd: string,
  incident: Incident,
  attempt: number,
  exhausted: boolean,
): void {
  try {
    const dir = join(agentDir, "incidents", "request");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const payload = {
      v: 1,
      session: sessionId || "unknown",
      class: INCIDENT_CLASS[incident.kind] + (exhausted ? "-exhausted" : ""),
      at,
      home: agentDir,
      cwd,
      model: incident.model,
      elapsed_ms: incident.elapsedMs,
      wall_clock_ms: incident.wallClockMs,
      attempt,
    };
    const name = `${sessionId || "unknown"}-${at.replace(/[:.]/g, "-")}-${incident.kind}-${attempt}${exhausted ? "-exhausted" : ""}.json`;
    writeFileSync(join(dir, name), JSON.stringify(payload));
  } catch {
    // Incident bookkeeping must never trap the session.
  }
}
