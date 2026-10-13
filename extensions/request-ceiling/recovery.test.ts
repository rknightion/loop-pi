import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc, PI_SUBAGENTS_PACKAGE_DIR, waitForCondition } from "../loop-guard/rpc-test-helpers.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
after(cleanupAll);

type BoundaryMode = "timeout-tool" | "mixed-tool" | "mixed-budget" | "server-budget" | "refusal" | "cancel" | "excluded-timeout" | "compaction-budget";
interface BoundaryOptions {
  mode: BoundaryMode;
  code?: string;
  httpStatus?: number;
  exclusion?: string;
  maxAttempts?: number;
  maxRetries?: number;
  providerRetries?: number;
  child?: boolean;
  enabled?: boolean;
  errorMessage?: string;
  errorType?: string;
  plainHttp?: boolean;
  summaryRoute?: "custom" | "native" | "oauth";
  split?: boolean;
  warm?: boolean;
  virtual?: boolean;
  projectRetries?: number;
  projectEpisodeMs?: number;
  homeEpisodeMs?: number;
  retryDelayMs?: number;
  unstructuredOverflow?: boolean;
  summarySampling?: boolean;
  summarySuccess?: boolean;
  managed?: boolean;
}

// All responses traverse the pinned native Responses decoder and agent loop. Only the
// local network peer is scripted; local bash and native detached children are real.
async function boundaryCase(options: BoundaryOptions) {
  const cwd = freshDir("recovery-boundary-work-");
  const home = freshDir("recovery-boundary-home-");
  const fixture = join(home, "provider.ts");
  const requests: any[] = [];
  const children: { pid: number; at: number; response: import("node:http").ServerResponse }[] = [];
  const sideEffects = options.mode === "timeout-tool" || options.mode === "mixed-tool";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const isChild = req.headers["x-fixture-child"] === "yes";
    if (isChild) {
      children.push({ pid: Number(req.headers["x-fixture-pid"]), at: Date.now(), response: res });
      writeFileSync(join(cwd,"child-ready"),"ready");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_child", status: "in_progress", output: [] } })}\n\n`);
      return;
    }
    requests.push({ body, headers: req.headers, at: Date.now() });
    const n = requests.length;
    if (options.split && n === 1) {
      res.writeHead(200, {"content-type":"text/event-stream"});
      const item = {id:"history",type:"message",role:"assistant",content:[{type:"output_text",text:"earlier completed history ".repeat(200),annotations:[]}]};
      res.end(`data: ${JSON.stringify({type:"response.output_item.done",output_index:0,item})}\n\ndata: ${JSON.stringify({type:"response.completed",response:{id:"resp_history",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}})}\n\n`);
      return;
    }
    if (options.mode === "compaction-budget" && n === (options.split ? 4 : 2)) {
      if (options.child) await waitForCondition(() => children.length ? true : undefined, 5000);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(options.unstructuredOverflow ? "maximum context length exceeded" : JSON.stringify({error:{code:options.code ?? "context_length_exceeded",type:options.errorType ?? "invalid_request_error",message:options.errorMessage ?? "Your input exceeds the context window of this model."}}));
      return;
    }
    if (options.mode === "refusal" && options.httpStatus) {
      res.writeHead(options.httpStatus, { "content-type": "application/json", "x-request-id": "fixture-correlation" });
      res.end(options.plainHttp ? "server error" : JSON.stringify({ error: { code: options.code, type: options.errorType ?? "server_error", message: options.errorMessage ?? "private upstream body marker" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "fixture-correlation" });
    const send = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const complete = (output: object[] = []) => {
      send({ type: "response.completed", response: { id: `resp_complete_${n}`, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    };
    send({ type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } });
    if (options.summarySuccess && n >= (options.split ? 5 : 3)) {
      const item = {id:"summary",type:"message",role:"assistant",content:[{type:"output_text",text:"The completed prior tool ran exactly once.",annotations:[]}]};
      send({type:"response.output_item.done",output_index:0,item});
      complete([item]); return;
    }
    if (options.mode === "refusal") {
      send({ type: "response.failed", response: { id: `resp_${n}`, status: "failed", error: { code: options.code, type: options.errorType ?? "server_error", message: options.errorMessage ?? "private upstream body marker" } } });
      res.end(); return;
    }
    const mixed = options.mode === "mixed-tool";
    const successAt = mixed ? 4 : 3;
    if (sideEffects && n > successAt) { complete(); return; }
    const timeout = options.mode === "cancel" || options.mode === "excluded-timeout" || options.mode === "timeout-tool" && n === 2
      || mixed && n === 3 || options.mode === "mixed-budget" && n % 2 === 0;
    if (sideEffects || options.mode === "cancel" || options.mode === "excluded-timeout" || options.mode === "compaction-budget" && (options.split ? n === 2 || n === 3 : n === 1)) {
      const label = options.split && n === 3 ? "prior2" : (options.split ? n === 2 : n === 1) && (sideEffects || options.mode === "compaction-budget") ? "prior" : n === successAt && sideEffects ? "retry" : "failed";
      const command = `printf '${label}\\n' >> executions.log` + (options.split ? "; printf 'large tool result %.0s' {1..300}" : "");
      const item = { id: `fc_${label}`, type: "function_call", call_id: `call_${label}`, name: "bash", arguments: JSON.stringify({ command }) };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
      send({ type: "response.output_item.done", output_index: 0, item });
      if (label === "prior" || label === "prior2" || label === "retry") {
        const output: object[] = [item];
        if (options.child && label === "prior") {
          const child = { id: "fc_child", type: "function_call", call_id: "call_child", name: "subagent", arguments: JSON.stringify({ agent: "probe", task: "CHILD_PROOF", async: true, worktree: false }) };
          send({ type: "response.output_item.added", output_index: 1, item: { ...child, arguments: "" } });
          send({ type: "response.function_call_arguments.delta", output_index: 1, item_id: child.id, delta: child.arguments });
          send({ type: "response.output_item.done", output_index: 1, item: child });
          output.push(child);
        }
        complete(output); return;
      }
    }
    if (options.exclusion === "hosted-output") {
      send({ type: "response.output_item.added", output_index: 1, item: { id: "search_item", type: "web_search_call", status: "in_progress" } });
    }
    if (timeout) return; // Native request ceiling, not a forged provider error.
    send({ type: "response.failed", response: { id: `resp_${n}`, status: "failed", error: { code: "stream_incomplete", type: "server_error", message: "Upstream websocket closed before response.completed" } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  writeFileSync(fixture, `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createParentWake } from ${JSON.stringify(join(PI_SUBAGENTS_PACKAGE_DIR, "src/shared/parent-wake.js"))};
import { installRequestCeiling, installRetryBackoff } from ${JSON.stringify(join(HERE, "index.ts"))};
export default function(pi) {
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  if (child) { installRequestCeiling(pi, {wallClockMs:15000,maxFollowUps:0}); installRetryBackoff(pi); }
  else {
    // Synchronize at the real awaited tool-result boundary, before the next root
    // turn's ceiling starts. Full-suite process contention must not turn this
    // survival proof into a child that was only launched after the timeout.
    if (${!!options.child}) pi.on("tool_result", async (e,ctx) => {
      if(e.toolName !== "subagent") return;
      const deadline = Date.now() + 15000;
      while(!existsSync(join(ctx.cwd,"child-ready"))) {
        if(Date.now() >= deadline) throw new Error("native child did not reach local Responses peer");
        await new Promise(resolve => setTimeout(resolve,20));
      }
    });
    let inSummary = false, summaryHeaders = 0;
    pi.on("session_before_compact", e => {
      inSummary = true; summaryHeaders = 0;
      pi.sendMessage({customType:"boundary-summary-shape",content:"shape",display:false,details:{split:e.preparation.isSplitTurn,history:e.preparation.messagesToSummarize.length,prefix:e.preparation.turnPrefixMessages.length}},{triggerTurn:false});
    });
    pi.on("before_provider_headers", () => { if(inSummary) summaryHeaders++; });
    const summaryEnded = e => {
      inSummary = false;
      pi.sendMessage({customType:"boundary-summary-observed",content:"summary headers",display:false,details:{headers:summaryHeaders,aborted:e.aborted ?? false}},{triggerTurn:false});
    };
    pi.on("session_compact", summaryEnded); pi.on("session_compact_failed", summaryEnded);
    if (${!!options.warm}) pi.on("cache_warming_decision", () => {
      pi.sendMessage({customType:"boundary-warm-decision",content:"decision",display:false},{triggerTurn:false});
      return {action:"warm"}; // Control forces a real warm; recovery must override to stop.
    });
    let clock = 0;
    const wake = createParentWake(pi, () => clock);
    pi.registerCommand("boundary-wakes", {description:"Deliver retained proof notices",handler:async () => {
      for(let i=0;i<3;i++) { clock += 11000; wake.sendMessage({customType:"boundary-stale-notice",content:"stale child update " + i,display:true},{triggerTurn:true}); await new Promise(resolve => setTimeout(resolve,100)); }
      pi.sendMessage({customType:"boundary-wakes-done",content:"done",display:false},{triggerTurn:false});
    }});
    pi.on("session_start", (_e,ctx) => wake.bindSession(ctx));
    pi.on("agent_start", () => wake.agentStarted());
    let notice = false;
    pi.on("provider_stream_event", e => {
      if (!notice && e.data?.type === "response.output_item.done" && e.data?.item?.id === "fc_failed") {
        notice = true;
        wake.sendMessage({customType:"boundary-notice",content:"retained child update",display:true},{triggerTurn:true});
      }
    });
    pi.on("message_end", e => {
      if (e.message.role !== "assistant" || e.message.stopReason !== "error" || !e.message.errorMessage?.includes("context_length_exceeded")) return;
      const route = ${JSON.stringify(options.summaryRoute ?? "")};
      if (route === "custom") pi.registerProvider("fixture", {api:"openai-responses",streamSimple:() => { throw new Error("summary custom stream must not run"); }});
      if (route === "native") pi.registerProvider({id:"fixture",name:"Opaque",auth:{},getModels:() => [],stream:() => {throw new Error("native must not run");},streamSimple:() => {throw new Error("native must not run");}});
      if (route === "oauth") pi.registerProvider("fixture", {oauth:{name:"Opaque",login:async()=>({}),refreshToken:async x=>x,getApiKey:()=>"test"}});
    });
    pi.on("before_provider_request", e => {
      const p = e.payload;
      if (${!!options.summarySampling}) return {...p,previous_response_id:undefined}; // Agent-only observation; native summary cannot see this transform.
      const exclusion = ${JSON.stringify(options.exclusion ?? "")};
      if (exclusion === "anchor") return {...p,previous_response_id:"resp_bound"};
      if (exclusion === "conversation") return {...p,conversation:"conversation_bound"};
      if (exclusion === "file") return {...p,input:[...p.input,{role:"user",content:[{type:"input_file",file_id:"file_bound"}]}]};
      if (exclusion === "hosted-tool") return {...p,tools:[{type:"web_search_preview"}]};
      if (exclusion === "orphan") return {...p,input:[...p.input,{type:"function_call_output",call_id:"orphan",output:"value"}]};
      if (exclusion === "duplicate") { const c={type:"function_call",call_id:"duplicate",name:"bash",arguments:"{}"}; return {...p,input:[...p.input,c,c,{type:"function_call_output",call_id:"duplicate",output:"value"}]}; }
      if (exclusion === "hosted-history") return {...p,input:[...p.input,{type:"web_search_call"}]};
    });
  }
  pi.on("before_provider_headers", e => { e.headers["x-fixture-child"]=child?"yes":"no";e.headers["x-fixture-pid"]=String(process.pid); });
  pi.registerProvider("fixture", {baseUrl:"http://127.0.0.1:${port}/v1",apiKey:"test",api:"openai-responses",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000,${options.warm ? 'promptCache:{short:10.2},' : ''}${options.summarySampling ? 'samplingParams:{previous_response_id:"summary_bound"},' : ''}}]});
  ${options.virtual ? 'pi.registerVirtualModel({provider:"fixture",id:"auto",name:"Auto",contextWindow:100000,maxTokens:1000,route:(request,ctx)=>({model:ctx.modelRegistry.find("fixture","fixture")})});' : ''}
}`);
  if (options.child) {
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents/probe.md"), `---\nname: probe\ndescription: Local recovery process proof\ntools: bash\nextensions: []\nsubagentOnlyExtensions: ${fixture}\nmodel: fixture/fixture\n---\nComplete the local proof.\n`);
  }
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    ...(options.warm ? {cacheWarming:"idle"} : {}),
    ...(options.projectRetries !== undefined || options.projectEpisodeMs !== undefined ? {defaultProjectTrust:"always"} : {}),
    ...(options.child ? { packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } } : {}),
    ...(options.mode === "compaction-budget" ? { compaction: { enabled: true, keepRecentTokens: options.split ? 100 : 1, reserveTokens: 2000 } } : {}),
    retry: { enabled: options.enabled !== false, maxRetries: options.maxRetries ?? 60, baseDelayMs: options.retryDelayMs ?? 25, maxAgentDelayMs: options.retryDelayMs ?? 25, provider: { maxRetries: options.providerRetries ?? 0 } },
    loopPi: { retryRecovery: { providerIds: options.managed === false ? [] : ["fixture"], episodeMs: options.homeEpisodeMs ?? 20000, maxAttempts: options.maxAttempts ?? 5 }, requestCeiling: { wallClockMs: options.mode === "compaction-budget" && options.child ? 6000 : 1500, maxFollowUps: 10 } },
  }));
  if (options.projectRetries !== undefined || options.projectEpisodeMs !== undefined) {
    mkdirSync(join(cwd,".pi"));
    writeFileSync(join(cwd,".pi/settings.json"),JSON.stringify({
      ...(options.projectRetries !== undefined ? {retry:{provider:{maxRetries:options.projectRetries}}} : {}),
      ...(options.projectEpisodeMs !== undefined ? {loopPi:{retryRecovery:{episodeMs:options.projectEpisodeMs}}} : {}),
    }));
  }
  const session = startPiRpc({ extensions: [fixture, join(HERE, "../call-timing/index.ts"), join(HERE, "index.ts")],
    extraArgs: ["--provider", "fixture", "--model", options.virtual ? "auto" : "fixture", ...(options.child ? ["--exclude-tools", "subagents_enable"] : [])],
    sessionArgs: options.child ? [] : undefined,
    agentDir: home, subagentTempRoot: freshDir(), cwd, fauxScriptPath: "" });
  try {
    if (options.split) {
      session.send({type:"prompt",id:"boot",message:"EARLIER SPAN"});
      await session.waitFor(e => e.type === "agent_settled", 5000);
    }
    session.send({ type: "prompt", id: "go", message: "GO" });
    if (options.mode === "cancel") {
      await session.waitFor((e) => e.type === "message_update" && (e.assistantMessageEvent as any)?.type === "toolcall_end", 10000);
      session.send({ type: "abort", id: "operator-cancel" });
    }
    const stopped = () => session.events.some((x) => x.type === "message_end" && ["loop-recovery-required", "loop-recovery-exhausted"].includes((x.message as any)?.customType));
    const terminal = await session.waitFor((e) => e.type === "agent_settled" &&
      (!options.split || requests.length >= 4) &&
      (options.mode === "cancel" || (sideEffects ? requests.length >= (options.mode === "mixed-tool" ? 5 : 4) || stopped()
        : options.mode === "mixed-budget" || options.mode === "server-budget" ? stopped() : true)), 12000);
    const requestsBeforeWakes = requests.length;
    // Drive native idle-parent wakes, not a loose proxy event. Every stopped case
    // must retain the notices without reopening a turn or resetting its budget.
    if (!sideEffects) {
      session.send({ type: "prompt", id: "stale-wakes", message: "/boundary-wakes" });
      await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "boundary-wakes-done", 3000);
    }
    session.send({ type: "get_messages", id: "retained" });
    const retained = await session.waitFor((e) => e.type === "response" && e.id === "retained", 3000);
    let childAlive = false;
    if (options.child) {
      try { await waitForCondition(() => children.length ? true : undefined, 5000); }
      catch (error) { throw new Error(String(error) + "\n" + JSON.stringify(session.events.filter((e) => e.type === "tool_execution_end")) + "\n" + session.stderr.join("")); }
      assert.equal(children.length, 1, "the native detached child reached the real Responses peer: " + JSON.stringify(session.events.filter((e) => e.type === "tool_execution_end")));
      const c = children[0];
      const timeout = session.events.find((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.reason === "safe-local-timeout");
      const stoppedAt = options.mode === "compaction-budget" ? runStopTime(session.events) : (timeout?.message as any)?.loopPiProgress?.endedAt;
      assert.ok(c.at < stoppedAt, "the child's request was active before the root safety stop, not launched afterward");
      assert.notEqual(c.pid, session.child.pid);
      process.kill(c.pid, 0); childAlive = true;
      const item = { id: "msg_child", type: "message", role: "assistant", content: [{ type: "output_text", text: "child survived root recovery", annotations: [] }] };
      c.response.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
      c.response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_child", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
      await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify", 10000);
    }
    return { requests, requestsBeforeWakes, events: session.events, retained, terminal, childAlive, rootPid:session.child.pid, childPid:children[0]?.pid,
      executions: existsSync(join(cwd, "executions.log")) ? readFileSync(join(cwd, "executions.log"), "utf8") : "" };
  } finally {
    for (const c of children) { c.response.destroy(); try { process.kill(c.pid, "SIGTERM"); } catch {} }
    await session.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("real Responses timeout omits failed local tool, preserves prior side effect and retained notice", { timeout: 25000 }, async () => {
  const run = await boundaryCase({ mode: "timeout-tool" });
  assert.equal(run.requests.length, 4);
  assert.equal(run.executions, "prior\nretry\n");
  const replay = run.requests[2].body.input;
  assert.ok(replay.some((i: any) => i.type === "function_call_output" && i.call_id === "call_prior"));
  assert.ok(!replay.some((i: any) => i.call_id === "call_failed"));
  assert.equal(JSON.stringify(replay).split("retained child update").length - 1, 1);
  assert.equal(run.events.filter((e) => e.type === "tool_execution_start").length, 2);
  assert.equal(run.events.filter((e) => e.type === "message_start" && (e.message as any)?.role === "user").length, 1);
  const failed = run.events.find((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.reason === "safe-local-timeout");
  assert.ok(failed, "timeout is visibly distinguished from upstream refusal");
  assert.equal((failed.message as any).loopPiProgress.stopReason, "aborted", "accepted progress semantics remain observational");
  const success = run.events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant").at(-1);
  assert.equal((success?.message as any).loopPiRecovery.attempts, 0, "successful completion resets the shared budget");
});

test("real mixed transport and timeout failures share a configurable five-attempt cap", { timeout: 25000 }, async () => {
  const run = await boundaryCase({ mode: "mixed-budget", maxAttempts: 5 });
  assert.equal(run.requests.length, 5);
  const notices = run.events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted");
  assert.equal(notices.length, 1);
  assert.equal((notices[0].message as any).details.reason, "attempt-limit");
  assert.equal(run.events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required").length, 0);
  const retained = (run.retained.data as any).messages.filter((m: any) => m.customType === "boundary-stale-notice");
  assert.deepEqual(retained.map((m: any) => m.content), ["stale child update 0", "stale child update 1", "stale child update 2"]);
  assert.equal(run.events.filter((e) => e.type === "agent_start").length, 5, "five real requests including native retries; no stale wake turn");
});

function runStopTime(events: any[]): number {
  return events.find(e => e.type === "message_end" && e.message?.customType === "loop-recovery-required")?.message?.timestamp ?? 0;
}

// Approved conservative contract: the opaque summary is not replay-authorized.
// Original 65-versus-4 red evidence is retained; this asserts exact admissions,
// cause and honest unknown upstream, not a weaker <=budget assertion.
test("native compaction admits one summary then denies opaque retry before dispatch", { timeout: 30000 }, async (t) => {
  const run = await boundaryCase({ mode: "compaction-budget", maxAttempts: 3 });
  assert.equal(run.requests.length, 3, "completed prior tool, failed continuation, exactly one admitted summary");
  assert.equal(run.executions, "prior\n");
  const compacted = run.events.find(e => e.type === "compaction_end");
  assert.equal(compacted?.aborted, true);
  const notices = run.events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal(notices.length, 1);
  const details = (notices[0].message as any).details;
  assert.equal(details.reason, "opaque-summary-retry-not-authorized");
  assert.equal(details.attempts, 2, "one failed agent plus one summary: single header counter");
  assert.equal(details.maxAttempts, 3);
  const observed = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "boundary-summary-observed");
  assert.deepEqual((observed?.message as any)?.details,{headers:2,aborted:true}, "one admitted summary header and exactly one locally denied invocation");
  t.diagnostic(JSON.stringify({requests:3,summaryHeaders:2,admittedSummary:1,localDenials:1,attempts:details.attempts,reason:details.reason,upstream:details.upstream}));
  assert.deepEqual(details.upstream, {code:null,type:null,status:null,requestId:null,clientRequestId:run.requests[2].headers["x-client-request-id"]});
  assert.match(details.upstream.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(run.events.filter(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted").length, 0);
  assert.equal(run.events.filter(e => e.type === "agent_start").length, 1, "stale wakes do not reopen stopped root");
});

test("real summary safety stop preserves same detached child and retained notifications", { timeout: 35000 }, async (t) => {
  const run = await boundaryCase({mode:"compaction-budget",maxAttempts:3,child:true});
  assert.equal(run.requests.length, 3);
  assert.equal(run.childAlive, true);
  t.diagnostic(JSON.stringify({rootPid:run.rootPid,survivingChildPid:run.childPid,rootRequests:run.requests.length,childAliveAfterSummaryAbort:true,retainedStaleNotices:3}));
  assert.equal(run.executions, "prior\n");
  assert.match(JSON.stringify(run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify")?.message), /child survived root recovery/);
  assert.equal(run.events.filter(e => e.type === "message_start" && (e.message as any)?.role === "user").length, 1);
  assert.deepEqual((run.retained.data as any).messages.filter((m:any)=>m.customType === "boundary-stale-notice").map((m:any)=>m.content), ["stale child update 0","stale child update 1","stale child update 2"]);
});

test("real summary preflight rejects unknown custom native and auth-rerouted provenance", { timeout: 35000 }, async () => {
  for (const summaryRoute of ["custom", "native", "oauth"] as const) {
    const run = await boundaryCase({mode:"compaction-budget",summaryRoute});
    assert.equal(run.requests.length, 2, "no opaque summary dispatched");
    const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
    assert.equal((notice?.message as any)?.details.reason, "summary-route-not-established");
    assert.deepEqual((notice?.message as any)?.details.upstream, {code:null,type:null,status:null,requestId:null,clientRequestId:null});
  }
});

test("model sampling overrides cannot inject protected state into an unobserved summary", {timeout:20000}, async () => {
  const run = await boundaryCase({mode:"compaction-budget",summarySampling:true});
  assert.equal(run.requests.length, 2, "safe Agent payload is insufficient to authorize differently constructed summary payload");
  assert.ok(run.requests.every(r => r.body.previous_response_id === undefined));
  const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal((notice?.message as any)?.details.reason, "summary-route-not-established");
});

test("successful native summary clears scope but cannot reset the shared count", {timeout:20000}, async () => {
  const run = await boundaryCase({mode:"compaction-budget",summarySuccess:true,maxAttempts:2});
  assert.equal(run.requests.length, 3, "completed tool, failed request, successful summary; continuation denied locally");
  assert.equal(run.events.find(e => e.type === "compaction_end")?.aborted, false);
  const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted");
  assert.equal((notice?.message as any)?.details.reason, "attempt-limit");
  assert.equal((notice?.message as any)?.details.attempts, 2);
  assert.equal(run.executions, "prior\n");
});

test("real virtual selection cannot authorize opaque summary routing or replay", {timeout:20000}, async () => {
  const run = await boundaryCase({mode:"compaction-budget",virtual:true});
  assert.equal(run.requests.length, 2, "completed tool and rejected continuation; no routed summary");
  assert.equal(run.events.find(e => e.type === "compaction_end")?.aborted, true, "physical turn ctx is safe; virtual selected summary route is not established");
  const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal((notice?.message as any)?.details.reason, "summary-route-not-established");
});

test("effective trusted project provider retries are refused before dispatch", {timeout:20000}, async () => {
  const run = await boundaryCase({mode:"server-budget",projectRetries:1});
  assert.equal(run.requests.length, 0);
  const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal((notice?.message as any)?.details.reason, "unobservable-provider-retries");
});

test("real two-call split compaction is conservatively declined during managed recovery", {timeout:25000}, async () => {
  const run = await boundaryCase({mode:"compaction-budget",split:true});
  const shape = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "boundary-summary-shape");
  assert.equal((shape?.message as any)?.details.split, true, "native preparation actually cuts within a user span");
  assert.ok((shape?.message as any)?.details.history > 0 && (shape?.message as any)?.details.prefix > 0, "native default would issue two summary calls");
  assert.equal(run.requests.length, 4, "history success, two completed tools, overflow; zero summary dispatches");
  assert.equal(run.executions, "prior\nprior2\n");
  const notice = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal((notice?.message as any)?.details.reason, "two-call-summary-not-authorized");
});

test("ordinary successful two-call split compaction remains unchanged outside recovery", {timeout:25000}, async () => {
  const run = await boundaryCase({mode:"compaction-budget",split:true,summarySuccess:true,managed:false});
  const shape = run.events.find(e => e.type === "message_end" && (e.message as any)?.customType === "boundary-summary-shape");
  assert.equal((shape?.message as any)?.details.split, true);
  assert.ok((shape?.message as any)?.details.history > 0 && (shape?.message as any)?.details.prefix > 0);
  assert.equal(run.requestsBeforeWakes, 7, "history, two tools, overflow, two successful summary calls, resumed continuation");
  assert.equal(run.requests.length, 10, "ordinary successful root still processes the three genuine native notification wakes");
  assert.equal(run.events.find(e => e.type === "compaction_end")?.aborted,false);
  assert.equal(run.executions,"prior\nprior2\n");
  assert.equal(run.events.filter(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required").length,0);
});

test("real idle cache warming cannot make a hidden request in a retained managed episode", {timeout:20000}, async () => {
  const run = await boundaryCase({mode:"server-budget",maxAttempts:1,warm:true});
  assert.equal(run.events.filter(e => e.type === "message_end" && (e.message as any)?.customType === "boundary-warm-decision").length, 1, "actual native cache timer reached the supported decision hook");
  assert.equal(run.requests.length, 1, "forced warm is suppressed before HTTP dispatch");
});

test("real recovery honors configured, disabled and smaller native retry limits without multiplying budgets", { timeout: 30000 }, async () => {
  for (const [settings, expected] of [[{maxAttempts:5,maxRetries:1},2], [{maxAttempts:2,maxRetries:60},2], [{maxAttempts:5,maxRetries:60,enabled:false},1]] as const) {
    const run = await boundaryCase({ mode: "server-budget", ...settings });
    assert.equal(run.requests.length, expected);
    assert.equal(run.events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted").length, 1);
  }
});

test("real policy and authentication refusals retain sanitized upstream identity without replay", { timeout: 45000 }, async () => {
  for (const [code, status, reason] of [["cyber_policy", 503, "upstream-policy-refusal"], ["content_policy_violation", undefined, "upstream-policy-refusal"], ["invalid_api_key", 401, "upstream-auth-refusal"], ["authentication_error", 403, "upstream-auth-refusal"], ["context_length_exceeded", undefined, "upstream-policy-refusal"], ["continuity_recovery_required", undefined, "non-retryable-upstream"]] as const) {
    const run = await boundaryCase({ mode: "refusal", code, httpStatus: status, errorMessage: code === "cyber_policy" ? "server error; maximum context length exceeded" : undefined,
      plainHttp: code === "authentication_error", errorType: code === "context_length_exceeded" ? "policy_error" : undefined });
    assert.equal(run.requests.length, 1);
    const failure = run.events.find((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
    const metadata = (failure?.message as any)?.loopPiRecovery;
    assert.equal(metadata.upstream.code, code);
    assert.equal(metadata.upstream.status, status ?? 200);
    // The pinned HTTP-error path never emits after_provider_response; the client
    // correlation is still authoritative, while unavailable server headers stay null.
    assert.equal(metadata.upstream.requestId, status ? null : "fixture-correlation");
    assert.match(metadata.upstream.clientRequestId, /^[0-9a-f-]{36}$/);
    assert.equal(metadata.reason, reason);
    assert.equal(metadata.disposition, "stop");
    assert.match((failure?.message as any).errorMessage, new RegExp(code));
    assert.ok(!run.events.some((e) => e.type === "auto_retry_start" || e.type === "compaction_end"), "refusal must never be mistaken for retry or native compaction");
    assert.ok(!JSON.stringify(failure).includes("private upstream body marker"));
    assert.ok(!JSON.stringify(failure).includes("maximum context length exceeded"));
  }
});

for (const code of ["continuity_recovery_required", "insufficient_quota", "unknown_refusal"]) {
  test(`real misleading overflow structured refusal ${code} cannot compact or replay`, {timeout:20000}, async () => {
    const run = await boundaryCase({mode:"compaction-budget",code,errorType:"server_error",errorMessage:"maximum context length exceeded; server error",summarySuccess:true,maxAttempts:4});
    assert.equal(run.requestsBeforeWakes, 2, "prior effect and refusal only; no summary or continuation");
    assert.equal(run.requests.length, 2, "stale wakes stay latched");
    assert.equal(run.executions, "prior\n");
    assert.ok(!run.events.some(e => e.type === "compaction_end" || e.type === "auto_retry_start"));
    const notices = run.events.filter(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
    assert.equal(notices.length, 1);
    const details = (notices[0].message as any).details;
    assert.equal(details.reason, "non-retryable-upstream");
    assert.deepEqual(details.upstream, {code:code === "unknown_refusal" ? "unrecognized" : code,type:"server_error",status:400,requestId:null,clientRequestId:run.requests[1].headers["x-client-request-id"]});
    assert.equal(run.events.filter(e => e.type === "message_start" && (e.message as any)?.role === "user").length, 1);
    assert.equal((run.retained.data as any).messages.filter((m:any)=>m.customType === "boundary-stale-notice").length, 3);
  });
}

for (const unstructuredOverflow of [false, true]) {
  test(`real legitimate overflow control unstructured=${unstructuredOverflow} retains native compaction`, {timeout:20000}, async () => {
    const run = await boundaryCase({mode:"compaction-budget",unstructuredOverflow,summarySuccess:true,maxAttempts:4});
    assert.equal(run.requestsBeforeWakes, 4);
    assert.equal(run.events.find(e => e.type === "compaction_end")?.aborted, false);
    assert.equal(run.executions, "prior\n");
  });
}

for (const projectEpisodeMs of [100, 10000]) {
  test(`real trusted project episode ${projectEpisodeMs} uses admitted duration`, {timeout:20000}, async (t) => {
    const run = await boundaryCase({mode:"server-budget",homeEpisodeMs:10000,projectEpisodeMs,retryDelayMs:700,maxAttempts:3});
    assert.equal(run.requests.length, projectEpisodeMs === 100 ? 1 : 3);
    const notices = run.events.filter(e => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted");
    assert.equal(notices.length, 1);
    const details = (notices[0].message as any).details;
    assert.equal(details.episodeMs, projectEpisodeMs);
    assert.equal(details.reason, projectEpisodeMs === 100 ? "episode-expired" : "attempt-limit");
    const gaps = run.requests.slice(1).map((r,i)=>r.at-run.requests[i].at);
    assert.ok(gaps.every(gap=>gap>600), "real native retry wait exceeds the short project episode");
    t.diagnostic(JSON.stringify({projectEpisodeMs,requests:run.requests.length,gaps,details}));
  });
}

test("real operator cancellation after a completed local tool-call delta remains cancelled", { timeout: 20000 }, async () => {
  const run = await boundaryCase({ mode: "cancel" });
  assert.equal(run.requests.length, 1);
  assert.equal(run.executions, "");
  const failure = run.events.find((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((failure?.message as any)?.stopReason, "aborted");
  assert.equal(run.events.filter((e) => e.type === "message_end" && ["loop-request-incident", "loop-recovery-exhausted", "loop-recovery-required"].includes((e.message as any)?.customType)).length, 0);
});

test("real Responses rejects anchored, file-bound, hosted and malformed-history timeout replay", { timeout: 60000 }, async () => {
  for (const exclusion of ["anchor", "conversation", "file", "hosted-tool", "orphan", "duplicate", "hosted-history", "hosted-output"]) {
    const run = await boundaryCase({ mode: "excluded-timeout", exclusion });
    assert.equal(run.requests.length, 1);
    assert.equal(run.executions, "");
    const failure = run.events.find((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
    assert.equal((failure?.message as any)?.loopPiRecovery?.disposition, "stop");
    assert.equal((failure?.message as any)?.loopPiRecovery?.reason, exclusion === "hosted-output" ? "hosted-or-unknown-output" : "protected-request");
  }
});


test("real native detached child survives root timeout recovery and delivers its retained result", { timeout: 35000 }, async (t) => {
  const run = await boundaryCase({ mode: "timeout-tool", child: true });
  assert.equal(run.childAlive, true);
  assert.equal(run.executions, "prior\nretry\n");
  t.diagnostic(JSON.stringify({rootPid:run.rootPid,survivingChildPid:run.childPid,rootRequests:run.requests.length,childAliveAfterTimeout:true,executions:run.executions,failedResponseToolRan:false}));
  const timeout = run.events.findIndex((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.reason === "safe-local-timeout");
  const completed = run.events.findIndex((e, i) => i > timeout && e.type === "message_end" && (e.message as any)?.role === "assistant" && (e.message as any)?.stopReason === "stop");
  const notice = run.events.findIndex((e) => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify");
  assert.ok(timeout >= 0 && completed > timeout && notice > completed, "root recovers before the surviving child finishes");
  assert.match(JSON.stringify(run.events[notice].message), /child survived root recovery/);
});

test("opted recovery refuses unobservable provider-internal retry multiplication before dispatch", { timeout: 20000 }, async () => {
  const run = await boundaryCase({ mode: "server-budget", providerRetries: 1 });
  assert.equal(run.requests.length, 0);
  const notice = run.events.find((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-required");
  assert.equal((notice?.message as any)?.details.reason, "unobservable-provider-retries");
});

async function runScenario(kind: "anchor" | "partial" | "budget" | "active-budget" | "protected" | "http" | "synthetic" | "ceiling" | "partial-ceiling" | "tool" | "close" | "hosted" | "hosted-output" | "wakes" | "overflow" | "empty-length", withWake = false, managed = true) {
  const cwd = freshDir("recovery-work-");
  const seen: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    if ((kind === "active-budget" && seen.length === 2) || kind === "ceiling") { req.on("close", () => res.end()); return; }
    if (kind === "overflow" && seen.length === 2) {
      res.writeHead(400, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:"context_length_exceeded",type:"invalid_request_error",message:"Your input exceeds the context window of this model."}})); return;
    }
    if (kind === "http" && seen.length === 1) {
      res.writeHead(502, {"content-type":"application/json"});
      res.end(JSON.stringify({error:{code:"previous_response_owner_unavailable",type:"server_error",message:"Previous response owner account is unavailable; retry later."}})); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } });
    if (kind === "empty-length" && seen.length === 1) {
      const item = { id: "reasoning_budget", type: "reasoning", summary: [{ type: "summary_text", text: "Still considering the task." }] };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, summary: [] } });
      send({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: item.id, summary_index: 0, delta: "Still considering the task." });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.incomplete", response: { id: "resp_empty", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item], usage: { input_tokens: 1, output_tokens: 1000, total_tokens: 1001 } } });
      res.end(); return;
    }
    if ((kind === "tool" && seen.length <= 3) || (kind === "overflow" && seen.length === 1)) {
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
    if (kind === "overflow" && seen.length === 3) {
      const item = {id:"msg_summary",type:"message",role:"assistant",content:[{type:"output_text",text:"The prior tool completed once. Continue the remaining work.",annotations:[]}]};
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end(); return;
    }
    if ((kind === "partial" || kind === "partial-ceiling") && seen.length === 1) {
      send({ type: "response.output_item.added", output_index: 0, item: { id: "msg_test", type: "message", role: "assistant", content: [] } });
      send({ type: "response.content_part.added", item_id: "msg_test", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: "partial" });
    }
    if (kind === "partial-ceiling" && seen.length === 1) { req.on("close", () => res.end()); return; }
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
  writeFileSync(join(home, "settings.json"), JSON.stringify({ ...(kind === "overflow" ? {compaction:{enabled:true,keepRecentTokens:1,reserveTokens:2000}} : {}), retry: { maxRetries: kind === "partial" ? 3 : 60, baseDelayMs: kind === "budget" ? 5000 : 200, maxAgentDelayMs: kind === "budget" ? 5000 : 200, provider: { maxRetries: 0 } }, loopPi: { retryRecovery: { episodeMs: kind === "budget" ? 1200 : kind === "synthetic" ? 120 : kind === "active-budget" ? 700 : ["ceiling", "partial-ceiling"].includes(kind) ? 1200 : 10000, providerIds: managed ? ["fixture"] : [] }, requestCeiling: { wallClockMs: ["ceiling", "partial-ceiling"].includes(kind) ? 800 : 5000, maxFollowUps: ["ceiling", "partial-ceiling", "empty-length"].includes(kind) ? 2 : 0 } } }));
  const session = startPiRpc({ extensions: [fixture, ...(withWake ? [join(HERE, "..", "loop-wait", "root.ts")] : []), ...(process.env.RECOVERY_BASELINE ? [] : [join(HERE, "index.ts")])], extraArgs: ["--provider", "fixture", "--model", "fixture"], agentDir: home, subagentTempRoot: freshDir(), cwd, fauxScriptPath: "" });
  try {
    session.send({ type: "prompt", id: "go", message: "GO" });
    await session.waitFor((e) => e.type === "agent_settled", 15000);
    if (kind === "empty-length") {
      const incident = await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-request-incident", 5000);
      if (!(incident.message as any).details.exhausted) {
        await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length >= 2, 5000);
      }
    }
    if (withWake) {
      await session.waitFor((e) => e.type === "message_start" && (e.message as any)?.customType === "loop-wake", 5000);
    }
    if (kind === "partial-ceiling") {
      const incident = await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-request-incident", 5000);
      if (!(incident.message as any).details.exhausted) {
        await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length >= 2, 5000);
      }
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
    return { seen, events: session.events, executions: ["tool", "overflow"].includes(kind) ? readFileSync(join(cwd, "executions.log"), "utf8") : undefined };
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

test("per-request timeout followups share the episode starting at the first failure", { timeout: 20000 }, async () => {
  const {seen,events}=await runScenario("ceiling");
  // First failure starts1200ms of recovery: the next800ms attempt fits,
  // then a third gets only the remaining400ms. No follow-up renews the budget.
  assert.equal(seen.length,3);
  assert.ok(events.some((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-recovery-exhausted"));
});
test("portable local Responses timeout after partial output recovers without a fake user turn", { timeout: 20000 }, async () => {
  const {seen,events}=await runScenario("partial-ceiling");
  assert.equal(seen.length,2);
  const assistants = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((assistants[0].message as any).loopPiRecovery.disposition, "retry");
  assert.equal((assistants.at(-1)?.message as any).stopReason, "stop");
  assert.equal(events.filter((e) => e.type === "message_start" && (e.message as any)?.role === "user").length, 1);
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


test("real pi preserves native context-overflow compaction and resumes from its summary", { timeout: 20000 }, async () => {
  const { seen, events, executions } = await runScenario("overflow");
  const compacted = events.find((e) => e.type === "compaction_end" && e.reason === "overflow");
  assert.ok(compacted, "context overflow must reach pi's native compaction path");
  assert.equal(compacted.aborted, false);
  assert.equal(compacted.willRetry, true);
  assert.match((compacted.result as any)?.summary, /The prior tool completed once/);
  assert.equal(seen.length, 4, "tool request, rejected continuation, summary, then resumed continuation");
  assert.equal(executions, "prior\n", "compaction must not execute the completed tool again");
  assert.match(JSON.stringify(seen[3].body.input), /The prior tool completed once/);
  const assistants = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((assistants.at(-1)?.message as any)?.stopReason, "stop");
  assert.ok(!events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop"));
});


test("ordinary native single-summary overflow outside managed recovery is unchanged", {timeout:20000}, async () => {
  const run = await runScenario("overflow", false, false);
  assert.equal(run.seen.length, 4);
  assert.equal(run.executions, "prior\n");
  const compacted = run.events.find(e => e.type === "compaction_end");
  assert.equal(compacted?.aborted, false);
  assert.match((compacted?.result as any)?.summary, /The prior tool completed once/);
  assert.match(JSON.stringify(run.seen[3].body.input), /The prior tool completed once/);
});

test("real pi preserves the bounded request-ceiling followup after reasoning exhausts the output budget", { timeout: 20000 }, async () => {
  const { seen, events } = await runScenario("empty-length");
  const firstAssistant = events.find((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.ok((firstAssistant?.message as any)?.content.some((block: any) => block.type === "thinking" && block.thinking === "Still considering the task."));
  assert.equal(seen.length, 2, "the output-budget incident must start its permitted followup");
  const incidents = events.filter((e) => e.type === "message_end" && (e.message as any)?.customType === "loop-request-incident");
  assert.equal(incidents.length, 1);
  assert.equal((incidents[0].message as any).details.kind, "empty-length");
  assert.equal((incidents[0].message as any).details.exhausted, false);
  const assistants = events.filter((e) => e.type === "message_end" && (e.message as any)?.role === "assistant");
  assert.equal((assistants.at(-1)?.message as any)?.stopReason, "stop");
  assert.ok(!events.some((e) => e.type === "message_end" && (e.message as any)?.loopPiRecovery?.disposition === "stop"));
});
