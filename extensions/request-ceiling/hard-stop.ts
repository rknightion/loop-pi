// Hard stops (SEAMS.md "Retry and hard stops"). pi's native retry repeats every failed request its
// classifier (pi-ai `isRetryableAssistantError`) deems transient: 429, 5xx, overloaded, network and
// stream cuts. A few failures can look transient yet need the owner: an authentication or
// permission refusal, a policy refusal (which can arrive with a 5xx status) and rejected encrypted
// reasoning. At `message_end` those are rewritten to a fixed text that pi's classifier rejects, with
// a bounded safe-token code, type and status for diagnosis. Quota stays pi's own refusal and a
// context overflow stays pi's compaction; nothing here authorises a retry pi would not make.
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";

export type HardStopCategory = "authentication" | "policy" | "encrypted-content";
export interface HardStop { category: HardStopCategory; code: string | null; type: string | null; status: number | null }
export const HARD_STOP_PREFIX = "loop-pi hard stop";

const safe = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
  && !["undefined", "null", "unknown"].includes(value) ? value : null;

/** Status, code and type from pi's provider error text ("<Provider> API error (<status>): <body>",
 *  "<status>: <body>", a Responses `response.failed` "<code>: <message>" or "Error Code <code>: ..."). */
export function providerError(text: string): { status: number | null; code: string | null; type: string | null } {
  const http = /^(?:[^\r\n]{1,128} API error \((\d{3})\)|(\d{3})): ([\s\S]*)$/.exec(text);
  if (http) {
    let body: any;
    try { body = JSON.parse(http[3]); } catch { body = undefined; }
    const error = body?.error ?? body;
    return { status: Number(http[1] ?? http[2]), code: safe(error?.code), type: safe(error?.type) };
  }
  const stream = /^(?:Error Code )?([A-Za-z0-9._-]{1,64}): /.exec(text);
  return { status: null, code: safe(stream?.[1]), type: null };
}

const POLICY = /\b(?:cyber_policy|content_policy\w*|policy_error)\b/;
const AUTH = /\b(?:invalid_api_key|permission_denied|insufficient_permissions|permission_error|authentication_error)\b|unauthori[sz]ed|forbidden|(?<![a-z0-9])40[13](?![a-z0-9])/i;
const ENCRYPTED = /\binvalid_encrypted_content\b/;

/** The hard stop a failed assistant message calls for, or undefined to leave it to pi. */
export function hardStopFor(message: { stopReason?: unknown; errorMessage?: unknown; loopPiHardStop?: unknown }): HardStop | undefined {
  if (message.stopReason !== "error") return undefined;
  const recorded = message.loopPiHardStop as HardStop | undefined;
  if (recorded && ["authentication", "policy", "encrypted-content"].includes(recorded.category)) return recorded;
  const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
  const { status, code, type } = providerError(text);
  const tokens = [code ?? "", type ?? "", text].join(" ");
  const found: [HardStopCategory, RegExp] | undefined = POLICY.test(tokens) ? ["policy", POLICY]
    : status === 401 || status === 403 || AUTH.test(tokens) ? ["authentication", AUTH]
    : ENCRYPTED.test(tokens) ? ["encrypted-content", ENCRYPTED] : undefined;
  if (!found) return undefined;
  // A refusal named only in the text keeps that name as its code.
  return { category: found[0], code: code ?? safe(found[1].exec(tokens)?.[0]), type,
    status: status !== null && status >= 100 && status <= 599 ? status : null };
}

/** The replacement text: pi's classifier must reject it and must not read it as a context overflow. */
export function hardStopText(stop: HardStop): string {
  const stopped = (text: string) => !isRetryableAssistantError({ stopReason: "error", errorMessage: text } as never)
    && !isContextOverflow({ stopReason: "error", errorMessage: text } as never, 0);
  const full = `${HARD_STOP_PREFIX} (${stop.category}${stop.code ? `: ${stop.code}` : ""}); not retried, the owner must act`;
  return stopped(full) ? full : `${HARD_STOP_PREFIX} (${stop.category}); not retried, the owner must act`;
}
