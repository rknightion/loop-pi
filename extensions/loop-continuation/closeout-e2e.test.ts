// End to end on the faux provider: `/loop-closeout` (loop-wait) emits `loop-closeout`;
// loop-continuation runs the closeout audit and lane-worktrees adds its sweep line, and the root
// receives one loop-closeout-audit message holding both.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, startPiRpc, writeFauxScript } from "../loop-wait/test-helpers.ts";
import { addAuthority, cleanupFixtures, fakePi, fresh, git, loopFixture } from "./test-fixture.ts";

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

test("restored armed state or a retained snapshot dispatches closeout without the marker", { timeout: 15_000 }, async () => {
  for (const evidence of ["armed-state", "snapshot"] as const) {
    const f = loopFixture();
    const audit = join(f.agentDir, "bin", "loop-pi-audit");
    writeFileSync(audit, '#!/bin/sh\necho "UNGRANTED replay: $*"\nexit 1\n');
    chmodSync(audit, 0o755);
    const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      let branch: unknown[] = [];
      if (evidence === "armed-state") {
        await pi.input(f.launch);
        branch = pi.entries.map((entry) => ({ ...entry, type: "custom" }));
        unlinkSync(join(f.runDir, "loop-pi-proto"));
      } else {
        writeFileSync(join(f.runDir, "audit-before.json"), JSON.stringify({ protocol: 2, repos: {} }));
      }
      await pi.handlers.get("session_start")!({ type: "session_start" }, pi.ctx(branch));
      pi.emit("loop-closeout", { lines: [], pending: [] });
      const deadline = Date.now() + 5_000;
      while (!pi.sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(pi.sent.length, 1, evidence);
      assert.match(pi.sent[0].message.content, /exited 1 \(NOT clean/);
      assert.match(pi.sent[0].message.content, /--push-log/);
    } finally {
      pi.restore();
    }
  }
});

// Exercise the real CLI and real pi, not just the audit helper: the launcher snapshots before
// arming, then an unlogged default-branch move must stay UNGRANTED after marker deletion.
test("/loop-closeout still dispatches a non-downgraded audit after the armed marker is deleted", { timeout: 90_000 }, async () => {
  const f = loopFixture();
  const audit = new URL("../../bin/loop-pi-audit", import.meta.url).pathname;
  symlinkSync(audit, join(f.agentDir, "bin", "loop-pi-audit"));
  // Local remote and fake release discovery keep this replay entirely offline.
  const gh = join(f.agentDir, "bin", "gh");
  writeFileSync(gh, '#!/bin/sh\nif [ "$1 $2" = "release list" ]; then echo "[]"; else exit 1; fi\n');
  chmodSync(gh, 0o755);
  const env = { ...process.env, LOOP_PI_RUN_DIR: f.runDir, PATH: `${join(f.agentDir, "bin")}:${process.env.PATH}` };
  const remote = fresh("loop-closeout-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(f.repo, "remote", "add", "origin", remote);
  git(f.repo, "push", "-q", "origin", "main");
  execFileSync(audit, ["begin", "--run-dir", f.runDir, f.repo], { env, timeout: 15_000 });
  const beforePath = join(f.runDir, "audit-before.json");
  assert.equal(JSON.parse(readFileSync(beforePath, "utf8")).protocol, undefined, "the launcher snapshots before arm");
  const grants = JSON.stringify({ [realpathSync(f.repo)]: ["refs/heads/main", "HEAD"] });
  const digest = createHash("sha256").update(grants).digest("hex");
  const grantsPath = join(f.repo, "codex", "grants-x-loop3.json");
  writeFileSync(grantsPath, grants);
  addAuthority(f, `audit grants: ${grantsPath} sha256=${digest}`);
  const rpc = startPiRpc({
    extensions: [FAUX_EXTENSION, LOOP_WAIT_ROOT, new URL("./index.ts", import.meta.url).pathname],
    fauxScriptPath: writeFauxScript([
      { match: "You are the root", once: true, text: "PAUSED: armed", stopReason: "stop" },
      { match: "loop-closeout:", text: "PAUSED: non-clean closeout read", stopReason: "stop" },
    ]),
    agentDir: f.agentDir,
    sessionDir: f.repo,
    extraEnv: { LOOP_PI_RUN_DIR: f.runDir, PATH: env.PATH },
  });
  try {
    rpc.send({ id: "launch", type: "prompt", message: `${f.launch}\nAudit grants: ${grantsPath} sha256=${digest}` });
    await rpc.waitFor((e) => e.type === "agent_settled", 30_000);
    unlinkSync(join(f.runDir, "loop-pi-proto"));
    git(f.repo, "commit", "--allow-empty", "-qm", "unlogged default-branch work");
    git(f.repo, "push", "-q", "origin", "main");
    rpc.send({ id: "closeout", type: "prompt", message: "/loop-closeout" });
    const message = await rpc.waitFor(
      (e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "loop-closeout-audit",
      10_000,
    );
    const content = String((message.message as { content?: unknown }).content);
    assert.match(content, /exited 1 \(NOT clean/);
    assert.match(content, /refs\/heads\/main.*UNGRANTED/);
    assert.match(content, /ignored/);
    assert.match(content, /--push-log/);
    // The durable before-snapshot also protects direct CLI closeout with no explicit ledger.
    const direct = spawnSync(audit, ["closeout", "--run-dir", f.runDir, "--grants", grantsPath, "--grants-sha256", digest], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(direct.status, 1, direct.stdout + direct.stderr);
    assert.match(direct.stdout, /refs\/heads\/main.*UNGRANTED/);
    assert.equal(JSON.parse(readFileSync(beforePath, "utf8")).protocol, 2);
  } finally {
    await rpc.close();
  }
});
