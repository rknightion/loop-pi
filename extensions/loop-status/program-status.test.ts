// The root's program status (program-status.ts): the decision table, the wrap on pi's terminal and
// the child records. The real path through an interactive pi on a pseudo-terminal is proved in
// program-status.e2e.test.ts; this pins every row and the seams in the pinned pi it relies on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { captureTui, childId, formatChildStatus, loopProgramStatus, OWNER_NEEDED_MESSAGE, REBUILD_HOLD_MS, RESUME_RECHECK_GRACE_MS, waitingNote, wrapProgramStatus, type LoopFacts } from "./program-status.ts";
import loopStatus from "./index.ts";

const idle: LoopFacts = { armed: true, closed: false, lanes: 0, nested: 0, timers: [], watchers: [], resumeDueAt: null };
const done: ProgramStatus = { state: "done", app: "pi", message: "session" };
const inAnHour = new Date(Date.now() + 3_600_000).toISOString();

test("a resting done becomes working while the loop waits on anything, and names what", () => {
  const cases: [string, Partial<LoopFacts>, RegExp][] = [
    ["a lane", { lanes: 1 }, /^Loop waiting on 1 lane$/],
    ["lanes with nested runs", { lanes: 2, nested: 3 }, /^Loop waiting on 2 lanes \(\+3 nested\)$/],
    ["only nested runs", { nested: 1 }, /^Loop waiting on 1 nested run$/],
    ["a timer", { timers: [{ at: inAnHour }] }, /^Loop waiting on 1 timer, next \d\d:\d\d$/],
    ["a watcher with a deadline", { watchers: [{ deadline: inAnHour }] }, /^Loop waiting on 1 watcher, next \d\d:\d\d$/],
    ["a watcher without one", { watchers: [{}] }, /^Loop waiting on 1 watcher$/],
  ];
  for (const [label, facts, message] of cases) {
    const out = loopProgramStatus(done, { ...idle, ...facts });
    assert.equal(out.state, "working", label);
    assert.equal(out.app, "pi", label);
    assert.match(String(out.message), message, label);
  }
});

test("a resting done with nothing pending asks for the owner; a closed loop's done is the finish", () => {
  assert.deepEqual(loopProgramStatus(done, idle), { state: "blocked", kind: "question", app: "pi", message: OWNER_NEEDED_MESSAGE });
  assert.deepEqual(loopProgramStatus(done, { ...idle, closed: true, lanes: 2 }), done);
});

test("an error, or the idle of a harness abort, is working only while an automatic resume is due", () => {
  const error: ProgramStatus = { state: "error", app: "pi", message: "fetch failed" };
  const aborted: ProgramStatus = { state: "idle", app: "pi" };
  for (const raw of [error, aborted]) {
    assert.deepEqual(loopProgramStatus(raw, idle), raw, raw.state);
    const out = loopProgramStatus(raw, { ...idle, resumeDueAt: Date.now() + 60_000 });
    assert.equal(out.state, "working", raw.state);
    assert.match(String(out.message), /^Loop retrying at \d\d:\d\d$/);
    const stale = Date.now() - RESUME_RECHECK_GRACE_MS - 1;
    assert.deepEqual(loopProgramStatus(raw, { ...idle, resumeDueAt: stale }), raw, `${raw.state}: a resume due long ago is stale`);
  }
});

test("working, blocked, an owner's idle and clear are pi's own, and an unarmed session is left alone", () => {
  for (const raw of [
    { state: "working", app: "pi" },
    { state: "blocked", kind: "permission", app: "pi", message: "Allow?" },
    { state: "idle", app: "pi" },
    { state: "clear" },
  ] as ProgramStatus[]) {
    assert.deepEqual(loopProgramStatus(raw, { ...idle, lanes: 1 }), raw, raw.state);
  }
  assert.deepEqual(loopProgramStatus(done, { ...idle, armed: false, lanes: 1 }), done);
  assert.equal(waitingNote(idle), null);
});

function fakeTerminal(supported = true) {
  const reports: ProgramStatus[] = [];
  const writes: string[] = [];
  const terminal = {
    programStatusSupported: supported,
    setProgramStatus: (status: ProgramStatus) => void reports.push(status),
    writeProgramStatus: () => void writes.push("<root>"),
    write: (data: string) => void writes.push(data),
  };
  return { terminal, reports, writes };
}

test("the wrap sends pi's report through the decision and never lets a waiting loop's done through", () => {
  const { terminal, reports } = fakeTerminal();
  let facts: LoopFacts = { ...idle, lanes: 1 };
  wrapProgramStatus({ terminal } as never, () => facts);
  terminal.setProgramStatus({ state: "working", app: "pi" });
  terminal.setProgramStatus(done);
  assert.deepEqual(reports.map((r) => r.state), ["working", "working"]);
  assert.equal(reports[1].message, "Loop waiting on 1 lane");
  facts = { ...idle };
  terminal.setProgramStatus(done);
  assert.deepEqual(reports.at(-1), { state: "blocked", kind: "question", app: "pi", message: OWNER_NEEDED_MESSAGE });
  facts = { ...idle, closed: true };
  terminal.setProgramStatus(done);
  assert.deepEqual(reports.at(-1), done);
  assert.equal(reports.slice(0, -1).some((r) => r.state === "done"), false, "done only once the loop closed");
});

test("a rebuild updates the working note at once, but leaves working only if pi has not reported within the hold", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { terminal, reports } = fakeTerminal();
  let facts: LoopFacts = { ...idle, lanes: 2 };
  const wrapper = wrapProgramStatus({ terminal } as never, () => facts)!;
  terminal.setProgramStatus(done);
  facts = { ...idle, lanes: 1 };
  wrapper.refresh();
  assert.equal(reports.at(-1)?.message, "Loop waiting on 1 lane");
  wrapper.refresh();
  assert.equal(reports.length, 2, "an unchanged decision is not sent again");

  // The last lane finished; pi-subagents wakes the root up to a second later and pi reports working.
  facts = { ...idle };
  wrapper.refresh();
  t.mock.timers.tick(REBUILD_HOLD_MS - 1);
  assert.equal(reports.length, 2, "nothing leaves working within the hold");
  terminal.setProgramStatus({ state: "working", app: "pi" });
  t.mock.timers.tick(REBUILD_HOLD_MS);
  assert.deepEqual(reports.map((r) => r.state), ["working", "working", "working"], "the woken run's report replaced the held decision");

  // A run below a lane ends without waking the root: once the hold passes, the owner is told.
  facts = { ...idle, nested: 1 };
  terminal.setProgramStatus(done);
  assert.equal(reports.at(-1)?.message, "Loop waiting on 1 nested run");
  facts = { ...idle };
  wrapper.refresh();
  wrapper.refresh();
  t.mock.timers.tick(REBUILD_HOLD_MS);
  assert.deepEqual(reports.at(-1), { state: "blocked", kind: "question", app: "pi", message: OWNER_NEEDED_MESSAGE });
});

test("a due automatic resume that never runs is decided again once it is due", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { terminal, reports } = fakeTerminal();
  let facts: LoopFacts = { ...idle, resumeDueAt: 1_000_000 + 60_000 };
  wrapProgramStatus({ terminal } as never, () => facts);
  const error: ProgramStatus = { state: "error", app: "pi", message: "fetch failed" };
  terminal.setProgramStatus(error);
  assert.equal(reports.at(-1)?.state, "working");
  facts = { ...idle };
  t.mock.timers.tick(60_000 + RESUME_RECHECK_GRACE_MS - 1);
  assert.equal(reports.at(-1)?.state, "working", "not before the grace has passed");
  t.mock.timers.tick(1);
  assert.deepEqual(reports.at(-1), error, "the dropped resume leaves pi's error for the owner");
});

test("facts are read only for a resting report, and an unreadable fact leaves pi's report untouched", () => {
  const { terminal, reports } = fakeTerminal();
  let reads = 0;
  wrapProgramStatus({ terminal } as never, () => {
    reads++;
    throw new Error("no facts");
  });
  terminal.setProgramStatus({ state: "working", app: "pi" });
  assert.equal(reads, 0);
  terminal.setProgramStatus(done);
  assert.equal(reads, 1);
  assert.deepEqual(reports.at(-1), done);
});

test("one wrap per terminal: a reloaded instance takes it over with its own facts", () => {
  const { terminal, reports } = fakeTerminal();
  const first = wrapProgramStatus({ terminal } as never, () => ({ ...idle, lanes: 1 }));
  const second = wrapProgramStatus({ terminal } as never, () => ({ ...idle, timers: [{ at: inAnHour }] }));
  assert.equal(first, second);
  terminal.setProgramStatus(done);
  assert.equal(reports.length, 1);
  assert.match(String(reports[0].message), /^Loop waiting on 1 timer/);
  assert.equal(wrapProgramStatus({ terminal: {} } as never, () => idle), null, "a pi without program status is not wrapped");
});

test("lanes are child records, written only once the terminal supports the protocol", () => {
  const { terminal, writes } = fakeTerminal();
  const wrapper = wrapProgramStatus({ terminal } as never, () => idle)!;
  wrapper.laneStarted("run-a", "worker");
  wrapper.laneStarted("run-a", "worker");
  wrapper.laneEnded("run-a");
  wrapper.laneEnded("run-a");
  wrapper.laneStarted("run-b", "reviewer");
  wrapper.syncLanes(new Map([["run-c", "scout"]]));
  wrapper.clearLanes();
  assert.deepEqual(writes, [
    formatChildStatus("run-a", "working", "worker"),
    formatChildStatus("run-a", "clear"),
    formatChildStatus("run-b", "working", "reviewer"),
    formatChildStatus("run-c", "working", "scout"),
    formatChildStatus("run-b", "clear"),
    formatChildStatus("run-c", "clear"),
  ]);
  assert.equal(writes.some((w) => w.includes("state=done")), false, "an ended lane is cleared, never left as an unread done");
  assert.equal(writes[0], `\x1b]7501;id=run-a:state=working:title=${Buffer.from("worker").toString("base64")}\x1b\\`);

  const quiet = fakeTerminal(false);
  const silent = wrapProgramStatus({ terminal: quiet.terminal } as never, () => idle)!;
  silent.laneStarted("run-a", "worker");
  assert.deepEqual(quiet.writes, []);
  // Support confirmed later, or a restart after a suspend: pi-tui re-sends its root report, and the lanes follow.
  quiet.terminal.programStatusSupported = true;
  quiet.terminal.writeProgramStatus();
  assert.deepEqual(quiet.writes, ["<root>", formatChildStatus("run-a", "working", "worker")]);
});

test("child ids fit the protocol's one-segment grammar and stay stable", () => {
  assert.equal(childId("run-a"), "run-a");
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const id = childId(uuid);
  assert.match(id, /^[A-Za-z0-9_.+-]{1,32}$/);
  assert.equal(childId(uuid), id);
  assert.notEqual(childId(uuid.replace(/e$/, "f")), id);
  assert.match(childId("a/b:c"), /^[A-Za-z0-9_.+-]{1,32}$/);
});

test("captureTui keeps the TUI a widget factory receives and removes the widget; a mode that ignores factories gives none", () => {
  const calls: [string, unknown][] = [];
  const tui = { terminal: {} };
  const interactive = {
    setWidget: (key: string, content: unknown) => {
      calls.push([key, content]);
      if (typeof content === "function") (content as (t: unknown) => unknown)(tui);
    },
  };
  assert.equal(captureTui(interactive), tui);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], undefined, "the widget is removed in the same call");
  assert.equal(captureTui({ setWidget: () => {} }), null);
});

test("after a reload the root counts and lists its lanes from the run index, and a completed one is not re-added", async () => {
  const temp = mkdtempSync(join(tmpdir(), "loop-status-program-"));
  const runs = join(temp, "async-subagent-runs");
  const sessionFile = join(temp, "sessions", "root.jsonl");
  const writeRun = (id: string, state: string) => {
    mkdirSync(join(runs, id), { recursive: true });
    mkdirSync(join(runs, ".active-runs"), { recursive: true });
    writeFileSync(join(runs, id, "status.json"), JSON.stringify({ runId: id, state, sessionId: sessionFile, steps: [{ agent: "worker" }] }));
    writeFileSync(join(runs, ".active-runs", id), "");
  };
  writeRun("run-live-0001", "running");
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = temp;
  try {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const bus = new Map<string, ((data: unknown) => void)[]>();
    const api = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(event, handler),
      registerCommand: () => undefined,
      events: {
        on: (name: string, handler: (data: unknown) => void) => {
          bus.set(name, [...(bus.get(name) ?? []), handler]);
          return () => undefined;
        },
        emit: (name: string, data: unknown) => (bus.get(name) ?? []).forEach((handler) => handler(data)),
      },
    };
    api.events.on("loop-continuation:query-launch", (data) => (data as { reply: (r: unknown) => void }).reply({ reportPath: join(temp, "codex", "closeout-x-loop1.md") }));
    const { terminal, reports, writes } = fakeTerminal();
    loopStatus(api as never);
    const ctx = {
      cwd: temp,
      hasUI: true,
      ui: {
        setStatus: () => undefined,
        setWidget: (_key: string, content: unknown) => {
          if (typeof content === "function") (content as (tui: unknown) => unknown)({ terminal });
        },
      },
      sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "root", getEntries: () => [], getHeader: () => ({}) },
    };
    // A resumed session: the lane was launched before the reload, so no launch event arrives.
    handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [formatChildStatus("run-live-0001", "working", "worker")]);
    terminal.setProgramStatus(done);
    assert.equal(reports.at(-1)?.message, "Loop waiting on 1 lane");

    // The lane's completion arrives while its status.json still says running.
    api.events.emit("subagent:async-complete", { runId: "run-live-0001" });
    api.events.emit("subagent:jobs-changed", { version: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes.slice(1), [formatChildStatus("run-live-0001", "clear")], "cleared once, never re-added");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("the pinned pi reports through ui.terminal.setProgramStatus and hands widget factories its TUI", () => {
  const dist = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/", import.meta.url);
  const mode = readFileSync(new URL("interactive-mode.js", dist), "utf8");
  assert.match(mode, /new ProgramStatusReporter\(\(\) => this\.ui\.terminal,/);
  assert.match(mode, /component = content\(this\.ui, theme\);/);
  const reporter = readFileSync(new URL("program-status-reporter.js", dist), "utf8");
  assert.match(reporter, /this\.getTerminal\(\)\.setProgramStatus\(status\)/);
  assert.match(reporter, /case "agent_settled":[\s\S]*?this\.restingStatus = event\.aborted \? \{ state: "idle" \} : this\.runResult;/);
  const terminal = readFileSync(new URL("../../node_modules/@earendil-works/pi-tui/dist/terminal.js", import.meta.url), "utf8");
  assert.match(terminal, /programStatusSupported = false;/);
  assert.match(terminal, /this\.programStatusSupported = true;\s*this\.writeProgramStatus\(\);/, "support confirmation re-sends through writeProgramStatus");
  assert.match(terminal, /process\.stdout\.write\(`\$\{KITTY_KEYBOARD_PROTOCOL_QUERY\}\$\{programStatusQuery\}\$\{DEVICE_ATTRIBUTES_QUERY\}`\);\s*this\.writeProgramStatus\(\);/, "start re-sends through writeProgramStatus");
});
