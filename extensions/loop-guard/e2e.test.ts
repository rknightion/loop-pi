// End-to-end proof required by SEAMS.md: on the real pinned pi
// CLI, with the faux provider standing in for a live model,
//   (a) a root session (`--extension loop-guard/root.ts`) whose model calls a
//       forbidden bash command sees it blocked;
//   (b) a pi-subagents child spawned by that root via the `subagent` tool,
//       fenced only by loop-guard/lane.ts delivered through
//       registerRequiredChildExtensions (never loaded directly: the agent
//       file declares `extensions: []`), has a forbidden command blocked by
//       the lane rules.
//
// (b) is also the live verification of SEAMS.md's "Unverified" note: whether
// an import of `registerRequiredChildExtensions` from our extension shares the
// module instance pi-subagents' own async runner reads from a genuine
// detached child process. It does — see the recorded evidence in the test and
// this file's header comment below.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  FAUX_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAll,
  freshDir,
  readTextFile,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
} from "./rpc-test-helpers.ts";

after(() => {
  cleanupAll();
});

test("(a) root: a forbidden bash command from the model is blocked by loop-guard/root.ts", async () => {
  const agentDir = freshDir("loop-guard-e2e-root-agentdir-");
  const subagentTemp = freshDir("loop-guard-e2e-root-subtemp-");
  const cwd = freshDir("loop-guard-e2e-root-cwd-");
  const fauxScript = writeFauxScript([
    { match: "RUN_FORBIDDEN", once: true, toolCalls: [{ name: "bash", args: { command: "git push --force origin main" } }] },
    { match: ".*", text: "ok" },
  ]);

  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: fauxScript,
    agentDir,
    subagentTempRoot: subagentTemp,
    cwd,
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "RUN_FORBIDDEN please" });
    const toolEnd = await session.waitFor(
      (e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "bash",
    );
    const result = toolEnd.result as { content: { type: string; text: string }[] };
    assert.equal(toolEnd.isError, true, "the blocked bash call must be reported as an error");
    assert.match(result.content[0].text, /loop-guard: force-push forms are blocked/);
  } finally {
    await session.close();
  }
});

test(
  "(b) lane: a pi-subagents child spawned via the subagent tool is fenced by loop-guard/lane.ts " +
    "delivered through registerRequiredChildExtensions",
  async () => {
    const agentDir = freshDir("loop-guard-e2e-child-agentdir-");
    const subagentTemp = freshDir("loop-guard-e2e-child-subtemp-");
    const cwd = freshDir("loop-guard-e2e-child-cwd-");

    // Settings: load pi-subagents as a package, and exclude ~/.agents from agent discovery.
    // pi-subagents scans that user agent directory recursively, so an agent-config checkout kept
    // there would shadow this test's own `lane-worker` agent with a real one. Excluding it keeps
    // the test hermetic.
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [PI_SUBAGENTS_PACKAGE_DIR],
        subagents: { agentExcludeDirs: ["~/.agents"] },
      }),
    );

    // The agent file: `extensions: []` per the brief, so loop-guard-lane can
    // only reach this child through registerRequiredChildExtensions, never
    // through its own frontmatter. `subagentOnlyExtensions` is a *separate*
    // pi-subagents field (docs/agents.md "Tool and extension selection": "the
    // listed extensions, path-like tools entries, required pi-subagents
    // runtime extensions, and subagentOnlyExtensions still load" even when
    // `extensions` is empty) used only to give this background child a model:
    // a detached child is a genuinely separate OS process with its own empty
    // module registry, so it cannot inherit the parent's in-process
    // `pi.registerProvider("faux", ...)` call the way a foreground child
    // would. Confirmed by running this exact scenario without it: pi-subagents
    // itself reports "Model \"faux/faux-1\" not found... list it in
    // `subagentOnlyExtensions` or `extensions`".
    writeFileSync(
      join(agentDir, "agents", "lane-worker.md"),
      [
        "---",
        "name: lane-worker",
        "description: Test lane worker for the loop-guard e2e proof",
        "tools: bash",
        "extensions: []",
        `subagentOnlyExtensions: ${FAUX_EXTENSION}`,
        "model: faux/faux-1",
        "---",
        "",
        "You are a test lane worker.",
      ].join("\n"),
    );

    const fauxScript = writeFauxScript([
      {
        match: "SPAWN_CHILD_MARKER",
        once: true,
        toolCalls: [{ name: "subagent", args: { agent: "lane-worker", task: "CHILD_FORBIDDEN_MARKER do the thing" } }],
      },
      { match: "CHILD_FORBIDDEN_MARKER", once: true, toolCalls: [{ name: "bash", args: { command: "git push --force origin main" } }] },
      { match: ".*", text: "ok" },
    ]);

    // No --no-session: pi-subagents writes the child's session file nested
    // under the parent's own session file/dir (SEAMS.md), so the root needs a
    // real persisted session for that path to exist at all.
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
      fauxScriptPath: fauxScript,
      agentDir,
      subagentTempRoot: subagentTemp,
      cwd,
      sessionArgs: [],
      // subagent starts registered-but-inactive on a fresh parent session
      // behind a subagents_enable gate (pi-subagents docs/configuration.md);
      // excluding it keeps `subagent` active from the first turn so the
      // scripted faux model can call it directly.
      extraArgs: ["--exclude-tools", "subagents_enable"],
    });

    try {
      session.send({ id: "p1", type: "prompt", message: "SPAWN_CHILD_MARKER please" });

      // The root's own subagent tool_execution_end just confirms the launch
      // kicked off (async by default); the actual proof is in the child's own
      // session file.
      const launchEnd = await session.waitFor(
        (e) => e.type === "tool_execution_end" && (e as { toolName?: string }).toolName === "subagent",
      );
      assert.equal(
        (launchEnd as { isError?: boolean }).isError ?? false,
        false,
        `the subagent launch itself must not fail: ${JSON.stringify(launchEnd).slice(0, 500)}`,
      );

      const sessionsDir = join(agentDir, "sessions");
      // The child appends its session file as it runs, so the file can exist (and already hold
      // the forced-push tool call) before the tool result is written. Poll until a complete bash
      // toolResult line is present; the assertions below then judge what that result says.
      const { path: childSessionPath, text: childSessionText } = await waitForCondition(() => {
        const path = findChildSessionFile(sessionsDir);
        if (!path) return undefined;
        const text = readTextFile(path);
        return hasBashToolResult(text) ? { path, text } : undefined;
      }, 30_000, 300);

      assert.match(
        childSessionText,
        /loop-guard: force-push forms are blocked for every role/,
        `child session file must show the lane rule's blocked reason: ${childSessionPath}`,
      );

      const blockedLine = childSessionText
        .split("\n")
        .find((line) => line.includes("loop-guard: force-push forms are blocked"));
      assert.ok(blockedLine, "expected a JSONL line carrying the blocked tool result");
      const parsedLine = JSON.parse(blockedLine!);
      assert.equal(parsedLine.message?.role, "toolResult");
      assert.equal(parsedLine.message?.isError, true);
      assert.equal(parsedLine.message?.toolName, "bash");

      // This IS the proof that registerRequiredChildExtensions reached the
      // child: the child's agent file declares `extensions: []`, so
      // loop-guard's block can only have run there because root.ts's
      // session_start registered loop-guard/lane.ts as a required child
      // extension and pi-subagents' async runner resolved and loaded it for
      // this detached process.
    } finally {
      await session.close();
    }
  },
);

test("root's required extension registration rejects an external runner's public launch contract", async () => {
  const agentDir = freshDir("loop-guard-e2e-external-agentdir-");
  const cwd = freshDir("loop-guard-e2e-external-cwd-");
  const marker = join(cwd, "runner-started");
  const runner = join(cwd, "runner.cjs");
  writeFileSync(runner, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`);
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR],
    subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
    "---", "name: lane-worker", "description: Test external runner",
    "runner:", "  type: external-cli", `  command: ${JSON.stringify(process.execPath)}`,
    `  args: [${JSON.stringify(runner)}]`, "---", "Test external runner.",
  ].join("\n"));
  // The root's direct subagent path always adds native-only extensionBindings, which
  // already rejects external runners. Use public preflight without bindings to isolate
  // the host-required extension contract instead of testing that unrelated fence.
  const probeDir = freshDir("loop-guard-e2e-preflight-extension-");
  symlinkSync(dirname(PI_SUBAGENTS_PACKAGE_DIR), join(probeDir, "node_modules"), "dir");
  const probe = join(probeDir, "probe.ts");
  writeFileSync(probe, [
    'import { resolveSubagentLaunchContract } from "pi-subagents/preflight";',
    'export default function (pi) { pi.registerTool({',
    'name: "inspect_child_contract", label: "Inspect child contract", description: "Test launch preflight",',
    'parameters: { type: "object", properties: {} },',
    'async execute(_id, _args, _signal, _update, ctx) {',
    'const result = await resolveSubagentLaunchContract({ agent: "lane-worker", cwd: ctx.cwd,',
    'parentSessionId: ctx.sessionManager.getSessionId() });',
    'return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };',
    '} }); }',
  ].join("\n"));
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, probe],
    fauxScriptPath: writeFauxScript([
      { match: "SPAWN_EXTERNAL", once: true, toolCalls: [
        { name: "inspect_child_contract", args: {} },
      ] },
      { match: ".*", text: "ok" },
    ]),
    agentDir, cwd, subagentTempRoot: freshDir("loop-guard-e2e-external-subtemp-"),
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_EXTERNAL" });
    const result = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "inspect_child_contract");
    assert.equal(result.isError, false, "the preflight probe itself must succeed");
    const details = (result.result as { details: { ok: boolean } }).details;
    assert.equal(details.ok, false, `external launch contract must be refused: ${JSON.stringify(result)}`);
    assert.match(JSON.stringify(result.result), /host requires child extensions.*for every runner/);
    assert.equal(existsSync(marker), false, "the external runner process must not start");
  } finally {
    await session.close();
  }
});

test("a required lane guard throwing at session_start refuses the child before its task runs", async () => {
  const agentDir = freshDir("loop-guard-e2e-throw-agentdir-");
  const cwd = freshDir("loop-guard-e2e-throw-cwd-");
  const fixture = freshDir("loop-guard-e2e-throw-extension-");
  // Exercise the unchanged root entry with a faulty sibling guard, as in an installed build.
  // Only the disposable copy's lane entry is replaced; the production lane stays untouched.
  cpSync(dirname(ROOT_EXTENSION), join(fixture, "extensions", "loop-guard"), { recursive: true });
  // root.ts imports its sibling request-ceiling extension, as in an installed build.
  cpSync(join(dirname(ROOT_EXTENSION), "..", "request-ceiling"), join(fixture, "extensions", "request-ceiling"), { recursive: true });
  symlinkSync(dirname(PI_SUBAGENTS_PACKAGE_DIR), join(fixture, "node_modules"), "dir");
  const startupMarker = join(cwd, "guard-started");
  const taskMarker = join(cwd, "task-ran");
  writeFileSync(join(fixture, "extensions", "loop-guard", "lane.ts"), [
    'import { writeFileSync } from "node:fs";',
    'export default function (pi) { pi.on("session_start", () => {',
    `writeFileSync(${JSON.stringify(startupMarker)}, "started");`,
    'throw new Error("FAULTY_LANE_GUARD_STARTUP");',
    '}); }',
  ].join("\n"));
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR],
    subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  writeFileSync(join(agentDir, "agents", "lane-worker.md"), [
    "---", "name: lane-worker", "description: Test faulty lane guard", "tools: bash",
    "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1",
    "---", "Test lane worker.",
  ].join("\n"));
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, join(fixture, "extensions", "loop-guard", "root.ts")],
    fauxScriptPath: writeFauxScript([
      { match: "SPAWN_FAULTY_GUARD", once: true, toolCalls: [
        { name: "subagent", args: { agent: "lane-worker", task: "CHILD_TASK_MARKER", async: false } },
      ] },
      { match: "CHILD_TASK_MARKER", once: true, toolCalls: [
        { name: "bash", args: { command: `touch '${taskMarker}'` } },
      ] },
      { match: ".*", text: "ok" },
    ]),
    agentDir, cwd, subagentTempRoot: freshDir("loop-guard-e2e-throw-subtemp-"),
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "SPAWN_FAULTY_GUARD" });
    const result = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "subagent");
    assert.equal(existsSync(startupMarker), true, "the required guard's startup handler must have run");
    assert.equal(result.isError, true, `faulty guard must refuse the launch: ${JSON.stringify(result)}`);
    assert.match(JSON.stringify(result.result), /Required child extension failed during startup/);
    assert.match(JSON.stringify(result.result), /FAULTY_LANE_GUARD_STARTUP/);
    assert.equal(existsSync(taskMarker), false, "no child task may run after guard startup fails");
  } finally {
    await session.close();
  }
});

/** True once a complete JSONL line records a bash tool result. A trailing line still being
 *  written fails to parse and is skipped until a later poll. */
function hasBashToolResult(text: string): boolean {
  return text.split("\n").some((line) => {
    try {
      const message = JSON.parse(line)?.message;
      return message?.role === "toolResult" && message?.toolName === "bash";
    } catch {
      return false;
    }
  });
}

/** Recursively find a pi-subagents child's `session.jsonl` (or `run-N/session.jsonl`)
 *  under the parent's `sessions/` dir, once it has at least one line. */
function findChildSessionFile(dir: string): string | undefined {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findChildSessionFile(full);
      if (found) return found;
    } else if (entry.name === "session.jsonl") {
      try {
        if (statSync(full).size > 0) return full;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

test("(c) protocol 2 root: with the run dir marker, a write into the run dir and a long bash timeout are refused", async () => {
  const runDir = freshDir("loop-guard-e2e-p2-run-");
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const cwd = freshDir("loop-guard-e2e-p2-cwd-");
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "P2_WRITE", once: true, toolCalls: [{ name: "write", args: { path: join(runDir, "push-log.jsonl"), content: "{}\n" } }] },
      { match: "P2_TIMEOUT", once: true, toolCalls: [{ name: "bash", args: { command: "true", timeout: 3600 } }] },
      { match: ".*", text: "ok" },
    ]),
    agentDir: freshDir("loop-guard-e2e-p2-agentdir-"),
    subagentTempRoot: freshDir("loop-guard-e2e-p2-subtemp-"),
    cwd,
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p1", type: "prompt", message: "P2_WRITE" });
    const write = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write");
    assert.equal(write.isError, true, JSON.stringify(write));
    assert.match(JSON.stringify(write.result), /inside the loop run dir/);
    assert.equal(existsSync(join(runDir, "push-log.jsonl")), false);
    await session.waitFor((e) => e.type === "agent_end");
    session.send({ id: "p2", type: "prompt", message: "P2_TIMEOUT" });
    const bash = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "bash");
    assert.equal(bash.isError, true, JSON.stringify(bash));
    assert.match(JSON.stringify(bash.result), /watch_start/);
  } finally {
    await session.close();
  }
});
