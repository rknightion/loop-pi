// End to end on the faux provider: `/loop-closeout` (loop-wait) emits `loop-closeout`;
// loop-continuation runs the closeout audit and lane-worktrees adds its sweep line, and the root
// receives one loop-closeout-audit message holding both.
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { cleanupFixtures, loopFixture } from "./test-fixture.ts";

after(cleanupAll);
after(cleanupFixtures);

const LOOP_WAIT_ROOT = new URL("../loop-wait/root.ts", import.meta.url).pathname;
const LANE_WORKTREES = new URL("../lane-worktrees/index.ts", import.meta.url).pathname;

test("/loop-closeout runs the audit and the worktree sweep and reports both to the root", async () => {
  const f = loopFixture();
  const audit = join(f.agentDir, "bin", "loop-pi-audit");
  writeFileSync(audit, `#!/bin/sh\necho "audit ran: $*"\nexit 0\n`);
  chmodSync(audit, 0o755);
  const rpc = startPiRpc({
    extensions: [FAUX_EXTENSION, LOOP_WAIT_ROOT, new URL("./index.ts", import.meta.url).pathname, LANE_WORKTREES],
    fauxScriptPath: writeFauxScript([
      { match: "You are the root", once: true, text: "PAUSED: armed", stopReason: "stop" },
      { match: "loop-closeout:", text: "PAUSED: closeout read", stopReason: "stop" },
    ]),
    agentDir: f.agentDir,
    sessionDir: f.repo,
    extraEnv: { LOOP_PI_RUN_DIR: f.runDir },
  });
  try {
    rpc.send({ id: "launch", type: "prompt", message: f.launch });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    rpc.send({ id: "closeout", type: "prompt", message: "/loop-closeout" });
    const message = await rpc.waitFor(
      (e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "loop-closeout-audit",
      30_000,
    );
    const content = String((message.message as { content?: unknown }).content);
    assert.match(content, /exited 0 \(clean\)/);
    assert.match(content, new RegExp(`audit ran: closeout --run-dir ${f.runDir} --push-log ${join(f.runDir, "push-log.jsonl")}`));
    assert.match(content, /loop-closeout: stopped 0 watcher\(s\), cancelled 0 timer\(s\)/);
    assert.match(content, /lane-worktrees: removed 0 worktree\(s\), deleted 0 merged branch\(es\); no unmerged lane branches/);
  } finally {
    await rpc.close();
  }
});
