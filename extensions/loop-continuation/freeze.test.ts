// loop-continuation wiring: the ops freeze at launch, the loop-continuation:query-launch answer,
// and the close-out nudge end to end. The first group loads index.ts against a fake ExtensionAPI;
// the last drives a real pi process on the scripted faux provider.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";

after(cleanupAll);

const OPS = {
  v: 1,
  ops: [{ surface: "deploy:site", kind: "deploy", allow: ["^just deploy( |$)"], secret_paths: ["kv/ci/site/token"] }],
};

type Handler = (event: any, ctx: any) => unknown;

async function loadWithFakePi(agentDir: string) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Handler>();
  const events = new Map<string, (data: unknown) => void>();
  const entries: { customType: string; data: any }[] = [];
  const fakePi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: {
      on: (name: string, handler: (data: unknown) => void) => events.set(name, handler),
      emit: (name: string, data: unknown) => events.get(name)?.(data),
    },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  };
  const module = await import("./index.ts");
  module.default(fakePi as never);
  const restore = () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
  const ctx = (branch: unknown[] = []) => ({
    cwd: agentDir,
    sessionManager: { getSessionId: () => "sess-1", getBranch: () => branch },
  });
  const query = () => {
    let answer: any;
    fakePi.events.emit("loop-continuation:query-launch", { reply: (r: unknown) => (answer = r) });
    return answer;
  };
  return { handlers, entries, events, ctx, query, restore };
}

function launchText(opsLine: string | null): string {
  return `You are the root. Write /repo/codex/report-x-loop3.md as the terminal action.${opsLine ? "\n" + opsLine : ""}`;
}

test("the ops file is read once at launch; a later edit is ignored; query-launch answers it", async () => {
  const agentDir = freshDir("loop-freeze-");
  const opsPath = join(agentDir, "ops.json");
  const text = JSON.stringify(OPS);
  writeFileSync(opsPath, text);
  const sha = createHash("sha256").update(text).digest("hex");
  const h = await loadWithFakePi(agentDir);
  try {
    h.handlers.get("session_start")!({}, h.ctx());
    assert.deepEqual(h.query(), { reportPath: null, opsPath: null, ops: null });

    h.handlers.get("before_agent_start")!({ prompt: launchText(`Ops grants: ${opsPath} sha256=${sha}`) }, h.ctx());
    writeFileSync(opsPath, JSON.stringify({ v: 1, ops: [] }));
    assert.deepEqual(h.query(), { reportPath: "/repo/codex/report-x-loop3.md", opsPath, ops: OPS });
    const stored = h.entries.at(-1)!;
    assert.equal(stored.customType, "loop-continuation-state");
    assert.deepEqual(stored.data.ops, OPS);
    assert.equal(stored.data.launch.opsLine, undefined, "the ops line is not persisted inside LaunchInfo");
    assert.equal(readdirSync(agentDir).includes("incidents"), false);

    // A resumed session restores the frozen grants from the state entry, not from the file.
    const resumed = await loadWithFakePi(agentDir);
    try {
      resumed.handlers.get("session_start")!(
        {},
        resumed.ctx([{ type: "custom", customType: "loop-continuation-state", data: stored.data }]),
      );
      assert.deepEqual(resumed.query().ops, OPS);
    } finally {
      resumed.restore();
    }
  } finally {
    h.restore();
  }
});

test("a digest mismatch, a missing file and an invalid file store ops:null and write an incident", async () => {
  const cases: { name: string; line: (dir: string) => string }[] = [
    { name: "mismatch", line: (dir) => (writeFileSync(join(dir, "o.json"), JSON.stringify(OPS)), `Ops grants: ${join(dir, "o.json")} sha256=${"0".repeat(64)}`) },
    { name: "missing", line: (dir) => `Ops grants: ${join(dir, "absent.json")} sha256=${"0".repeat(64)}` },
    {
      name: "invalid",
      line: (dir) => {
        const bad = JSON.stringify({ v: 1, ops: [{ surface: "s", kind: "nuke", allow: [], secret_paths: [] }] });
        writeFileSync(join(dir, "o.json"), bad);
        return `Ops grants: ${join(dir, "o.json")} sha256=${createHash("sha256").update(bad).digest("hex")}`;
      },
    },
  ];
  for (const c of cases) {
    const agentDir = freshDir("loop-freeze-bad-");
    const h = await loadWithFakePi(agentDir);
    try {
      h.handlers.get("session_start")!({}, h.ctx());
      h.handlers.get("before_agent_start")!({ prompt: launchText(c.line(agentDir)) }, h.ctx());
      assert.equal(h.query().ops, null, c.name);
      assert.deepEqual(readdirSync(join(agentDir, "incidents")), ["ops"], `${c.name}: nothing at the top level`);
      const files = readdirSync(join(agentDir, "incidents", "ops"));
      assert.equal(files.length, 1, c.name);
      assert.match(files[0], /^sess-1-.*\.json$/);
      const incident = JSON.parse(readFileSync(join(agentDir, "incidents", "ops", files[0]), "utf8"));
      assert.equal(incident.class, "loop-ops-grants-rejected", c.name);
      assert.equal(incident.session, "sess-1");
      assert.ok(typeof incident.reason === "string" && incident.reason.length > 0);
    } finally {
      h.restore();
    }
  }
});

test("a launch with no Ops grants line stores no grants and writes no incident", async () => {
  const agentDir = freshDir("loop-freeze-none-");
  const h = await loadWithFakePi(agentDir);
  try {
    h.handlers.get("session_start")!({}, h.ctx());
    h.handlers.get("before_agent_start")!({ prompt: launchText(null) }, h.ctx());
    assert.deepEqual(h.query(), { reportPath: "/repo/codex/report-x-loop3.md", opsPath: null, ops: null });
    assert.equal(readdirSync(agentDir).includes("incidents"), false);
  } finally {
    h.restore();
  }
});

test("a watcher reply that is not an array counts as no reply, so close-out falls back to the WAITING release", async () => {
  for (const reply of [undefined, { length: 0 }, null, "none"]) {
    const agentDir = freshDir("loop-watchers-");
    mkdirSync(join(agentDir, "bin"));
    writeFileSync(join(agentDir, "bin", "loop-state"), `#!/bin/sh\necho '{"live_lanes":0,"open_tasks":[],"admissible":[],"parked":[]}'\n`);
    chmodSync(join(agentDir, "bin", "loop-state"), 0o755);
    mkdirSync(join(agentDir, "codex"));
    writeFileSync(join(agentDir, "codex", "state-x-loop1.jsonl"), "");
    const h = await loadWithFakePi(agentDir);
    try {
      h.events.set("loop-wait:query-timers", (d: any) => d.reply([]));
      h.events.set("loop-wait:arm-timer", (d: any) => d.reply({ id: "t1", at: d.at }));
      h.events.set("loop-wait:query-watchers", (d: any) => d.reply(reply));
      h.handlers.get("session_start")!({}, h.ctx());
      h.handlers.get("before_agent_start")!({ prompt: "You are the root. Report at codex/report-x-loop1.md when finished." }, h.ctx());
      const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
      const result = await h.handlers.get("agent_before_settle")!(
        { outcome: "completed", entries: [], context: { contextMessages: [{ role: "assistant", content: `WAITING: lanes until ${future}` }] } },
        h.ctx(),
      );
      assert.deepEqual(result, {}, `reply ${JSON.stringify(reply)}: released, not nudged to close out`);
    } finally {
      h.restore();
    }
  }
});

// End to end on the faux provider: loop-wait and loop-continuation loaded, a fake loop-state in
// the home's bin/, a state log beside the report. A WAITING stop with nothing admissible gets a
// close-out nudge instead of a release; with an admissible task it is released as before.
function runCloseOut(digestJson: string) {
  const agentDir = freshDir("loop-closeout-agent-");
  const cwd = freshDir("loop-closeout-cwd-");
  mkdirSync(join(agentDir, "bin"));
  const fake = join(agentDir, "bin", "loop-state");
  writeFileSync(fake, `#!/bin/sh\necho '${digestJson}'\n`);
  chmodSync(fake, 0o755);
  mkdirSync(join(cwd, "codex"));
  writeFileSync(join(cwd, "codex", "state-x-loop1.jsonl"), "");
  const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const script = writeFauxScript([
    { match: "You are the root", once: true, text: `Waiting on lanes.\nWAITING: lanes until ${future}`, stopReason: "stop" },
    { match: "close out", text: "PAUSED: closing out", stopReason: "stop" },
    { match: "TURN ENDINGS", text: "PAUSED: nothing else", stopReason: "stop" },
  ]);
  const rpc = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, new URL("./index.ts", import.meta.url).pathname],
    fauxScriptPath: script,
    agentDir,
    sessionDir: cwd,
  });
  return { rpc, cwd };
}

test("a WAITING stop with a drained digest is nudged to close out instead of released", async () => {
  const { rpc, cwd } = runCloseOut('{"live_lanes":0,"open_tasks":[],"admissible":[],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: "You are the root. Report at codex/report-x-loop1.md when finished." });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter(
      (e: any) => e.type === "entry_appended" && e.entry?.type === "custom_message" && e.entry?.customType === "loop-continuation",
    ) as any[];
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].entry.details.reason, "close-out");
    assert.match(nudges[0].entry.content, /close out: nothing admissible remains; generate the report and end the run/);
  } finally {
    await rpc.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a WAITING stop with an admissible task is released as before", async () => {
  const { rpc, cwd } = runCloseOut('{"live_lanes":0,"open_tasks":["T-1"],"admissible":["T-1"],"parked":[]}');
  try {
    rpc.send({ id: "launch", type: "prompt", message: "You are the root. Report at codex/report-x-loop1.md when finished." });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    const nudges = rpc.events.filter((e: any) => e.type === "entry_appended" && e.entry?.customType === "loop-continuation");
    assert.equal(nudges.length, 0);
  } finally {
    await rpc.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
