// Metadata-only views of the pinned native async snapshot and inspection reply.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
function text(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  // These fields are display metadata, never terminal control sequences or multiline output.
  return value.slice(0, 320).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 160) || "unknown";
}

function snapshotNodes(snapshot: unknown): { nodes: RecordValue[]; truncated: boolean } {
  const s = record(snapshot);
  if (s.kind !== "pi-subagents.async-status-snapshot" || s.version !== 1 || !Array.isArray(s.runs)) return { nodes: [], truncated: false };
  const nodes: RecordValue[] = [];
  let truncated = false;
  const visit = (items: unknown[], depth: number, runId?: string) => {
    if (items.length > 20 || (depth > 3 && items.length > 0)) truncated = true;
    for (const value of items.slice(0, 20)) {
      if (nodes.length >= 180 || depth > 3) { truncated = true; break; }
      const node = record(value);
      nodes.push({ ...node, runId: runId ?? node.id });
      if (Array.isArray(node.children)) visit(node.children, depth + 1, runId ?? node.id);
    }
  };
  visit(s.runs, 0);
  return { nodes, truncated };
}

export function formatChildren(snapshot: unknown): string {
  const s = record(snapshot);
  if (s.kind !== "pi-subagents.async-status-snapshot" || s.version !== 1 || !Array.isArray(s.runs)) return "Child status unavailable (native snapshot unknown).";
  const { nodes, truncated } = snapshotNodes(s);
  const omitted = record(s.omitted);
  const partial = truncated || omitted.runs !== 0 || omitted.children !== 0 || omitted.byteLimitExceeded !== false;
  return [
    `Native child status${partial ? " (partial; omitted metadata is unknown)" : ""}. Model is native status metadata, not proof of the answering provider.`,
    ...nodes.map(node => `${text(node.runId)}/${text(node.id)} [${text(node.state)}] · agent=${text(node.agent)} · model=${text(node.model)} · thinking=${text(node.thinking)}`),
    ...(nodes.length ? [] : ["No displayed async children."]),
  ].join("\n");
}

export function formatInspection(reply: unknown, requested: unknown): string {
  const r = record(reply), route = record(requested), actual = record(r.resolvedModel);
  if (r.kind !== "pi-subagents.inspect-reply" || r.version !== 1 || r.error) return "Child inspection unavailable (native reply failed or unsupported).";
  const identity = typeof actual.provider === "string" && typeof actual.model === "string" && actual.provider.trim() && actual.model.trim()
    ? `${text(actual.provider)}/${text(actual.model)}` : "unknown";
  return [
    `Run: ${text(r.asyncId)}${r.childId ? ` / ${text(r.childId)}` : ""}`,
    `Requested model: ${text(route.model)} (recorded launch route)`,
    `Thinking: ${text(route.thinking)} · Agent: ${text(route.agent)}`,
    `Answering model: ${identity} (latest own reply recorded by Pi)`,
  ].join("\n");
}

/** Read only bounded canonical metadata. Never reconcile or open a transcript/output artifact. */
function readRecord(file: string): RecordValue {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    const bytes = Buffer.alloc(stat.size);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return record(JSON.parse(bytes.subarray(0, count).toString("utf8")));
  } finally { closeSync(fd); }
}

export function readInspection(runsDir: string, sessionId: string, id: string, childId?: string,
  owns: (current: string, owner: unknown) => boolean = (current, owner) => current === owner): string {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) return "Child inspection unavailable (use an exact async run ID).";
    const status = readRecord(join(runsDir, id, "status.json"));
    if (status.runId !== id || !owns(sessionId, status.sessionId)) return "Child inspection unavailable (run is not owned by this session).";
    const steps = Array.isArray(status.steps) ? status.steps : [];
    const matches = childId ? steps.filter((s: any, i: number) => [s.workflowKey, s.runId, `step:${i}`].includes(childId))
      : status.mode === "single" && steps.length === 1 ? steps : [];
    const step = matches.length === 1 ? record(matches[0]) : {};
    let descriptor: RecordValue = {};
    // A single-run descriptor records the original selected route, even after step.model changes.
    if (status.mode === "single" && steps.length === 1 && matches.length === 1) {
      try { descriptor = readRecord(join(runsDir, id, "recovery-descriptor.json")); } catch { /* old run */ }
      if (descriptor.version !== 1 || descriptor.sourceRunId !== id) descriptor = {};
    }
    const requested = { model: step.launchModel ?? descriptor.model, thinking: descriptor.thinking ?? step.thinking, agent: step.agent };
    return formatInspection({ kind: "pi-subagents.inspect-reply", version: 1, asyncId: id, childId,
      resolvedModel: step.resolvedModel }, requested);
  } catch { return "Child inspection unavailable (native metadata unreadable)."; }
}

function nativeStatus(pi: ExtensionAPI): Promise<unknown> {
  return new Promise(resolve => {
    const requestId = randomUUID();
    let unsubscribe: (() => void) | undefined;
    const finish = (value?: unknown) => { clearTimeout(timer); unsubscribe?.(); resolve(value); };
    const timer = setTimeout(() => finish(), 3000);
    unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, raw => {
      const reply = record(raw);
      if (reply.version === 1 && reply.requestId === requestId) finish(reply.success === true ? record(reply.data).asyncSnapshot : undefined);
    });
    try { pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} }); }
    catch { finish(); }
  });
}

export function installObservability(pi: ExtensionAPI): void {
  const show = (content: string) => pi.sendMessage({ customType: "loop-child-observation", content, display: true }, { triggerTurn: false });
  pi.registerCommand("loop-children", {
    description: "Show native async child agent/model/thinking metadata without a model turn",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionFile();
      const snapshot = await nativeStatus(pi);
      show(ctx.sessionManager.getSessionFile() === sessionId ? formatChildren(snapshot) : "Child status unavailable (session changed).");
    },
  });
  pi.registerCommand("loop-inspect", {
    description: "Show requested and answering model: /loop-inspect <asyncId> [childId]",
    handler: async (args, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 1 || parts.length > 2 || !parts.every(p => /^[A-Za-z0-9_:.\-]{1,256}$/.test(p))) {
        show("Usage: /loop-inspect <asyncId> [childId]"); return;
      }
      const sessionId = ctx.sessionManager.getSessionFile();
      if (!sessionId) { show("Child inspection unavailable (no persisted current session)."); return; }
      try {
        const { DIRS } = await import(new URL("../../node_modules/pi-subagents/src/shared/types.js", import.meta.url).href);
        const { ownsRun } = await import(new URL("../../node_modules/pi-subagents/src/runs/shared/run-ownership.js", import.meta.url).href);
        const content = readInspection(DIRS.async, sessionId, parts[0], parts[1], ownsRun);
        // A session switch during dynamic import must not display another session's observation.
        if (ctx.sessionManager.getSessionFile() !== sessionId) { show("Child inspection unavailable (session changed)."); return; }
        show(content);
      } catch { show("Child inspection unavailable (native artifacts unreadable)."); }
    },
  });
}
