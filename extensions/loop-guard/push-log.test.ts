// SEAMS S1 push log, end to end on the pinned pi CLI with the faux provider: a successful
// `git push` from the root (tool_execution_end) or from a lane (the lane guard's post-exec hook)
// appends one line per updated ref to `$LOOP_PI_RUN_DIR/push-log.jsonl`, with `old` read from the
// remote before the push. A failed push, or a run without the protocol marker, writes nothing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { hermeticFixtureEnv, hermeticPiEnv } from "../test-support/hermetic-env.ts";
import laneExtension from "./lane.ts";
import { capturePushExecutions, hiddenPush, planPushes, recordPushes, unloggedPushRefusal } from "./push-log.ts";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAll,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "./rpc-test-helpers.ts";

after(cleanupAll);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: hermeticFixtureEnv(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com"];

test("fixture environments isolate inherited Git config without changing the runner's lane fence", () => {
  const before = { ...process.env };
  const fixtureEnv = hermeticFixtureEnv();
  const piEnv = hermeticPiEnv({ PI_OFFLINE: "1" });
  for (const key of Object.keys(before)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) {
      assert.equal(fixtureEnv[key], undefined, key);
      assert.equal(piEnv[key], undefined, key);
    } else {
      assert.equal(fixtureEnv[key], before[key], key);
    }
    if (/^PI_SUBAGENTS?_/.test(key)) assert.equal(piEnv[key], undefined, key);
  }
  assert.equal(hermeticFixtureEnv({ GIT_CONFIG_COUNT: "0" }).GIT_CONFIG_COUNT, "0");
  assert.deepEqual({ ...process.env }, before, "the actual lane's environment remains intact");
});

/** A repository with one commit and a bare `origin`, plus a run dir (with the marker unless legacy). */
function fixture(legacy = false) {
  const repo = freshDir("push-log-repo-");
  const remote = freshDir("push-log-remote-");
  const runDir = freshDir("push-log-run-");
  git(repo, "init", "-b", "main");
  git(remote, "init", "--bare");
  git(repo, ...IDENTITY, "commit", "--allow-empty", "-m", "one");
  git(repo, "remote", "add", "origin", remote);
  if (!legacy) writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  return { repo, remote, runDir, log: join(runDir, "push-log.jsonl") };
}

function readLog(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("root push log: receipts survive moving the pinned Cellar node directory mid-run", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const pinnedDir = join(freshDir("push-log-node-"), "Cellar", "node", "old", "bin");
  mkdirSync(pinnedDir, { recursive: true });
  const pinnedNode = join(pinnedDir, "node");
  // Simulate the physical executable retained by an already-running Node process.
  writeFileSync(pinnedNode, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' "$@"\n`);
  chmodSync(pinnedNode, 0o755);
  const stableDir = join(pinnedDir, "../../../../opt/node/bin");
  mkdirSync(stableDir, { recursive: true });
  writeFileSync(join(stableDir, "node"), readFileSync(pinnedNode));
  chmodSync(join(stableDir, "node"), 0o755);
  const command = "git push origin main";
  const plans = await planPushes(command, repo, runDir);
  const original = Object.getOwnPropertyDescriptor(process, "execPath")!;
  let evidence: ReturnType<typeof capturePushExecutions>;
  try {
    Object.defineProperty(process, "execPath", { ...original, value: pinnedNode });
    evidence = capturePushExecutions(command, plans);
  } finally {
    Object.defineProperty(process, "execPath", original);
  }
  renameSync(pinnedDir, `${pinnedDir}.retired`);
  try {
    const result = spawnSync("bash", ["-c", evidence.command], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const tip = git(repo, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
    assert.equal(await recordPushes(plans, { runDir, actor: "root", agent: null, lane: null }, evidence), 1,
      "the successful local push must produce its trusted receipt after the executable directory moves");
    assert.deepEqual({ ...readLog(log)[0], ts: "" }, {
      v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo),
      remote: "origin", ref: "refs/heads/main", old: null, new: tip,
    });
  } finally {
    evidence.dispose();
  }
});

for (const [platform, selected] of [["darwin", "usr/local/bin/node"], ["linux", "custom/bin/node"]]) {
  test(`root push log: selected ${platform} runtime works without node on PATH`, { timeout: 60_000 }, async () => {
    const { repo, runDir } = fixture();
    const scratch = freshDir("push-selected-node-");
    const node = join(scratch, selected);
    const witness = join(scratch, "called");
    mkdirSync(join(node, ".."), { recursive: true });
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' called >> ${quote(witness)}\nexec ${quote(process.execPath)} "$@"\n`);
    chmodSync(node, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    const plans = await planPushes("git push origin main", repo, runDir);
    const original = Object.getOwnPropertyDescriptor(process, "execPath")!;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let evidence: ReturnType<typeof capturePushExecutions>;
    try {
      Object.defineProperty(process, "execPath", { ...original, value: node });
      Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
      evidence = capturePushExecutions("git push origin main", plans);
    } finally {
      Object.defineProperty(process, "execPath", original);
      Object.defineProperty(process, "platform", originalPlatform);
    }
    try {
      const result = spawnSync("/bin/bash", ["-c", evidence.command], {
        cwd: repo, encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: "/usr/bin:/bin" },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(existsSync(witness), "receipt must use the selected runtime, not a platform default");
      assert.equal(await recordPushes(plans, { runDir, actor: "root", agent: null, lane: null }, evidence), 1);
    } finally {
      evidence.dispose();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
}

const ISO_SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

const EXEC_PUSHES = [
  "find . -exec git push origin main \\;",
  "find . -execdir sh -c 'git pu\\sh origin main' \\;",
  "git rebase -x 'git push origin main' HEAD~1",
  'git rebase --exec="git pu\\sh origin main" HEAD~1',
  `uv run python -c "import subprocess; subprocess.run(['git','push','origin','main'])"`,
  `deno eval "new Deno.Command('git', {args: ['push', 'origin', 'main']}).outputSync()"`,
  `awk 'BEGIN { system("git push origin main") }'`,
  "watch -n 1 git push origin main",
  "parallel git push origin ::: main",
];

test("root push log: one line per updated ref, old read before the push, nothing for a failed push", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const first = git(repo, "rev-parse", "HEAD");
  const script = writeFauxScript([
    { match: "PUSH_ONE", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
    {
      match: "PUSH_TWO",
      once: true,
      toolCalls: [{ name: "bash", args: { command: `git ${IDENTITY.join(" ")} commit --allow-empty -m two && git push origin main HEAD:refs/heads/feature` } }],
    },
    { match: "PUSH_FAILS", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin refs/heads/missing:refs/heads/other" } }] },
    { match: "PUSH_NOOP", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin main" } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  const bashEnds = () => session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
  const prompt = async (message: string, n: number) => {
    session.send({ id: message, type: "prompt", message });
    await waitForCondition(() => (bashEnds().length >= n ? true : undefined), 30_000);
    await session.waitFor((e) => e.type === "agent_end" && session.events.indexOf(e) > session.events.indexOf(bashEnds()[n - 1]), 30_000);
  };
  try {
    await prompt("PUSH_ONE", 1);
    assert.equal(bashEnds()[0].isError, false, JSON.stringify(bashEnds()[0]));
    let lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [one] = lines;
    assert.match(String(one.ts), ISO_SECONDS);
    assert.deepEqual(
      { ...one, ts: "" },
      { v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo), remote: "origin", ref: "refs/heads/main", old: null, new: first },
    );

    await prompt("PUSH_TWO", 2);
    assert.equal(bashEnds()[1].isError, false, JSON.stringify(bashEnds()[1]));
    const second = git(repo, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), second);
    lines = readLog(log);
    assert.equal(lines.length, 3, JSON.stringify(lines));
    const byRef = Object.fromEntries(lines.slice(1).map((l) => [l.ref, l]));
    assert.deepEqual([byRef["refs/heads/main"]?.old, byRef["refs/heads/main"]?.new], [first, second]);
    assert.deepEqual([byRef["refs/heads/feature"]?.old, byRef["refs/heads/feature"]?.new], [null, second]);

    await prompt("PUSH_FAILS", 3);
    assert.equal(bashEnds()[2].isError, true, "the push of a missing ref must fail");
    await prompt("PUSH_NOOP", 4);
    assert.equal(bashEnds()[3].isError, false);
    assert.equal(readLog(log).length, 3, "a failed push and an up-to-date push write nothing");
  } finally {
    await session.close();
  }
});

test("root push log: publication before a board-only tip is fully receipted even if a later command fails", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const base = git(repo, "rev-parse", "HEAD");
  assert.equal(runAudit(runDir, "begin", realpathSync(repo)).status, 0);
  mkdirSync(join(repo, "contracts"));
  writeFileSync(join(repo, "contracts", "coverage.yaml"), "coverage: supported\n");
  git(repo, "add", "--", "contracts/coverage.yaml");
  git(repo, ...IDENTITY, ...NO_SIGN, "commit", "-m", "publish coverage", "--", "contracts/coverage.yaml");
  const publication = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "backlog"));
  writeFileSync(join(repo, "backlog", "status.yaml"), "status: parked\n");
  git(repo, "add", "--", "backlog/status.yaml");
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      {
        match: "PUBLISH_CLOSEOUT", once: true,
        toolCalls: [{ name: "bash", args: {
          command: `git ${[...IDENTITY, ...NO_SIGN].join(" ")} commit -m 'board status' -- backlog/status.yaml; git push origin main; printf 'no match\\n' | grep '^missing-recipe:'`,
        } }],
      },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"), subagentTempRoot: freshDir(), cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "PUBLISH_CLOSEOUT" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, true, "the trailing search fails, not the preceding push");
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    const tip = git(repo, "rev-parse", "HEAD");
    assert.notEqual(tip, publication, "a board-only commit follows the publication");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip, "both commits reached the remote");
    const lines = readLog(log);
    assert.equal(lines.length, 1, "a successful push needs a receipt despite a later shell failure");
    assert.deepEqual({ ...lines[0], ts: "" }, {
      v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo),
      remote: "origin", ref: "refs/heads/main", old: base, new: tip,
    });
    assert.deepEqual(git(repo, "rev-list", `${lines[0].old}..${lines[0].new}`).split("\n"), [tip, publication]);
    // Negative control: a receipt covering just the board-only tip misses the publication.
    const tipOnly = join(runDir, "tip-only.jsonl");
    writeFileSync(tipOnly, `${JSON.stringify({ ...lines[0], old: publication })}\n`);
    const incomplete = runAudit(runDir, "closeout", "--push-log", tipOnly);
    assert.equal(incomplete.status, 1, incomplete.output);
    assert.match(incomplete.output, /UNGRANTED/);
    assert.ok(incomplete.output.includes(publication.slice(0, 12)), incomplete.output);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 0, closeout.output);
    assert.doesNotMatch(closeout.output, /UNGRANTED/);
    assert.match(closeout.output, /refs\/heads\/main.*GRANTED/);
  } finally {
    await session.close();
  }
});

for (const mode of ["skipped", "rejected", "noop", "skipped-success", "skipped-printed", "redirected", "redirected-configured"] as const) {
  test(`root push log: same-source foreign publication grants nothing when the planned push is ${mode}`, { timeout: 60_000 }, async () => {
    const { repo, remote, runDir, log } = fixture();
    git(repo, "push", "-q", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const base = git(repo, "rev-parse", "HEAD");
    const begin = runAudit(runDir, "begin", realpathSync(repo));
    assert.equal(begin.status, 0, begin.output);
    const redirected = mode.startsWith("redirected");
    const twin = redirected ? freshDir("push-log-other-endpoint-") : undefined;
    if (twin) {
      git(twin, "init", "--bare");
      git(repo, "push", "-q", twin, "main");
      if (mode === "redirected-configured") git(repo, "config", "remote.origin.pushurl", twin);
    }
    writeFileSync(join(repo, "publication.yaml"), "coverage: supported\n");
    git(repo, "add", "--", "publication.yaml");
    git(repo, ...IDENTITY, ...NO_SIGN, "commit", "-m", "publish coverage", "--", "publication.yaml");
    const tip = git(repo, "rev-parse", "HEAD");
    const signalDir = freshDir("push-log-race-signal-");
    const ready = join(signalDir, "ready");
    const released = join(signalDir, "released");
    const attempted = join(signalDir, "attempted");
    if (mode === "rejected") {
      const hook = join(remote, "hooks", "pre-receive");
      writeFileSync(hook, `#!/bin/sh\nprintf rejected > '${attempted}'\nexit 1\n`);
      chmodSync(hook, 0o755);
    }
    // The test process is the other writer. The root can only wait, skip, reject or no-op.
    const wait = `printf ready > '${ready}'; for i in {1..500}; do [ -f '${released}' ] && break; sleep 0.02; done; test -f '${released}'`;
    const printed = mode === "skipped-printed" ? `printf ' \\trefs/heads/main:refs/heads/main\\t${base}..${tip}\\n'; ` : "";
    const command = redirected
      ? `git ${mode === "redirected" ? `-c remote.origin.pushurl='${twin}' ` : ""}push origin main; ${wait}; false`
      : mode === "rejected"
        ? `git push origin main; ${wait}; false`
        : `${wait}; ${printed}${mode.startsWith("skipped") ? "false && " : ""}git push origin main${mode === "noop" ? "; false" : mode === "skipped-success" ? "; true" : ""}`;
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
      fauxScriptPath: writeFauxScript([
        { match: "FOREIGN_SAME_SOURCE", once: true, toolCalls: [{ name: "bash", args: { command } }] },
        { match: ".*", text: "done" },
      ]),
      agentDir: freshDir("push-log-home-"), subagentTempRoot: freshDir(), cwd: repo,
      env: { LOOP_PI_RUN_DIR: runDir },
    });
    try {
      session.send({ id: "p", type: "prompt", message: "FOREIGN_SAME_SOURCE" });
      await waitForCondition(() => existsSync(ready) || undefined, 30_000);
      assert.equal(git(remote, "rev-parse", "refs/heads/main"), base, "planning and any rejected push preceded the foreign move");
      if (mode === "rejected") {
        assert.equal(readFileSync(attempted, "utf8"), "rejected", "the planned push really executed and was rejected");
        unlinkSync(join(remote, "hooks", "pre-receive"));
      }
      if (twin) assert.equal(git(twin, "rev-parse", "refs/heads/main"), tip, "the root updated only the other endpoint");
      // A separate process publishes the same source to the audited endpoint, not its pushurl.
      git(repo, "push", "-q", remote, "main");
      writeFileSync(released, "go\n");
      const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
      assert.equal(end.isError, mode !== "skipped-success", JSON.stringify(end));
      if (mode === "noop") assert.match(JSON.stringify(end.result), /up.to.date/i, "the planned push actually executed as a no-op");
      await session.waitFor((e) => e.type === "agent_end", 30_000);
      assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
      assert.equal(git(repo, "rev-parse", "HEAD"), tip, "remote and planned local source are equal");
      const lines = readLog(log);
      // Check audit independently too: a fabricated root receipt would grant this range.
      if (!existsSync(log)) writeFileSync(log, "");
      const closeout = runAudit(runDir, "closeout", "--push-log", log);
      assert.deepEqual({ receipts: lines.length, auditExit: closeout.status }, { receipts: 0, auditExit: 1 }, closeout.output);
      assert.match(closeout.output, /UNGRANTED/);
      assert.ok(closeout.output.includes(tip.slice(0, 12)), closeout.output);
    } finally {
      await session.close();
    }
  });
}

// SSH transport stays wholly local: the fixture executes only Git's pack command, never ssh.
function sshFixture(repo: string, foreign?: string): string {
  const script = join(freshDir("push-log-ssh-bin-"), "ssh-fixture");
  writeFileSync(script, [
    "#!/bin/sh", "for last; do :; done",
    ...(foreign ? [`case " $* " in *"other@fixture-host"*|*" -l other "*) last="git-receive-pack '${foreign}'";; esac`] : []),
    'case "$last" in *git-upload-pack*|*git-receive-pack*) exec sh -c "$last";; *) exit 1;; esac',
  ].join("\n"));
  chmodSync(script, 0o755);
  git(repo, "config", "core.sshCommand", script);
  return script;
}

for (const form of ["scp", "url"] as const) {
  test(`root endpoint: canonical SSH ${form} username publication survives trailing failure`, { timeout: 60_000 }, async () => {
    const { repo, remote, runDir, log } = fixture();
    sshFixture(repo);
    const endpoint = form === "scp" ? `fixture@fixture-host:${remote}` : `ssh://fixture@fixture-host${remote}`;
    git(repo, "remote", "set-url", "origin", endpoint);
    git(repo, "push", "-q", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    const base = git(repo, "rev-parse", "HEAD");
    const begin = runAudit(runDir, "begin", realpathSync(repo));
    assert.equal(begin.status, 0, begin.output);
    git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "publication");
    const tip = git(repo, "rev-parse", "HEAD");
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
      fauxScriptPath: writeFauxScript([
        { match: "SSH_PUBLICATION", once: true, toolCalls: [{ name: "bash", args: { command: "git push --set-upstream origin main; false" } }] },
        { match: ".*", text: "done" },
      ]),
      agentDir: freshDir("push-log-home-"), subagentTempRoot: freshDir(), cwd: repo,
      env: { LOOP_PI_RUN_DIR: runDir },
    });
    try {
      session.send({ id: "p", type: "prompt", message: "SSH_PUBLICATION" });
      const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
      assert.equal(end.isError, true);
      await session.waitFor((e) => e.type === "agent_end", 30_000);
      assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip, "real local SSH pack transport succeeded");
      assert.match(JSON.stringify(end.result), /To (?:ssh:\/\/)?fixture-host/);
      if (!existsSync(log)) writeFileSync(log, "");
      const closeout = runAudit(runDir, "closeout", "--push-log", log);
      const lines = readLog(log);
      assert.deepEqual({ receipts: lines.length, auditExit: closeout.status }, { receipts: 1, auditExit: 0 }, closeout.output);
      assert.deepEqual({ ...lines[0], ts: "" }, {
        v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo),
        remote: "origin", ref: "refs/heads/main", old: base, new: tip,
      });
    } finally { await session.close(); }
  });
}

for (const mode of ["mirror", "restored-url", "ssh-user", "ssh-environment", "ssh-config", "ambiguous-push"] as const) {
  test(`root endpoint: ${mode} publication cannot grant foreign same-SHA origin`, { timeout: 60_000 }, async () => {
    const { repo, remote, runDir, log } = fixture();
    const twin = freshDir("push-log-mirror-");
    git(twin, "init", "--bare");
    const ssh = mode.startsWith("ssh-") ? sshFixture(repo, twin) : undefined;
    if (ssh) git(repo, "remote", "set-url", "origin", `fixture@fixture-host:${remote}`);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "remote", "add", "mirror", twin);
    git(repo, "push", "-q", "mirror", "main");
    for (const r of [remote, twin]) git(r, "symbolic-ref", "HEAD", "refs/heads/main");
    const base = git(repo, "rev-parse", "HEAD");
    const begin = runAudit(runDir, "begin", realpathSync(repo));
    assert.equal(begin.status, 0, begin.output);
    if (mode === "restored-url") git(repo, "remote", "set-url", "origin", twin);
    if (mode === "ambiguous-push") {
      git(repo, "config", "--add", "remote.origin.pushurl", remote);
      git(repo, "config", "--add", "remote.origin.pushurl", twin);
    }
    git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "publication");
    const tip = git(repo, "rev-parse", "HEAD");
    const signal = freshDir("push-log-endpoint-signal-");
    const ready = join(signal, "ready"), released = join(signal, "released");
    const wait = `printf ready > '${ready}'; for i in {1..500}; do [ -f '${released}' ] && break; sleep 0.02; done; test -f '${released}'`;
    const command = mode === "mirror" ? `git push mirror main; ${wait}; false`
      : mode === "restored-url" ? `git push origin main; git remote set-url origin '${remote}'; ${wait}; false`
      : mode === "ssh-user" ? `git remote set-url origin 'other@fixture-host:${remote}'; git push origin main; git remote set-url origin 'fixture@fixture-host:${remote}'; ${wait}; false`
      : mode === "ssh-environment" ? `GIT_SSH_COMMAND='${ssh} other@fixture-host' git push origin main; ${wait}; false`
      : mode === "ssh-config" ? `git config core.sshCommand '${ssh} other@fixture-host'; git push origin main; git config core.sshCommand '${ssh}'; ${wait}; false`
      : `git push origin main; ${wait}; false`;
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
      fauxScriptPath: writeFauxScript([
        { match: "ENDPOINT_SCOPE", once: true, toolCalls: [{ name: "bash", args: { command } }] },
        { match: ".*", text: "done" },
      ]),
      agentDir: freshDir("push-log-home-"), subagentTempRoot: freshDir(), cwd: repo,
      env: { LOOP_PI_RUN_DIR: runDir },
    });
    try {
      session.send({ id: "p", type: "prompt", message: "ENDPOINT_SCOPE" });
      await waitForCondition(() => existsSync(ready) || undefined, 30_000);
      assert.equal(git(twin, "rev-parse", "refs/heads/main"), tip, "actual root publication reached mirror");
      if (mode !== "ambiguous-push") assert.equal(git(remote, "rev-parse", "refs/heads/main"), base, "root did not publish origin");
      git(repo, "push", "-q", remote, "main");
      writeFileSync(released, "go\n");
      const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
      assert.equal(end.isError, true);
      await session.waitFor((e) => e.type === "agent_end", 30_000);
      assert.equal(git(remote, "rev-parse", "refs/heads/main"), tip);
      if (!existsSync(log)) writeFileSync(log, "");
      const lines = readLog(log);
      const closeout = runAudit(runDir, "closeout", "--push-log", log);
      assert.deepEqual({ receipts: lines.length, auditExit: closeout.status }, { receipts: mode === "mirror" ? 1 : 0, auditExit: 1 }, closeout.output);
      if (mode === "mirror") {
        assert.equal(lines[0].remote, "mirror", "legitimate mirror receipt is preserved, not discarded");
        assert.match(closeout.output, /remote 'mirror' ref moved: refs\/heads\/main.*\[GRANTED\]/);
      }
      assert.match(closeout.output, /remote 'origin' ref moved: refs\/heads\/main.*\[UNGRANTED\]/);
      assert.ok(closeout.output.includes(tip.slice(0, 12)), closeout.output);
    } finally { await session.close(); }
  });
}

test("root push log: a run without the protocol marker writes no push log", { timeout: 60_000 }, async () => {
  const { repo, runDir, log } = fixture(true);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "PUSH_LEGACY", once: true, toolCalls: [{ name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "PUSH_LEGACY" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    assert.equal(existsSync(log), false);
  } finally {
    await session.close();
  }
});

/** An agent home whose `worker` agent runs on the faux provider with only `bash`. */
function pushLaneHome(): string {
  const home = freshDir("push-log-lane-home-");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] } }));
  const config = JSON.parse(readFileSync(new URL("../../home/extensions/subagent/config.json", import.meta.url), "utf8"));
  // The installer expands the home template; fixtures must use their own disposable root.
  config.worktreeBaseDir = freshDir("push-log-managed-worktrees-");
  writeFileSync(join(home, "extensions", "subagent", "config.json"), JSON.stringify(config));
  writeFileSync(
    join(home, "agents", "worker.md"),
    ["---", "name: worker", "description: Push log test", "tools: bash", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", "---", "Test worker."].join("\n"),
  );
  return home;
}

/** Child-session bash results under `home` that the lane guard refused. */
function refusedBash(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "session.jsonl") {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          try {
            const message = JSON.parse(line).message;
            if (message?.role === "toolResult" && message.toolName === "bash" && message.isError && /loop-guard:/.test(JSON.stringify(message.content))) found.push(JSON.stringify(message.content));
          } catch { /* a writer may be completing the last JSONL line */ }
        }
      }
    }
  };
  walk(join(home, "sessions"));
  return found;
}

test("lanes never push: a managed-worktree lane's push is refused, the remote and the push log stay untouched", { timeout: 90_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const before = git(repo, "rev-parse", "HEAD");
  const begin = runAudit(runDir, "begin", realpathSync(repo));
  assert.equal(begin.status, 0, begin.output);
  const home = pushLaneHome();
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "worker", task: "Lane: L7 · Task: T-3 · Tier: routine\nCHILD_PUSH", async: true, worktree: true } }],
    },
    { match: "CHILD_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: `git ${[...IDENTITY, "-c", "commit.gpgsign=false"].join(" ")} commit --allow-empty -m lane-work && git push origin HEAD:refs/heads/main` } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: home,
    subagentTempRoot: freshDir(),
    cwd: repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "SPAWN_LANE" });
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
    const refused = await waitForCondition(() => (refusedBash(home).length ? refusedBash(home) : undefined), 45_000);
    assert.match(refused[0], /lanes never push/);
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), before, "the lane's push never reached the remote");
    assert.equal(git(repo, "rev-parse", "HEAD"), before, "the main checkout stayed on its original commit");
    assert.equal(readLog(log).length, 0, "a refused push leaves no push-log line");
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 0, closeout.output);
    assert.doesNotMatch(closeout.output, /UNGRANTED/);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------------------------
// A push the push log cannot see must not land (the subprocess-push regression): a granted lane ran
// `git push` from a Python heredoc, the remote's default branch moved with no push-log line, and the
// closeout audit marked the move UNGRANTED. The lane guard refuses such a push and names the literal
// form; the lane's literal retry is logged, so the real audit passes.
// ---------------------------------------------------------------------------------------------

const AUDIT = fileURLToPath(new URL("../../bin/loop-pi-audit", import.meta.url));

/** Run the closeout audit CLI with a stub `gh` (these scratch remotes have no GitHub releases). */
function runAudit(runDir: string, ...args: string[]): { status: number; output: string } {
  const bin = freshDir("push-log-audit-bin-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("python3", [AUDIT, ...args, "--run-dir", runDir], {
    encoding: "utf8",
    timeout: 30_000,
    env: hermeticFixtureEnv({ PATH: `${bin}:${process.env.PATH}`, LOOP_PI_RUN_DIR: runDir }),
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const COMMIT_TWO = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "two"];
const SUBPROCESS_PUSH = [
  "python3 - <<'PY'",
  "import subprocess",
  `subprocess.run([${["git", ...COMMIT_TWO].map((a) => `'${a}'`).join(",")}],check=True)`,
  "subprocess.run(['git','push','origin','main'],check=True)",
  "PY",
].join("\n");

test("lanes never push: a lane's subprocess push and its literal retry are both refused, so the closeout audit finds no move", { timeout: 90_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  const before = git(remote, "rev-parse", "refs/heads/main");
  const begin = runAudit(runDir, "begin", realpathSync(repo));
  assert.equal(begin.status, 0, begin.output);
  const home = pushLaneHome();
  const script = writeFauxScript([
    {
      match: "SPAWN_LANE",
      once: true,
      toolCalls: [{ name: "subagent", args: { agent: "worker", task: "Lane: L16 · Task: T-1 · Tier: routine\nCHILD_SUBPROCESS_PUSH", async: true } }],
    },
    { match: "CHILD_SUBPROCESS_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: SUBPROCESS_PUSH } }] },
    {
      match: "loop-guard:",
      once: true,
      toolCalls: [{ name: "bash", args: { command: `git ${COMMIT_TWO.join(" ")} && git push origin main` } }],
    },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: script,
    agentDir: home,
    subagentTempRoot: freshDir(),
    cwd: repo,
    sessionArgs: [],
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "SPAWN_LANE" });
    const launch = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent", 30_000);
    assert.equal(launch.isError ?? false, false, JSON.stringify(launch));
    // Both the interpreter push and the literal retry are refused.
    const refused = await waitForCondition(() => (refusedBash(home).length >= 2 ? refusedBash(home) : undefined), 45_000);
    for (const reason of refused) assert.match(reason, /lanes never push|push log cannot see/);
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), before, "no lane push reached the remote");
    assert.equal(readLog(log).length, 0);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.doesNotMatch(closeout.output, /UNGRANTED/, closeout.output);
    assert.equal(closeout.status, 0, closeout.output);
  } finally {
    await session.close();
  }
});

// Remaining root-only gap: root.ts is outside this lane's ownership. It calls planPushes but
// not unloggedPushRefusal for bash, and its watch tools plan no pushes. This replay proves the
// precise inline-interpreter case still lands without a ledger entry, but the audit refuses it.
test("remaining root gap: an inline-interpreter push lands unlogged and closeout refuses it", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const begin = runAudit(runDir, "begin", realpathSync(repo));
  assert.equal(begin.status, 0, begin.output);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "ROOT_HIDDEN_PUSH", once: true, toolCalls: [{ name: "bash", args: { command: SUBPROCESS_PUSH } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-root-gap-home-"), subagentTempRoot: freshDir(), cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "ROOT_HIDDEN_PUSH" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    assert.equal(git(remote, "log", "-1", "--format=%s", "refs/heads/main"), "two");
    assert.equal(readLog(log).length, 0);
    const closeout = runAudit(runDir, "closeout", "--push-log", log);
    assert.equal(closeout.status, 1, closeout.output);
    assert.match(closeout.output, /UNGRANTED/);
  } finally {
    await session.close();
  }
});

test("push log: exec-wrapper pushes are hidden and refused on granted lanes", () => {
  for (const command of EXEC_PUSHES) {
    assert.equal(hiddenPush(command), true, command);
    assert.match(unloggedPushRefusal(command, "bash") ?? "", /push log cannot see it/, command);
    assert.match(unloggedPushRefusal(command, "watch_process") ?? "", /not recorded/, command);
  }
});

test("push log: a push the log cannot attribute is hidden; a literal push is not", () => {
  const hidden = [
    SUBPROCESS_PUSH,
    `python3 -c "import subprocess; subprocess.run(['git', 'push', 'origin', 'main'], check=True)"`,
    `node -e "require('child_process').execSync('git -C repo push origin HEAD')"`,
    `perl -e 'system("gh pr merge 7 --merge")'`,
    "git -c alias.ship='!git push origin main' ship",
  ];
  for (const command of hidden) assert.equal(hiddenPush(command), true, command);
  const attributed = [
    "git push origin main",
    'bash -c "git push origin main"',
    "env GIT_TRACE=1 git push",
    "cd sub && git push origin HEAD:refs/heads/main",
    'git commit -m "explain why git push was refused"',
    `python3 -c "import subprocess; subprocess.run(['git', 'status'])"`,
  ];
  for (const command of attributed) assert.equal(hiddenPush(command), false, command);
  assert.equal(unloggedPushRefusal("git push origin main", "bash"), undefined);
  assert.match(unloggedPushRefusal(SUBPROCESS_PUSH, "bash") ?? "", /push log cannot see it/);
  assert.match(unloggedPushRefusal("git push origin main", "watch_process") ?? "", /watch_process is not recorded/);
  assert.equal(unloggedPushRefusal("npm test", "watch_process"), undefined);
});

test("lanes never push: the lane reads the run dir from its binding when the environment has none", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const saved = { run: process.env.LOOP_PI_RUN_DIR, bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS };
  delete process.env.LOOP_PI_RUN_DIR;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "loop-pi.guard/1": { agent: "senior", runDir } });
  try {
    const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
    laneExtension({ events: { on() { return () => {}; }, emit() {} }, on: (event: string, h: any) => void handlers.set(event, [...(handlers.get(event) ?? []), h]) } as any);
    const ctx = { cwd: repo, ui: { notify: () => {} } };
    const fire = async (event: string, payload: Record<string, unknown>) => {
      let last: any;
      for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...payload }, ctx);
      return last;
    };
    await fire("before_agent_start", { prompt: "Lane: C2 · Task: T-9 · Tier: guarded\nObjective: x", systemPrompt: "" });
    // The binding's run dir arms the marker-gated rules for this lane: the run dir is the harness's, not the lane's.
    const intoRunDir = await fire("tool_call", { toolCallId: "rd", toolName: "bash", input: { command: `echo x > ${runDir}/stray` } });
    assert.equal(intoRunDir?.block, true, "the run dir named by the binding is protected");
    assert.match(intoRunDir.reason, /inside the loop run dir/);
    // Every push form a lane can type is refused, hidden or literal; none is recorded.
    const forms = ["git pu\\sh origin HEAD:refs/heads/main", "git push origin HEAD:refs/heads/main", ...EXEC_PUSHES];
    for (const command of forms) {
      for (const toolName of ["bash", "watch_process"]) {
        const refusal = await fire("tool_call", { toolCallId: "p", toolName, input: { command } });
        assert.equal(refusal?.block, true, `${toolName}: ${command}`);
        assert.match(refusal.reason, /lanes never push|push log cannot see it|not recorded/, `${toolName}: ${command}`);
      }
    }
    unlinkSync(join(runDir, "loop-pi-proto"));
    const afterDeletion = await fire("tool_call", { toolCallId: "deleted", toolName: "bash", input: { command: "git push origin main" } });
    assert.equal(afterDeletion?.block, true, "a push stays refused when the marker is gone");
    assert.match(afterDeletion.reason, /lanes never push/);
    const stillProtected = await fire("tool_call", { toolCallId: "rd2", toolName: "bash", input: { command: `echo x > ${runDir}/stray2` } });
    assert.equal(stillProtected?.block, true, "observed protocol cannot be downgraded by marker deletion");
    assert.equal(readLog(log).length, 0);
  } finally {
    if (saved.run === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = saved.run;
    if (saved.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved.bindings;
  }
});

// ---------------------------------------------------------------------------------------------
// The logged range is the root's or lane's own push: `new` is the local commit the push sent, and
// a line is written only when the remote ref equals it afterwards (SEAMS S1, security review M1).
// ---------------------------------------------------------------------------------------------

const NO_SIGN = ["-c", "commit.gpgsign=false"];

test("root push log: a foreign push between the root's push and tool_execution_end is not inside the logged range", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  const first = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "two");
  const other = freshDir("push-log-foreign-");
  git(other, "clone", "-q", remote, ".");
  // Runs after the root's push, inside the same bash call, where the guard cannot see it.
  const foreign = join(freshDir("push-log-foreign-script-"), "foreign.sh");
  writeFileSync(
    foreign,
    [
      "set -e",
      `cd '${other}'`,
      "git fetch -q origin",
      "git reset -q --hard origin/main",
      `git ${[...IDENTITY, ...NO_SIGN].join(" ")} commit -q --allow-empty -m foreign`,
      "git push -q origin HEAD:refs/heads/main",
    ].join("\n"),
  );
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "PUSH_RACE", once: true, toolCalls: [{ name: "bash", args: { command: `git push origin main && sh '${foreign}'` } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "PUSH_RACE" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash", 30_000);
    assert.equal(end.isError, false, JSON.stringify(end));
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    const foreignSha = git(other, "rev-parse", "HEAD");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), foreignSha, "the foreign push landed after the root's");
    for (const line of readLog(log)) {
      assert.notEqual(line.new, foreignSha, JSON.stringify(line));
      const inRange = (() => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", foreignSha, String(line.new)], { cwd: remote, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      assert.equal(inRange, false, `the foreign commit is inside the logged range ${line.old}..${line.new}`);
    }
    assert.notEqual(first, foreignSha);
  } finally {
    await session.close();
  }
});

test("push log: the refspec forms resolve to the local commit each push sent", { timeout: 60_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const meta = { runDir, actor: "root" as const, agent: null, lane: null };
  const commit = (m: string) => {
    git(repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", m);
    return git(repo, "rev-parse", "HEAD");
  };
  const run = async (command: string) => {
    const before = readLog(log).length;
    const plans = await planPushes(command, repo);
    execFileSync("/bin/sh", ["-c", command], { cwd: repo, stdio: "ignore", timeout: 20_000 });
    await recordPushes(plans, meta);
    return readLog(log).slice(before).map((l) => [l.ref, l.old, l.new]);
  };
  const c1 = git(repo, "rev-parse", "HEAD");
  assert.deepEqual(await run("git push -q --set-upstream origin main"), [["refs/heads/main", null, c1]]);
  const c2 = commit("c2");
  assert.deepEqual(await run("git push -q"), [["refs/heads/main", c1, c2]]);
  const c3 = commit("c3");
  assert.deepEqual(await run("git push -q origin main"), [["refs/heads/main", c2, c3]]);
  const c4 = commit("c4");
  assert.deepEqual(await run("git push -q origin HEAD:main"), [["refs/heads/main", c3, c4]]);
  git(repo, "branch", "topic", c3);
  assert.deepEqual(await run("git push -q origin +topic:refs/heads/review"), [["refs/heads/review", null, c3]]);
  assert.deepEqual(await run("git push -q origin main"), [], "an up-to-date push logs nothing");
  // A commit made earlier in the same command is the commit the push sent.
  const quoted = [...IDENTITY, ...NO_SIGN].join(" ");
  const lines = await run(`git checkout -q -b fresh && git ${quoted} commit -q --allow-empty -m c5 && git push -q -u origin fresh`);
  assert.deepEqual(lines, [["refs/heads/fresh", null, git(repo, "rev-parse", "HEAD")]]);
});

test("push log: a push from a linked worktree records the main checkout as repo", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const wt = join(freshDir("push-log-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", "lane-branch", wt);
  git(wt, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "lane work");
  const plans = await planPushes("git push origin lane-branch", wt);
  git(wt, "push", "-q", "origin", "lane-branch");
  await recordPushes(plans, { runDir, actor: "lane", agent: "worker", lane: "L1" });
  const lines = readLog(log);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].repo, realpathSync(repo));
  assert.equal(lines[0].new, git(wt, "rev-parse", "HEAD"));
});

test("push log: an escaped literal push is planned and recorded", { timeout: 30_000 }, async () => {
  const { repo, runDir, log } = fixture();
  const command = "git pu\\sh origin HEAD:refs/heads/main";
  const plans = await planPushes(command, repo);
  assert.equal(plans.length, 1);
  execFileSync("/bin/sh", ["-c", command], { cwd: repo, timeout: 10_000 });
  assert.equal(await recordPushes(plans, { runDir, actor: "lane", agent: "worker", lane: "L2" }), 1);
  assert.equal(readLog(log)[0].new, git(repo, "rev-parse", "HEAD"));
});

test("root push log: a push from a linked worktree grants closeout under both snapshot paths", { timeout: 30_000 }, async () => {
  const { repo, remote, runDir, log } = fixture();
  git(repo, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const wt = join(freshDir("push-log-audit-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", "lane-work", wt);
  assert.equal(runAudit(runDir, "begin", wt).status, 0);
  assert.equal(runAudit(runDir, "add", realpathSync(repo)).status, 0);
  git(wt, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "worktree change");
  const plans = await planPushes("git push origin HEAD:refs/heads/main", wt, runDir);
  assert.equal(plans.length, 1);
  git(wt, "push", "-q", "origin", "HEAD:refs/heads/main");
  assert.equal(await recordPushes(plans, { runDir, actor: "root", agent: null, lane: null }), 1);
  const lines = readLog(log);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.deepEqual([lines[0].repo, lines[0].actor, lines[0].new], [realpathSync(repo), "root", git(wt, "rev-parse", "HEAD")]);
  const closeout = runAudit(runDir, "closeout", "--push-log", log);
  assert.equal(closeout.status, 0, closeout.output);
  assert.doesNotMatch(closeout.output, /UNGRANTED/);
  assert.match(closeout.output, /refs\/heads\/main.*GRANTED/);
});

// ---------------------------------------------------------------------------------------------
// `gh pr merge` lands a pull request the same way a push does (security review M2a): old is the
// remote base branch before, new the PR's merge commit, logged only when the PR is MERGED and the
// remote base branch equals that commit. A fake `gh` on PATH stands in for GitHub.
// ---------------------------------------------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", ["-c", "user.name=gh", "-c", "user.email=gh@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: process.env.FAKE_GH_WORK, encoding: "utf8" }).trim();
if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1].split(",");
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((f) => [f, state[f] ?? null]))) + "\\n");
} else if (args[0] === "pr" && args[1] === "merge") {
  if (args.includes("--auto")) {
    process.stdout.write("auto-merge enabled\\n");
  } else {
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-B", state.baseRefName, "origin/" + state.baseRefName);
    git("merge", "-q", "--no-ff", "-m", "Merge pull request #" + state.number, "origin/" + state.headRefName);
    git("push", "-q", "origin", "HEAD:refs/heads/" + state.baseRefName);
    state.state = "MERGED";
    state.mergeCommit = { oid: git("rev-parse", "HEAD") };
    writeFileSync(statePath, JSON.stringify(state));
  }
} else {
  process.stderr.write("fake gh: unsupported " + args.join(" ") + "\\n");
  process.exit(1);
}
`;

/** The push-log fixture plus a pushed `main`, an open PR #7 from `feature`, and a fake `gh`. */
function prFixture() {
  const f = fixture();
  git(f.repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(f.repo, "checkout", "-q", "-b", "feature");
  git(f.repo, ...IDENTITY, ...NO_SIGN, "commit", "--allow-empty", "-m", "feature work");
  git(f.repo, "push", "-q", "origin", "feature");
  const bin = freshDir("push-log-gh-bin-");
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const work = freshDir("push-log-gh-work-");
  git(work, "clone", "-q", f.remote, ".");
  const state = join(freshDir("push-log-gh-state-"), "pr.json");
  writeFileSync(
    state,
    JSON.stringify({ number: 7, url: "https://github.com/acme/widget/pull/7", baseRefName: "main", headRefName: "feature", state: "OPEN", mergeCommit: null }),
  );
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_WORK: work };
  return { ...f, env, mainBefore: git(f.remote, "rev-parse", "refs/heads/main") };
}

test("root push log: a successful gh pr merge logs the base branch move to the PR's merge commit", { timeout: 60_000 }, async () => {
  const { repo, remote, runDir, log, env, mainBefore } = prFixture();
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "MERGE_AUTO", once: true, toolCalls: [{ name: "bash", args: { command: "gh pr merge 7 --auto --merge" } }] },
      { match: "MERGE_NOW", once: true, toolCalls: [{ name: "bash", args: { command: "gh pr merge 7 --merge --delete-branch" } }] },
      { match: ".*", text: "done" },
    ]),
    agentDir: freshDir("push-log-home-"),
    subagentTempRoot: freshDir(),
    cwd: repo,
    env: { LOOP_PI_RUN_DIR: runDir, ...env },
  });
  const bashEnds = () => session.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash");
  const prompt = async (message: string, n: number) => {
    session.send({ id: message, type: "prompt", message });
    await waitForCondition(() => (bashEnds().length >= n ? true : undefined), 30_000);
    await session.waitFor((e) => e.type === "agent_end" && session.events.indexOf(e) > session.events.indexOf(bashEnds()[n - 1]), 30_000);
  };
  try {
    await prompt("MERGE_AUTO", 1);
    assert.equal(bashEnds()[0].isError, false, JSON.stringify(bashEnds()[0]));
    assert.deepEqual(readLog(log), [], "an auto-merge that has not merged yet logs nothing");
    await prompt("MERGE_NOW", 2);
    assert.equal(bashEnds()[1].isError, false, JSON.stringify(bashEnds()[1]));
    const merged = git(remote, "rev-parse", "refs/heads/main");
    assert.notEqual(merged, mainBefore);
    const lines = readLog(log);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.deepEqual(
      { ...lines[0], ts: "" },
      { v: 1, ts: "", actor: "root", agent: null, lane: null, repo: realpathSync(repo), remote: "origin", ref: "refs/heads/main", old: mainBefore, new: merged },
    );
  } finally {
    await session.close();
  }
});
