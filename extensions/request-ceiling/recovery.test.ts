import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc } from "../loop-guard/rpc-test-helpers.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
after(cleanupAll);

async function runScenario(kind: "anchor" | "partial" | "budget" | "active-budget" | "protected" | "http" | "synthetic" | "ceiling" | "partial-ceiling" | "tool" | "close" | "hosted" | "hosted-output" | "wakes", withWake = false) {
  const cwd = freshDir("recovery-work-");
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
    if (kind === "tool" && seen.length <= 3) {
      const label = seen.length === 1 ? "prior" : seen.length === 2 ? "failed" : "retry";
      const item = { id: `fc_${label}`, type: "function_call", call_id: `call_${label}`, name: "bash", arguments: JSON.stringify({ command: `printf '${label}\\n' >> executions.log` }) };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
      send({ type: "response.output_item.done", output_index: 0, item });
      if (seen.length !== 2) {
        send({ type: "response.completed", response: { id: `resp_${label}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end(); return;
      }
    }
    if ((kind === "partial" && seen.length === 1) || kind === "partial-ceiling") {
      send({ type: "response.output_item.added", output_index: 0, item: { id: "msg_test", type: "message", role: "assistant", content: [] } });
      send({ type: "response.content_part.added", item_id: "msg_test", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "partial" });
    }
    if (kind === "partial-ceiling") { req.on("close", () => res.end()); return; }
    if ((["anchor", "active-budget", "protected", "partial", "close", "hosted", "hosted-output", "wakes"].includes(kind) && seen.length === 1) || (kind === "tool" && seen.length === 2) || ["budget", "synthetic"].includes(kind)) {
      send({ type: "response.failed", response: { id: "resp_test", status: "failed", ...(kind === "hosted-output" ? {output:[{id:"search_test",type:"web_search_call",status:"completed"}]} : {}), error: { code: "stream_incomplete", type: "server_error", message: ["partial", "tool", "close"].includes(kind) ? "Upstream websocket closed before response.completed (close_code=1000)" : "The previous response anchor was rejected upstream; retry the request." } } });
    } else send({ type: "response.completed", response: { id: "resp_ok", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = freshDir("recovery-home-");
  const fixture = join(home, "provider.ts");
  writeFileSync(fixture, `import { createParentWake } from ${JSON.stringify(join(HERE, "..", "..", "node_modules", "pi-subagents", "src", "shared", "parent-wake.js"))};
export default function(pi) {
  ${kind === "tool" ? `const wake = createParentWake(pi); pi.on("session_start", (_e,ctx) => wake.bindSession(ctx)); pi.on("agent_start", () => wake.agentStarted()); pi.on("provider_stream_event", (e) => { if(e.data?.type === "response.failed") wake.sendMessage({customType:"subagent-parent-wake",content:"busy child finished",display:true},{triggerTurn:true}); });` : ""}
  ${kind === "wakes" ? `let clock = 0; const wake = createParentWake(pi, () => clock); pi.on("session_start", (_e,ctx) => wake.bindSession(ctx)); pi.on("agent_start", () => wake.agentStarted()); pi.registerCommand("wake-notices", {description:"Deliver test notices", handler:async () => { for(let i=0;i<3;i++) { clock += 11000; wake.sendMessage({customType:"subagent-parent-wake",content:"child notice " + i,display:true},{triggerTurn:true}); await new Promise(resolve => setTimeout(resolve,100)); } pi.sendMessage({customType:"wake-test-done",content:"done",display:false},{triggerTurn:false}); }});` : ""}
  ${kind === "budget" ? "Math.random = () => 0;" : ""}
  ${withWake ? 'let armed = false; pi.on("turn_start", () => { if (!armed) { armed = true; pi.events.emit("loop-wait:arm-timer", { at: new Date(Date.now() + 300).toISOString(), reason: "episode-fired-wake", reply() {} }); } });' : ""}
  ${kind === "synthetic" ? 'let sent=false; pi.on("agent_settled", () => { if (!sent) { sent=true; pi.sendMessage({customType:"test-followup",content:"CONTINUE",display:false},{triggerTurn:true}); } });' : ""}
  ${["protected", "wakes"].includes(kind) ? 'pi.on("before_provider_request", (e) => ({...e.payload, previous_response_id:"resp_bound"}));' : ""}
  ${kind === "hosted" ? 'pi.on("before_provider_request", (e) => ({...e.payload, tools:[{type:"web_search_preview"}]}));' : ""}
  pi.registerProvider("fixture", {baseUrl:"http://127.0.0.1:${address.port}/v1",apiKey:"test",api:"openai-responses",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]});
}`);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retry: { maxRetries: kind === "partial" ? 3 : 60, baseDelayMs: kind === "budget" ? 5000 : 200, maxAgentDelayMs: kind === "budget" ? 5000 : 200, provider: { maxRetries: 0 } }, loopPi: { retryRecovery: { episodeMs: kind === "budget" ? 1200 : kind === "synthetic" ? 120 : kind === "active-budget" ? 700 : ["ceiling", "partial-ceiling"].includes(kind) ? 1200 : 10000, providerIds: ["fixture"] }, requestCeiling: { wallClockMs: ["ceiling", "partial-ceiling"].includes(kind) ? 800 : 5000, maxFollowUps: ["ceiling", "partial-ceiling"].includes(kind) ? 2 : 0 } } }));
  const session = startPiRpc({ extensions: [fixture, ...(withWake ? [join(HERE, "..", "loop-wait", "root.ts")] : []), ...(process.env.RECOVERY_BASELINE ? [] : [join(HERE, "index.ts")])], extraArgs: ["--provider", "fixture", "--model", "fixture"], agentDir: home, subagentTempRoot: freshDir(), cwd, fauxScriptPath: "" });
  try {
    session.send({ type: "prompt", id: "go", message: "GO" });
    await session.waitFor((e) => e.type === "agent_settled", 15000);
    if (withWake) {
      await session.waitFor((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake", 5000);
    }
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
    if (kind === "wakes") {
      session.send({ type: "prompt", id: "notices", message: "/wake-notices" });
      await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "wake-test-done", 5000);
      const errorsBeforeResume = session.events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant" && (e.message as any)?.stopReason === "error").length;
      const startsBeforeResume = session.events.filter((e) => e.type === "agent_start").length;
      session.send({ type: "get_messages", id: "retained-notices" });
      const retained = await session.waitFor((e) => e.type === "response" && e.id === "retained-notices", 5000);
      const settled = session.events.filter((e) => e.type === "agent_settled").length;
      session.send({ type: "prompt", id: "resume", message: "resume" });
      await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length > settled, 5000);
      return { seen, events: session.events, errorsBeforeResume, startsBeforeResume, retained };
    }
    return { seen, events: session.events, executions: kind === "tool" ? readFileSync(join(cwd, "executions.log"), "utf8") : undefined };
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
test("real pi retries portable partial text through its native retry engine", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("partial");
  assert.equal(seen.length, 2);
  assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success === true));
});
// Remove random extension backoff in this subprocess so expiry exercises pi's own retry wait.
// Allow request setup under parallel-suite load, then bound a much longer native retry wait.
test("real pi episode expires during built-in retry sleep", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("budget");
  assert.equal(seen.length, 1);
  assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success === false));
});

test("real pi episode expiry delivers a fired wake without owner input", { timeout: 20000 }, async () => {
  const { events } = await runScenario("budget", true);
  const settled = events.findIndex((e) => e.type === "agent_settled" && e.aborted === true);
  const wake = events.findIndex((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake");
  assert.ok(settled >= 0 && wake > settled, "expiry must settle before the fired wake delivers");
  assert.match((events[wake].message as any).content, /episode-fired-wake/);
  assert.equal(events.filter((e) => e.type === "message_start" && (e.message as any)?.role === "user").length, 1, "delivery requires no new owner input");
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


test("real pi retries failed local tool output without executing it or losing completed tool history", { timeout: 20000 }, async () => {
  const { seen, events, executions } = await runScenario("tool");
  assert.equal(seen.length, 4);
  assert.equal(executions, "prior\nretry\n", "completed tools run once; the tool in the failed response never runs");
  const replay = seen[2].body.input;
  assert.ok(replay.some((item: any) => item.type === "function_call" && item.call_id === "call_prior"));
  assert.ok(replay.some((item: any) => item.type === "function_call_output" && item.call_id === "call_prior"));
  assert.ok(!replay.some((item: any) => item.call_id === "call_failed"));
  assert.equal(JSON.stringify(replay).split("busy child finished").length - 1, 1, "busy-parent notification survives the retry exactly once");
  assert.equal(events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "subagent-parent-wake").length, 1);
  assert.equal(events.filter((e) => e.type === "tool_execution_start").length, 2);
  assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success === true));
});

test("real pi retries portable generic stream closure but preserves hosted-tool protection", { timeout: 20000 }, async () => {
  const recovered = await runScenario("close");
  assert.equal(recovered.seen.length, 2);
  assert.ok(recovered.events.some((e) => e.type === "auto_retry_end" && e.success === true));
  for (const kind of ["hosted", "hosted-output"] as const) {
    const protectedRun = await runScenario(kind);
    assert.equal(protectedRun.seen.length, 1);
    const failure = protectedRun.events.find((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop");
    assert.equal((failure?.message as any)?.loopPiRecovery?.reason, kind === "hosted" ? "protected-request" : "hosted-or-unknown-output");
  }
});

test("real parent wakes retain notices silently while halted and a genuine user resumes", { timeout: 20000 }, async () => {
  const { seen, events, errorsBeforeResume, startsBeforeResume, retained } = await runScenario("wakes");
  assert.equal(errorsBeforeResume, 1, "parent wakes must not create repeated local error messages");
  assert.equal(startsBeforeResume, 1, "parent wakes must be handled before starting model turns");
  const notices = (retained?.data as any)?.messages.filter((m: any) => m.customType === "subagent-parent-wake");
  assert.deepEqual(notices.map((m: any) => m.content), ["child notice 0", "child notice 1", "child notice 2"]);
  assert.equal(seen.length, 2, "only the initial request and genuine resume reach the provider");
  const assistants = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((assistants.at(-1)?.message as any)?.stopReason, "stop");
});
