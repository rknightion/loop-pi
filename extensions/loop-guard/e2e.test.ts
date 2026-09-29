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
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      const childSessionPath = await waitForCondition(() => findChildSessionFile(sessionsDir), 20_000, 300);
      const childSessionText = readTextFile(childSessionPath);

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
