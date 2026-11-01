import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAllAfterExit, expectDetachedRuns, freshDir, startPiRpc, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, waitForCondition, waitForDetachedWriters } from "./rpc-test-helpers.ts";
after(async () => { await cleanupAllAfterExit(); });

for (const guarded of [false, true]) for (const emptyRunId of [false, true]) {
  test(`interrupt requires target (guard=${guarded}, emptyRunId=${emptyRunId})`, { timeout: 90000 }, async () => {
    const home = freshDir("interrupt-home-");
    const subRoot = freshDir("interrupt-runs-");
    const cwd = freshDir("interrupt-cwd-");
    const probe = join(home, "provider.ts");
    const targetFile = join(home, "target.json");
    const activeFile = join(home, "child-active");
    const ai = new URL("../../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).pathname;
    writeFileSync(probe, `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(ai)};
import { readFileSync, writeFileSync } from 'node:fs';
export default function(pi) {
 const f=fauxProvider({provider:'faux',models:[{id:'faux-1',contextWindow:272000,maxTokens:128000}]});
 f.setResponses(Array.from({length:100},()=>async(ctx,options)=>{
 const last=[...ctx.messages].reverse().find(m=>m.role!=='assistant');
 const text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
 if(last?.role==='toolResult') return fauxAssistantMessage('ready');
 if(text?.includes('CHILD_WAIT')) return fauxAssistantMessage([fauxToolCall('bash',{command:${JSON.stringify(`printf ready > '${activeFile}'; sleep 60`)},timeout:60})]);
 if(text?.includes('SPAWN'))return fauxAssistantMessage([fauxToolCall('subagent',{agent:'worker',task:'CHILD_WAIT',async:true})]);
 if(text?.includes('INTERRUPT')) { const id=JSON.parse(readFileSync(${JSON.stringify(targetFile)},'utf8')).id; return fauxAssistantMessage([fauxToolCall('subagent',${emptyRunId ? "{action:'interrupt',id,runId:''}" : "{action:'interrupt'}"})]); }
 if(text?.includes('CLEANUP')) { const id=JSON.parse(readFileSync(${JSON.stringify(targetFile)},'utf8')).id; return fauxAssistantMessage([fauxToolCall('subagent',{action:'interrupt',id})]); }
 return fauxAssistantMessage('ready');
 }));pi.registerProvider(f.provider);
}`);
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
    writeFileSync(join(home, "agents/worker.md"), ["---", "name: worker", "description: interrupt fixture", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${probe}`, "model: faux/faux-1", "---", "wait"].join("\n"));
    expectDetachedRuns(subRoot, 1);
    const session = startPiRpc({ extensions: [probe, ...(guarded ? [ROOT_EXTENSION] : [])], fauxScriptPath: "", agentDir: home, subagentTempRoot: subRoot, cwd, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"] });
    let id: string | undefined;
    try {
      session.send({type:"prompt",message:"SPAWN"});
      const launch:any = await session.waitFor(e=>e.type==="tool_execution_end" && e.toolName==="subagent",30000);
      assert.equal(launch.isError ?? false,false,JSON.stringify(launch));
      id=launch.result.details.runId ?? launch.result.details.asyncId;
      assert.ok(id,JSON.stringify(launch));
      writeFileSync(targetFile,JSON.stringify({id}));
      const statusPath=join(subRoot,"async-subagent-runs",id!,"status.json");
      await waitForCondition(()=>{try{return JSON.parse(readFileSync(statusPath,"utf8")).state==="running" || undefined;}catch{return;}},30000);
      await waitForCondition(()=>existsSync(activeFile) || undefined,30000);
      await session.waitFor(e=>e.type==="agent_end");
      const offset=session.events.length;
      session.send({type:"prompt",message:"INTERRUPT"});
      const outcome=await session.waitFor(e=>session.events.indexOf(e)>=offset && e.type==="tool_execution_end" && e.toolName==="subagent",30000);
      const text=JSON.stringify(outcome);
      // Read state before asserting refusal so the old-version evidence includes its effect.
      await new Promise(resolve=>setTimeout(resolve,300));
      if(text.includes("Interrupt requested")) await waitForCondition(()=>{
        const state=JSON.parse(readFileSync(statusPath,"utf8")).state;
        return state!=="running" ? state : undefined;
      },15000);
      const state=JSON.parse(readFileSync(statusPath,"utf8")).state;
      console.log(JSON.stringify({guarded,emptyRunId,state,outcome}));
      assert.match(text,guarded ? /loop-guard:.*interrupt.*needs an explicit run/ : /action='interrupt' requires id\./);
      assert.equal(state,"running");
    } finally {
      if(id) {
        session.send({type:"prompt",message:"CLEANUP"});
        await waitForCondition(()=>{
          try { return JSON.parse(readFileSync(join(subRoot,"async-subagent-runs",id!,"status.json"),"utf8")).state!=="running" || undefined; }
          catch { return; }
        },15000);
      }
      try { if (id) await waitForDetachedWriters(subRoot, 1, 30000); }
      finally { await session.close(); }
    }
  });
}
