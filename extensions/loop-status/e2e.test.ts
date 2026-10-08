// Real-CLI test: the pinned pi in RPC mode with the faux provider, loop-wait's root extension
// (the real timer owner) and the real loop-status extension. A test-support companion plays the
// pi-subagents lane events. The status line is read off the RPC `setStatus` UI requests, which is
// exactly what the interactive footer receives.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
      `launch ${join(codex, "report-demo-loop1.md")}`,
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
