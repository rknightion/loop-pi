// Child results for a lane that launches its own children (a senior). pi-subagents gives a child
// runtime no completion notifier: its `agent_end` drain only waits for queued or running children
// and injects nothing, and loop-pi turns `bg_wait` off for every runtime. So a senior that ends its
// turn to wait for a scout settles without ever seeing the scout's result. This hook runs at the
// senior's settle boundary, after that drain has made every child terminal, and appends one message
// per finished child it has not delivered yet, then continues the run so the senior can use it.
// It reads each child's run record (`status.json`) only at that boundary; nothing polls.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_RESULT_CUSTOM_TYPE = "loop-pi-child-result";
const MAX_RESULT_BYTES = 8 * 1024;
// The boundary runs inside pi-subagents' one-second settle grace, so read only a session's tail.
const MAX_SESSION_TAIL_BYTES = 1024 * 1024;
const RETURN_REMINDER =
  "Your last message is this lane's return. If you launch another child or one is still running, " +
  "end your turn without a " +
  "lane-return block; its result will arrive here. Otherwise end with your complete final report, " +
  "including the lane-return block, even if you gave one before.";
const LIVE_STATES = new Set(["queued", "running"]);
// The child drain gives up after 30 minutes; each notice buys another drain. Eight cover a senior's
// four-hour timeout.
export const MAX_STILL_RUNNING_NOTICES = 8;

export interface ChildRun {
  id: string;
  agent: string;
  asyncDir: string;
}

export interface ChildStatus {
  state: string;
  sessionFile?: string;
  outputFile?: string;
}

/** The run record, or a reason it could not be read. Never throws. */
export function readChildStatus(asyncDir: string): ChildStatus | { error: string } {
  const path = join(asyncDir, "status.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data?.state !== "string") return { error: `${path} has no state` };
    return {
      state: data.state,
      ...(typeof data.sessionFile === "string" ? { sessionFile: data.sessionFile } : {}),
      ...(typeof data.outputFile === "string" ? { outputFile: data.outputFile } : {}),
    };
  } catch (error) {
    return { error: `${path} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function isFinished(state: string): boolean {
  return !LIVE_STATES.has(state);
}

/** The last `max` bytes of a file, from a whole line when `wholeLines` (JSONL). Throws like readFileSync. */
export function readTail(path: string, max = MAX_SESSION_TAIL_BYTES, wholeLines = true): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 || !wholeLines ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

/** The child's last assistant text with no tool call: what pi-subagents reports as its output.
 *  None when the child's last turn errored, so an earlier interim reply is not passed off as it. */
export function finalAssistantText(sessionJsonl: string): string | undefined {
  let last: string | undefined;
  for (const line of sessionJsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const message = row?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.stopReason === "error") {
      last = undefined;
      continue;
    }
    if (message.content.some((part: any) => part?.type === "toolCall")) continue;
    const text = message.content.map((part: any) => (part?.type === "text" ? part.text : "")).join("").trim();
    if (text) last = text;
  }
  return last;
}

/** Keep the tail: a lane-return block and the conclusion come last. */
export function capTail(text: string, max = MAX_RESULT_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  return `[... first ${bytes.length - max} bytes omitted]\n` + bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}

export function childResultText(run: ChildRun, status: ChildStatus | { error: string }): string {
  const head = `loop-pi: child run ${run.id} (${run.agent})`;
  if ("error" in status) return `${head} finished, but its result could not be read: ${status.error}`;
  let output: string | undefined;
  let source: string | undefined;
  for (const [path, read, wholeLines] of [
    [status.sessionFile, (s: string) => finalAssistantText(s), true],
    [status.outputFile, (s: string) => s.trim() || undefined, false],
  ] as const) {
    if (!path || output) continue;
    try {
      output = read(readTail(path, MAX_SESSION_TAIL_BYTES, wholeLines));
      source = path;
    } catch {
      // Fall through to the next source; the message names what was found.
    }
  }
  const lines = [`${head} finished: ${status.state}.`];
  if (output) lines.push("", capTail(output), "", `Full output: ${source}`);
  else lines.push(`No final output was found${status.outputFile ? `; see ${status.outputFile}` : ""}.`);
  lines.push("", RETURN_REMINDER);
  return lines.join("\n");
}

/** True when the lane's last assistant message already carries its lane-return block. */
export function alreadyReturned(messages: readonly any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part: any) => (part?.type === "text" ? part.text : "")).join("") : "";
    return /```lane-return\b/.test(text);
  }
  return false;
}

/** Run ids already delivered on this session's branch, so a resumed lane is not fed twice. */
export function deliveredIds(entries: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry?.type === "custom_message" && entry.customType === CHILD_RESULT_CUSTOM_TYPE && typeof entry.details?.runId === "string" &&
        entry.details.pending !== true) {
      ids.add(entry.details.runId);
    }
  }
  return ids;
}

export function registerChildResultDelivery(pi: ExtensionAPI): void {
  const children = new Map<string, ChildRun>();
  const delivered = new Set<string>();
  const stillRunning = new Map<string, number>();
  let sessionFile: string | undefined;
  let sessionId: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = ctx.sessionManager.getSessionId();
    for (const id of deliveredIds(ctx.sessionManager.getBranch())) delivered.add(id);
  });

  // The settle hook is registered with the first child, so lanes that launch none never run the
  // boundary (pi skips it when no handler is registered).
  let settleRegistered = false;
  pi.events.on("subagent:async-started", (data: any) => {
    if (typeof data?.id !== "string" || typeof data.asyncDir !== "string") return;
    // Only children this session launched; the event bus is per process, but stay explicit.
    if (data.sessionId !== undefined && data.sessionId !== sessionFile && data.sessionId !== sessionId) return;
    children.set(data.id, { id: data.id, agent: typeof data.agent === "string" ? data.agent : "child", asyncDir: data.asyncDir });
    if (!settleRegistered) {
      settleRegistered = true;
      pi.on("agent_before_settle", settle);
    }
  });

  function settle(event: { entries: any[]; outcome: string; context?: { contextMessages?: readonly any[] } }) {
    // An aborted or failed run is not ours to restart; its children are delivered at a later settle.
    if (event.outcome !== "completed") return undefined;
    // A lane that has already written its return keeps it: pi-subagents reports the last assistant
    // text, so continuing would replace the return. Record finished results without continuing.
    const returned = alreadyReturned(event.context?.contextMessages ?? []);
    const drafts: any[] = [];
    for (const run of children.values()) {
      if (delivered.has(run.id)) continue;
      const status = readChildStatus(run.asyncDir);
      if (!("error" in status) && !isFinished(status.state)) {
        if (returned) continue;
        // Only reached when the drain timed out with this child still live: ask the senior to end
        // its turn again so the next drain keeps waiting, a bounded number of times.
        const notices = (stillRunning.get(run.id) ?? 0) + 1;
        if (notices > MAX_STILL_RUNNING_NOTICES) continue;
        stillRunning.set(run.id, notices);
        const next = notices === MAX_STILL_RUNNING_NOTICES
          ? "This is the last such notice: end this turn with your final report with what you have, including the lane-return block. If the child finishes before this lane ends, its result is recorded in the session but not shown to you."
          : "End your turn to keep waiting; its result will arrive here.";
        drafts.push({
          type: "custom_message",
          customType: CHILD_RESULT_CUSTOM_TYPE,
          content: `loop-pi: child run ${run.id} (${run.agent}) is still ${status.state}. ${next}`,
          display: true,
          details: { runId: run.id, agent: run.agent, state: status.state, pending: true },
        });
        continue;
      }
      delivered.add(run.id);
      drafts.push({
        type: "custom_message",
        customType: CHILD_RESULT_CUSTOM_TYPE,
        content: childResultText(run, status),
        display: true,
        details: { runId: run.id, agent: run.agent, state: "error" in status ? "unknown" : status.state, ...(returned ? { afterReturn: true } : {}) },
      });
    }
    if (drafts.length === 0) return undefined;
    // pi replaces the boundary entries with what a handler returns, so keep the ones already there.
    const entries = [...event.entries, ...drafts];
    return returned ? { entries } : { entries, continue: true };
  }
}
