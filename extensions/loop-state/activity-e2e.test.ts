// Real faux-provider root processes: lifecycle rows, crash/restart replay, and an exact
// heartbeat boundary. The clock fixture controls wall time only, never synthesizes activity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupAll, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, startPiRpc, writeFauxScript, type PiRpcSession } from "../loop-wait/test-helpers.ts";
import { killProcessTree } from "../loop-wait/core.ts";

const STATE = join(import.meta.dirname, "index.ts");
const BIN = join(import.meta.dirname, "..", "..", "bin", "loop-state");
after(cleanupAll);

function scaffold() {
  const dir = freshDir("loop-activity-project-");
  const agentDir = freshDir("loop-activity-agent-");
  const store = freshDir("loop-activity-store-");
  const log = join(dir, "state-proof.jsonl");
  const stub = join(dir, "launch.ts");
  mkdirSync(join(agentDir, "bin"));
  symlinkSync(BIN, join(agentDir, "bin", "loop-state"));
  writeFileSync(stub, `export default function(pi) {
    pi.events.on("loop-continuation:query-launch", d => d.reply({reportPath: ${JSON.stringify(join(dir, "report-proof.md"))}}));
  }`);
  const sessionArgs = ["--session-dir", store, "--session-id", "activity-proof"];
  return { dir, agentDir, log, stub, sessionArgs };
}
function rows(log: string): any[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await delay(40);
  }
  assert.fail("activity state did not reach the expected outcome");
}
async function prompt(s: PiRpcSession, id: string, message: string) {
  const from = s.events.length;
  s.send({ id, type: "prompt", message });
  await s.waitForResponse(id);
  await s.waitFor(e => e.type === "agent_settled" && s.events.indexOf(e) >= from);
}
async function crash(s: PiRpcSession) {
  const exited = new Promise<void>(r => s.child.once("exit", () => r()));
  s.child.kill("SIGKILL");
  await exited;
}

test("real watch tools record starts, terminal stops, cancellation, and restart without duplicate rows", { timeout: 60_000 }, async () => {
  const s = scaffold();
  const extensions = [FAUX_EXTENSION, s.stub, STATE, ROOT_EXTENSION];
  const at = new Date(Date.now() + 40_000).toISOString();
  const lostAck = join(s.dir, "lost-ack.ts");
  writeFileSync(lostAck, `export default function(pi) {
    pi.events.on("loop-wait:state-event", d => { d.reply = () => {}; });
  }`);
  const first = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, lostAck, STATE, ROOT_EXTENSION], ...s, sessionDir: s.dir, fauxScriptPath: writeFauxScript([
    { match: "ARM", once: true, toolCalls: [
      { name: "watch_start", args: { command: "sleep 35", deadline_s: 40, interval_s: 1, label: "cancel-proof" } },
      { name: "wake_at", args: { at, reason: "cancel-timer-proof" } },
    ] }, { match: ".*", text: "ack" },
  ]) });
  let second: PiRpcSession | undefined;
  let third: PiRpcSession | undefined;
  let pid: number | undefined;
  try {
    await prompt(first, "arm", "ARM");
    await until(() => rows(s.log).filter(r => r.ev === "watch" && r.op === "start").length === 2);
    const toolResult = (name: string) => first.events.find(e => e.type === "tool_execution_end" && e.toolName === name)!.result as { details: { id: string } };
    first.send({ id: "pending", type: "get_entries" });
    const pending = (await first.waitForResponse("pending")).data as { entries: any[] };
    const snapshot = pending.entries.filter(e => e.type === "custom" && e.customType === "loop-wait-state").at(-1).data;
    assert.equal(snapshot.pendingEvents.length, 2, "lost acknowledgements leave both recorded starts durable for replay");
    const watchId = toolResult("watch_start").details.id;
    const timerId = toolResult("wake_at").details.id;
    const receipt = join(s.agentDir, "loop-wait", "activity-proof", "receipts", watchId + ".json");
    pid = JSON.parse(readFileSync(receipt, "utf8")).pid;
    await crash(first);
    second = startPiRpc({ extensions, ...s, sessionDir: s.dir, fauxScriptPath: writeFauxScript([
      { match: "END", once: true, toolCalls: [
        { name: "watch_stop", args: { id: watchId } },
        { name: "wake_cancel", args: { id: timerId.slice(0, 8) } },
        { name: "wake_at", args: { at: new Date(Date.now() - 1000).toISOString(), reason: "fire-proof" } },
        { name: "watch_start", args: { command: "printf done", deadline_s: 5, interval_s: 1, label: "exit-proof" } },
        { name: "watch_start", args: { command: "sleep 10", deadline_s: 1, interval_s: 1, label: "deadline-proof" } },
      ] }, { match: ".*", text: "ack" },
    ]) });
    await prompt(second, "end", "END");
    await until(() => rows(s.log).filter(r => r.ev === "watch" && r.op === "stop").length === 5);
    const watches = rows(s.log).filter(r => r.ev === "watch");
    assert.equal(watches.length, 10, "all five instances have exactly one start and stop, including rearmed timers");
    for (const start of watches.filter(r => r.op === "start")) {
      const stop = watches.filter(r => r.op === "stop" && r.what === start.what);
      assert.equal(stop.length, 1);
      assert.equal(stop[0].deadline, start.deadline);
      assert.equal(start.by, "ext");
      assert.deepEqual(Object.keys(start).sort(), ["by", "deadline", "ev", "op", "seq", "ts", "v", "what"]);
      assert.ok(stop[0].seq > start.seq);
    }
    execFileSync(BIN, ["check", s.log]);
    assert.match(execFileSync(BIN, ["digest", s.log], { encoding: "utf8" }), /## Root watches \(0\)/);
    await crash(second);
    third = startPiRpc({ extensions, ...s, sessionDir: s.dir, fauxScriptPath: writeFauxScript([{ match: ".*", text: "ack" }]) });
    await prompt(third, "after", "AFTER");
    await delay(200);
    assert.deepEqual(rows(s.log).filter(r => r.ev === "watch"), watches, "restarting after completion neither loses nor duplicates terminal events");
  } finally {
    if (pid) killProcessTree(pid, { group: true, force: true });
    await first.close();
    await second?.close();
    await third?.close();
  }
});

for (const fault of ["unwritten-start", "lost-start-ack"] as const) {
  test(`causal outbox: ${fault} cannot be overtaken by an available stop; restart digest stays stopped`, { timeout: 40_000 }, async () => {
    const s = scaffold();
    const attempts = join(s.dir, "append-attempts.jsonl");
    const released = join(s.dir, "release-append");
    const bin = join(s.agentDir, "bin", "loop-state");
    unlinkSync(bin);
    // The real append CLI remains behind this fault boundary. Only the target start fails
    // before writing; a stop would succeed, exposing independent-event transport ordering.
    writeFileSync(bin, `#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
if not args or args[0] != "append":
    os.execv(${JSON.stringify(BIN)}, [${JSON.stringify(BIN)}] + args)
payload = sys.stdin.read()
event = json.loads(payload)
target = event.get("ev") == "watch" and "fault-proof" in event.get("what", "")
blocked = target and event.get("op") == "start" and ${fault === "unwritten-start" ? "True" : "False"} and not os.path.exists(${JSON.stringify(released)})
if target:
    with open(${JSON.stringify(attempts)}, "a") as fh:
        fh.write(json.dumps({"op": event["op"], "blocked": blocked}) + "\\n")
if blocked:
    sys.stderr.write("injected start failure before any append\\n")
    sys.exit(2)
result = subprocess.run([${JSON.stringify(BIN)}] + args, input=payload, text=True, timeout=15)
sys.exit(result.returncode)
`, { mode: 0o755 });
    const fixture = join(s.dir, "fault-controls.ts");
    writeFileSync(fixture, `export default function(pi) {
      ${fault === "lost-start-ack" ? `pi.events.on("loop-wait:state-event", d => {
        if (d.event.op !== "start" || !d.event.what.includes("fault-proof")) return;
        const reply = d.reply;
        d.reply = pending => reply(pending.then(() => false));
      });` : ""}
      pi.registerTool({name: "test_cancel_target", label: "Cancel target fixture", description: "Cancel the fault-test timer through the real tool",
        parameters: {type: "object", properties: {}, additionalProperties: false},
        async execute(_id, _args, _signal, _update, ctx) {
          let timers = [];
          pi.events.emit("loop-wait:query-timers", {reply: t => { timers = t; }});
          const target = timers.find(t => t.reason === "fault-proof");
          if (!target) throw new Error("missing fault-test timer");
          return ctx.executeTool("wake_cancel", {id: target.id});
        }
      });
    }`);
    const first = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, fixture, STATE, ROOT_EXTENSION], ...s, sessionDir: s.dir,
      fauxScriptPath: writeFauxScript([
        { match: "ARM", once: true, toolCalls: [
          { name: "wake_at", args: { at: new Date(Date.now() + 30_000).toISOString(), reason: "fault-proof" } },
          { name: "wake_at", args: { at: new Date(Date.now() + 30_000).toISOString(), reason: "unrelated-proof" } },
        ] },
        { match: "END", once: true, toolCalls: [{ name: "test_cancel_target", args: {} }] },
        { match: ".*", text: "ack" },
      ]),
    });
    let second: PiRpcSession | undefined;
    let third: PiRpcSession | undefined;
    const targetRows = () => rows(s.log).filter(r => r.ev === "watch" && r.what.includes("fault-proof"));
    try {
      await prompt(first, "arm", "ARM");
      await prompt(first, "end", "END");
      const cancel = first.events.find(e => e.type === "tool_execution_end" && e.toolName === "wake_cancel");
      assert.ok(cancel && (cancel.result as { details: { cancelled: boolean } }).details.cancelled, "the real wake_cancel terminated the timer");
      first.send({ id: "outbox", type: "get_entries" });
      const stored = (await first.waitForResponse("outbox")).data as { entries: any[] };
      const pending = stored.entries.filter(e => e.type === "custom" && e.customType === "loop-wait-state").at(-1).data.pendingEvents;
      assert.deepEqual(pending.filter((e: any) => e.what.includes("fault-proof")).map((e: any) => e.op), ["start", "stop"], "failed or unacknowledged start and its stop remain durable in causal order");
      const attempted = rows(attempts);
      assert.ok(attempted.some(r => r.op === "start"));
      assert.equal(attempted.filter(r => r.op === "stop").length, 0, "the available successful stop must not overtake the failed/unacknowledged start");
      assert.equal(targetRows().length, fault === "unwritten-start" ? 0 : 1);
      assert.ok(rows(s.log).some(r => r.ev === "watch" && r.op === "start" && r.what.includes("unrelated-proof")), "one blocked instance does not block unrelated lifecycles");
      await crash(first);
      writeFileSync(released, "release");
      second = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, STATE, ROOT_EXTENSION], ...s, sessionDir: s.dir,
        fauxScriptPath: writeFauxScript([{ match: ".*", text: "ack" }]),
      });
      await until(() => targetRows().some(r => r.op === "stop"));
      const terminal = targetRows();
      assert.deepEqual(terminal.map(r => r.op), ["start", "stop"], "replay writes start before stop and deduplicates a start already written before ACK loss");
      assert.equal(terminal[0].what, terminal[1].what);
      assert.equal(terminal[0].deadline, terminal[1].deadline);
      execFileSync(BIN, ["check", s.log]);
      const digest = execFileSync(BIN, ["digest", s.log], { encoding: "utf8" });
      assert.doesNotMatch(digest, /fault-proof/, "a stopped instance is not reopened in the actual CLI recovery digest");
      await crash(second);
      third = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, STATE, ROOT_EXTENSION], ...s, sessionDir: s.dir,
        fauxScriptPath: writeFauxScript([{ match: ".*", text: "ack" }]),
      });
      await prompt(third, "after-replay", "AFTER_REPLAY");
      assert.deepEqual(targetRows(), terminal, "another restart cannot duplicate or reopen the stopped instance");
      assert.doesNotMatch(execFileSync(BIN, ["digest", s.log], { encoding: "utf8" }), /fault-proof/);
    } finally {
      await first.close();
      await second?.close();
      await third?.close();
    }
  });
}

test("missing recorder keeps a durable timer outbox, replay and orderly shutdown record suppressed stops", { timeout: 40_000 }, async () => {
  const s = scaffold();
  const future = new Date(Date.now() + 25_000).toISOString();
  const first = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, ROOT_EXTENSION], ...s, sessionDir: s.dir,
    fauxScriptPath: writeFauxScript([
      { match: "ARM", once: true, toolCalls: [{ name: "wake_at", args: { at: future, reason: "missing-recorder" } }] },
      { match: ".*", text: "ack" },
    ]),
  });
  let second: PiRpcSession | undefined;
  try {
    await prompt(first, "arm", "ARM");
    assert.deepEqual(rows(s.log), [], "no recorder means no invented log rows");
    await crash(first);
    second = startPiRpc({ extensions: [FAUX_EXTENSION, s.stub, ROOT_EXTENSION, STATE], ...s, sessionDir: s.dir,
      fauxScriptPath: writeFauxScript([
        { match: "WATCH", once: true, toolCalls: [{ name: "watch_start", args: { command: "sleep 20", deadline_s: 25, interval_s: 1, label: "shutdown-proof" } }] },
        { match: ".*", text: "ack" },
      ]),
    });
    await until(() => rows(s.log).some(r => r.ev === "watch" && r.op === "start" && r.what.includes("missing-recorder")));
    await prompt(second, "watch", "WATCH");
    await second.close();
    await until(() => rows(s.log).filter(r => r.ev === "watch" && r.op === "stop").length === 2);
    const watches = rows(s.log).filter(r => r.ev === "watch");
    assert.equal(watches.length, 4);
    assert.equal(watches.filter(r => r.op === "start").length, 2);
    execFileSync(BIN, ["check", s.log]);
    assert.match(execFileSync(BIN, ["digest", s.log], { encoding: "utf8" }), /## Root watches \(0\)/);
  } finally {
    await first.close();
    await second?.close();
  }
});

for (const pendingRestart of [false, true]) {
test(`real root activity heartbeats respect the 5-minute boundary and persisted log across restart, never idle${pendingRestart ? " with pending restart append" : ""}`, { timeout: 40_000 }, async () => {
  const s = scaffold();
  const clockFile = join(s.dir, "clock");
  const base = Date.now();
  const appendStarted = join(s.dir, "restart-append-started");
  const appendRelease = join(s.dir, "restart-append-release");
  writeFileSync(clockFile, String(base));
  const clock = join(s.dir, "clock-extension.ts");
  writeFileSync(clock, `import {readFileSync} from "node:fs";
    export default function() { Date.now = () => Number(readFileSync(${JSON.stringify(clockFile)}, "utf8")); }`);
  const opts = { extensions: [FAUX_EXTENSION, s.stub, clock, STATE], ...s, sessionDir: s.dir, fauxScriptPath: writeFauxScript([{ match: ".*", text: "ack" }]) };
  const first = startPiRpc(opts);
  let second: PiRpcSession | undefined;
  try {
    // get_state waits for startup without starting an agent turn.
    first.send({ id: "ready", type: "get_state" });
    await first.waitForResponse("ready");
    await delay(150);
    assert.equal(rows(s.log).length, 0, "session startup is not root activity");
    await prompt(first, "one", "ONE");
    await until(() => rows(s.log).length === 1);
    assert.equal(rows(s.log)[0].at, new Date(base).toISOString());
    writeFileSync(clockFile, String(base + 299_999));
    await prompt(first, "before", "BEFORE");
    await delay(150);
    assert.equal(rows(s.log).length, 1, "299999 ms is below the boundary");
    writeFileSync(clockFile, String(base + 300_000));
    await delay(200);
    assert.equal(rows(s.log).length, 1, "crossing the boundary while idle does not emit a heartbeat");
    await prompt(first, "boundary", "BOUNDARY");
    await until(() => rows(s.log).length === 2);
    assert.equal(rows(s.log)[1].at, new Date(base + 300_000).toISOString());
    await crash(first);
    if (pendingRestart) {
      const localCli = join(s.agentDir, "bin", "loop-state");
      unlinkSync(localCli); // Own fixture link: retain the genuine CLI without overwriting it.
      writeFileSync(localCli, `#!/usr/bin/env python3
import json, pathlib, subprocess, sys, time
payload = sys.stdin.buffer.read()
try:
    event = json.loads(payload)
except ValueError:
    event = {}
if event.get("ev") == "heartbeat" and event.get("at") == ${JSON.stringify(new Date(base + 300_001).toISOString())}:
    pathlib.Path(${JSON.stringify(appendStarted)}).write_text("pending")
    for _ in range(900):
        if pathlib.Path(${JSON.stringify(appendRelease)}).exists():
            break
        time.sleep(0.01)
    else:
        sys.exit(1)
sys.exit(subprocess.run([${JSON.stringify(BIN)}, *sys.argv[1:]], input=payload).returncode)
`, { mode: 0o755 });
    }
    writeFileSync(clockFile, String(base + 300_001));
    second = startPiRpc(opts);
    await prompt(second, "restart", "RESTART");
    if (pendingRestart) await until(() => existsSync(appendStarted));
    await delay(150);
    assert.equal(rows(s.log).length, 2, "restart does not reset the persisted throttle");
    writeFileSync(clockFile, String(base + 600_000));
    await prompt(second, "next", "NEXT");
    if (pendingRestart) {
      assert.equal(rows(s.log).length, 2, "queued activity cannot invent a row before the pending CLI settles");
      writeFileSync(appendRelease, "release");
    }
    await until(() => rows(s.log).length === 3);
    assert.equal(rows(s.log)[2].at, new Date(base + 600_000).toISOString());
    assert.ok(rows(s.log).every(r => r.ev === "heartbeat" && r.by === "ext"));
    execFileSync(BIN, ["check", s.log]);
  } finally {
    if (pendingRestart) writeFileSync(appendRelease, "release");
    await first.close();
    await second?.close();
  }
});
}
