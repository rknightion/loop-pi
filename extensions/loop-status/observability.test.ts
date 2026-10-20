import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatChildren, formatInspection, readInspection } from "./observability.ts";

const dirs: string[] = [];
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

test("native status RPC projects child metadata, including old snapshots with missing fields", async () => {
  const { registerSubagentRpcBridge } = await import(new URL("../../node_modules/pi-subagents/src/extension/rpc.js", import.meta.url).href);
  const sessionId = "/fixture/root.jsonl";
  const handlers = new Map<string, any>();
  const events = { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name); }, emit: (name: string, value: any) => handlers.get(name)?.(value) };
  const state = { currentSessionId: sessionId, statusProjectionSessionId: sessionId, foregroundControls: new Map(), fleetJobs: new Map(),
    activeAsyncCapacity: { used: 1, limit: 19 }, asyncJobs: new Map([["child-job", { asyncId: "child-job", sessionId, status: "running", mode: "single", startedAt: 1, updatedAt: 2,
      steps: [{ agent: "worker", status: "running", model: "requested/model:medium", thinking: "medium" }] }]]) };
  registerSubagentRpcBridge({ events, state, getContext: () => ({ sessionManager: { getSessionFile: () => sessionId } }), execute: () => { throw new Error("unexpected executor"); } });
  let reply: any;
  events.on("subagents:rpc:v1:reply:proof", (value: any) => { reply = value; });
  await events.emit("subagents:rpc:v1:request", { version: 1, requestId: "proof", method: "status", params: {} });
  const before = JSON.stringify(reply.data);
  assert.match(formatChildren(reply.data.asyncSnapshot), /agent=worker · model=requested\/model · thinking=medium/);
  assert.equal(JSON.stringify(reply.data), before, "display must not mutate capacity or status");
  const legacy = structuredClone(reply.data.asyncSnapshot);
  for (const field of ["agent", "model", "thinking"]) delete legacy.runs[0].children[0][field];
  assert.match(formatChildren(legacy), /agent=unknown · model=unknown · thinking=unknown/);
  assert.match(formatChildren(undefined), /unavailable/);
  legacy.omitted.children = 1;
  assert.match(formatChildren(legacy), /partial/);
});

test("native inspection reply supplies only the child's own recorded model; no inference from history or requested route", async () => {
  const { buildInspectReply } = await import(new URL("../../node_modules/pi-subagents/src/runs/background/inspect-rpc.js", import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "loop-observe-")); dirs.push(root);
  const asyncDirRoot = join(root, "async"), resultsDir = join(root, "results"), runId = "observed-child";
  mkdirSync(join(asyncDirRoot, runId), { recursive: true }); mkdirSync(resultsDir);
  const sessionId = join(root, "root.jsonl"), childFile = join(root, "child.jsonl");
  // Inherited history is deliberately a different model and never evidence of this child's reply.
  writeFileSync(childFile, JSON.stringify({ type: "message", message: { role: "assistant", provider: "inherited", model: "parent", content: [{ type: "text", text: "private history" }] } }) + "\n");
  const state: any = { currentSessionId: sessionId, foregroundControls: new Map(), asyncJobs: new Map() };
  const write = (mode: string, steps: any[], context = "fresh") => writeFileSync(join(asyncDirRoot, runId, "status.json"), JSON.stringify({ runId, state: "complete", mode, context, sessionId, sessionRoot: root, sessionFile: childFile, steps }));
  const inspect = (childId?: string) => buildInspectReply({ requestId: "proof", asyncId: runId, childId }, { state, asyncDirRoot, resultsDir });
  const requested = { model: "requested/model", thinking: "medium", agent: "worker" };
  writeFileSync(join(asyncDirRoot, runId, "recovery-descriptor.json"), JSON.stringify({ version: 1, sourceRunId: runId, model: "original/model", thinking: "medium" }));
  write("single", [{ ...requested, launchModel: "requested/model", resolvedModel: { provider: "answer-provider", model: "answer-model" } }]);
  const view = () => readInspection(asyncDirRoot, state.currentSessionId, runId);
  assert.match(view(), /Requested model: requested\/model/);
  assert.match(view(), /Answering model: answer-provider\/answer-model/);
  const reply = inspect(); assert.equal(reply.error, undefined);
  assert.match(formatInspection(reply, requested), /Requested model: requested\/model/);
  assert.match(formatInspection(reply, requested), /Answering model: answer-provider\/answer-model/);
  assert.doesNotMatch(formatInspection(reply, requested), /private history/);
  for (const context of ["fresh", "fork"]) {
    write("single", [requested], context);
    assert.match(formatInspection(inspect(), requested), /Answering model: unknown/);
    assert.match(view(), /Answering model: unknown/);
    assert.match(view(), /Requested model: original\/model/);
  }
  for (const mode of ["chain", "workflow"]) {
    write(mode, [{ ...requested, resolvedModel: { provider: "one", model: "child" } }, { agent: "reviewer" }]);
    assert.match(formatInspection(inspect(), undefined), /Answering model: unknown/);
    assert.match(view(), /Answering model: unknown/);
    assert.match(readInspection(asyncDirRoot, sessionId, runId, "step:0"), /Answering model: one\/child/);
    assert.match(readInspection(asyncDirRoot, sessionId, runId, "step:1"), /Answering model: unknown/);
    assert.match(formatInspection(inspect("step:0"), requested), /Answering model: one\/child/);
  }
  state.currentSessionId = join(root, "foreign.jsonl");
  const before = (await import("node:fs")).readFileSync(join(asyncDirRoot, runId, "status.json"), "utf8");
  assert.match(view(), /unavailable/);
  assert.equal((await import("node:fs")).readFileSync(join(asyncDirRoot, runId, "status.json"), "utf8"), before);
  assert.match(formatInspection(inspect(), requested), /unavailable/);
});

 test("local traversal bounds are explicitly partial even with native omission counters at zero", () => {
  const snapshot = { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: Array.from({ length: 21 }, (_, i) => ({ id: `run-${i}`, kind: "subagent", state: "running" })) };
  assert.match(formatChildren(snapshot), /partial/);
});
