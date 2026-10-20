// Native live steering against a real async child (pinned pi + pi-subagents, real runner process,
// in-process child session) behind a local Responses peer. No live model, no credentials.
//
// The child calls `block_sync` (test-support/block-sync-extension.ts), which saves a file and then
// blocks the runner process synchronously. While it is blocked the runner cannot acknowledge a steer
// (pi-subagents waits 3 s) nor act on the recovery interrupt (pi-subagents waits 15 s for the pause).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { cleanupAll, freshDir, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, startPiRpc, waitForCondition, type PiRpcSession } from "./loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BLOCK_EXTENSION = join(HERE, "test-support/block-sync-extension.ts");
const CHILD_MARKER = "STEER_PROBE_CHILD_PROMPT";
after(cleanupAll);

interface Peer {
  server: Server;
  port: number;
  /** Root tool outputs, in order. */
  rootOutputs: string[];
  /** Every child request's flattened input text, in order. */
  childInputs: string[];
  /** Root replies: the next root user prompt decides the tool call. */
  childBlockMs: number;
  childFirstDelayMs: number;
}

function inputText(input: any[]): string {
  return JSON.stringify(input);
}

function lastUserText(input: any[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.role === "user") return JSON.stringify(item.content);
  }
  return "";
}

async function startPeer(childBlockMs: number, childFirstDelayMs = 0): Promise<Peer> {
  const peer = { rootOutputs: [], childInputs: [], childBlockMs, childFirstDelayMs } as unknown as Peer;
  let n = 0;
  peer.server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input: any[] = body.input ?? [];
    const whole = JSON.stringify(body);
    const isChild = whole.includes(CHILD_MARKER);
    n += 1;
    const id = `resp_${n}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
    const call = (name: string, args: object) => ({ id: `fc_${n}`, type: "function_call", call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
    const text = (value: string) => ({ id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "output_text", text: value, annotations: [] }] });
    let item: any;
    const last = input[input.length - 1];
    if (isChild) {
      peer.childInputs.push(inputText(input));
      const steerSeen = inputText(input).includes("STEER_MSG");
      const resumeSeen = inputText(input).includes("RESUME_MSG");
      if (last?.type === "function_call_output") item = text(`CHILD_DONE steer_seen=${steerSeen}`);
      else if (steerSeen || resumeSeen) item = text(`CHILD_RESUMED steer_seen=${steerSeen} resume_seen=${resumeSeen}`);
      else {
        send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
        if (peer.childFirstDelayMs) await new Promise((r) => setTimeout(r, peer.childFirstDelayMs));
        item = call("block_sync", { ms: peer.childBlockMs });
      }
    } else if (last?.type === "function_call_output") {
      peer.rootOutputs.push(typeof last.output === "string" ? last.output : JSON.stringify(last.output));
      item = text("ok");
    } else {
      const prompt = lastUserText(input);
      const steer = /STEER (\S+?)(?: NORECOVERY)?\\?"/.exec(prompt);
      const resume = /RESUME (\S+?)\\?"/.exec(prompt);
      if (prompt.includes("LAUNCH")) item = call("subagent", { agent: "scout", task: "CHILD_TASK", async: true, worktree: false });
      else if (steer) item = call("subagent", { action: "steer", id: steer[1], message: "STEER_MSG", ...(prompt.includes("NORECOVERY") ? { options: { steeringRecovery: false } } : {}) });
      else if (resume) item = call("subagent", { action: "resume", id: resume[1], message: "RESUME_MSG" });
      else item = text("idle");
    }
    if (!(isChild && item.type === "function_call" && item.name === "block_sync")) send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    send({ type: "response.output_item.added", output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : item });
    if (item.type === "function_call") send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response: { id, status: "completed", output: [item], usage } });
    res.end();
  });
  await new Promise<void>((resolve) => peer.server.listen(0, "127.0.0.1", resolve));
  peer.port = (peer.server.address() as AddressInfo).port;
  return peer;
}

interface Rig { peer: Peer; root: PiRpcSession; runsDir: string; cwd: string; close(): Promise<void> }

async function startRig(childBlockMs: number, opts: { loopGuard?: boolean; childFirstDelayMs?: number } = {}): Promise<Rig> {
  const peer = await startPeer(childBlockMs, opts.childFirstDelayMs);
  const home = freshDir("steer-home-");
  const cwd = freshDir("steer-work-");
  const tempRoot = freshDir("steer-sub-");
  writeFileSync(join(home, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${peer.port}/v1`, apiKey: "test", api: "openai-responses",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  } } }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] }, retry: { enabled: false } }));
  mkdirSync(join(home, "extensions/subagent"), { recursive: true });
  const config = JSON.parse(readFileSync(join(ROOT, "home/extensions/subagent/config.json"), "utf8").replaceAll("{{HOME}}", home).replaceAll("{{PREFIX}}", ROOT));
  delete config.runnerLaunchers;
  writeFileSync(join(home, "extensions/subagent/config.json"), JSON.stringify(config));
  mkdirSync(join(home, "agents"));
  writeFileSync(join(home, "agents/scout.md"), `---\nname: scout\ndescription: Steering probe\ntools: block_sync\nextensions: ${BLOCK_EXTENSION}\nmodel: fixture/fixture\n---\n${CHILD_MARKER}\n`);
  const root = startPiRpc({
    extensions: opts.loopGuard ? [ROOT_EXTENSION] : [],
    extraArgs: ["--provider", "fixture", "--model", "fixture"],
    sessionArgs: [], agentDir: home, subagentTempRoot: tempRoot, cwd, fauxScriptPath: "",
  });
  return {
    peer, root, cwd, runsDir: join(tempRoot, "async-subagent-runs"),
    async close() {
      await root.close();
      peer.server.closeAllConnections();
      await new Promise<void>((resolve) => peer.server.close(() => resolve()));
    },
  };
}

let promptSeq = 0;
async function prompt(rig: Rig, message: string, timeoutMs = 60_000): Promise<string> {
  const before = rig.peer.rootOutputs.length;
  const ends = rig.root.events.filter((e) => e.type === "agent_end").length;
  rig.root.send({ type: "prompt", id: `p${++promptSeq}`, message });
  await waitForCondition(() => (rig.root.events.filter((e) => e.type === "agent_end").length > ends ? true : undefined), timeoutMs);
  return rig.peer.rootOutputs.slice(before).join("\n");
}

function runIds(rig: Rig): string[] {
  return existsSync(rig.runsDir) ? readdirSync(rig.runsDir).filter((name) => existsSync(join(rig.runsDir, name, "status.json"))) : [];
}

function status(rig: Rig, id: string): any {
  return JSON.parse(readFileSync(join(rig.runsDir, id, "status.json"), "utf8"));
}

async function launchBlockedChild(rig: Rig): Promise<string> {
  const launched = await prompt(rig, "LAUNCH");
  const id = await waitForCondition(() => runIds(rig)[0], 30_000).catch((error) => { throw new Error(`${error}\nlaunch: ${launched}\nstderr: ${rig.root.stderr.join("")}`); });
  // The child is inside block_sync once its saved-work file exists.
  await waitForCondition(() => (existsSync(join(rig.cwd, "saved-work.txt")) ? true : undefined), 30_000, 50);
  return id;
}

const claimPath = (rig: Rig, id: string) => join(rig.runsDir, id, "control", "steer-recovery", "claim.json");

test("live success: a steer to a child in a long model turn is queued, delivered at its boundary, and nothing pauses", { timeout: 120_000 }, async () => {
  const rig = await startRig(0, { childFirstDelayMs: 8_000 });
  try {
    await prompt(rig, "LAUNCH");
    const id = await waitForCondition(() => runIds(rig)[0], 30_000);
    await waitForCondition(() => (rig.peer.childInputs.length > 0 ? true : undefined), 30_000, 50);
    const started = Date.now();
    const out = await prompt(rig, `STEER ${id}`);
    assert.ok(Date.now() - started < 8_000, `the steer answered within the acknowledgement window: ${Date.now() - started} ms`);
    assert.match(out, /Steering queued for async run/);
    await waitForCondition(() => (status(rig, id).state === "complete" ? true : undefined), 60_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the child saw the steer at its next boundary");
    assert.equal(existsSync(claimPath(rig, id)), false);
    assert.equal(runIds(rig).length, 1, "no replacement run");
  } finally {
    await rig.close();
  }
});

test("timeout: a steer whose pause is confirmed after 15 s strands the child paused; resume continues it with its saved work", { timeout: 180_000 }, async () => {
  const rig = await startRig(30_000);
  try {
    const id = await launchBlockedChild(rig);
    const started = Date.now();
    const out = await prompt(rig, `STEER ${id}`, 90_000);
    const elapsed = Date.now() - started;
    console.log(`[timeout] steer returned after ${elapsed} ms: ${out}`);
    assert.match(out, /did not (reach|confirm) (a )?confirmed paused state|did not confirm a paused state/);
    // The interrupt is already in the run's inbox: when the block ends the runner pauses the child.
    const paused = await waitForCondition(() => { const s = status(rig, id); return s.state === "paused" && s.endedAt ? s : undefined; }, 60_000);
    console.log(`[timeout] child paused ${paused.endedAt - started} ms after the steer; claim present=${existsSync(claimPath(rig, id))}`);
    assert.equal(runIds(rig).length, 1, "no replacement was launched");
    assert.ok(!rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steering message was never applied");
    // Explicit resume continues the paused child; its saved work survives.
    const resumed = await prompt(rig, `RESUME ${id}`);
    console.log(`[timeout] resume: ${resumed}`);
    await waitForCondition(() => (runIds(rig).length === 2 ? true : undefined), 30_000);
    await waitForCondition(() => (rig.peer.childInputs.some((text) => text.includes("RESUME_MSG")) ? true : undefined), 30_000);
    assert.ok(existsSync(join(rig.cwd, "saved-work.txt")), "saved work survives the strand");
  } finally {
    await rig.close();
  }
});

test("fix: steeringRecovery false never interrupts; the steer is delivered when the child reaches its boundary", { timeout: 180_000 }, async () => {
  const rig = await startRig(30_000);
  try {
    const id = await launchBlockedChild(rig);
    const out = await prompt(rig, `STEER ${id} NORECOVERY`, 60_000);
    console.log(`[fix] ${out}`);
    assert.doesNotMatch(out, /paused|recovered|failed/i);
    await waitForCondition(() => (status(rig, id).state === "complete" ? true : undefined), 90_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steer reached the child at its boundary");
    assert.equal(existsSync(claimPath(rig, id)), false);
    assert.equal(existsSync(join(rig.runsDir, id, "control", "interrupt.json")), false);
    assert.equal(runIds(rig).length, 1, "no replacement");
  } finally {
    await rig.close();
  }
});

test("loop-guard: a plain root steer is sent without recovery, so a slow child is never stranded", { timeout: 180_000 }, async () => {
  const rig = await startRig(30_000, { loopGuard: true });
  try {
    const id = await launchBlockedChild(rig);
    const out = await prompt(rig, `STEER ${id}`, 60_000);
    console.log(`[guard] ${out}`);
    assert.doesNotMatch(out, /paused|recovered|failed/i);
    await waitForCondition(() => (status(rig, id).state === "complete" ? true : undefined), 90_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steer reached the child at its boundary");
    assert.equal(existsSync(claimPath(rig, id)), false);
    assert.equal(runIds(rig).length, 1, "no replacement");
  } finally {
    await rig.close();
  }
});
