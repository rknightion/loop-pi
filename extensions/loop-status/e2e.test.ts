// Real-CLI test: the pinned pi in RPC mode with the faux provider, loop-wait's root extension
// (the real timer owner) and the real loop-status extension. A test-support companion plays the
// pi-subagents lane events. The status line is read off the RPC `setStatus` UI requests, which is
// exactly what the interactive footer receives.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { cleanupAll, FAUX_EXTENSION, freshDir, ROOT_EXTENSION, startPiRpc, writeFauxScript, type RpcEvent } from "../loop-wait/test-helpers.ts";

const STATUS_EXTENSION = join(import.meta.dirname, "index.ts");
const COMPANION = join(import.meta.dirname, "test-support-lanes.ts");

after(cleanupAll);

const isStatus = (e: RpcEvent): boolean => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "loop-status";
const text = (e: RpcEvent): string => String(e.statusText);

function start(extra: string[] = []) {
  const dir = freshDir("loop-status-");
  return startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, STATUS_EXTENSION, COMPANION, ...extra],
    fauxScriptPath: writeFauxScript([{ match: ".*", text: "ok" }]),
    sessionDir: dir,
  });
}

test("the status line changes when a lane starts and when it finishes", async () => {
  const pi = start();
  try {
    const first = await pi.waitFor(isStatus);
    assert.match(text(first), /^loop: 0 lanes · 0 timers · 0 watchers · nudge 0\/3 · hb -$/);

    let seen = pi.events.length;
    pi.send({ id: "s1", type: "prompt", message: "lane-start run-a" });
    const started = await pi.waitFor((e) => isStatus(e) && /1 lane ·/.test(text(e)) && pi.events.indexOf(e) >= seen);
    assert.match(text(started), /^loop: 1 lane · /);

    seen = pi.events.length;
    pi.send({ id: "s2", type: "prompt", message: "lane-done run-a" });
    const done = await pi.waitFor((e) => isStatus(e) && /0 lanes ·/.test(text(e)) && pi.events.indexOf(e) >= seen);
    assert.match(text(done), /^loop: 0 lanes · /);
  } finally {
    await pi.close();
  }
});

test("timers, watchers' next deadline, the nudge chain and the heartbeat age show after a turn", async () => {
  const pi = start();
  try {
    await pi.waitFor(isStatus);
    const codex = join(freshDir("loop-status-repo-"), "codex");
    mkdirSync(codex);
    const heartbeatAt = new Date(Date.now() - 125_000).toISOString();
    writeFileSync(join(codex, "state-demo-loop1.jsonl"), `{"ev":"open","at":"2026-10-08T00:00:00Z"}\n{"ev":"heartbeat","at":"${heartbeatAt}"}\n`);
    for (const [i, message] of [
      `launch ${join(codex, "closeout-demo-loop1.md")}`,
      "nudges 2",
      `timer ${new Date(Date.now() + 3_600_000).toISOString()}`,
    ].entries()) {
      pi.send({ id: `c${i}`, type: "prompt", message });
      await pi.waitForResponse(`c${i}`);
    }
    const seen = pi.events.length;
    pi.send({ id: "turn", type: "prompt", message: "hello" });
    const status = await pi.waitFor((e) => isStatus(e) && /1 timer/.test(text(e)) && pi.events.indexOf(e) >= seen, 20_000);
    assert.match(text(status), /next \d\d:\d\d · nudge 2\/3 · hb 2m ago$/);
  } finally {
    await pi.close();
  }
});

test("a goal's slot cap shows as lanes over cap once the launch carries one", async () => {
  const pi = start();
  try {
    await pi.waitFor(isStatus);
    for (const [i, message] of ["launch /tmp/none/codex/closeout-demo-loop1.md", "cap 4"].entries()) {
      pi.send({ id: `k${i}`, type: "prompt", message });
      await pi.waitForResponse(`k${i}`);
    }
    const seen = pi.events.length;
    pi.send({ id: "k2", type: "prompt", message: "lane-start run-a" });
    const started = await pi.waitFor((e) => isStatus(e) && /1\/4 lanes ·/.test(text(e)) && pi.events.indexOf(e) >= seen);
    assert.match(text(started), /^loop: 1\/4 lanes · /);
  } finally {
    await pi.close();
  }
});

test("pi-subagents' jobs-changed notice refreshes the status line with no turn", async () => {
  const pi = start();
  try {
    await pi.waitFor(isStatus);
    const codex = join(freshDir("loop-status-repo-"), "codex");
    mkdirSync(codex);
    pi.send({ id: "j0", type: "prompt", message: `launch ${join(codex, "closeout-demo-loop1.md")}` });
    await pi.waitForResponse("j0");
    // Written behind the extension's back: only a refresh reads it. Handled inputs start no turn.
    const heartbeatAt = new Date(Date.now() - 125_000).toISOString();
    writeFileSync(join(codex, "state-demo-loop1.jsonl"), `{"ev":"open","at":"2026-10-08T00:00:00Z"}\n{"ev":"heartbeat","at":"${heartbeatAt}"}\n`);
    const seen = pi.events.length;
    pi.send({ id: "j1", type: "prompt", message: "jobs-changed 1" });
    const status = await pi.waitFor((e) => isStatus(e) && /hb 2m ago$/.test(text(e)) && pi.events.indexOf(e) >= seen, 5_000);
    assert.match(text(status), /^loop: 0 lanes · /);
  } finally {
    await pi.close();
  }
});

test("the installed pi-subagents emits the jobs-changed event this extension listens for", () => {
  // The e2e above plays the event from a companion; this pins its name to the installed package.
  const types = readFileSync(new URL("../../node_modules/pi-subagents/src/shared/types.js", import.meta.url), "utf8");
  assert.match(types, /export const SUBAGENT_JOBS_CHANGED_EVENT = "subagent:jobs-changed";/);
  const tracker = readFileSync(new URL("../../node_modules/pi-subagents/src/runs/background/async-job-tracker.js", import.meta.url), "utf8");
  assert.match(tracker, /pi\.events\.emit\(SUBAGENT_JOBS_CHANGED_EVENT\b/, "the async job tracker still emits the event");
  assert.match(readFileSync(join(import.meta.dirname, "index.ts"), "utf8"), /pi\.events\.on\("subagent:jobs-changed"/);
});
