// S1 harness facts, S7 context-overflow incident and alerting, and the closeout audit through
// index.ts against a fake ExtensionAPI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runOnIncident } from "./incident.ts";
import { addAuthority, cleanupFixtures, fakePi, fresh, loopFixture } from "./test-fixture.ts";

after(cleanupFixtures);

const facts = (runDir: string) =>
  existsSync(join(runDir, "harness-facts.jsonl"))
    ? readFileSync(join(runDir, "harness-facts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const rootIncidents = (agentDir: string) => {
  const dir = join(agentDir, "incidents", "root");
  return existsSync(dir) ? readdirSync(dir).map((name) => ({ name, body: JSON.parse(readFileSync(join(dir, name), "utf8")) })) : [];
};
const assistant = (stopReason: string, errorMessage?: string) => ({ type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage } });

async function armed() {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  assert.deepEqual(await pi.input(f.launch), { action: "continue" });
  return { f, pi };
}

test("a failed compaction is a compaction-failed fact; an aborted one is not", async () => {
  const { f, pi } = await armed();
  try {
    await pi.handlers.get("session_compact_failed")!({ type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false }, pi.ctx());
    assert.deepEqual(facts(f.runDir), []);
    await pi.handlers.get("session_compact_failed")!(
      { type: "session_compact_failed", reason: "threshold", errorMessage: "Auto-compaction failed: summarizer 500", aborted: false, willRetry: false, fromExtension: false },
      pi.ctx(),
    );
    const [fact] = facts(f.runDir);
    assert.deepEqual({ v: fact.v, kind: fact.kind, session: fact.session }, { v: 1, kind: "compaction-failed", session: "sess-1" });
    assert.match(fact.detail, /threshold: Auto-compaction failed: summarizer 500/);
    assert.ok(Number.isFinite(Date.parse(fact.ts)));
  } finally {
    pi.restore();
  }
});

test("a request that ends on a usage limit after pi's retries is a quota-exhausted fact; a retried success is not", async () => {
  const { f, pi } = await armed();
  try {
    const end = pi.handlers.get("message_end")!;
    const settled = pi.handlers.get("agent_settled")!;
    await end(assistant("error", "429 Too Many Requests: rate limit"), pi.ctx());
    await end(assistant("stop"), pi.ctx());
    await settled({ type: "agent_settled" }, pi.ctx());
    assert.deepEqual(facts(f.runDir), [], "a 429 that a retry got past is no fact");
    await end(assistant("error", "You have hit your ChatGPT usage limit (plus plan). Try again in 3 hours."), pi.ctx());
    await settled({ type: "agent_settled" }, pi.ctx());
    await settled({ type: "agent_settled" }, pi.ctx());
    const all = facts(f.runDir);
    assert.equal(all.length, 1);
    assert.equal(all[0].kind, "quota-exhausted");
    assert.match(all[0].detail, /usage limit/);
    await end(assistant("error", "500 internal error"), pi.ctx());
    await settled({ type: "agent_settled" }, pi.ctx());
    assert.equal(facts(f.runDir).length, 1, "an ordinary provider error is no quota fact");
  } finally {
    pi.restore();
  }
});

async function notifiedPath(out: string, completed: string, timeout = 10_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (!existsSync(completed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(completed), "notifier did not complete");
  return readFileSync(out, "utf8");
}

// Exercise the real detached collaborator, holding its redirected output open before printf.
// A FIFO handshake (not a timing delay) controls when it can finish; read has a bounded timeout.
test("onIncident readiness waits for successful completion, not an opened output file", async () => {
  const dir = fresh("loop-cont-notifier-");
  const out = join(dir, "incident-path.txt");
  const completed = join(dir, "completed");
  const opened = join(dir, "opened");
  const release = join(dir, "release");
  const file = join(dir, "incident.json");
  execFileSync("mkfifo", [release]);
  const fd = openSync(release, constants.O_RDWR);
  let released = false;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ loopPi: { onIncident: [
      "bash", "-c", '{ : > "$4"; read -r -t 10 release < "$5" && printf %s "$1"; } > "$2" && : > "$3"',
      "bash", "{file}", out, completed, opened, release,
    ] } }));
    runOnIncident(dir, file);
    const deadline = Date.now() + 10_000;
    while (!existsSync(opened) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(opened), "notifier did not open output");
    assert.equal(readFileSync(out, "utf8"), "", "redirection exists before printf writes");
    assert.equal(existsSync(completed), false);
    await assert.rejects(notifiedPath(out, completed, 100), /notifier did not complete/);
    writeSync(fd, "release\n");
    released = true;
    assert.equal(await notifiedPath(out, completed), file);
  } finally {
    if (!released) writeSync(fd, "release\n");
    closeSync(fd);
  }
});

test("onIncident completion does not accept a wrong path, failed write or missing witness", async () => {
  const dir = fresh("loop-cont-notifier-negative-");
  const file = join(dir, "incident.json");
  const out = join(dir, "incident-path.txt");
  const completed = join(dir, "completed");
  const configure = (script: string, output: string, witness: string) => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ loopPi: { onIncident: ["sh", "-c", script, "sh", "{file}", output, witness] } }));
    runOnIncident(dir, file);
  };
  configure('printf %s wrong-path > "$2" && : > "$3"', out, completed);
  await assert.rejects(async () => assert.equal(await notifiedPath(out, completed), file), { code: "ERR_ASSERTION", actual: "wrong-path", expected: file, operator: "strictEqual" });

  const failed = join(dir, "failed-completion");
  configure('printf %s "$1" > "$2" && : > "$3"', dir, failed);
  await assert.rejects(notifiedPath(dir, failed, 100), /notifier did not complete/);
  assert.equal(existsSync(failed), false, "a failed redirect cannot signal success");

  const missing = join(dir, "missing-completion");
  configure('printf %s "$1" > "$2"', join(dir, "unwitnessed-path.txt"), missing);
  await assert.rejects(notifiedPath(join(dir, "unwitnessed-path.txt"), missing, 100), /notifier did not complete/);
});

test("context_length_exceeded with a live async lane writes the root incident, the fact and runs onIncident; without one only the fact", async () => {
  const { f, pi } = await armed();
  const out = join(fresh("loop-cont-notify-"), "incident-path.txt");
  const completed = `${out}.completed`;
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ loopPi: { onIncident: ["sh", "-c", 'printf %s "$1" > "$2" && : > "$3"', "sh", "{file}", out, completed] } }));
  try {
    const end = pi.handlers.get("message_end")!;
    const overflow = assistant("error", "context_length_exceeded: Your input exceeds the context window of this model.");
    await end(overflow, pi.ctx());
    assert.deepEqual(facts(f.runDir).map((x) => x.kind), ["context-overflow"]);
    assert.equal(rootIncidents(f.agentDir).length, 0, "no live lane: no incident");
    await end(assistant("stop"), pi.ctx());

    pi.emit("subagent:async-started", { id: "run-1", sessionId: "/sessions/sess-1.jsonl" });
    pi.emit("subagent:async-started", { id: "run-x", sessionId: "/sessions/other.jsonl" });
    await end(overflow, pi.ctx());
    await end(overflow, pi.ctx());
    const incidents = rootIncidents(f.agentDir);
    assert.equal(incidents.length, 1, "one incident per overflow episode");
    assert.match(incidents[0].name, /^sess-1-.*-context-overflow\.json$/);
    assert.equal(incidents[0].body.class, "loop-root-context-overflow");
    assert.deepEqual(incidents[0].body.live_runs, ["run-1"]);
    assert.equal(facts(f.runDir).filter((x) => x.kind === "context-overflow").length, 2);
    assert.equal(await notifiedPath(out, completed), join(f.agentDir, "incidents", "root", incidents[0].name));

    // A failed overflow recovery in a new episode while the lane is still live is its own incident.
    await end(assistant("stop"), pi.ctx());
    await pi.handlers.get("session_compact_failed")!(
      { type: "session_compact_failed", reason: "overflow", errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.", aborted: false, willRetry: false, fromExtension: false },
      pi.ctx(),
    );
    assert.equal(rootIncidents(f.agentDir).length, 2);
    assert.deepEqual(facts(f.runDir).map((x) => x.kind).slice(-2).sort(), ["compaction-failed", "context-overflow"]);

    // Once the lane completes, an overflow is a fact only.
    pi.emit("subagent:async-complete", { runId: "run-1", sessionId: "/sessions/sess-1.jsonl" });
    await end(assistant("stop"), pi.ctx());
    await end(overflow, pi.ctx());
    assert.equal(rootIncidents(f.agentDir).length, 2);
  } finally {
    pi.restore();
  }
});

function fakeAudit(agentDir: string, exit: number): string {
  const argvFile = join(agentDir, "audit-argv.txt");
  const bin = join(agentDir, "bin", "loop-pi-audit");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho "UNGRANTED refs/heads/x"\nexit ${exit}\n`);
  chmodSync(bin, 0o755);
  return argvFile;
}

test("/loop-closeout runs loop-pi-audit closeout with the frozen grants and push log and surfaces the result to the root", async () => {
  const f = loopFixture();
  const argvFile = fakeAudit(f.agentDir, 1);
  const grants = JSON.stringify({ [f.repo]: ["refs/heads/main"] });
  const grantsPath = join(f.repo, "codex", "grants-x-loop3.json");
  writeFileSync(grantsPath, grants);
  const digest = createHash("sha256").update(grants).digest("hex");
  addAuthority(f, `audit grants: ${grantsPath} sha256=${digest}`);
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    await pi.input(`${f.launch}\nAudit grants: ${grantsPath} sha256=${digest}`);
    let resolveSweep!: () => void;
    const lines: string[] = [];
    const pending = [new Promise<void>((r) => (resolveSweep = r)).then(() => void lines.push("lane-worktrees: removed 1 worktree(s)"))];
    pi.emit("loop-closeout", { lines, pending });
    setTimeout(() => resolveSweep(), 200);
    const deadline = Date.now() + 10_000;
    while (pi.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pi.sent.length, 1);
    const { message, options } = pi.sent[0];
    assert.equal(message.customType, "loop-closeout-audit");
    assert.equal(message.display, true);
    assert.equal(options.triggerTurn, true);
    assert.match(message.content, /exited 1 \(NOT clean/);
    assert.match(message.content, /UNGRANTED refs\/heads\/x/);
    assert.match(message.content, /lane-worktrees: removed 1 worktree\(s\)/, "lines other extensions add are included");
    assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), [
      "closeout",
      "--run-dir",
      f.runDir,
      "--grants",
      join(f.runDir, "audit-grants.json"),
      "--grants-sha256",
      digest,
      "--push-log",
      join(f.runDir, "push-log.jsonl"),
    ]);
  } finally {
    pi.restore();
  }
});

test("without audit grants closeout passes no --grants; without the protocol marker it does not run", async () => {
  const { f, pi } = await armed();
  const argvFile = fakeAudit(f.agentDir, 0);
  try {
    pi.emit("loop-closeout", { lines: [], pending: [] });
    const deadline = Date.now() + 10_000;
    while (pi.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), ["closeout", "--run-dir", f.runDir, "--push-log", join(f.runDir, "push-log.jsonl")]);
    assert.match(pi.sent[0].message.content, /exited 0 \(clean\)/);
  } finally {
    pi.restore();
  }

  const g = loopFixture();
  const argv2 = fakeAudit(g.agentDir, 0);
  const pi2 = await fakePi({ agentDir: g.agentDir, cwd: g.repo, runDir: g.runDir });
  try {
    pi2.emit("loop-closeout", { lines: [], pending: [] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(argv2), false, "no marker: legacy run, no audit from the extension");
    assert.equal(pi2.sent.length, 0);
  } finally {
    pi2.restore();
  }
});
