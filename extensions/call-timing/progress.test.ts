// Request progress seam (SEAMS.md "Request progress seam"). Real pi processes stream from a local
// scripted Responses server through pi's own OpenAI client and normalization. All content is
// synthetic; each test asserts no synthetic content reaches a checkpoint or the persisted metadata.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cleanupAll, freshDir, PI_SUBAGENTS_PACKAGE_DIR, type PiRpcSession, ROOT_EXTENSION, startPiRpc, waitForCondition,
} from "../loop-guard/rpc-test-helpers.ts";
import { type Step, startResponsesServer } from "./test-support/responses-server.ts";
import install from "./index.ts";
import { checkpointPath, newProgress, observeProviderEvent, removeOrphanTemps } from "./progress.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PROVIDER = join(HERE, "test-support", "responses-provider.ts");
after(cleanupAll);

// Synthetic markers: none may appear in any progress record.
const PROMPT = "SYNTHETIC-PROMPT-MARKER exercise the progress stream";
const OPAQUE = `SYNTHETIC-OPAQUE-MARKER-${"q".repeat(48)}`;
const SUMMARY = "SYNTHETIC-SUMMARY-MARKER";
const TEXT = "SYNTHETIC-TEXT-MARKER";
const ARGS = "SYNTHETIC-ARGS-MARKER";
const FORBIDDEN = [PROMPT, "SYNTHETIC", OPAQUE, SUMMARY, TEXT, ARGS, "fixture-placeholder", "authorization", "encrypted"];

function assertContentFree(serialized: string) {
  for (const marker of FORBIDDEN) assert.ok(!serialized.includes(marker), `progress metadata must not contain ${marker}`);
}

/** Builds one Responses SSE script with real event shapes and synthetic content. */
function script() {
  let sequence = 0;
  let index = 0;
  const output: Record<string, unknown>[] = [];
  const steps: Step[] = [];
  const frame = (type: string, body: Record<string, unknown> = {}, mark?: string) =>
    steps.push({ frame: { type, sequence_number: sequence++, ...body }, mark });
  const response = (status: string) => ({
    id: "resp_fixture", object: "response", created_at: 1, status, model: "fixture", output: status === "completed" ? output : [],
    usage: status === "completed"
      ? { input_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 5 }
      : null,
  });
  const api = {
    steps,
    start() { frame("response.created", { response: response("in_progress") }); frame("response.in_progress", { response: response("in_progress") }); return api; },
    reasoning(summary?: string, mark?: string) {
      const i = index++;
      const id = `rs_${i}`;
      frame("response.output_item.added", { output_index: i, item: { id, type: "reasoning", summary: [] } });
      if (summary) {
        frame("response.reasoning_summary_part.added", { item_id: id, output_index: i, summary_index: 0, part: { type: "summary_text", text: "" } });
        frame("response.reasoning_summary_text.delta", { item_id: id, output_index: i, summary_index: 0, delta: summary });
        frame("response.reasoning_summary_text.done", { item_id: id, output_index: i, summary_index: 0, text: summary });
        frame("response.reasoning_summary_part.done", { item_id: id, output_index: i, summary_index: 0, part: { type: "summary_text", text: summary } });
      }
      const item = { id, type: "reasoning", summary: summary ? [{ type: "summary_text", text: summary }] : [], encrypted_content: OPAQUE };
      output.push(item);
      frame("response.output_item.done", { output_index: i, item }, mark);
      return api;
    },
    text(deltas: string[]) {
      const i = index++;
      const id = `msg_${i}`;
      frame("response.output_item.added", { output_index: i, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } });
      frame("response.content_part.added", { item_id: id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      for (const delta of deltas) frame("response.output_text.delta", { item_id: id, output_index: i, content_index: 0, delta, logprobs: [] });
      const text = deltas.join("");
      frame("response.output_text.done", { item_id: id, output_index: i, content_index: 0, text, logprobs: [] });
      const item = { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      output.push(item);
      frame("response.output_item.done", { output_index: i, item });
      return api;
    },
    toolCall(deltas: string[]) {
      const i = index++;
      const id = `fc_${i}`;
      const base = { id, type: "function_call", call_id: `call_${i}`, name: "read" };
      frame("response.output_item.added", { output_index: i, item: { ...base, arguments: "", status: "in_progress" } });
      for (const delta of deltas) frame("response.function_call_arguments.delta", { item_id: id, output_index: i, delta });
      const args = deltas.join("");
      frame("response.function_call_arguments.done", { item_id: id, output_index: i, arguments: args });
      const item = { ...base, arguments: args, status: "completed" };
      output.push(item);
      frame("response.output_item.done", { output_index: i, item });
      return api;
    },
    keepalive(mark?: string) { frame("keepalive", {}, mark); return api; },
    comment() { steps.push({ comment: "ping" }); return api; },
    sleep(ms: number) { steps.push({ sleepMs: ms }); return api; },
    hang() { steps.push({ hang: true }); return api; },
    complete() { frame("response.completed", { response: response("completed") }); return api; },
  };
  return api;
}

const FALLBACK = script().start().text(["done"]).complete().steps;

async function launch(scripts: Step[][]) {
  const server = await startResponsesServer(scripts, FALLBACK);
  const home = freshDir("call-progress-home-");
  const cwd = freshDir("call-progress-cwd-");
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never", loopPi: { progress: { checkpointIntervalMs: 250 } },
  }));
  const session = startPiRpc({
    extensions: [PROVIDER, ENTRY], fauxScriptPath: join(home, "unused.json"), agentDir: home,
    subagentTempRoot: join(home, "tmp"), cwd, sessionArgs: [],
    extraArgs: ["--provider", "progress-fixture", "--model", "fixture"],
    env: { LOOP_PI_PROGRESS_BASE_URL: server.baseUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
  });
  session.send({ id: "progress", type: "prompt", message: PROMPT });
  return { server, home, session };
}

function checkpointFile(home: string): string | undefined {
  const dir = join(home, "progress");
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length <= 1, `one session, one checkpoint: ${files.join(",")}`);
  return files[0] && join(dir, files[0]);
}

function readCheckpoint(home: string): any | undefined {
  const path = checkpointFile(home);
  if (!path) return undefined;
  const raw = readFileSync(path, "utf8");
  assertContentFree(raw);
  return JSON.parse(raw);
}

function waitForCheckpoint(home: string, ready: (c: any) => boolean, timeoutMs = 20_000) {
  return waitForCondition(() => {
    const c = readCheckpoint(home);
    return c && ready(c) ? c : undefined;
  }, timeoutMs, 50);
}

function assistants(home: string): any[] {
  const found: any[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(child, "utf8").split("\n").filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.type === "message" && record.message?.role === "assistant") found.push(record.message);
        }
      }
    }
  };
  if (existsSync(join(home, "sessions"))) walk(join(home, "sessions"));
  return found;
}

async function settle(session: PiRpcSession, server: { close(): Promise<void> }) {
  await session.waitFor((e) => e.type === "agent_settled");
  await session.close();
  await server.close();
}

/** The final record on the first assistant message, checked against the final checkpoint. */
function finalRecord(home: string) {
  const message = assistants(home)[0];
  assert.ok(message?.loopPiProgress, "assistant message must carry loopPiProgress");
  assertContentFree(JSON.stringify(message.loopPiProgress));
  return message;
}

test("encrypted-only reasoning counts completed items, keeps TTFT null and is readable mid-request", async () => {
  const s = script().start().reasoning(undefined, "r0").keepalive().reasoning(undefined, "r1").sleep(1_000)
    .reasoning(undefined, "r2").complete();
  const { server, home, session } = await launch([s.steps]);
  try {
    // A periodic checkpoint during the pause shows two completed items while the request runs.
    const live = await waitForCheckpoint(home, (c) => c.reasoning.completed === 2);
    assert.equal(live.state, "active");
    assert.equal(live.endedAt, null);
    assert.equal(live.text.deltas, 0);
    assert.ok(live.writtenAt >= live.lastModelEventAt);
    await settle(session, server);
    const message = finalRecord(home);
    const p = message.loopPiProgress;
    assert.equal(message.loopPiTiming.firstTokenAt, null, "encrypted reasoning is still not a first token");
    assert.deepEqual([p.reasoning.started, p.reasoning.completed, p.reasoning.deltas], [3, 3, 0]);
    assert.deepEqual([p.text.started, p.text.deltas, p.toolCalls.started], [0, 0, 0]);
    assert.equal(p.modelEvents, 6);
    assert.ok(p.firstModelEventAt >= p.startedAt && p.firstModelEventAt <= p.lastModelEventAt);
    assert.ok(p.lastModelEventAt >= server.marks.r2, "the last reasoning item moves the last model event");
    assert.equal(p.keepalives, 1);
    assert.equal(p.state, "ended");
    assert.equal(p.stopReason, message.stopReason);
    assert.equal(p.providerResponses, 1);
    assert.equal(p.providerRequestId, "fixture-request-1");
    assert.deepEqual(readCheckpoint(home), p, "the final checkpoint is the persisted record");
  } finally {
    await session.close();
    await server.close();
  }
});

test("visible reasoning, text and tool-call deltas are counted without their content", async () => {
  const first = script().start().reasoning(SUMMARY).text([`${TEXT} one`, " two"]).toolCall([`{"path":"`, `${ARGS}.txt"}`]).complete();
  const { server, home, session } = await launch([first.steps]);
  try {
    await settle(session, server);
    const message = finalRecord(home);
    const p = message.loopPiProgress;
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual([p.reasoning.started, p.reasoning.deltas, p.reasoning.completed], [1, 2, 1], "summary delta and part separator");
    assert.deepEqual([p.text.started, p.text.deltas, p.text.completed], [1, 2, 1]);
    assert.deepEqual([p.toolCalls.started, p.toolCalls.deltas, p.toolCalls.completed], [1, 2, 1]);
    assert.ok(p.text.firstAt <= p.text.lastAt && p.toolCalls.firstAt >= p.text.lastAt);
    const ttft = message.loopPiTiming.firstTokenAt;
    assert.ok(ttft >= p.firstModelEventAt && ttft <= p.text.firstAt, "TTFT stays the first nonempty delta");
    assert.equal(p.lastModelEventAt, p.toolCalls.lastAt);
    // Each turn is its own request record with its own id and ordinal.
    const second = assistants(home)[1]?.loopPiProgress;
    assert.equal(second?.turn, 2);
    assert.notEqual(second.request, p.request);
    assert.equal(second.session, p.session);
  } finally {
    await session.close();
    await server.close();
  }
});

test("keepalives are counted as transport and never advance model progress", async () => {
  const s = script().start().reasoning(undefined, "r0");
  for (let i = 0; i < 4; i++) s.sleep(60).keepalive(`k${i}`).comment();
  s.complete();
  const { server, home, session } = await launch([s.steps]);
  try {
    await settle(session, server);
    const p = finalRecord(home).loopPiProgress;
    assert.equal(p.keepalives, 4, "SSE comments are invisible; only keepalive events count");
    assert.equal(p.modelEvents, 2);
    // Same clock, order only: the last model event is the reasoning item's end, before every keepalive.
    assert.equal(p.lastModelEventAt, p.reasoning.lastAt, "keepalives after the last item leave it unchanged");
    assert.ok(p.lastModelEventAt < p.lastKeepaliveAt);
    assert.equal(p.providerEvents, 2 + 2 + 4 + 1, "created, in_progress, item added/done, keepalives, completed");
    assert.ok(p.lastProviderEventAt >= p.lastKeepaliveAt);
  } finally {
    await session.close();
    await server.close();
  }
});

test("a silent stream stays unknown, keeps refreshing freshness, and records cancellation", async () => {
  const { server, home, session } = await launch([script().hang().steps]);
  try {
    const firstSeen = await waitForCheckpoint(home, (c) => c.providerResponses === 1);
    const later = await waitForCheckpoint(home, (c) => c.writtenAt >= firstSeen.writtenAt + 400);
    assert.equal(later.state, "active");
    assert.ok(later.ageMs > firstSeen.ageMs, "request age grows with each periodic write");
    for (const field of ["firstModelEventAt", "lastModelEventAt", "providerEvents", "keepalives", "lastKeepaliveAt", "lastProviderEventAt"]) {
      assert.equal(later[field], null, `${field} is unknown, not zero, before any observation`);
    }
    assert.equal(later.modelEvents, 0);
    session.send({ id: "abort", type: "abort" });
    await settle(session, server);
    const p = finalRecord(home).loopPiProgress;
    assert.equal(p.stopReason, "aborted");
    assert.equal(p.state, "ended");
    assert.equal(p.firstModelEventAt, null);
  } finally {
    await session.close();
    await server.close();
  }
});

test("cancellation mid-reasoning keeps the observed progress", async () => {
  const s = script().start().reasoning(undefined, "r0").reasoning(undefined, "r1").hang();
  const { server, home, session } = await launch([s.steps]);
  try {
    await waitForCheckpoint(home, (c) => c.reasoning.completed === 2);
    session.send({ id: "abort", type: "abort" });
    await settle(session, server);
    const message = finalRecord(home);
    const p = message.loopPiProgress;
    assert.equal(message.stopReason, "aborted");
    assert.deepEqual([p.state, p.stopReason, p.reasoning.completed], ["ended", "aborted", 2]);
    assert.ok(p.endedAt >= p.lastModelEventAt);
    assert.deepEqual(readCheckpoint(home), p);
  } finally {
    await session.close();
    await server.close();
  }
});

test("process interruption leaves the last bounded checkpoint with its writer pid", async () => {
  const s = script().start().reasoning(undefined, "r0").keepalive().hang();
  const { server, home, session } = await launch([s.steps]);
  try {
    const live = await waitForCheckpoint(home, (c) => c.reasoning.completed === 1 && c.keepalives === 1);
    const pid = session.child.pid;
    session.child.kill("SIGKILL");
    await new Promise((resolve) => session.child.once("exit", resolve));
    const killedAt = Date.now();
    const left = readCheckpoint(home);
    assert.equal(left.state, "active", "no final write is possible after SIGKILL");
    assert.equal(left.pid, pid);
    assert.equal(left.reasoning.completed, 1);
    assert.ok(left.writtenAt >= live.writtenAt && left.writtenAt <= killedAt);
    assert.equal(typeof left.session, "string");
    assert.equal(typeof left.request, "string");
    assert.throws(() => process.kill(pid!, 0), "writer is gone; staleness is the reader's signal");
  } finally {
    await session.close();
    await server.close();
  }
});

test("checkpoint cadence is bounded by the interval, not by event volume", async (t) => {
  const home = freshDir("call-progress-cadence-");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ loopPi: { progress: { checkpointIntervalMs: 1_000 } } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  install({ on: (event: string, handler: (event: any, ctx?: any) => any) => { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => "cadence-session" }, model: { provider: "p", id: "m", api: "openai-responses" } };
  const emit = (type: string, event: object = {}) => handlers.get(type)?.(event, ctx);
  const path = join(home, "progress", "cadence-session.json");
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 1 };
  mkdirSync(join(home, "progress"));
  const orphan = join(home, "progress", `cadence-session.json.${randomUUID()}.tmp`);
  const unrelated = join(home, "progress", "other-session.json.0000.tmp");
  writeFileSync(orphan, "");
  writeFileSync(unrelated, "");
  emit("session_start");
  emit("turn_start");
  assert.ok(!existsSync(orphan), "a killed writer's temp file for this session is removed");
  assert.ok(existsSync(unrelated), "another session's temp file is left alone");
  assert.deepEqual(readdirSync(join(home, "progress")).filter((n) => n.startsWith("cadence-session")), ["cadence-session.json"]);
  assert.equal(read().writtenAt, 1_000_000, "request start is written");
  t.mock.timers.tick(10);
  for (let i = 0; i < 5_000; i++) emit("message_update", { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  assert.deepEqual([read().writtenAt, read().modelEvents], [1_000_010, 1], "only the first model event writes");
  t.mock.timers.tick(989);
  assert.equal(read().modelEvents, 1, "no write before the interval");
  t.mock.timers.tick(1);
  assert.deepEqual([read().writtenAt, read().modelEvents], [1_001_000, 5_000]);
  emit("provider_stream_event", { data: { type: "keepalive" } });
  const ended = emit("message_end", { message: assistant }).message.loopPiProgress;
  assert.deepEqual(read(), ended);
  t.mock.timers.tick(5_000);
  assert.deepEqual(read(), ended, "no write after the request ends");
});

test("a child launched by the root writes its own progress checkpoint in the shared home", async () => {
  const home = freshDir("call-progress-child-");
  const cwd = freshDir("call-progress-child-cwd-");
  const timingScript = join(home, "script.json");
  writeFileSync(timingScript, JSON.stringify({ responses: [{ "x-request-id": "child-request" }], trace: join(home, "trace.json") }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never", packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  const timingProvider = join(HERE, "test-support", "provider.ts");
  const spawnResult = join(home, "spawn.json");
  mkdirSync(join(home, "agents"));
  writeFileSync(join(home, "agents", "lane-worker.md"), [
    "---", "name: lane-worker", "description: Progress child fixture", "extensions: []",
    `subagentOnlyExtensions: ${timingProvider}`, "tools: read", "model: timing-fixture/fixture", "---", "Exercise progress.",
  ].join("\n"));
  const session = startPiRpc({
    extensions: [timingProvider, join(HERE, "test-support", "spawn.ts"), ROOT_EXTENSION], fauxScriptPath: timingScript,
    agentDir: home, subagentTempRoot: join(home, "tmp"), cwd, sessionArgs: [],
    extraArgs: ["--provider", "timing-fixture", "--model", "fixture"],
    env: { LOOP_PI_TIMING_SCRIPT: timingScript, LOOP_PI_TIMING_SPAWN_RESULT: spawnResult },
  });
  try {
    session.send({ id: "spawn", type: "prompt", message: "SPAWN_TIMING" });
    const child = await waitForCondition(() => assistants(home).find((m) => m.loopPiProgress), 30_000);
    const p = child.loopPiProgress;
    assertContentFree(JSON.stringify(p));
    assert.equal(p.providerRequestId, "child-request");
    assert.deepEqual([p.text.deltas, p.state, p.turn], [2, "ended", 1]);
    const path = join(home, "progress", `${p.session}.json`);
    const written = await waitForCondition(() => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined));
    assert.deepEqual(written, p, "the child's checkpoint is keyed by the child session");
    assert.notEqual(p.pid, session.child.pid, "written by the child process, not the root");
    // Wait for the exact child runner to close before teardown, so no late write races cleanup.
    const reply = await waitForCondition(() => (existsSync(spawnResult) ? JSON.parse(readFileSync(spawnResult, "utf8")) : undefined), 30_000);
    const launched = reply.data.details;
    const runId = launched.runId ?? launched.asyncId;
    const terminalPath = join(launched.asyncDir, "process-terminal.json");
    const terminal = await waitForCondition(() => {
      if (!existsSync(terminalPath)) return undefined;
      const record = JSON.parse(readFileSync(terminalPath, "utf8"));
      return record.runId === runId && record.state === "observed" ? record : undefined;
    }, 30_000);
    const runner = terminal.instances.find((instance: any) => instance.kind === "runner");
    assert.equal(runner?.processInstanceId, reply.runnerProcessInstanceId);
    assert.ok(Number.isFinite(runner.closeObservedAt), "child runner closed before parent teardown");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), p, "no checkpoint write after the child ended");
  } finally {
    await session.close();
  }
});

test("orphan cleanup matches only this session's UUID or legacy PID temp suffix", () => {
  const home = freshDir("call-progress-orphans-");
  const path = checkpointPath(home, "s");
  const neighbour = checkpointPath(home, "s.json.other");
  assert.ok(path && neighbour, "both prefixed session identifiers are accepted");
  mkdirSync(dirname(path));
  const ownUuid = `${path}.${randomUUID()}.tmp`;
  const ownPid = `${path}.12345.tmp`;
  const neighbourTemp = `${neighbour}.${randomUUID()}.tmp`;
  const untouched = [
    neighbourTemp,
    `${neighbour}.12345.tmp`,
    `${path}.not-a-uuid.tmp`,
    `${path}.12345-extra.tmp`,
    `${path}.0.tmp`,
    `${path}.${randomUUID()}.extra.tmp`,
    `${path}.${randomUUID()}.tmp\n`,
  ];
  writeFileSync(path, "own checkpoint");
  writeFileSync(neighbour, "neighbour checkpoint");
  for (const temp of [ownUuid, ownPid, ...untouched]) writeFileSync(temp, "temp");
  removeOrphanTemps(path);
  assert.ok(existsSync(neighbourTemp), "a prefixed neighbouring session's UUID temp must remain intact");
  for (const temp of untouched) assert.equal(readFileSync(temp, "utf8"), "temp", "nonmatching temps remain untouched");
  assert.ok(!existsSync(ownUuid), "this session's ordinary UUID orphan is removed");
  assert.ok(!existsSync(ownPid), "this session's exact legacy positive PID orphan is removed");
  assert.equal(readFileSync(path, "utf8"), "own checkpoint");
  assert.equal(readFileSync(neighbour, "utf8"), "neighbour checkpoint");
});

test("inherited API names leave unobservable keepalives null", async (t) => {
  for (const api of ["constructor", "toString", "__proto__"]) {
    await t.test(api, () => {
      const p = newProgress({ session: null, request: "fixture", turn: 1, provider: null, model: null, api }, 1);
      for (const type of ["response.created", "keepalive", "ping"]) observeProviderEvent(p, { type }, 2);
      assert.deepEqual([p.providerEvents, p.lastProviderEventAt], [3, 2], "raw transport remains observable");
      assert.deepEqual([p.keepalives, p.lastKeepaliveAt], [null, null], "unsupported keepalives are unknown, not zero");
      assert.deepEqual([p.modelEvents, p.firstModelEventAt, p.lastModelEventAt], [0, null, null]);
    });
  }
});

test("keepalives stay unknown for an API whose keepalives cannot be recognised", () => {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  install({ on: (event: string, handler: (event: any, ctx?: any) => any) => { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  const emit = (type: string, event: object, ctx: object) => handlers.get(type)?.(event, ctx);
  const assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 1 };
  const run = (api: string) => {
    const ctx = { model: { provider: "p", id: "m", api } };
    emit("turn_start", {}, ctx);
    for (const type of ["response.created", "keepalive", "ping"]) emit("provider_stream_event", { data: { type } }, ctx);
    return emit("message_end", { message: assistant }, ctx).message.loopPiProgress;
  };
  const completions = run("openai-completions");
  assert.deepEqual([completions.providerEvents, completions.keepalives, completions.lastKeepaliveAt], [3, null, null]);
  const responses = run("openai-responses");
  assert.deepEqual([responses.providerEvents, responses.keepalives], [3, 1], "only the family's own keepalive type counts");
  const anthropic = run("anthropic-messages");
  assert.deepEqual([anthropic.providerEvents, anthropic.keepalives], [3, 1]);
});
