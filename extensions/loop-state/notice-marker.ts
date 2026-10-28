// Marks loop-pi's own automated messages in the model request (SEAMS.md "Automated notice marker").
// pi sends a custom message to the model as a plain user message, so a nudge, a wake or a recovery
// notice reads like text the owner typed. pi-subagents 0.83.0 wraps its notices the same way (in context_with_system). The
// marker depends only on the message, so history renders the same bytes every turn and cached
// prefixes stay valid. Only the model request changes: the stored message and the chat view do not.

/** Every custom message type loop-pi sends to the model. notice-marker.test.ts checks the sources. */
export const LOOP_PI_NOTICE_TYPES: ReadonlySet<string> = new Set([
  "loop-continuation", "loop-root-recovery", "loop-closeout-audit",
  "loop-wake", "loop-watch",
  "loop-recovery-required", "loop-recovery-exhausted", "loop-request-incident",
  "loop-state-digest", "loop-model-time-notice", "loop-child-observation",
  // Sent in a senior lane (loop-wait/lane-children.ts). Only the root runs this marker, so it is
  // marked when a root ever carries one; in the lane it stays plain, like lane timer notices.
  "loop-pi-child-result",
]);

const CLOSE = "</loop_pi_notice>";
const open = (type: string) => `<loop_pi_notice type="${type}" origin="automated message from the loop-pi harness, not typed by the user">`;

type Part = { type: string; text?: string };
type Message = { role?: string; customType?: string; content?: unknown };

/** The marked copy of one message, or the message itself when it is not a loop-pi notice. */
export function markNotice<M extends Message>(message: M): M {
  if (message.role !== "custom" || typeof message.customType !== "string" || !LOOP_PI_NOTICE_TYPES.has(message.customType)) return message;
  const head = open(message.customType);
  if (typeof message.content === "string") return { ...message, content: `${head}\n${message.content}\n${CLOSE}` };
  if (Array.isArray(message.content)) {
    return { ...message, content: [{ type: "text", text: `${head}\n` }, ...(message.content as Part[]), { type: "text", text: `\n${CLOSE}` }] };
  }
  return message;
}

/** The marked list, or undefined when no message needed a marker. */
export function markNotices<M extends Message>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const marked = messages.map((m) => {
    const next = markNotice(m);
    if (next !== m) changed = true;
    return next;
  });
  return changed ? marked : undefined;
}
