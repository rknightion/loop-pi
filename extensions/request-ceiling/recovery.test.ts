import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc } from "../loop-guard/rpc-test-helpers.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
after(cleanupAll);

async function runScenario(kind: "anchor" | "partial" | "budget" | "active-budget" | "protected" | "http" | "synthetic" | "ceiling" | "partial-ceiling") {
  const seen: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    if ((kind === "active-budget" && seen.length === 2) || kind === "ceiling") { req.on("close", () => res.end()); return; }
    if (kind === "http" && seen.length === 1) {
      res.writeHead(502, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:"previous_response_owner_unavailable",type:"server_error",message:"Previous response owner account is unavailable; retry later."}})); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } });
    if (kind === "partial" || kind === "partial-ceiling") {
      send({ type: "response.output_item.added", output_index: 0, item: { id: "msg_test", type: "message", role: "assistant", content: [] } });
      send({ type: "response.content_part.added", item_id: "msg_test", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "partial" });
    }
    if (kind === "partial-ceiling") { req.on("close", () => res.end()); return; }
    if ((["anchor", "active-budget", "protected"].includes(kind) && seen.length === 1) || kind === "partial" || ["budget", "synthetic"].includes(kind)) {
      send({ type: "response.failed", response: { id: "resp_test", status: "failed", error: { code: "stream_incomplete", type: "server_error", message: kind === "partial" ? "Upstream websocket closed before response.completed (close_code=1000)" : "The previous response anchor was rejected upstream; retry the request." } } });
    } else send({ type: "response.completed", response: { id: "resp_ok", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = freshDir("recovery-home-");
  const fixture = join(home, "provider.ts");
  writeFileSync(fixture, `export default function(pi) { ${kind === "budget" ? "Math.random = () => 0;" : ""} ${kind === "synthetic" ? 'let sent=false; pi.on("agent_settled", () => { if (!sent) { sent=true; pi.sendMessage({customType:"test-followup",content:"CONTINUE",display:false},{triggerTurn:true}); } });' : ""} ${kind === "protected" ? 'pi.on("before_provider_request", (e) => ({...e.payload, previous_response_id:"resp_bound"}));' : ""} pi.registerProvider("fixture", {baseUrl:"http://127.0.0.1:${address.port}/v1",apiKey:"test",api:"openai-responses",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]}); }`);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retry: { maxRetries: kind === "partial" ? 3 : 60, baseDelayMs: kind === "budget" ? 5000 : 200, maxAgentDelayMs: kind === "budget" ? 5000 : 200, provider: { maxRetries: 0 } }, loopPi: { retryRecovery: { episodeMs: kind === "budget" ? 1200 : kind === "synthetic" ? 120 : kind === "active-budget" ? 700 : ["ceiling", "partial-ceiling"].includes(kind) ? 1200 : 10000, providerIds: ["fixture"] }, requestCeiling: { wallClockMs: ["ceiling", "partial-ceiling"].includes(kind) ? 800 : 5000, maxFollowUps: ["ceiling", "partial-ceiling"].includes(kind) ? 2 : 0 } } }));
  const session = startPiRpc({ extensions: [fixture, ...(process.env.RECOVERY_BASELINE ? [] : [join(HERE, "index.ts")])], extraArgs: ["--provider", "fixture", "--model", "fixture"], agentDir: home, subagentTempRoot: freshDir(), cwd: freshDir(), fauxScriptPath: "" });
  try {
    session.send({ type: "prompt", id: "go", message: "GO" });
    await session.waitFor((e) => e.type === "agent_settled", 15000);
    if (kind === "ceiling") {
      await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted",10000);
    }
    if (kind === "synthetic") {
      await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length >= 2, 10000);
    }
    if (kind === "active-budget") {
      const settled = session.events.filter((e) => e.type === "agent_settled").length;
      session.send({ type: "prompt", id: "new", message: "NEW USER TURN" });
      await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length > settled, 10000);
    }
    return { seen, events: session.events };
  } finally { await session.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("real pi recovers a structured no-output anchor refusal with stable affinity and distinct attempts", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("anchor");
  assert.equal(seen.length, 2);
  assert.equal(typeof seen[0].headers.session_id, "string");
  assert.equal(seen[0].headers.session_id, seen[1].headers.session_id);
  assert.equal(typeof seen[0].headers["x-client-request-id"], "string");
  assert.equal(typeof seen[1].headers["x-client-request-id"], "string");
  assert.notEqual(seen[0].headers["x-client-request-id"], seen[1].headers["x-client-request-id"]);
  assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success === true));
});
test("real pi refuses replay after output", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("partial");
  assert.equal(seen.length, 1);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop"));
});
// Remove random extension backoff in this subprocess so expiry exercises pi's own retry wait.
// Allow request setup under parallel-suite load, then bound a much longer native retry wait.
test("real pi episode expires during built-in retry sleep", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("budget");
  assert.equal(seen.length, 1);
  assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success === false));
});

test("real pi bounds the active recovery request and a genuine new user turn can succeed", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("active-budget");
  assert.equal(seen.length, 3);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted"));
  const assistants = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((assistants.at(-1)?.message as any)?.stopReason, "stop");
});
test("real pi preserves explicitly anchored requests", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("protected");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.previous_response_id, "resp_bound");
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop"));
});
test("real pi also classifies HTTP owner errors with the same recovery metadata", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("http");
  assert.equal(seen.length, 2);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.status === 502), JSON.stringify(events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant")));
});

test("real pi synthetic followup cannot restart an exhausted episode", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("synthetic");
  assert.equal(seen.length, 1);
  assert.equal(events.filter((e) => e.type === "agent_settled").length, 2);
});

test("per-request timeout followups share the original failure episode", { timeout: 20000 }, async () => {
  const {seen,events}=await runScenario("ceiling");
  assert.equal(seen.length,2);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted"));
});
test("per-request timeout after partial output never triggers a synthetic recovery", { timeout: 20000 }, async () => {
  const {seen,events}=await runScenario("partial-ceiling");
  assert.equal(seen.length,1);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop"));
});
