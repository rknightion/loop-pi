import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { asyncRunsDir, findNestedRun, formatNestedRun, formatNestedRuns, listNestedRuns, sessionScope } from "./descendants.ts";
import loopStatus from "./index.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const LANE = "11111111-aaaa-4bbb-8ccc-000000000001";
const CHILD = "922850f1-05ad-4e6e-bb26-0dcc7ee59602";
const GRANDCHILD = "33333333-aaaa-4bbb-8ccc-000000000003";
const OTHER = "44444444-aaaa-4bbb-8ccc-000000000004";

interface Fixture {
  tempRoot: string;
  runs: string;
  rootFile: string;
  laneFile: string;
  childFile: string;
}

/** A root session with one lane run, the lane's child and a run that belongs to another session. */
function fixture(): Fixture {
  const tempRoot = mkdtempSync(join(tmpdir(), "loop-status-nested-"));
  dirs.push(tempRoot);
  const runs = join(tempRoot, "tmp", "async-subagent-runs");
  const sessions = join(tempRoot, "sessions", "--repo--");
  const rootFile = join(sessions, "2026-10-15T23-01-14-426Z_01a141cc.jsonl");
  const laneFile = join(sessions, "2026-10-15T23-01-14-426Z_01a141cc", "275d87de", "run-0", "session.jsonl");
  const childFile = join(sessions, "2026-10-15T23-01-14-426Z_01a141cc", "275d87de", "run-0", "session", "de19bf2a", "run-0", "session.jsonl");
  const write = (id: string, status: Record<string, unknown>, active = true) => {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, "status.json"), JSON.stringify({ runId: id, ...status }));
    if (active) {
      mkdirSync(join(runs, ".active-runs"), { recursive: true });
      writeFileSync(join(runs, ".active-runs", id), "");
    }
  };
  write(LANE, { state: "running", mode: "single", sessionId: rootFile, sessionFile: laneFile, steps: [{ agent: "senior", sessionFile: laneFile }], startedAt: 1000, lastUpdate: 2000 });
  write(CHILD, { state: "running", mode: "single", sessionId: laneFile, sessionFile: childFile, steps: [{ agent: "worker" }], startedAt: 3000, lastUpdate: 4000 });
  write(OTHER, { state: "running", mode: "single", sessionId: join(tempRoot, "sessions", "--repo--", "another-session.jsonl"), steps: [{ agent: "worker" }] });
  return { tempRoot: join(tempRoot, "tmp"), runs, rootFile, laneFile, childFile };
}

test("a run launched by a lane is listed with its parent lane, and another session's run is not", () => {
  const f = fixture();
  const nested = listNestedRuns(f.runs, f.rootFile);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].id, CHILD);
  assert.equal(nested[0].agent, "worker");
  assert.equal(nested[0].parentRunId, LANE);
  assert.match(formatNestedRuns(nested), new RegExp(`${CHILD} worker \\(single, running\\) parent ${LANE}`));
});

test("a run below a nested run names that run as its parent", () => {
  const f = fixture();
  mkdirSync(join(f.runs, GRANDCHILD), { recursive: true });
  writeFileSync(
    join(f.runs, GRANDCHILD, "status.json"),
    JSON.stringify({ runId: GRANDCHILD, state: "queued", sessionId: f.childFile, steps: [{ agent: "scout" }], startedAt: 5000 }),
  );
  mkdirSync(join(f.runs, ".active-runs"), { recursive: true });
  writeFileSync(join(f.runs, ".active-runs", GRANDCHILD), "");
  const nested = listNestedRuns(f.runs, f.rootFile);
  assert.deepEqual(nested.map((r) => [r.id, r.parentRunId]), [[CHILD, LANE], [GRANDCHILD, CHILD]]);
});

test("a finished child is found by id or id prefix, terminal state included", () => {
  const f = fixture();
  writeFileSync(join(f.runs, CHILD, "status.json"), JSON.stringify({ runId: CHILD, state: "complete", sessionId: f.laneFile, steps: [{ agent: "worker" }] }));
  rmSync(join(f.runs, ".active-runs", CHILD));
  assert.deepEqual(listNestedRuns(f.runs, f.rootFile), []);
  const byId = findNestedRun(f.runs, f.rootFile, CHILD);
  assert.equal(byId?.state, "complete");
  assert.equal(byId?.parentRunId, LANE);
  assert.equal(findNestedRun(f.runs, f.rootFile, "922850f1")?.id, CHILD);
  assert.match(formatNestedRun(byId!), /State: complete/);
  assert.equal(findNestedRun(f.runs, f.rootFile, OTHER), null);
  assert.equal(findNestedRun(f.runs, f.rootFile, "../etc"), null);
});

test("a missing run directory, an unset temp root and a corrupt status.json show no nested runs", () => {
  const f = fixture();
  writeFileSync(join(f.runs, CHILD, "status.json"), "{ not json");
  assert.deepEqual(listNestedRuns(f.runs, f.rootFile), []);
  assert.deepEqual(listNestedRuns(join(f.runs, "missing"), f.rootFile), []);
  assert.deepEqual(listNestedRuns(null, f.rootFile), []);
  assert.deepEqual(listNestedRuns(f.runs, null), []);
  assert.equal(asyncRunsDir({}), null);
  assert.equal(asyncRunsDir({ PI_SUBAGENTS_TEMP_ROOT: "/h/tmp" }), "/h/tmp/async-subagent-runs");
  assert.equal(sessionScope("relative.jsonl"), null);
});

type Handler = (event: any, ctx: any) => any;

function startRoot(f: Fixture) {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    events: { on: () => () => undefined, emit: () => undefined },
  };
  process.env.PI_SUBAGENTS_TEMP_ROOT = f.tempRoot;
  (loopStatus as any)(api);
  const ctx = {
    cwd: f.tempRoot,
    hasUI: false,
    ui: { setStatus: () => undefined },
    sessionManager: { getSessionFile: () => f.rootFile, getSessionId: () => "sess", getEntries: () => [] },
  };
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  return (input: Record<string, unknown>, text: string, isError = false) =>
    handlers.get("tool_result")!({ type: "tool_result", toolName: "subagent", toolCallId: "c1", input, content: [{ type: "text", text }], details: undefined, isError }, ctx);
}

test("the root's subagent status listing gains the nested runs", () => {
  const f = fixture();
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  try {
    const result = startRoot(f)({ action: "status" }, `Active async runs: 1\n\n- ${LANE} senior`);
    const text = result.content[0].text as string;
    assert.ok(text.startsWith(`Active async runs: 1\n\n- ${LANE} senior`));
    assert.match(text, new RegExp(`Nested runs below this session's lanes, not in the list above: 1`));
    assert.match(text, new RegExp(`- ${CHILD} worker \\(single, running\\) parent ${LANE}`));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
  }
});

test("status for a nested run id is answered instead of 'Async run not found'", () => {
  const f = fixture();
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  try {
    const status = startRoot(f);
    const result = status({ action: "status", id: CHILD.slice(0, 8) }, "Async run not found. Provide id or dir.", true);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, new RegExp(`Run: ${CHILD}\\nState: running`));
    assert.match(result.content[0].text, new RegExp(`Parent run: ${LANE}`));
    // An id that is not nested, a fleet view and a successful lookup are left to pi-subagents.
    assert.equal(status({ action: "status", id: OTHER }, "Async run not found. Provide id or dir.", true), undefined);
    assert.equal(status({ action: "status", options: { view: "fleet" } }, "fleet"), undefined);
    assert.equal(status({ action: "status", id: CHILD }, "Run: x", false), undefined);
    assert.equal(status({ action: "list" }, "x"), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
  }
});
