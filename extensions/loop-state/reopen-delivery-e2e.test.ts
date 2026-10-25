// A loop root killed while a lane runs must learn the lane's result when its session is reopened.
// pi-subagents 0.82.0 delivers a finished run whose completion owner process is dead to the
// session that owns the run (`runs/background/result-delivery-ownership.js`), appended without a
// turn on startup. 0.81.0 kept the dead owner's id and never reported it. Native Pi RPC + faux.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupFixtures, loopFixture } from "../loop-continuation/test-fixture.ts";
import { cleanupAllAfterExit, expectDetachedRuns, FAUX_EXTENSION, freshDir, PI_SUBAGENTS_PACKAGE_DIR, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

const STATE = fileURLToPath(new URL("./index.ts", import.meta.url));
const CONTINUATION = fileURLToPath(new URL("../loop-continuation/index.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));
const append = (log: string, ...args: string[]) => execFileSync(BIN, ["append", log, ...args], { timeout: 10_000, stdio: "pipe" });
const rows = (log: string): any[] => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("a lane that finishes while its root is dead is returned when the root session is reopened", { timeout: 120_000 }, async (t) => {
  const s = loopFixture({ root: "faux/faux-1" });
  mkdirSync(join(s.agentDir, "agents"));
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, packages: [PI_SUBAGENTS_PACKAGE_DIR], defaultProjectTrust: "never", subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(s.agentDir, "agents", "worker.md"), ["---", "name: worker", "description: Fixture", "tools: read", "model: faux/faux-1", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "---", "Fixture"].join("\n"));
  const block = '```lane-return\n' + JSON.stringify({ v: 2, lane: "L1", status: "complete", sha: null, landed: false, base: "fixture", check: "reopen-fixture", exit: 0, tail: "ok", ci: null, coderabbit: null, questions: [] }) + '\n```';
  const subagentTempRoot = freshDir();
  t.after(async () => {
    // Observe owned root exit and detached writer quiescence; never signal a persisted PID.
    // If startup/terminal evidence is missing, this fails and retains every fixture directory.
    await cleanupAllAfterExit();
    cleanupFixtures();
  });
  const fauxScriptPath = writeFauxScript([
    { match: "SPAWN_SLOW", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "Lane: L1 · Task: T-1 · Tier: routine\nObjective: CHILD_SLOW", async: true, worktree: false } }] },
    { match: "CHILD_SLOW", delayMs: 6_000, text: block },
    { match: ".*", text: "PAUSED: fixture awaits the next explicit input." },
  ]);
  const start = (sessionArgs: string[]) => startPiRpc({ extensions: [FAUX_EXTENSION, CONTINUATION, STATE], agentDir: s.agentDir, subagentTempRoot, cwd: s.repo, sessionArgs, extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: s.runDir }, fauxScriptPath });
  const first = start([]);
  let sessionFile: string;
  let run: string;
  try {
    first.send({ type: "prompt", id: "arm", message: s.launch });
    await first.waitFor((e) => e.type === "agent_settled");
    first.send({ type: "get_state", id: "identity" });
    sessionFile = ((await first.waitFor((e) => e.type === "response" && e.id === "identity")).data as any).sessionFile;
    assert.ok(sessionFile, "the root has a real session file");
    append(s.log, "admit", "task=T-1", "source=first-wave", "owned=a/**", "accept=fixture", "tier=routine");
    expectDetachedRuns(subagentTempRoot, 1);
    first.send({ type: "prompt", id: "spawn", message: "SPAWN_SLOW" });
    run = (await waitForCondition(() => rows(s.log).find((r) => r.ev === "dispatch"), 30_000)).run;
    assert.ok(run, "the dispatch names the native run id");
    // The root dies without shutdown while the detached lane is still working.
    first.child.kill("SIGKILL");
    await new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
  } finally {
    await first.close();
  }
  assert.equal(rows(s.log).some((r) => r.ev === "return"), false, "no return can be recorded before the lane ends");
  const status = join(subagentTempRoot, "async-subagent-runs", run, "status.json");
  await waitForCondition(() => { try { return JSON.parse(readFileSync(status, "utf8")).state === "complete" ? true : undefined; } catch { return undefined; } }, 60_000);
  assert.equal(rows(s.log).some((r) => r.ev === "return"), false, "nothing delivers the result while no root is running");
  const reopened = start(["--session", sessionFile]);
  try {
    const ret = await waitForCondition(() => rows(s.log).find((r) => r.ev === "return" && r.run === run), 30_000).catch(() => undefined);
    assert.ok(ret, "reopened root records the completed lane return without another user prompt");
    assert.equal(ret.status, "complete");
    assert.equal(ret.check, "reopen-fixture");
    reopened.send({ type: "get_messages", id: "after-reopen" });
    const messages = ((await reopened.waitFor((e) => e.type === "response" && e.id === "after-reopen")).data as any).messages;
    const notices = messages.filter((m: any) => m.customType === "subagent-notify" && String(m.content).includes(run));
    assert.equal(notices.length, 1, "the reopened root receives the lane's completion exactly once");
  } finally {
    await reopened.close();
  }
});
