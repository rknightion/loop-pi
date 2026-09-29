// Adapter tests against the guard scripts, copied into a scratch
// scripts/ dir the way loop-pi-install lays out a real agent home.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KNOWN_HOOK_SCRIPTS, hookScriptPaths, hookScriptsToRun, requiredHookScripts, runHookScript, runHookScripts } from "./hooks.ts";
import { HOOK_TEMPLATES_DIR, SAMPLE_HOOK_SCRIPTS_DIR } from "../test-support/hook-templates.ts";

// The guard scripts to lay out in a scratch <agentDir>/scripts/: this checkout's shared guards
// when it carries them, else the sample guards in test-support (see hook-templates.ts).
const TEMPLATES_DIR = HOOK_TEMPLATES_DIR;

test("hookScriptPaths resolves under <agentDir>/scripts/", () => {
  const paths = hookScriptPaths("/tmp/example-agent-dir");
  assert.equal(paths.backlogGuard, "/tmp/example-agent-dir/scripts/backlog-guard.py");
  assert.equal(paths.stagingGuard, "/tmp/example-agent-dir/scripts/staging-guard.py");
});

async function setupHooks(): Promise<{ backlogGuard: string; stagingGuard: string; cwd: string }> {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-hooks-run-"));
  const hooksDir = join(dir, "scripts");
  await cp(TEMPLATES_DIR, hooksDir, { recursive: true });
  return { backlogGuard: join(hooksDir, "backlog-guard.py"), stagingGuard: join(hooksDir, "staging-guard.py"), cwd: dir };
}

test("runHookScript: backlog-guard.py denies a bare --notes flag", async () => {
  const { backlogGuard, cwd } = await setupHooks();
  try {
    const result = await runHookScript({
      script: backlogGuard,
      toolName: "bash",
      toolInput: { command: "backlog task edit hrn-1 --notes hi" },
      cwd,
    });
    assert.equal(result.denied, true);
    assert.ok(result.reason && /append-notes/.test(result.reason));
    assert.equal(result.adapterFailure, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScript: backlog-guard.py allows --append-notes", async () => {
  const { backlogGuard, cwd } = await setupHooks();
  try {
    const result = await runHookScript({
      script: backlogGuard,
      toolName: "bash",
      toolInput: { command: "backlog task edit hrn-1 --append-notes hi" },
      cwd,
    });
    assert.equal(result.denied, false);
    assert.equal(result.adapterFailure, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScript: backlog-guard.py denies a hand-edit of backlog/tasks", async () => {
  const { backlogGuard, cwd } = await setupHooks();
  try {
    const result = await runHookScript({
      script: backlogGuard,
      toolName: "edit",
      toolInput: { path: `${cwd}/backlog/tasks/task-1.md` },
      cwd,
    });
    assert.equal(result.denied, true);
    assert.ok(result.reason && /CLI-owned/.test(result.reason));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScript: staging-guard.py denies bulk git add -A", async () => {
  const { stagingGuard, cwd } = await setupHooks();
  try {
    const result = await runHookScript({
      script: stagingGuard,
      toolName: "bash",
      toolInput: { command: "git add -A" },
      cwd,
    });
    assert.equal(result.denied, true);
    assert.ok(result.reason && /bulk staging/i.test(result.reason));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScript: an ordinary read-only command is allowed by both scripts", async () => {
  const { backlogGuard, stagingGuard, cwd } = await setupHooks();
  try {
    for (const script of [backlogGuard, stagingGuard]) {
      const result = await runHookScript({ script, toolName: "bash", toolInput: { command: "ls -la" }, cwd });
      assert.equal(result.denied, false);
      assert.equal(result.adapterFailure, undefined);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScript: a missing script is an adapter failure, not a deny", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-hooks-missing-"));
  try {
    const result = await runHookScript({
      script: join(dir, "scripts", "does-not-exist.py"),
      toolName: "bash",
      toolInput: { command: "ls" },
      cwd: dir,
    });
    assert.equal(result.denied, false);
    assert.ok(result.adapterFailure, "a missing script must surface as an adapter failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookScript: a timeout is an adapter failure, not a deny", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-hooks-timeout-"));
  const slowScript = join(dir, "slow.py");
  await writeFile(slowScript, "import time\ntime.sleep(5)\n", "utf8");
  try {
    const result = await runHookScript({
      script: slowScript,
      toolName: "bash",
      toolInput: { command: "ls" },
      cwd: dir,
      timeoutMs: 200,
    });
    assert.equal(result.denied, false);
    assert.ok(result.adapterFailure && /timeout/.test(result.adapterFailure));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookScript: a script that closes stdin early is an adapter failure, not a crash (EPIPE)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-hooks-epipe-"));
  const script = join(dir, "closes-stdin.py");
  // Closes stdin without reading, then exits non-zero: the payload write below is larger than a
  // pipe buffer, so it fails with EPIPE, which must not escape as an unhandled stream error.
  await writeFile(script, "import os, sys\nos.close(0)\nsys.exit(3)\n", "utf8");
  try {
    const result = await runHookScript({
      script,
      toolName: "bash",
      toolInput: { command: "x".repeat(4 * 1024 * 1024) },
      cwd: dir,
    });
    assert.equal(result.denied, false);
    assert.ok(result.adapterFailure && /exit 3/.test(result.adapterFailure), `got ${JSON.stringify(result)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHookScripts: stops at the first deny and does not run later scripts", async () => {
  const { backlogGuard, cwd } = await setupHooks();
  const neverRun = join(cwd, "scripts", "does-not-exist.py");
  try {
    const summary = await runHookScripts([backlogGuard, neverRun], "bash", { command: "backlog task edit hrn-1 --notes hi" }, cwd);
    assert.equal(summary.denied, true);
    assert.deepEqual(summary.adapterFailures, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runHookScripts: collects adapter failures when nothing denies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-hooks-fail-"));
  try {
    const summary = await runHookScripts(
      [join(dir, "scripts", "missing-one.py"), join(dir, "scripts", "missing-two.py")],
      "bash",
      { command: "ls" },
      dir,
    );
    assert.equal(summary.denied, false);
    assert.equal(summary.adapterFailures.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// loopPi.requiredHookScripts (settings.json): a guard script that is absent and
// not required is skipped; an absent REQUIRED one is still run, so it surfaces
// as an adapter failure (which blocks lanes). A settings file that cannot be
// read as JSON fails closed: every known guard is required.
// ---------------------------------------------------------------------------

async function agentDirWith(scripts: string[], settings?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-required-"));
  await mkdir(join(dir, "scripts"), { recursive: true });
  for (const name of scripts) await cp(join(SAMPLE_HOOK_SCRIPTS_DIR, name), join(dir, "scripts", name));
  if (settings !== undefined) await writeFile(join(dir, "settings.json"), settings, "utf8");
  return dir;
}

test("hookScriptsToRun: an absent optional script is skipped, a present one runs", async () => {
  const dir = await agentDirWith(["backlog-guard.py"]);
  try {
    assert.deepEqual(hookScriptsToRun(dir, [...KNOWN_HOOK_SCRIPTS]), [join(dir, "scripts", "backlog-guard.py")]);
    const summary = await runHookScripts(hookScriptsToRun(dir, [...KNOWN_HOOK_SCRIPTS]), "bash", { command: "ls" }, dir);
    assert.deepEqual(summary, { denied: false, adapterFailures: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hookScriptsToRun: an absent required script is still run and is an adapter failure", async () => {
  const dir = await agentDirWith([], JSON.stringify({ loopPi: { requiredHookScripts: ["staging-guard.py"] } }));
  try {
    const scripts = hookScriptsToRun(dir, [...KNOWN_HOOK_SCRIPTS]);
    assert.deepEqual(scripts, [join(dir, "scripts", "staging-guard.py")]);
    const summary = await runHookScripts(scripts, "bash", { command: "ls" }, dir);
    assert.equal(summary.adapterFailures.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requiredHookScripts: no settings file or no key requires nothing", async () => {
  const bare = await agentDirWith([]);
  const other = await agentDirWith([], JSON.stringify({ theme: "dark", loopPi: {} }));
  try {
    assert.deepEqual(requiredHookScripts(bare), []);
    assert.deepEqual(requiredHookScripts(other), []);
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("requiredHookScripts: unreadable or malformed settings fail closed to every known guard", async () => {
  for (const settings of ["{not json", JSON.stringify({ loopPi: { requiredHookScripts: "backlog-guard.py" } }),
    JSON.stringify({ loopPi: { requiredHookScripts: [1] } })]) {
    const dir = await agentDirWith([], settings);
    try {
      assert.deepEqual(requiredHookScripts(dir), [...KNOWN_HOOK_SCRIPTS], settings);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("the sample guards honour the hook contract the adapter expects", async () => {
  const dir = await agentDirWith([...KNOWN_HOOK_SCRIPTS]);
  const [backlog, staging] = [join(dir, "scripts", "backlog-guard.py"), join(dir, "scripts", "staging-guard.py")];
  try {
    const cases: [string, string, Record<string, unknown>, boolean][] = [
      [backlog, "bash", { command: "backlog task edit t-1 --plan x" }, true],
      [backlog, "bash", { command: "backlog task edit t-1 --append-plan x" }, false],
      [backlog, "write", { path: `${dir}/backlog/docs/doc-1.md` }, true],
      [staging, "bash", { command: "git add --all" }, true],
      [staging, "bash", { command: "git add README.md" }, false],
    ];
    for (const [script, toolName, toolInput, denied] of cases) {
      const result = await runHookScript({ script, toolName, toolInput, cwd: dir });
      assert.equal(result.denied, denied, JSON.stringify(toolInput));
      assert.equal(result.adapterFailure, undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
