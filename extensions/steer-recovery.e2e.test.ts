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
import { cleanupAllAfterExit, expectDetachedRuns, freshDir, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, startPiRpc, waitForCondition, waitForDetachedWriters, type PiRpcSession } from "./loop-guard/rpc-test-helpers.ts";
import { adoptNopushLauncher } from "./test-support/lane-agents.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BLOCK_EXTENSION = join(HERE, "test-support/block-sync-extension.ts");
const HOLD_EXTENSION = join(HERE, "test-support/hold-after-reply-extension.ts");
const CHILD_MARKER = "STEER_PROBE_CHILD_PROMPT";
after(() => cleanupAllAfterExit(60_000));

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
  /** The child's first reply is a malformed acceptance-report instead of a `block_sync` call. */
  childReport: boolean;
  /** Set once that reply has been sent. */
  reportSent: boolean;
  holdNextWake: boolean;
  wakeHeld: boolean;
  releaseWake(): void;
}

const ACCEPTANCE_REPORT_REPLY = "CHILD_REPORTED\n```acceptance-report\nnot json\n```";

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

async function startPeer(childBlockMs: number, childFirstDelayMs = 0, childReport = false): Promise<Peer> {
  const peer = { rootOutputs: [], childInputs: [], childBlockMs, childFirstDelayMs, childReport, reportSent: false } as unknown as Peer;
  peer.holdNextWake = false;
  peer.wakeHeld = false;
  peer.releaseWake = () => {};
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
      else if (peer.childReport) {
        // Any acceptance-report fence locks the child's queue, a malformed body included.
        item = text(ACCEPTANCE_REPORT_REPLY);
        peer.reportSent = true;
      } else {
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
      if (JSON.stringify(last).includes("Background task completed:")) {
        if (peer.holdNextWake) {
          peer.holdNextWake = false;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            peer.releaseWake = () => { clearTimeout(timer); resolve(); };
            peer.wakeHeld = true;
          });
        }
        item = text("WAKE_DONE");
      } else if (prompt.includes("LAUNCH")) item = call("subagent", { agent: "scout", task: "CHILD_TASK", async: true, worktree: false });
      else if (steer) item = call("subagent", { action: "steer", id: steer[1], message: "STEER_MSG", options: { steeringRecovery: !prompt.includes("NORECOVERY") } });
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

interface Rig { peer: Peer; root: PiRpcSession; runsDir: string; tempRoot: string; expectedRuns: number; cwd: string; close(): Promise<void> }

async function startRig(childBlockMs: number, opts: { loopGuard?: boolean; childFirstDelayMs?: number; childReport?: boolean } = {}): Promise<Rig> {
  const peer = await startPeer(childBlockMs, opts.childFirstDelayMs, opts.childReport);
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
  writeFileSync(join(home, "agents/scout.md"), `---\nname: scout\ndescription: Steering probe\ntools: block_sync\nextensions: ${BLOCK_EXTENSION}${opts.childReport ? `, ${HOLD_EXTENSION}` : ""}\nmodel: fixture/fixture\n---\n${CHILD_MARKER}\n`);
  // Launch as an installed home does: the root guard pins every lane launch to the nopush launcher.
  adoptNopushLauncher(home);
  const root = startPiRpc({
    extensions: opts.loopGuard ? [ROOT_EXTENSION] : [],
    extraArgs: ["--provider", "fixture", "--model", "fixture"],
    sessionArgs: [], agentDir: home, subagentTempRoot: tempRoot, cwd, fauxScriptPath: "",
  });
  // Even a failed first request must retain unexpected writers for diagnosis.
  expectDetachedRuns(tempRoot, 0);
  const rig: Rig = {
    peer, root, cwd, tempRoot, expectedRuns: 0, runsDir: join(tempRoot, "async-subagent-runs"),
    async close() {
      await root.close();
      // Native terminal receipts, writer closure and session-lease release precede cleanup.
      // On uncertainty cleanupAllAfterExit retains every directory for diagnosis.
      try { await waitForDetachedWriters(tempRoot, rig.expectedRuns, 60_000); }
      finally {
        peer.server.closeAllConnections();
        await new Promise<void>((resolve) => peer.server.close(() => resolve()));
      }
    },
  };
  return rig;
}

let promptSeq = 0;
async function prompt(rig: Rig, message: string, timeoutMs = 60_000, queueWhileBusy = true): Promise<string> {
  const id = `p${++promptSeq}`;
  const before = rig.root.events.length;
  const priorRuns = new Set(runIds(rig));
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const subsequent = (event: PiRpcSession["events"][number]) => rig.root.events.indexOf(event) >= before;
  rig.root.send({ type: "prompt", id, message, ...(queueWhileBusy ? { streamingBehavior: "followUp" } : {}) });
  const accepted = await rig.root.waitFor((event) => event.type === "response" && event.id === id && event.command === "prompt", remaining());
  assert.equal(accepted.success, true, `RPC ${id}: ${accepted.error ?? JSON.stringify(accepted)}`);
  assert.notEqual((accepted.data as { disposition?: string } | undefined)?.disposition, "handled", `RPC ${id} did not start or queue model work`);

  // Completion wakes have their own turns. Correlate the requested action and its toolCallId;
  // neither another turn's agent_end nor prompt acceptance proves the tool executed.
  const action = message.split(" ")[0];
  const target = message.split(" ")[1];
  const started = await rig.root.waitFor((event) => {
    if (!subsequent(event) || event.type !== "tool_execution_start" || event.toolName !== "subagent") return false;
    const args = event.args as Record<string, unknown>;
    return action === "LAUNCH"
      ? args.agent === "scout" && args.task === "CHILD_TASK" && args.async === true
      : args.action === action.toLowerCase() && args.id === target && args.message === `${action}_MSG`;
  }, remaining());
  const ended = await rig.root.waitFor((event) => subsequent(event) && event.type === "tool_execution_end" && event.toolCallId === started.toolCallId, remaining());
  const result = ended.result as { content?: { type: string; text?: string }[]; details?: { runId?: string } };
  const output = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  if (action === "LAUNCH" || action === "RESUME") {
    assert.notEqual(ended.isError, true, `RPC ${id} tool failed: ${output}`);
    const runId = result.details?.runId;
    assert.ok(runId && !priorRuns.has(runId), `RPC ${id} did not report a new run: ${output}`);
    // Register only an actually executed launch. Unknown extra runs still fail the exact-count
    // writer barrier, retaining their directories instead of silently treating them as absent.
    await waitForCondition(() => runIds(rig).includes(runId) ? true : undefined, remaining());
    rig.expectedRuns += 1;
    expectDetachedRuns(rig.tempRoot, rig.expectedRuns);
  }
  await rig.root.waitFor((event) => event.type === "agent_end" && subsequent(event)
    && (event.messages as { role?: string; toolCallId?: string }[] | undefined)?.some((item) => item.role === "toolResult" && item.toolCallId === started.toolCallId) === true, remaining());
  return output;
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
    console.log(`[timeout] child paused ${paused.endedAt - started} ms after the steer; claim present=${existsSync(claimPath(rig, id))}; state=${paused.state}; runs=${runIds(rig).length}`);
    // The no-strand removal hypothesis fails on these pins: recovery is still unsafe.
    assert.equal(paused.state, "paused");
    assert.ok(elapsed >= 15_000 && elapsed < 30_000, `recovery timed out before the slow boundary (${elapsed} ms)`);
    assert.equal(runIds(rig).length, 1, "no replacement was launched");
    assert.ok(!rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steering message was never applied");
    // Explicit resume continues the paused child; its saved work survives.
    const resumed = await prompt(rig, `RESUME ${id}`);
    console.log(`[timeout] resume: ${resumed}`);
    await waitForCondition(() => (runIds(rig).length === 2 ? true : undefined), 30_000);
    await waitForCondition(() => (rig.peer.childInputs.some((text) => text.includes("RESUME_MSG")) ? true : undefined), 30_000);
    const revivedId = runIds(rig).find((runId) => runId !== id)!;
    await waitForCondition(() => (status(rig, revivedId).state === "complete" ? true : undefined), 30_000);
    assert.equal(status(rig, id).state, "paused", "only explicit resume replaces the stranded run");
    console.log(`[timeout] after explicit resume: source=${status(rig, id).state}; revived=${status(rig, revivedId).state}; runs=${runIds(rig).length}`);
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

test("loop-guard: even an explicit recovery request is disabled, so a slow child is never stranded", { timeout: 180_000 }, async () => {
  const rig = await startRig(30_000, { loopGuard: true });
  try {
    const id = await launchBlockedChild(rig);
    const out = await prompt(rig, `STEER ${id}`, 60_000);
    console.log(`[guard] ${out}`);
    assert.doesNotMatch(out, /paused|recovered|failed/i);
    await waitForCondition(() => (status(rig, id).state === "complete" ? true : undefined), 90_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steer reached the child at its boundary");
    assert.equal(existsSync(claimPath(rig, id)), false);
    assert.equal(existsSync(join(rig.runsDir, id, "control", "interrupt.json")), false);
    assert.equal(runIds(rig).length, 1, "no replacement");
    console.log(`[guard] terminal state=${status(rig, id).state}; runs=${runIds(rig).length}; steer_seen=true`);
  } finally {
    await rig.close();
  }
});

test("RPC rejection during a native completion wake is reported without inventing a resumed run", { timeout: 60_000 }, async () => {
  const rig = await startRig(0, { childFirstDelayMs: 1_000 });
  rig.peer.holdNextWake = true;
  try {
    const id = await launchBlockedChild(rig);
    await waitForCondition(() => rig.peer.wakeHeld ? true : undefined, 30_000);
    const before = rig.root.events.length;
    await assert.rejects(prompt(rig, `RESUME ${id}`, 2_000, false), /Agent is already processing/);
    assert.equal(rig.expectedRuns, 1, "a rejected RPC request cannot create a run expectation");
    assert.equal(runIds(rig).length, 1);
    rig.peer.releaseWake();
    await rig.root.waitFor((event) => event.type === "agent_end" && rig.root.events.indexOf(event) >= before, 5_000);
    assert.equal(rig.root.events.slice(before).some((event) => event.type === "tool_execution_start"
      && (event.args as { action?: string } | undefined)?.action === "resume"), false,
      "the unrelated wake agent_end must not turn a rejected RESUME into success");
  } catch (error) {
    console.error("Native wake rejection regression:", error);
    throw error;
  } finally {
    rig.peer.releaseWake();
    await rig.close();
  }
});

test("RESUME queued behind a native completion wake waits for its own tool result and new run", { timeout: 90_000 }, async () => {
  const rig = await startRig(0, { childFirstDelayMs: 1_000 });
  rig.peer.holdNextWake = true;
  try {
    const id = await launchBlockedChild(rig);
    await waitForCondition(() => rig.peer.wakeHeld ? true : undefined, 30_000);
    const requestId = `p${promptSeq + 1}`;
    const resumed = prompt(rig, `RESUME ${id}`);
    // Attach immediately so a failed acceptance assertion cannot leave an unhandled rejection.
    void resumed.catch(() => {});
    const accepted = await rig.root.waitFor((e) => e.type === "response" && e.id === requestId, 5_000);
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    assert.equal(rig.expectedRuns, 1, "queued acceptance is not RESUME execution");
    assert.equal(runIds(rig).length, 1);
    rig.peer.releaseWake();
    const output = await resumed;
    assert.match(output, /Revived async subagent/);
    assert.equal(rig.expectedRuns, 2);
    assert.equal(runIds(rig).length, 2);
    const revivedId = runIds(rig).find((runId) => runId !== id)!;
    await waitForCondition(() => status(rig, revivedId).state === "complete" ? true : undefined, 30_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("RESUME_MSG")));
    assert.ok(existsSync(join(rig.cwd, "saved-work.txt")));
  } finally {
    rig.peer.releaseWake();
    await rig.close();
  }
});

// pi-subagents 0.88.0 locks a child's queue once its final reply (stopReason "stop") carries an
// `acceptance-report` fence, a malformed one included: the queue is cleared and steer/followUp throw.
// The child here answers with a malformed fence and then stays live for a few seconds (the
// hold-after-reply extension), the window in which the root can still steer it.
test("acceptance-report lock: a steer to a reported child is rejected without a restart, and resume of the lane works", { timeout: 120_000 }, async () => {
  const rig = await startRig(0, { childReport: true });
  try {
    await prompt(rig, "LAUNCH");
    const id = await waitForCondition(() => runIds(rig)[0], 30_000);
    await waitForCondition(() => (rig.peer.reportSent ? true : undefined), 30_000, 50);
    // The default steer asks for steering recovery (an interrupt plus a restart on a failed
    // acknowledgement), so a restart here would show up as a second run or a recovery claim.
    const out = await prompt(rig, `STEER ${id}`);
    console.log(`[report-lock] steer: ${out}`);
    assert.match(out, /Steering failed for async run/);
    const rejected = await waitForCondition(() => {
      const target = status(rig, id).steering?.recent?.[0]?.targets?.[0];
      return target?.state === "failed" ? target : undefined;
    }, 30_000, 50);
    console.log(`[report-lock] target: ${JSON.stringify(rejected)}`);
    assert.equal(rejected.failureKind, "rejected");
    assert.match(rejected.reason, /Child completed its acceptance report; resume it for further guidance\./);
    await waitForCondition(() => (status(rig, id).state === "complete" ? true : undefined), 60_000);
    assert.equal(status(rig, id).steering.recent[0].targets[0].failureKind, "rejected", "settling keeps the rejection");
    assert.ok(!rig.peer.childInputs.some((text) => text.includes("STEER_MSG")), "the steer never reached the child");
    assert.equal(existsSync(claimPath(rig, id)), false, "no recovery claim");
    assert.equal(existsSync(join(rig.runsDir, id, "control", "interrupt.json")), false, "no interrupt");
    assert.equal(runIds(rig).length, 1, "the run was not restarted");

    // The lock is on that live session only: resuming the same lane starts a fresh child.
    const resumed = await prompt(rig, `RESUME ${id}`);
    assert.match(resumed, /Revived async subagent/);
    const revivedId = runIds(rig).find((runId) => runId !== id)!;
    await waitForCondition(() => (status(rig, revivedId).state === "complete" ? true : undefined), 60_000);
    assert.ok(rig.peer.childInputs.some((text) => text.includes("RESUME_MSG")), "the resumed child received the repair");
    assert.equal(runIds(rig).length, 2);
  } finally {
    await rig.close();
  }
});
