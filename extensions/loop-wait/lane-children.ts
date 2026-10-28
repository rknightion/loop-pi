// Child results for a lane that launches its own children (a senior). pi-subagents gives a child
// runtime no completion notifier: its `agent_end` drain only waits for queued or running children
// and injects nothing, and loop-pi turns `bg_wait` off for every runtime. So a senior that ends its
// turn to wait for a scout settles without ever seeing the scout's result. This hook runs at the
// senior's settle boundary, after that drain has made every child terminal, and appends one message
// per finished child it has not delivered yet, then continues the run so the senior can use it.
// It reads each child's run record (`status.json`) only at that boundary; nothing polls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_RESULT_CUSTOM_TYPE = "loop-pi-child-result";
const MAX_RESULT_BYTES = 8 * 1024;
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

/** The child's last assistant text with no tool call: what pi-subagents reports as its output. */
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
  for (const [path, read] of [
    [status.sessionFile, (s: string) => finalAssistantText(s)],
    [status.outputFile, (s: string) => s.trim() || undefined],
  ] as const) {
    if (!path || output) continue;
    try {
      output = read(readFileSync(path, "utf8"));
      source = path;
    } catch {
      // Fall through to the next source; the message names what was found.
    }
  }
  const lines = [`${head} finished: ${status.state}.`];
  if (output) lines.push("", capTail(output), "", `Full output: ${source}`);
  else lines.push(`No final output was found${status.outputFile ? `; see ${status.outputFile}` : ""}.`);
  return lines.join("\n");
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

  pi.events.on("subagent:async-started", (data: any) => {
    if (typeof data?.id !== "string" || typeof data.asyncDir !== "string") return;
    // Only children this session launched; the event bus is per process, but stay explicit.
    if (data.sessionId !== undefined && data.sessionId !== sessionFile && data.sessionId !== sessionId) return;
    children.set(data.id, { id: data.id, agent: typeof data.agent === "string" ? data.agent : "child", asyncDir: data.asyncDir });
  });

  pi.on("agent_before_settle", (event) => {
    // An aborted or failed run is not ours to restart; its children are delivered at a later settle.
    if (event.outcome !== "completed") return undefined;
    const drafts: any[] = [];
    for (const run of children.values()) {
      if (delivered.has(run.id)) continue;
      const status = readChildStatus(run.asyncDir);
      if (!("error" in status) && !isFinished(status.state)) {
        // Only reached when the drain timed out with this child still live: ask the senior to end
        // its turn again so the next drain keeps waiting, a bounded number of times.
        const notices = stillRunning.get(run.id) ?? 0;
        if (notices >= MAX_STILL_RUNNING_NOTICES) continue;
        stillRunning.set(run.id, notices + 1);
        drafts.push({
          type: "custom_message",
          customType: CHILD_RESULT_CUSTOM_TYPE,
          content: `loop-pi: child run ${run.id} (${run.agent}) is still ${status.state}. End your turn to keep waiting; its result will arrive here.`,
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
        details: { runId: run.id, agent: run.agent, state: "error" in status ? "unknown" : status.state },
      });
    }
    if (drafts.length === 0) return undefined;
    // pi replaces the boundary entries with what a handler returns, so keep the ones already there.
    return { entries: [...event.entries, ...drafts], continue: true };
  });
}
