// Real-CLI test: the pinned pi in RPC mode with the faux provider, the real call-timing extension
// (which stamps each root assistant message with its request timing) and the real loop-status
// extension. The share is read off the status line; a second pi process resuming the same session
// proves it is rebuilt from the persisted session rather than held in memory.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";

import { cleanupAll, FAUX_EXTENSION, freshDir, startPiRpc, writeFauxScript, type RpcEvent } from "../loop-wait/test-helpers.ts";

const STATUS_EXTENSION = join(import.meta.dirname, "index.ts");
const CALL_TIMING = join(import.meta.dirname, "..", "call-timing", "index.ts");

after(cleanupAll);

const isStatus = (e: RpcEvent): boolean => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "loop-status";
const text = (e: RpcEvent): string => String(e.statusText);
const SHARE = /· root model time (\d+)% of [\dhms]+ ·/;

test("the status line shows the root's model-time share, and a resumed session shows it again", async () => {
  const store = freshDir("loop-model-time-sessions-");
  const script = writeFauxScript([{ match: ".*", text: "ok", delayMs: 1_500 }]);
  const sessionArgs = ["--session-dir", store, "--session-id", "model-time-e2e"];
  const first = startPiRpc({ extensions: [FAUX_EXTENSION, CALL_TIMING, STATUS_EXTENSION], fauxScriptPath: script, sessionDir: store, sessionArgs });
  let agentDir: string;
  try {
    const initial = await first.waitFor(isStatus);
    assert.doesNotMatch(text(initial), /model time/, "nothing to show before the first request");
    first.send({ id: "t1", type: "prompt", message: "hello" });
    const shown = await first.waitFor((e) => isStatus(e) && SHARE.test(text(e)), 20_000);
    const share = Number(SHARE.exec(text(shown))![1]);
    assert.ok(share > 0 && share <= 100, `a 1.5 s request within the session's wall time: ${text(shown)}`);
    agentDir = first.agentDir;
  } finally {
    await first.close();
  }

  const second = startPiRpc({ extensions: [FAUX_EXTENSION, CALL_TIMING, STATUS_EXTENSION], fauxScriptPath: script, sessionDir: store, sessionArgs, agentDir });
  try {
    const resumed = await second.waitFor((e) => isStatus(e) && /root model time \d+% of /.test(text(e)), 20_000);
    assert.match(text(resumed), /· root model time \d+% of \d+[sm]/);
  } finally {
    await second.close();
  }
});

test("without call-timing the share is unknown, never a number", async () => {
  const script = writeFauxScript([{ match: ".*", text: "ok" }]);
  const pi = startPiRpc({ extensions: [FAUX_EXTENSION, STATUS_EXTENSION], fauxScriptPath: script, sessionDir: freshDir("loop-model-time-") });
  try {
    await pi.waitFor(isStatus);
    pi.send({ id: "t1", type: "prompt", message: "hello" });
    const shown = await pi.waitFor((e) => isStatus(e) && /root model time \? ·/.test(text(e)), 20_000);
    assert.match(text(shown), /root model time \? ·/);
  } finally {
    await pi.close();
  }
});
