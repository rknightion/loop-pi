// pi's native retry with the hard-stop list (SEAMS.md "Retry and hard stops"), end to end: a real pi
// process loads request-ceiling and talks to a local scripted Responses server through pi's own
// OpenAI client, Responses decoder, agent loop and retry machine. Only the network peer is scripted;
// the bash side effect in the replay test is real.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { cleanupAll, freshDir, startPiRpc, type RpcEvent } from "../loop-guard/rpc-test-helpers.ts";
import { type Step, startResponsesServer } from "../call-timing/test-support/responses-server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
after(cleanupAll);

const response = (id: string, status: string, output: unknown[] = []) => ({
  id, object: "response", created_at: 1, status, model: "fixture", output,
  usage: status === "completed" ? { input_tokens: 1, output_tokens: 1, total_tokens: 2 } : null,
});
const answer = (text: string): Step[] => {
  const item = { id: "msg_ok", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { frame: { type: "response.created", response: response("resp_ok", "in_progress") } },
    { frame: { type: "response.output_item.done", output_index: 0, item } },
    { frame: { type: "response.completed", response: response("resp_ok", "completed", [item]) } },
  ];
};
const httpError = (status: number, code: string, type: string, message = "fixture upstream body, never retained"): Step[] =>
  [{ http: status, body: { error: { code, type, message } } }];

interface Run { requests: number; bodies: any[]; events: RpcEvent[]; stderr: string[]; cwd: string }

/** One prompt against the scripted peer: `first` serves the first request(s), every later one gets `then`. */
async function retryCase(first: Step[][], then: Step[] = answer("RECOVERED")): Promise<Run> {
  const server = await startResponsesServer(first, then, { keepBodies: true });
  const home = freshDir("native-retry-home-");
  const cwd = freshDir("native-retry-work-");
  const provider = join(home, "provider.ts");
  writeFileSync(provider, `export default function (pi) {
  pi.registerProvider("fixture", { baseUrl: ${JSON.stringify(server.baseUrl)}, apiKey: "test", api: "openai-responses",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}`);
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 20, maxAgentDelayMs: 20, provider: { maxRetries: 0 } },
    compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 2000 },
    // retryRecovery is the retired recovery controller's settings key: a home that still carries it behaves the same.
    loopPi: { retryBackoff: { rateLimitDelayMs: 20 }, requestCeiling: { maxFollowUps: 0 }, retryRecovery: { providerIds: ["fixture"], episodeMs: 20_000 } },
  }));
  const session = startPiRpc({
    extensions: [provider, join(HERE, "index.ts")],
    extraArgs: ["--provider", "fixture", "--model", "fixture"],
    agentDir: home, subagentTempRoot: freshDir(), cwd, fauxScriptPath: "",
  });
  try {
    session.send({ type: "prompt", id: "go", message: "Run the scripted step." });
    await session.waitFor((e) => e.type === "agent_settled", 30_000);
    // Let a compaction or follow-up that settles later finish too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { requests: server.requests(), bodies: server.bodies() as any[], events: session.events, stderr: session.stderr, cwd };
  } finally {
    await session.close();
    await server.close();
  }
}

const assistants = (run: Run) => run.events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant").map((e) => e.message as any);
const lastText = (run: Run) => (assistants(run).at(-1)?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

test("a 503 with an unknown JSON code and type before any output retries and then succeeds", { timeout: 40_000 }, async () => {
  const run = await retryCase([httpError(503, "mystery_code", "mystery_type", "Service temporarily unavailable")]);
  assert.equal(run.requests, 2, run.stderr.join(""));
  assert.equal(assistants(run).at(-1)?.stopReason, "stop");
  assert.equal(lastText(run), "RECOVERED");
  assert.ok(!assistants(run).some((m) => m.loopPiHardStop), "a transient failure is never a hard stop");
});

// The hard-stop list and pi's own refusals. `requests` 1 means stopped with no retry.
for (const c of [
  { name: "401 invalid_api_key stops", steps: httpError(401, "invalid_api_key", "authentication_error"), requests: 1, hard: "authentication" },
  { name: "403 permission stops", steps: httpError(403, "permission_denied", "permission_error"), requests: 1, hard: "authentication" },
  { name: "cyber_policy at 503 stops", steps: httpError(503, "cyber_policy", "server_error"), requests: 1, hard: "policy" },
  { name: "content_policy_violation at 500 stops", steps: httpError(500, "content_policy_violation", "server_error"), requests: 1, hard: "policy" },
  { name: "invalid_encrypted_content at 400 stops", steps: httpError(400, "invalid_encrypted_content", "invalid_request_error"), requests: 1, hard: "encrypted-content" },
  { name: "insufficient_quota stops (pi's own refusal)", steps: httpError(429, "insufficient_quota", "insufficient_quota"), requests: 1, hard: null },
  { name: "subscription_sharing_usage_limit_exceeded stops (pi's own refusal)", steps: httpError(429, "subscription_sharing_usage_limit_exceeded", "usage_limit_reached"), requests: 1, hard: null },
  { name: "429 rate limit retries", steps: httpError(429, "rate_limit_exceeded", "requests"), requests: 2, hard: null },
  { name: "500 retries", steps: httpError(500, "server_error", "server_error"), requests: 2, hard: null },
  { name: "502 retries", steps: httpError(502, "bad_gateway", "server_error"), requests: 2, hard: null },
  { name: "503 overloaded retries", steps: httpError(503, "server_is_overloaded", "service_unavailable_error"), requests: 2, hard: null },
  { name: "504 retries", steps: httpError(504, "gateway_timeout", "server_error"), requests: 2, hard: null },
  { name: "a connection reset before the response retries", steps: [{ destroy: true } as Step], requests: 2, hard: null },
  { name: "a stream cut after the response started retries", steps: [{ frame: { type: "response.created", response: response("resp_cut", "in_progress") } }, { destroy: true } as Step], requests: 2, hard: null },
]) {
  test(`deny-list: ${c.name}`, { timeout: 40_000 }, async () => {
    const run = await retryCase([c.steps]);
    assert.equal(run.requests, c.requests, `${run.stderr.join("")} ${JSON.stringify(assistants(run).map((m) => m.errorMessage))}`);
    const final = assistants(run).at(-1);
    if (c.requests === 1) {
      assert.equal(final?.stopReason, "error");
      assert.equal(run.events.filter((e) => e.type === "auto_retry_start").length, 0, "pi scheduled no retry");
      assert.equal(final?.loopPiHardStop?.category ?? null, c.hard);
      if (c.hard) {
        assert.match(final.errorMessage, /^loop-pi hard stop/);
        assert.doesNotMatch(JSON.stringify(final), /fixture upstream body/, "a hard stop keeps no error body");
      }
    } else {
      assert.equal(final?.stopReason, "stop");
      assert.equal(lastText(run), "RECOVERED");
    }
  });
}

test("deny-list: context_length_exceeded goes to compaction, not to a retry or a hard stop", { timeout: 40_000 }, async () => {
  const run = await retryCase([httpError(400, "context_length_exceeded", "invalid_request_error", "Your input exceeds the context window of this model.")]);
  const failed = assistants(run)[0];
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.loopPiHardStop, undefined);
  assert.equal(run.events.filter((e) => e.type === "auto_retry_start").length, 0, "no plain retry of an overflow");
  assert.ok(run.events.some((e) => e.type === "compaction_start" && (e as any).reason === "overflow"), JSON.stringify(run.events.map((e) => e.type)));
});

test("a tool call in a failed stream never runs on replay", { timeout: 40_000 }, async () => {
  const call = { id: "fc_1", type: "function_call", call_id: "call_failed", name: "bash", arguments: JSON.stringify({ command: "printf ran > side-effect" }) };
  const run = await retryCase([[
    { frame: { type: "response.created", response: response("resp_1", "in_progress") } },
    { frame: { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } } },
    { frame: { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: call.arguments } },
    { frame: { type: "response.output_item.done", output_index: 0, item: call } },
    { frame: { type: "response.failed", response: { ...response("resp_1", "failed"), error: { code: "server_error", message: "The server had an error while processing your request." } } } },
  ]]);
  assert.equal(run.requests, 2, run.stderr.join(""));
  assert.equal(lastText(run), "RECOVERED");
  assert.equal(existsSync(join(run.cwd, "side-effect")), false, "the failed response's tool call never ran");
  assert.equal(run.events.filter((e) => e.type === "tool_execution_start").length, 0);
  const replay = JSON.stringify(run.bodies[1]?.input ?? []);
  assert.doesNotMatch(replay, /call_failed/, "the retry does not replay the failed attempt's tool call");
});
