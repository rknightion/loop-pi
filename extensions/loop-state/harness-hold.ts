// pi-subagents 0.78.0 holds the parent after any aborted turn (`ctx.hasUI && ctx.signal.aborted` at
// agent_end) until the next agent_start. While held, a completion notice starts no turn and ends with
// HELD_COMPLETION_ACTION: "The user stopped the parent turn ... do not resume the stopped task unless
// asked". The package cannot tell an operator Esc from loop-pi's own request-ceiling or recovery abort,
// so after a harness abort the root would read a stop the owner never gave. loop-pi announces its
// aborts synchronously on the event bus first (`loop-recovery:request-timeout`, `loop-recovery:abort`);
// each opens a window that the next agent_start closes. Held notices timestamped inside a window are
// rewritten for the model only; the session keeps the package's text, and an operator Esc (no window)
// keeps it verbatim.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTIFY_CUSTOM_TYPE } from "./return-cap.ts";

/** pi-subagents 0.78.0 `HELD_COMPLETION_ACTION` (src/runs/background/notify.js), matched verbatim. */
export const HELD_COMPLETION_ACTION =
  "The user stopped the parent turn. Report these results at the user's next prompt and do not resume the stopped task unless asked.";
export const HARNESS_HELD_ACTION =
  "loop-pi stopped the parent turn automatically (request ceiling or recovery), not the owner. Follow the loop-pi incident or recovery notice in this session.";
export const HARNESS_HOLD_STATE = "loop-pi-harness-hold";
const ABORT_EVENTS = ["loop-recovery:request-timeout", "loop-recovery:abort"] as const;

type Window = { start: number; end?: number };
type HoldEntry = { start?: unknown; end?: unknown };

export function rewriteHeldNotices<M>(messages: readonly M[], windows: readonly Window[]): M[] | undefined {
  if (windows.length === 0) return undefined;
  let changed = false;
  const out = messages.map((message) => {
    const m = message as { role?: string; customType?: string; content?: unknown; timestamp?: unknown };
    if (m.role !== "custom" || m.customType !== NOTIFY_CUSTOM_TYPE || typeof m.timestamp !== "number") return message;
    const at = m.timestamp;
    if (!windows.some((w) => at >= w.start && (w.end === undefined || at <= w.end))) return message;
    const content = replaceText(m.content);
    if (content === undefined) return message;
    changed = true;
    return { ...m, content } as M;
  });
  return changed ? out : undefined;
}

function replaceText(content: unknown): unknown {
  if (typeof content === "string") return content.includes(HELD_COMPLETION_ACTION) ? content.replaceAll(HELD_COMPLETION_ACTION, HARNESS_HELD_ACTION) : undefined;
  if (!Array.isArray(content)) return undefined;
  let hit = false;
  const parts = content.map((part) => {
    const p = part as { type?: string; text?: unknown };
    if (p?.type !== "text" || typeof p.text !== "string" || !p.text.includes(HELD_COMPLETION_ACTION)) return part;
    hit = true;
    return { ...p, text: p.text.replaceAll(HELD_COMPLETION_ACTION, HARNESS_HELD_ACTION) };
  });
  return hit ? parts : undefined;
}

/** Tracks harness-abort windows in memory and in the session branch, so a resumed root keeps them. */
export function registerHarnessHold(pi: ExtensionAPI, now: () => number = Date.now) {
  let windows: Window[] = [];
  let open: Window | undefined;
  for (const name of ABORT_EVENTS) {
    pi.events.on(name, () => {
      if (open) return;
      open = { start: now() };
      windows.push(open);
      pi.appendEntry(HARNESS_HOLD_STATE, { start: open.start });
    });
  }
  pi.on("agent_start", () => {
    if (!open) return;
    open.end = now();
    pi.appendEntry(HARNESS_HOLD_STATE, { start: open.start, end: open.end });
    open = undefined;
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const byStart = new Map<number, Window>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== HARNESS_HOLD_STATE) continue;
      const d = entry.data as HoldEntry;
      if (typeof d?.start !== "number") continue;
      const w = byStart.get(d.start) ?? { start: d.start };
      if (typeof d.end === "number") w.end = d.end;
      byStart.set(d.start, w);
    }
    windows = [...byStart.values()];
    // A window still open at restart closed when that process ended: no later run of it can be held.
    open = undefined;
    for (const w of windows) w.end ??= now();
  });
  return { rewrite: <M>(messages: readonly M[]) => rewriteHeldNotices(messages, windows) };
}
