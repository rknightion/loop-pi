import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupAll, freshDir, startPiRpc } from "../loop-guard/rpc-test-helpers.ts";
import { withoutEncryptedReasoning } from "./recovery.ts";
import { loopFixture, cleanupFixtures } from "../loop-continuation/test-fixture.ts";
after(()=>{cleanupAll();cleanupFixtures();});
const HERE=fileURLToPath(new URL('.',import.meta.url));
for(const exhausted of [false,true]) test(`encrypted reasoning recovery through native Responses (exhausted=${exhausted})`,{timeout:30000},async()=>{
 const s=loopFixture({root:"fixture/fixture"});const requests:any[]=[];
 const server=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);const n=requests.length;
  if(n>=3 && (exhausted || body.input.some((x:any)=>x.type==='reasoning' && x.encrypted_content==='account-A'))) {
   res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'invalid_encrypted_content',type:'invalid_request_error',message:'Encrypted reasoning belongs to another account.'}}));return;
  }
  res.writeHead(200,{'content-type':'text/event-stream'});const send=(x:any)=>res.write(`data: ${JSON.stringify(x)}\n\n`);
  send({type:'response.created',response:{id:`resp_${n}`,status:'in_progress',output:[]}});
  if(n===4){send({type:'response.failed',response:{id:`resp_${n}`,status:'failed',error:{code:'stream_incomplete',type:'server_error',message:'Upstream websocket closed before response.completed'}}});res.end();return;}
  const output:any[]=[];
  if(n===1){
   const reasoning={id:'rs_history',type:'reasoning',encrypted_content:'account-A',summary:[]};
   send({type:'response.output_item.added',output_index:0,item:reasoning});send({type:'response.output_item.done',output_index:0,item:reasoning});output.push(reasoning);
   const call={id:'fc_prior',type:'function_call',call_id:'call_prior',name:'bash',arguments:JSON.stringify({command:"printf 'once\\n' >> executed.log"})};
   send({type:'response.output_item.added',output_index:1,item:{...call,arguments:''}});
   send({type:'response.function_call_arguments.delta',output_index:1,item_id:call.id,delta:call.arguments});
   send({type:'response.output_item.done',output_index:1,item:call});output.push(call);
  }else{
   const msg={id:`msg_${n}`,type:'message',role:'assistant',content:[{type:'output_text',text:'PAUSED: fixture complete',annotations:[]}]};
   send({type:'response.output_item.done',output_index:0,item:msg});output.push(msg);
  }
  send({type:'response.completed',response:{id:`resp_${n}`,status:'completed',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});res.end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
 const provider=join(s.agentDir,'provider.ts');writeFileSync(provider,`export default function(pi){pi.registerProvider('fixture',{baseUrl:'http://127.0.0.1:${port}/v1',apiKey:'fixture',api:'openai-responses',models:[{id:'fixture',name:'Fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]});}`);
 writeFileSync(join(s.agentDir,'settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:5,baseDelayMs:25,maxAgentDelayMs:25,provider:{maxRetries:0}},compaction:{enabled:false},loopPi:{retryRecovery:{providerIds:['fixture'],maxAttempts:5,episodeMs:10000},rootRecovery:{baseDelayMs:50,maxDelayMs:50},requestCeiling:{wallClockMs:10000,maxFollowUps:0}}}));
 const startOptions={extensions:[provider,join(HERE,'index.ts'),join(HERE,'../loop-continuation/index.ts')],extraArgs:['--provider','fixture','--model','fixture'],sessionArgs:[],agentDir:s.agentDir,subagentTempRoot:freshDir(),cwd:s.repo,fauxScriptPath:'',env:{LOOP_PI_RUN_DIR:s.runDir}};
 let session=startPiRpc(startOptions);
 try{
  session.send({type:'prompt',message:s.launch});await session.waitFor(e=>e.type==='agent_settled',10000);
  assert.equal(requests.length,2,'seed includes one completed local tool');
  const offset=session.events.length;session.send({type:'prompt',message:'ACCOUNT_ROTATED'});
  await session.waitFor(e=>session.events.indexOf(e)>=offset && e.type==='agent_settled',10000);
  await new Promise(resolve=>setTimeout(resolve,350));
  console.log(JSON.stringify({exhausted,requests:requests.map(p=>({input:p.input.filter((x:any)=>["reasoning","function_call","function_call_output"].includes(x.type)),include:p.include})),outcomes:session.events.filter(e=>e.type==='message_end').map((e:any)=>({stopReason:e.message.stopReason,recovery:e.message.loopPiRecovery,customType:e.message.customType}))}));
  assert.equal(readFileSync(join(s.repo,'executed.log'),'utf8'),'once\n','completed tool executes once');
  assert.equal(requests.length,exhausted?4:5,'one sanitized attempt; ordinary managed stream retry remains bounded');
  for(const p of requests.slice(3)){
   assert.equal(p.input.some((x:any)=>x.type==='reasoning'),false,'wire retry omits poisoned reasoning');
   assert.equal(p.include?.includes('reasoning.encrypted_content')??false,false);
   const call=p.input.find((x:any)=>x.type==='function_call');assert.equal(call.id,undefined);assert.equal(call.call_id,'call_prior');
   assert.ok(p.input.some((x:any)=>x.type==='function_call_output' && x.call_id===call.call_id));
  }
  if(exhausted) assert.ok(session.events.some((e:any)=>e.message?.customType==='loop-recovery-required' && e.message?.details?.reason==='encrypted-history-quarantined'));
  else {
   assert.ok(session.events.some((e:any)=>session.events.indexOf(e)>=offset && e.message?.role==='assistant' && e.message?.stopReason==='stop'));
   session.send({type:'get_state',id:'saved'});
   const state:any=await session.waitFor(e=>e.type==='response' && e.id==='saved');
   const sessionFile=state.data.sessionFile;
   assert.ok(readFileSync(sessionFile,'utf8').includes('account-A'),'sanitation leaves saved reasoning unchanged');
   const next=session.events.length;session.send({type:'prompt',message:'NEXT_TURN'});
   await session.waitFor(e=>session.events.indexOf(e)>=next && e.type==='agent_settled');
   assert.equal(requests.length,6);assert.equal(requests[5].input.some((x:any)=>x.type==='reasoning'),false,'quarantine survives successful turn reset');
   await session.close();session=startPiRpc({...startOptions,sessionArgs:['--session',sessionFile]});
   session.send({type:'prompt',message:'AFTER_RELOAD'});await session.waitFor(e=>e.type==='agent_settled');
   assert.equal(requests.length,7);assert.equal(requests[6].input.some((x:any)=>x.type==='reasoning'),false,'quarantine survives root reload');
  }
 }finally{await session.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test("reasoning sanitation preserves complete custom calls and refuses protected state",()=>{
 const payload={input:[{type:"reasoning",encrypted_content:"fixture"},{type:"custom_tool_call",id:"paired",call_id:"call",name:"local",input:"args"},{type:"custom_tool_call_output",call_id:"call",output:"done"}],include:["reasoning.encrypted_content","message.output_text.logprobs"]};
 const before=JSON.stringify(payload);const result=withoutEncryptedReasoning(payload) as any;
 assert.deepEqual(result,{input:[{type:"custom_tool_call",call_id:"call",name:"local",input:"args"},{type:"custom_tool_call_output",call_id:"call",output:"done"}],include:["message.output_text.logprobs"]});
 assert.equal(JSON.stringify(payload),before);
 for(const protectedPayload of [{...payload,previous_response_id:"bound"},{...payload,input:[...payload.input,{type:"web_search_call"}]},{...payload,input:payload.input.slice(0,2)}])assert.equal(withoutEncryptedReasoning(protectedPayload),protectedPayload);
});
