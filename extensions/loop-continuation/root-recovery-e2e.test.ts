// Automatic root recovery end to end (SEAMS.md "Automatic root recovery"). A real pi root, armed by a
// v3 launch, runs against a scripted local Responses peer through pi's native Responses decoder,
// agent loop and retry machine, with the request ceiling, the retry recovery episode, loop-wait and
// loop-continuation loaded. Only the network peer is scripted; the bash side effect is real.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, freshDir, startPiRpc, type RpcEvent } from "../loop-guard/rpc-test-helpers.ts";
import { cleanupFixtures, loopFixture } from "./test-fixture.ts";

after(cleanupAll);
after(cleanupFixtures);

const HERE = new URL(".", import.meta.url).pathname;
const CONTINUATION = join(HERE, "index.ts");
const CEILING = join(HERE, "..", "request-ceiling", "index.ts");
const LOOP_WAIT = join(HERE, "..", "loop-wait", "root.ts");
const BASE_MS = 400;
const MAX_MS = 800;

type Step =
  | { kind: "tool"; command: string }
  | { kind: "fail" }
  | { kind: "text"; text: string }
  | { kind: "hang" }
  | { kind: "http"; status: number; code: string; type: string };

interface Captured { body: any; at: number }

async function rootCase(steps: (n: number) => Step, opts: { recoverPlainTransport?: boolean; ownerFollowUp?: boolean; plainProviderError?: string; abortAfterMs?: number; until: (events: RpcEvent[], requests: Captured[]) => boolean; settleMs?: number }) {
  const f = loopFixture();
  const requests: Captured[] = [];
  const open: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ body: JSON.parse(raw), at: Date.now() });
    const n = requests.length;
    const step = steps(n);
    if (step.kind === "http") {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: step.code, type: step.type, message: opts.plainProviderError ?? "fixture upstream body, never retained" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } });
    if (step.kind === "hang") {
      open.push(res);
      return;
    }
    if (opts.plainProviderError && (n === 1 || !opts.recoverPlainTransport)) {
      send({ type: "error", message: opts.plainProviderError });
      res.end();
      return;
    }
    if (step.kind === "fail") {
      send({ type: "response.failed", response: { id: `resp_${n}`, status: "failed", error: { code: "stream_incomplete", type: "server_error", message: "Upstream websocket closed before response.completed" } } });
      res.end();
      return;
    }
    const item = step.kind === "tool"
      ? { id: `fc_${n}`, type: "function_call", call_id: `call_${n}`, name: "bash", arguments: JSON.stringify({ command: step.command }) }
      : { id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "output_text", text: step.text, annotations: [] }] };
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const provider = join(freshDir("root-recovery-provider-"), "provider.ts");
  writeFileSync(provider, `export default function (pi) {
  pi.registerProvider("fixture", { baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "test", api: "openai-responses",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}`);
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 20, maxAgentDelayMs: 20, provider: { maxRetries: 0 } },
    loopPi: {
      retryRecovery: { providerIds: ["fixture"], episodeMs: 20_000, maxAttempts: 2 },
      requestCeiling: { inactivityMs: 700, absoluteMs: 30_000, maxFollowUps: 0 },
      rootRecovery: { baseDelayMs: BASE_MS, maxDelayMs: MAX_MS },
    },
  }));
  const session = startPiRpc({
    extensions: [provider, CEILING, LOOP_WAIT, CONTINUATION],
    extraArgs: ["--provider", "fixture", "--model", "fixture"],
    agentDir: f.agentDir, subagentTempRoot: freshDir(), cwd: f.repo, fauxScriptPath: "",
    env: { LOOP_PI_RUN_DIR: f.runDir },
  });
  try {
    session.send({ type: "prompt", id: "launch", message: f.launch });
    if (opts.abortAfterMs !== undefined) {
      await session.waitFor((e) => e.type === "agent_start", 10_000);
      await new Promise((resolve) => setTimeout(resolve, opts.abortAfterMs));
      session.send({ type: "abort", id: "operator-abort" });
    }
    await session.waitFor((e) => e.type === "agent_settled" && opts.until(session.events, requests), 30_000);
    // Long enough for any further automatic resume to have fired (three backoffs at the cap).
    if (opts.settleMs) await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
    const requestsBeforeOwner = requests.length;
    if (opts.ownerFollowUp) {
      session.send({ type: "prompt", id: "fresh-owner-input", message: "Continue the same authorised scratch task after checking quota." });
      await session.waitFor((event) => event.type === "agent_settled" && requests.length >= requestsBeforeOwner + 3, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 3 * MAX_MS + 500));
    }
    session.send({ type: "get_entries", id: "quota-budget-entries" });
    const entriesReply = await session.waitFor((event) => event.type === "response" && event.id === "quota-budget-entries", 10_000);
    assert.equal(entriesReply.success, true);
    const quotaEntries = ((entriesReply.data as any)?.entries ?? []).filter((entry: any) => entry.customType === "loop-root-quota-recovery");
    const log = existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const incidentDir = join(f.agentDir, "incidents", "root");
    const incidents = existsSync(incidentDir)
      ? readdirSync(incidentDir).map((name) => ({ name, body: JSON.parse(readFileSync(join(incidentDir, name), "utf8")) }))
      : [];
    const executions = existsSync(join(f.repo, "executions.log")) ? readFileSync(join(f.repo, "executions.log"), "utf8") : "";
    return { requests, requestsBeforeOwner, quotaEntries, events: session.events, log, incidents, executions, stderr: session.stderr };
  } finally {
    for (const res of open) res.destroy();
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const resumes = (events: RpcEvent[]) =>
  events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-root-recovery").map((e) => e.message as any);
const judgements = (log: any[]) => log.filter((row) => row.ev === "judgement");
const lastAssistantText = (events: RpcEvent[]) => {
  const message = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant").at(-1)?.message as any;
  return (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
};

test("provider errors that exhaust the recovery budget resume the root with exponential backoff until it recovers", { timeout: 45_000 }, async () => {
  // 1: a real side-effecting tool call. 2-7: three exhausted episodes of two failed attempts each.
  // 8: success. The root resumes after 400 ms, then 800 ms, then 800 ms (the cap), and never relaunches.
  const run = await rootCase(
    (n) => n === 1 ? { kind: "tool", command: "printf 'prior\\n' >> executions.log" } : n <= 7 ? { kind: "fail" } : { kind: "text", text: "PAUSED: recovered after the outage" },
    { until: (_events, requests) => requests.length >= 8 },
  );
  assert.equal(run.requests.length, 8, run.stderr.join(""));
  assert.equal(lastAssistantText(run.events), "PAUSED: recovered after the outage");
  assert.equal(run.executions, "prior\n", "the completed tool ran exactly once; nothing from a failed request ran");
  const sent = resumes(run.events);
  assert.deepEqual(sent.map((m) => [m.details.attempt, m.details.cause, m.details.delayMs]), [
    [1, "provider-error", BASE_MS], [2, "provider-error", MAX_MS], [3, "provider-error", MAX_MS],
  ]);
  assert.match(sent[0].details.detail, /attempt-limit/);
  assert.doesNotMatch(JSON.stringify(sent), /fixture upstream body/, "notices never retain an upstream body");
  // Each episode's first request waits for its backoff after the previous episode's last failure.
  const gap = (i: number) => run.requests[i].at - run.requests[i - 1].at;
  assert.ok(gap(3) >= BASE_MS, `first resume waited ${gap(3)} ms`);
  assert.ok(gap(5) >= MAX_MS, `second resume waited ${gap(5)} ms`);
  assert.ok(gap(7) >= MAX_MS && gap(7) < 2 * MAX_MS, `third resume is capped: ${gap(7)} ms`);
  assert.ok(gap(4) < BASE_MS && gap(6) < BASE_MS, "within an episode pi's own short retry runs, not the root backoff");
  // Completed history survives every resume; failed attempts are not replayed.
  const replay = run.requests[7].body.input;
  assert.equal(replay.filter((i: any) => i.type === "function_call_output" && i.call_id === "call_1").length, 1);
  assert.match(JSON.stringify(replay), /Automatic recovery 3/);
  // Every resume is recorded in the state log, by the extension, next to the open it appended.
  assert.equal(run.log.filter((row) => row.ev === "open" && row.by === "ext").length, 1);
  assert.deepEqual(judgements(run.log).map((row) => [row.by, row.text.replace(/\(.*\)/, "()")]), [
    ["ext", "loop-pi auto-resume 1: provider-error () after 0.4 s backoff"],
    ["ext", "loop-pi auto-resume 2: provider-error () after 0.8 s backoff"],
    ["ext", "loop-pi auto-resume 3: provider-error () after 0.8 s backoff"],
  ]);
  assert.equal(run.incidents.filter((i) => i.body.class === "loop-root-recovery-stopped").length, 0);
});

for (const c of [
  { name: "authentication", status: 401, code: "invalid_api_key", type: "authentication_error" },
    { name: "policy", status: 400, code: "cyber_policy", type: "invalid_request_error" },
] as const) {
  test(`a ${c.name} refusal stops the root with an incident and is never resumed`, { timeout: 30_000 }, async () => {
    const run = await rootCase(() => ({ kind: "http", status: c.status, code: c.code, type: c.type }), {
      until: (_events, requests) => requests.length >= 1, settleMs: 3 * MAX_MS + 500,
    });
    assert.equal(run.requests.length, 1, "no automatic resume and no replay");
    assert.equal(resumes(run.events).length, 0);
    const stopped = run.incidents.filter((i) => i.body.class === "loop-root-recovery-stopped");
    assert.equal(stopped.length, 1, JSON.stringify(run.incidents));
    assert.match(stopped[0].name, /-recovery-stopped\.json$/);
    assert.equal(stopped[0].body.cause, c.name);
    assert.doesNotMatch(JSON.stringify(stopped[0].body), /fixture upstream body/);
    assert.deepEqual(judgements(run.log).map((row) => row.text.split(" (")[0]), [`loop-pi recovery stopped: ${c.name}`]);
  });
}

test("a stalled request aborted by the request ceiling resumes the root after the backoff", { timeout: 30_000 }, async () => {
  const run = await rootCase((n) => n === 1 ? { kind: "hang" } : { kind: "text", text: "PAUSED: recovered after the stall" }, {
    until: (_events, requests) => requests.length >= 2,
  });
  assert.equal(run.requests.length, 2, run.stderr.join(""));
  assert.equal(lastAssistantText(run.events), "PAUSED: recovered after the stall");
  const sent = resumes(run.events);
  assert.deepEqual(sent.map((m) => [m.details.attempt, m.details.cause]), [[1, "stalled-request"]]);
  // The ceiling's clock starts at turn start, a little before the peer sees the request.
  assert.ok(run.requests[1].at - run.requests[0].at >= 700 + BASE_MS - 100, "the inactivity ceiling, then the backoff");
  assert.deepEqual(judgements(run.log).map((row) => row.text.split(" (")[0]), ["loop-pi auto-resume 1: stalled-request"]);
});

test("an operator abort is never resumed automatically", { timeout: 30_000 }, async () => {
  const run = await rootCase(() => ({ kind: "hang" }), {
    abortAfterMs: 200, until: (_events, requests) => requests.length >= 1, settleMs: 3 * MAX_MS + 500,
  });
  assert.equal(run.requests.length, 1);
  assert.equal(resumes(run.events).length, 0);
  assert.equal(judgements(run.log).length, 0);
  assert.equal(run.incidents.filter((i) => i.body.class === "loop-root-recovery-stopped").length, 0);
});

for (const [cause, errorMessage] of [
  ["authentication", "invalid_api_key"],
  ["authentication", "401 Unauthorized"],
  ["policy", "cyber_policy"],
  ["quota", "You have hit your usage limit for this period"],
  ["quota", "You exceeded your current quota"],
] as const) {
  test(`plain stream refusal ${errorMessage} stops without another root turn`, { timeout: 30_000 }, async () => {
    const run = await rootCase(() => ({ kind: "text", text: "PAUSED: unexpected request" }), {
      plainProviderError: errorMessage,
      until: (events, requests) => requests.length >= (cause === "quota" ? 3 : 1) && events.some((event) => event.type === "message_end" && (event.message as any)?.stopReason === "error"),
      settleMs: 3 * MAX_MS + 500,
    });
    assert.equal(run.requests.length, cause === "quota" ? 3 : 1, "quota permits only two additional attempts");
    assert.equal(resumes(run.events).length, cause === "quota" ? 2 : 0, "quota recovery is bounded and auth/policy never resume");
    const stopped = run.incidents.filter((incident) => incident.body.class === "loop-root-recovery-stopped");
    assert.equal(stopped.length, 1, JSON.stringify(run.incidents));
    assert.equal(stopped[0].body.cause, cause);
  });
}

test("a plain connection refusal still permits automatic root recovery", { timeout: 30_000 }, async () => {
  const run = await rootCase(() => ({ kind: "text", text: "PAUSED: transport recovered" }), {
    plainProviderError: "Connection refused", recoverPlainTransport: true,
    until: (_events, requests) => requests.length >= 2,
  });
  assert.equal(run.requests.length, 2);
  assert.equal(resumes(run.events).length, 1);
  assert.equal(lastAssistantText(run.events), "PAUSED: transport recovered");
  assert.equal(run.incidents.filter((incident) => incident.body.class === "loop-root-recovery-stopped").length, 0);
});

test("structured quota failures retry twice and then stop without an endless recovery loop", { timeout: 30_000 }, async () => {
  const run = await rootCase(() => ({ kind: "http", status: 429, code: "insufficient_quota", type: "rate_limit_error" }), {
    until: (_events, requests) => requests.length >= 3, settleMs: 3 * MAX_MS + 500,
  });
  assert.equal(run.requests.length, 3);
  assert.deepEqual(resumes(run.events).map((m) => [m.details.cause, m.details.delayMs]), [["quota", BASE_MS], ["quota", MAX_MS]]);
  const stopped = run.incidents.filter((i) => i.body.class === "loop-root-recovery-stopped");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].body.cause, "quota");
  assert.deepEqual(run.quotaEntries.map((entry: any) => entry.data.attempts), [1, 2]);
});

test("only fresh owner input grants another pair of quota retries", { timeout: 30_000 }, async () => {
  const run = await rootCase(() => ({ kind: "http", status: 429, code: "insufficient_quota", type: "rate_limit_error" }), {
    until: (_events, requests) => requests.length >= 3, settleMs: 3 * MAX_MS + 500, ownerFollowUp: true,
  });
  assert.equal(run.requestsBeforeOwner, 3);
  assert.equal(run.requests.length, 6);
  assert.deepEqual(run.quotaEntries.map((entry: any) => entry.data.attempts), [1, 2, 0, 1, 2]);
  assert.equal(resumes(run.events).length, 4);
  assert.equal(run.incidents.filter((i) => i.body.cause === "quota").length, 2);
});
