// Shared read-only settle controls. loop-wait uses the existing persisted continuation-state
// entry to count the report, so cancellation needs no new event bus or public seam.
import type { AgentActivityOutcome } from "./state.ts";
import type { FinalMarker } from "./report-status.ts";

export function continuationClockStopped(outcome: AgentActivityOutcome, reportCounted: boolean, marker: FinalMarker): boolean {
  return outcome !== "completed" || reportCounted || marker === "paused";
}

/** The text content of the last assistant message, or null when there is none. */
export function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block: unknown): block is { type: string; text: string } => {
          return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
        })
        .map((block) => block.text)
        .join("\n");
    }
    return null;
  }
  return null;
}
