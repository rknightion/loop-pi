// Characterise a live watch across a real pi root crash/restart, not just a dead orphan.
// The command has no output after the crash: inherited stdout pipes cannot be recovered.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { isProcessAlive, killProcessTree, readReceipt, receiptPathFor, runDirFor, type Receipt } from "./core.ts";
import { cleanupAll, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, startPiRpc, writeFauxScript, type PiRpcSession } from "./test-helpers.ts";

after(cleanupAll);

async function crash(session: PiRpcSession): Promise<void> {
  const exited = new Promise<void>((resolve) => session.child.once("exit", () => resolve()));
  session.child.kill("SIGKILL");
  await exited;
}

async function awaitReceipt(path: string, predicate: (receipt: Receipt) => boolean): Promise<Receipt> {
  for (let i = 0; i < 200; i++) {
    const receipt = readReceipt(path);
    if (receipt && predicate(receipt)) return receipt;
    await delay(50);
  }
  assert.fail(`receipt did not reach the expected state: ${JSON.stringify(readReceipt(path))}`);
}

test("a live watcher is adopted across root lifetimes and pushes its completion with cumulative receipts", { timeout: 60_000 }, async () => {
  const projectDir = freshDir("loop-wait-restart-project-");
  const storeDir = freshDir("loop-wait-restart-store-");
  const releasePath = join(projectDir, "release");
  const sessionId = "live-restart-run";
  const sessionArgs = ["--session-dir", storeDir, "--session-id", sessionId];
  // A file barrier, rather than a sleep duration, ensures the watcher cannot finish before
  // adoption has actually been observed. Cleanup releases/kills it even on assertion failure.
  const script = writeFauxScript([
    { match: "START_LIVE_WATCH", once: true, toolCalls: [{ name: "watch_start", args: {
      command: `while [ ! -f '${releasePath}' ]; do sleep 0.1; done; exit 7`,
      deadline_s: 45, interval_s: 1, label: "live-restart",
    } }] },
    { match: ".*", text: "ack" },
  ]);
  const first = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: script, sessionArgs, sessionDir: projectDir });
  let second: PiRpcSession | undefined;
  let pid: number | null = null;
  try {
    const turns = ["START_LIVE_WATCH", "OBSERVE_ONE", "OBSERVE_TWO"];
    for (const [i, message] of turns.entries()) {
      const from = first.events.length;
      first.send({ id: `turn-${i}`, type: "prompt", message });
      await first.waitForResponse(`turn-${i}`);
      await first.waitFor((e) => e.type === "agent_settled" && first.events.indexOf(e) >= from);
    }
    const started = first.events.find((e) => e.type === "tool_execution_end" && e.toolName === "watch_start");
    assert.ok(started);
    const id = (started.result as { details: { id: string } }).details.id;
    const receiptPath = receiptPathFor(runDirFor(first.agentDir, sessionId), id);
    const before = await awaitReceipt(receiptPath, (r) => r.phase === "running" && r.observations >= 2);
    pid = before.pid;
    assert.ok(pid && isProcessAlive(pid));

    // SIGKILL deliberately bypasses session_shutdown, which cancels watches by design.
    await crash(first);
    assert.ok(isProcessAlive(pid), "the watched process must outlive the first root");
    const afterCrash = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
    assert.equal(afterCrash.phase, "running");

    second = startPiRpc({ extensions: [FAUX_EXTENSION, ROOT_EXTENSION], fauxScriptPath: writeFauxScript([{ match: ".*", text: "ack" }]), sessionArgs, sessionDir: projectDir, agentDir: first.agentDir });
    const adopted = await awaitReceipt(receiptPath, (r) => r.note === "adopted on reconcile");
    assert.equal(adopted.pid, pid, "adoption must retain the original watched process");
    assert.ok(adopted.observations > before.observations, "the first lifetime's observations must survive adoption");
    const polled = await awaitReceipt(receiptPath, (r) => r.note?.startsWith("adopted: liveness poll") === true);
    assert.ok(polled.observations > adopted.observations, "the second root must continue heartbeating");
    const releaseIndex = second.events.length;
    writeFileSync(releasePath, "release");
    const pushed = await second.waitFor((e) => e.type === "message_start" && (e.message as { customType?: string })?.customType === "loop-watch", 15_000);
    const message = pushed.message as { content: string; details: { id: string; receipt: Receipt } };
    assert.equal(message.details.id, id);
    assert.match(message.content, /phase=done exit_code=null deadline_hit=false/);
    assert.match(message.content, /adopted watcher no longer running \(exit code unknown\)/);
    const final = readReceipt(receiptPath)!;
    assert.deepEqual(message.details.receipt, final, "the push must carry the final on-disk receipt");
    assert.ok(final.observations > polled.observations);
    assert.equal(final.result?.exit_code, null, "an adopted non-child's exit status is unavailable, not success");
    assert.equal(final.result?.deadline_hit, false);
    assert.equal(second.events.slice(releaseIndex, second.events.indexOf(pushed)).filter((e) => e.type === "message_start" && (e.message as { role?: string })?.role === "assistant").length, 0, "completion is pushed without another user or assistant turn");
    await second.waitFor((e) => e.type === "agent_settled" && second!.events.indexOf(e) > second!.events.indexOf(pushed));

    second.send({ id: "entries", type: "get_entries" });
    const entries = (await second.waitForResponse("entries")).data as { entries: { type: string; message?: { role?: string; content?: unknown }; customType?: string; data?: unknown }[] };
    for (const turn of turns) assert.ok(JSON.stringify(entries).includes(turn), `the resumed session must retain ${turn}`);
    const states = entries.entries.filter((e) => e.type === "custom" && e.customType === "loop-wait-state");
    assert.ok(states.some((e) => (e.data as { watchers: { id: string }[] }).watchers.some((w) => w.id === id)));
    assert.deepEqual((states.at(-1)!.data as { watchers: unknown[] }).watchers, [], "completion must remove the adopted watcher from persisted state");
    // TAP captures neutral fixture receipts and the persisted session entries for proof receipts.
    console.log(JSON.stringify({ verdict: "adopted", before, afterCrash, adopted, polled, final, entries: entries.entries }));
  } finally {
    writeFileSync(releasePath, "cleanup");
    if (pid) killProcessTree(pid, { group: true, force: true });
    await first.close();
    await second?.close();
  }
});
