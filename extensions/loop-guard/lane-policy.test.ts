import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_PATH, FAUX_EXTENSION, ROOT_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, cleanupAll, freshDir, startPiRpc, waitForCondition } from "./rpc-test-helpers.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const evidence = process.env.LOOP_PI_POLICY_EVIDENCE;
after(cleanupAll);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
const fields = ["control", "acceptance", "gate", "workflow", "thinking", "extensionBindings", "model", "timeoutMs", "maxRuntimeMs"] as const;

test("required native child boundary refuses policy overrides without widening child authority", { timeout: 240_000 }, async () => {
  const outcomes: Record<string, unknown>[] = [];
  for (const field of fields) for (const shape of field === "control" ? ["top"] : ["top", "options"]) {
    const fixture = freshDir(`native-policy-${field}-${shape}-`);
    const home = join(fixture, "home");
    const cwd = join(fixture, "repo");
    mkdirSync(join(home, "agents"), { recursive: true });
    mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
    const config = JSON.parse(readFileSync(join(ROOT, "home/extensions/subagent/config.json"), "utf8").replaceAll("{{HOME}}", home));
    writeFileSync(join(home, "extensions/subagent/config.json"), JSON.stringify(config));
    const capture = join(fixture, "capture.ts");
    writeFileSync(capture, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.on('session_start',(_event,ctx)=>{writeFileSync(${JSON.stringify(join(fixture, "identity-"))}+process.pid+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid,execPath:process.execPath,argv:process.argv,cwd:ctx.cwd,bindings:process.env.PI_SUBAGENT_EXTENSION_BINDINGS,depth:process.env.PI_SUBAGENT_DEPTH,session:ctx.sessionManager.getSessionFile()}));});}`);
    for (const agent of ["senior", "scout"]) writeFileSync(join(home, "agents", `${agent}.md`), [
      "---", `name: ${agent}`, "description: Disposable policy fixture", `tools: ${agent === "senior" ? "bash, subagent" : "bash"}`,
      ...(agent === "senior" ? ["allowedAgents: scout"] : []), "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}, ${capture}`,
      "model: faux/faux-1", "timeoutMs: 60000", "---", "Synthetic fixture only.",
    ].join("\n"));
    const marker = join(cwd, "leaf-ran");
    const hostMarker = join(cwd, "host-ran");
    const workflow = join(cwd, "workflow.js");
    writeFileSync(workflow, 'const r = await runs.run("leaf",{agent:"scout",task:"LEAF_POLICY",async:true}); return r;');
    const values: Record<string, unknown> = {
      acceptance: { level: "verified", verify: [{ id: "local", command: `touch '${hostMarker}'` }] },
      gate: { command: `touch '${hostMarker}'` }, workflow,
      thinking: "low", extensionBindings: { "loop-pi.guard/1": { agent: "worker" } },
      model: "faux/faux-1", timeoutMs: 50000, maxRuntimeMs: 50000,
    };
    const nested = { agent: "scout", task: "LEAF_POLICY", async: true,
      ...(field === "control" ? {} : shape === "options" ? { options: { [field]: values[field] } } : { [field]: values[field] }) };
    if (field === "workflow" && shape === "top") {
      delete (nested as Record<string, unknown>).agent;
      delete (nested as Record<string, unknown>).task;
    }
    const script = join(fixture, "faux.json");
    writeFileSync(script, JSON.stringify({ rules: [
      { match: "ROOT_POLICY", once: true, toolCalls: [{ name: "subagent", args: { agent: "senior", task: "CHILD_POLICY", async: true } }] },
      { match: "CHILD_POLICY", once: true, toolCalls: [{ name: "subagent", args: nested }] },
      { match: "LEAF_POLICY", once: true, toolCalls: [{ name: "bash", args: { command: `touch '${marker}'` } }] },
      { match: ".*", text: "synthetic done" },
    ] }));
    const session = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script, agentDir: home,
      subagentTempRoot: join(fixture, "subtemp"), cwd, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"] });
    try {
      session.send({ id: "p", type: "prompt", message: "ROOT_POLICY" });
      const launch = await session.waitFor(e => e.type === "tool_execution_end" && e.toolName === "subagent");
      assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
      const result = await waitForCondition(() => {
        for (const path of files(join(home, "sessions")).filter(p => p.endsWith(".jsonl"))) {
          const calls = new Set<string>();
          for (const line of readFileSync(path, "utf8").split("\n")) {
            let record; try { record = JSON.parse(line); } catch { continue; }
            if (record.message?.role === "assistant") for (const c of record.message.content ?? []) {
              if (c.type === "toolCall" && c.name === "subagent" && (c.arguments?.task === "LEAF_POLICY" || c.arguments?.workflow === workflow)) calls.add(c.id);
            }
            if (record.message?.role === "toolResult" && calls.has(record.message.toolCallId)) return { path, message: record.message };
          }
        }
        return undefined;
      }, 30_000);
      if (!result.message.isError) await waitForCondition(() => existsSync(marker) ? true : undefined, 30_000);
      const details = (launch.result as { details: { asyncDir: string; launchResolvedExtensions: { required: string[] } } }).details;
      assert.ok(details.launchResolvedExtensions.required.includes("loop-guard-lane"), "root must register the actual required child hook");
      const terminal = await waitForCondition(() => {
        const path = join(details.asyncDir, "status.json");
        try {
          const status = JSON.parse(readFileSync(path, "utf8"));
          return ["complete", "failed", "cancelled"].includes(status.state) && status.processTerminal?.state === "observed" ? status : undefined;
        } catch { return undefined; }
      }, 30_000);
      const row = { field, shape, input: nested, rootPid: session.child.pid, fixture, launch: details, terminal, processes: files(fixture).filter(p => /\/identity-\d+\.json$/.test(p)).map(p => JSON.parse(readFileSync(p, "utf8"))),
        result, leafRan: existsSync(marker), hostRan: existsSync(hostMarker),
        hookChecksField: ["acceptance", "gate", "workflow", "extensionBindings", "model", "timeoutMs", "maxRuntimeMs"].includes(field),
        identities: { node: process.version, pi: JSON.parse(readFileSync(join(dirname(dirname(CLI_PATH)), "../package.json"), "utf8")).version,
          subagents: JSON.parse(readFileSync(join(PI_SUBAGENTS_PACKAGE_DIR, "package.json"), "utf8")).version,
          cli: { path: CLI_PATH, sha256: hash(CLI_PATH) }, lane: hash(join(ROOT, "extensions/loop-guard/lane.ts")),
          sdk: { path: join(PI_SUBAGENTS_PACKAGE_DIR, "src/extension/fanout-child.js"), sha256: hash(join(PI_SUBAGENTS_PACKAGE_DIR, "src/extension/fanout-child.js")) } } };
      outcomes.push(row);
    } finally {
      await session.close();
      if (evidence) {
        // Retain aggregate/identity projections only, never conversation content or excerpts.
        const projected = outcomes.map(row => {
          const result = row.result as { message: { isError?: boolean; toolCallId: string; content: unknown } };
          const launch = row.launch as { runId: string; launchResolvedExtensions: unknown };
          const terminal = row.terminal as { state: string; processTerminal: unknown; capabilityCeiling?: unknown };
          return {
            field: row.field, shape: row.shape, rootPid: row.rootPid,
            runId: launch.runId, launchResolvedExtensions: launch.launchResolvedExtensions,
            terminal: { state: terminal.state, processTerminal: terminal.processTerminal, capabilityCeiling: terminal.capabilityCeiling },
            processes: row.processes, identities: row.identities,
            toolCallId: result.message.toolCallId, isError: result.message.isError ?? false,
            leafRan: row.leafRan, hostRan: row.hostRan, hookChecksField: row.hookChecksField,
            rejectionLayer: !result.message.isError ? "none" : /loop-guard:/.test(JSON.stringify(result.message.content)) ? "required-hook" : "native",
          };
        });
        writeFileSync(join(evidence, "native-outcomes.json"), JSON.stringify(projected, null, 2));
      }
    }
  }
  for (const row of outcomes) {
    const result = row.result as { message: { isError?: boolean; content: unknown } };
    if (row.field === "control") assert.equal(row.leafRan, true, "ordinary allowed child must run");
    else {
      assert.equal(result.message.isError, true, `${row.field}/${row.shape}: overrides must be refused`);
      assert.equal(row.leafRan, false, `${row.field}/${row.shape}: no leaf task may run`);
      assert.equal(row.hostRan, false, `${row.field}/${row.shape}: no host command may run`);
      const reason = JSON.stringify(result.message.content);
      assert.match(reason, row.field === "thinking" ? /disabledFeatures.*watchdog/ : /loop-guard:/,
        `${row.field}/${row.shape}: verify the effective rejection layer`);
    }
  }
});
