import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, freshDir, startPiRpc, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, FAUX_EXTENSION, waitForCondition, writeFauxScript } from "./rpc-test-helpers.ts";
after(cleanupAll);

for (const agent of ["outside-fixture", "worker", "senior", "senior-escalation", "reviewer", "scout"]) test(`session ceiling checks exported delegation without a tool_call: ${agent}`, { timeout: 60000 }, async () => {
  const home=freshDir("ceiling-home-"); const cwd=freshDir("ceiling-cwd-");
  mkdirSync(join(home,"agents"));
  writeFileSync(join(home,"settings.json"),JSON.stringify({packages:[PI_SUBAGENTS_PACKAGE_DIR],subagents:{agentExcludeDirs:["~/.agents"]}}));
  writeFileSync(join(home,`agents/${agent}.md`),["---",`name: ${agent}`,"description: ceiling probe","tools: read","extensions: []",`subagentOnlyExtensions: ${FAUX_EXTENSION}`,"model: faux/faux-1","---","probe"].join("\n"));
  const facts=join(home,"facts.json");const probe=join(home,"probe.ts");
  writeFileSync(probe,`import {writeFileSync} from 'node:fs';
import {SUBAGENT_DELEGATION_REQUEST_EVENT as REQUEST,SUBAGENT_DELEGATION_RESPONSE_EVENT as RESPONSE} from ${JSON.stringify(join(PI_SUBAGENTS_PACKAGE_DIR,"bundle/delegation.js"))};
export default function(pi) {
let calls=0; pi.on('tool_call',()=>{calls++;});
pi.on('input',async(event,ctx)=>{
 if(event.text!=='DIRECT_CEILING')return;
 const result=await new Promise(resolve=>{
 const off=pi.events.on(RESPONSE,r=>{if(r.requestId==='ceiling-attempt'){off();resolve(r);}});
 pi.events.emit(REQUEST,{requestId:'ceiling-attempt',ownerRunId:'ceiling-owner',nodeId:'outside',agent:${JSON.stringify(agent)},task:'CEILING_CHILD_MARKER',context:'fresh',cwd:ctx.cwd,model:'faux/faux-1',timeoutMs:10000,artifacts:false,intercomBridge:{mode:'off'},result:{kind:'text'}});
 });
 writeFileSync(${JSON.stringify(facts)},JSON.stringify({result,calls}));return {action:'handled'};
});}
`);
  const session=startPiRpc({extensions:[FAUX_EXTENSION,ROOT_EXTENSION,probe],agentDir:home,cwd,subagentTempRoot:freshDir("ceiling-runs-"),sessionArgs:[],fauxScriptPath:writeFauxScript([{match:"CEILING_CHILD_MARKER",text:"CEILING_CHILD_MARKER"}]),extraArgs:["--exclude-tools","subagents_enable"]});
  try {
    session.send({type:"prompt",message:"DIRECT_CEILING"});
    await waitForCondition(()=>existsSync(facts)||undefined,30000);
    const observed=JSON.parse(readFileSync(facts,"utf8"));
    console.log(JSON.stringify(observed));
    assert.equal(observed.calls,0,"package delegation bypasses root tool_call");
    if (agent === "outside-fixture") {
      assert.equal(observed.result.status,"failed");
      assert.match(JSON.stringify(observed.result),/Capability ceiling from loop-guard does not allow agent 'outside-fixture'/);
    } else {
      assert.equal(observed.result.status,"completed");
      assert.equal(observed.result.result.text,"CEILING_CHILD_MARKER");
    }
  } finally { await session.close(); }
});


test("failed ceiling registration terminates startup before delegation admission", () => {
  const home = freshDir("ceiling-failure-");
  const script = join(home,"failure.mjs");
  const marker = join(home,"admitted");
  writeFileSync(script, `import root from ${JSON.stringify(ROOT_EXTENSION)};
import {writeFileSync} from 'node:fs';
const handlers = new Map();
root({on:(name,fn)=>{if(!handlers.has(name))handlers.set(name,fn);},events:{on:()=>{},emit:()=>{}}});
handlers.get('session_start')({}, {sessionManager:{getSessionId:()=>''},ui:{notify:()=>{}}});
writeFileSync(${JSON.stringify(marker)},'unsafe startup admitted');`);
  const result=spawnSync(process.execPath,[script],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/capability ceiling registration failed; refusing root startup/);
  assert.equal(existsSync(marker),false,"no package delegation can be admitted after failed startup");
});
