// Controlled clocks at the network edge; responses still traverse real pi's native decoder.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc, waitForCondition } from "../loop-guard/rpc-test-helpers.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60000;
after(cleanupAll);

async function streamCase(run: (peer: any) => Promise<void>, recovery = false) {
  const cwd = freshDir("activity-work-"); const home = freshDir("activity-home-");
  const peers: ServerResponse[] = [];
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body)); peers.push(res);
    res.writeHead(200, {"content-type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({type:"response.created",response:{id:`resp_${peers.length}`,status:"in_progress",output:[]}})}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const {port} = server.address() as {port:number};
  const fixture = join(home,"fixture.ts"); const ack = join(cwd,"clock.json");
  writeFileSync(fixture, `import {mock} from "node:test"; import {writeFileSync} from "node:fs";
export default function(pi) {
  pi.on("session_start",()=>mock.timers.enable({apis:["Date","setTimeout"],now:1000000000000}));
  pi.on("provider_stream_event",e=>{ if(e.data?.type==="fixture.clock") { if(e.data.jump) mock.timers.setTime(Date.now()+e.data.ms); else mock.timers.tick(e.data.ms); writeFileSync(${JSON.stringify(ack)},JSON.stringify({id:e.data.id,now:Date.now()})); } });
  pi.registerProvider("fixture",{baseUrl:"http://127.0.0.1:${port}/v1",api:"openai-responses",apiKey:"test",models:[{id:"fixture",name:"Fixture",reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:80000}]});
}`);
  writeFileSync(join(home,"settings.json"),JSON.stringify({httpIdleTimeoutMs:100000000, retry:{maxRetries:3,provider:{maxRetries:0}},loopPi:{requestCeiling:{inactivityMs:15*MINUTE,absoluteMs:75*MINUTE,maxFollowUps:recovery?2:0},retryRecovery:{providerIds:recovery?["fixture"]:[],episodeMs:20*MINUTE},progress:{checkpointIntervalMs:60000}}}));
  const session = startPiRpc({extensions:[fixture,join(HERE,"index.ts"),join(HERE,"..","call-timing","index.ts")],extraArgs:["--provider","fixture","--model","fixture"],agentDir:home,subagentTempRoot:freshDir(),cwd,fauxScriptPath:""});
  let clockId=0, itemId=0;
  const send=(event:object,n=0)=>peers[n].write(`data: ${JSON.stringify(event)}\n\n`);
  const tick=async(ms:number,n=0,jump=false)=>{const id=++clockId;send({type:"fixture.clock",ms,id,jump},n);await waitForCondition(()=>existsSync(ack)&&JSON.parse(readFileSync(ack,"utf8")).id===id?true:undefined,5000);};
  const reasoning=async(n=0)=>{
    const expected=session.events.filter(e=>e.type==="message_update"&&(e.assistantMessageEvent as any)?.type==="thinking_end").length+1;
    const item={id:`reasoning_${++itemId}`,type:"reasoning",summary:[],encrypted_content:"fixture-encrypted"};
    send({type:"response.output_item.added",output_index:itemId-1,item:{...item,encrypted_content:undefined}},n);
    send({type:"response.output_item.done",output_index:itemId-1,item},n);
    await session.waitFor(e=>e.type==="message_update"&&(e.assistantMessageEvent as any)?.type==="thinking_end"&&session.events.filter(x=>x.type==="message_update"&&(x.assistantMessageEvent as any)?.type==="thinking_end").length>=expected,5000);
  };
  const complete=(n=0)=>{const item={id:"answer",type:"message",role:"assistant",content:[{type:"output_text",text:"Useful answer",annotations:[]}]};send({type:"response.output_item.done",output_index:itemId,item},n);send({type:"response.completed",response:{id:`resp_${n+1}`,status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},n);peers[n].end();};
  try {
    session.send({type:"prompt",id:"go",message:"GO"});
    await waitForCondition(()=>peers.length?true:undefined,10000);
    await run({session,tick,reasoning,complete,send,peers,bodies,home,cwd});
  } catch(error) { throw new Error(String(error)+" observed="+JSON.stringify(session.events.map(e=>({type:e.type,stream:(e.assistantMessageEvent as any)?.type,stop:(e.message as any)?.stopReason,error:(e.message as any)?.errorMessage}))));
  } finally {await session.close();for(const peer of peers)peer.end();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
const ends=(session:any)=>session.events.filter((e:any)=>e.type==="message_end"&&e.message?.role==="assistant").map((e:any)=>e.message);
const notice=(session:any)=>session.events.find((e:any)=>e.type==="message_end"&&e.message?.customType==="loop-request-incident")?.message;

test("native encrypted reasoning passes fourteen minutes and an hour before useful completion",{timeout:20000},async()=>{
  await streamCase(async({session,tick,reasoning,complete}:any)=>{
    for(let i=0;i<12;i++){await tick(5*MINUTE);await reasoning();}
    await tick(MINUTE);complete();await session.waitFor((e:any)=>e.type==="agent_settled",5000);
    assert.equal(ends(session).at(-1).stopReason,"stop");
    assert.equal(ends(session).at(-1).loopPiProgress.reasoning.completed,12);
    assert.equal(ends(session).at(-1).loopPiTiming.firstTokenAt,null,"encrypted reasoning does not fabricate TTFT");
    assert.equal(notice(session),undefined);
  });
});

test("connected silence and heartbeat-only streams expire for inactivity",{timeout:20000},async()=>{
  for(const heartbeats of [false,true])await streamCase(async({session,tick,send}:any)=>{
    if(heartbeats){for(let i=0;i<2;i++){await tick(5*MINUTE);send({type:"keepalive"});}}
    await tick(heartbeats?5*MINUTE:15*MINUTE);await session.waitFor((e:any)=>e.type==="agent_settled",5000);
    assert.equal(ends(session)[0].stopReason,"aborted");
    assert.equal(notice(session).details.limitType,"inactivity");
    assert.equal(notice(session).details.idleMs,15*MINUTE);
  });
});

test("endless native reasoning reaches its fixed absolute limit",{timeout:20000},async()=>{
  await streamCase(async({session,tick,reasoning}:any)=>{
    for(let i=0;i<14;i++){await tick(5*MINUTE);await reasoning();}
    await tick(5*MINUTE);await session.waitFor((e:any)=>e.type==="agent_settled",5000);
    assert.equal(notice(session).details.limitType,"absolute");
    assert.equal(notice(session).details.elapsedMs,75*MINUTE);
    assert.equal(notice(session).details.idleMs,5*MINUTE);
  });
});

test("long first request gets recovery budget from failure, and reasoning cannot extend that episode",{timeout:20000},async()=>{
  await streamCase(async({session,tick,reasoning,peers}:any)=>{
    for(let i=0;i<14;i++){await tick(5*MINUTE);await reasoning();}
    await tick(5*MINUTE);await waitForCondition(()=>peers.length===2?true:undefined,5000);
    await tick(10*MINUTE,1);await reasoning(1);
    await tick(9*MINUTE,1);await reasoning(1);
    await tick(MINUTE,1);
    await session.waitFor((e:any)=>e.type==="message_end"&&(e.message as any)?.customType==="loop-recovery-exhausted",5000);
    assert.equal(peers.length,2);
    assert.equal(ends(session).at(-1).loopPiRecovery.reason,"episode-expired");
  },true);
});


test("native operator cancellation retains abort and creates no recovery incident",{timeout:20000},async()=>{
  await streamCase(async({session,reasoning,tick}:any)=>{
    for(let i=0;i<6;i++){await tick(5*MINUTE);await reasoning();} session.send({type:"abort",id:"cancel"});
    await session.waitFor((e:any)=>e.type==="agent_settled",5000);
    assert.equal(ends(session)[0].stopReason,"aborted");
    assert.equal(notice(session),undefined);
    assert.ok(!session.events.some((e:any)=>e.type==="message_end"&&e.message?.customType==="loop-recovery-required"));
  },true);
});

test("late local-tool progress cannot reopen a deadline whose timer was delayed",{timeout:20000},async()=>{
  await streamCase(async({session,tick,send,cwd,peers}:any)=>{
    const item={id:"fc_late",type:"function_call",call_id:"call_late",name:"bash",arguments:JSON.stringify({command:"printf executed > late-effect"})};
    send({type:"response.output_item.added",output_index:0,item:{...item,arguments:""}});
    send({type:"response.function_call_arguments.delta",output_index:0,item_id:item.id,delta:item.arguments});
    send({type:"response.output_item.done",output_index:0,item});
    await session.waitFor((e:any)=>e.type==="message_update"&&(e.assistantMessageEvent as any)?.type==="toolcall_end",5000);
    await tick(75*MINUTE,0,true);
    send({type:"response.completed",response:{id:"resp_late",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
    peers[0].end();
    await session.waitFor((e:any)=>e.type==="message_end"&&(e.message as any)?.role==="assistant",5000);
    assert.equal(ends(session)[0].stopReason,"aborted");
    await session.waitFor((e:any)=>e.type==="agent_settled",5000);
    assert.equal(notice(session).details.limitType,"absolute");
    assert.equal(existsSync(join(cwd,"late-effect")),false,"no side effect from the expired response may execute");
    assert.equal(session.events.filter((e:any)=>e.type==="tool_execution_start").length,0);
  });
});
