// Real-CLI proof on the faux provider, against the pinned pi and pi-subagents:
//   - a workflow child start that pi-subagents offers to tool_call handlers as a nested
//     `subagent_launch` call is refused by both the root and the lane guard;
//   - every root launch carries `requireLauncher` naming `nopush` and the digest pi-subagents'
//     own preflight computes for the installed agent definition; the package then refuses a launch
//     whose agent file changed after the root started, or whose agent names no launcher;
//   - a resumed lane keeps running under `nopush`, and its resume carries the launcher requirement.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";
import {
  FAUX_EXTENSION,
  LANE_EXTENSION,
  PI_SUBAGENTS_PACKAGE_DIR,
  ROOT_EXTENSION,
  cleanupAllAfterExit,
  expectDetachedRuns,
  freshDir,
  startPiRpc,
  waitForCondition,
  writeFauxScript,
  type PiRpcSession,
  type RpcEvent,
} from "./rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOPUSH = join(HERE, "..", "..", "bin", "loop-pi-nopush");
const PROBE_EXTENSION = join(HERE, "..", "test-support", "launch-probe-extension.ts");

after(() => cleanupAllAfterExit(60_000));

interface Fixture { agentDir: string; subagentTemp: string; cwd: string }

function agentFile(name: string, launcher: boolean, body = "Launcher pin fixture."): string {
  return [
    "---", `name: ${name}`, "description: Launcher pin fixture", "tools: bash", "extensions: []",
    `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "model: faux/faux-1", ...(launcher ? ["launcher: nopush"] : []),
    "---", "", body,
  ].join("\n");
}

/** A home whose user subagent config maps `nopush` to the shipped wrapper, as the installer does. */
function nopushHome(agents: Record<string, boolean>): Fixture {
  const agentDir = freshDir("launcher-pin-home-");
  mkdirSync(join(agentDir, "agents"));
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] },
  }));
  writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ runnerLaunchers: { nopush: [NOPUSH] } }));
  for (const [name, launcher] of Object.entries(agents)) writeFileSync(join(agentDir, "agents", `${name}.md`), agentFile(name, launcher));
  return { agentDir, subagentTemp: freshDir("launcher-pin-sub-"), cwd: freshDir("launcher-pin-cwd-") };
}

/** The digest pi-subagents' preflight computes for `agent` in this home, from a separate process. */
function preflightDigest(f: Fixture, agent: string): string {
  const module = pathToFileURL(join(PI_SUBAGENTS_PACKAGE_DIR, "bundle", "preflight.js")).href;
  const code = `const { resolveSubagentLaunchContract } = await import(${JSON.stringify(module)});
    const r = await resolveSubagentLaunchContract({ agent: ${JSON.stringify(agent)}, cwd: process.cwd() });
    if (!r.ok) throw new Error(r.message);
    process.stdout.write(r.contract.agent.definitionDigest);`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: f.cwd, encoding: "utf8", timeout: 30_000,
    env: hermeticPiEnv({ PI_CODING_AGENT_DIR: f.agentDir, PI_SUBAGENTS_TEMP_ROOT: f.subagentTemp, PI_OFFLINE: "1" }),
  });
}

function toolEndFor(session: PiRpcSession, toolName: string, from: number): Promise<RpcEvent> {
  return session.waitFor((e) => session.events.indexOf(e) >= from && e.type === "tool_execution_end" && e.toolName === toolName, 30_000);
}

function toolStartFor(session: PiRpcSession, toolCallId: unknown): RpcEvent | undefined {
  return session.events.find((e) => e.type === "tool_execution_start" && e.toolCallId === toolCallId);
}

function text(end: RpcEvent): string {
  const result = end.result as { content?: { type: string; text?: string }[] };
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

function runIdOf(end: RpcEvent): string {
  const runId = (end.result as { details?: { runId?: string } }).details?.runId;
  assert.ok(runId, `the launch reported no run id: ${text(end)}`);
  return runId;
}

function runs(f: Fixture): string[] {
  const dir = join(f.subagentTemp, "async-subagent-runs");
  return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
}

function completedStatus(f: Fixture, runId: string): Promise<Record<string, any>> {
  const path = join(f.subagentTemp, "async-subagent-runs", runId, "status.json");
  return waitForCondition(() => {
    try {
      const status = JSON.parse(readFileSync(path, "utf8"));
      return ["complete", "completed", "failed", "stopped"].includes(status.state) ? status : undefined;
    } catch {
      return undefined;
    }
  }, 40_000, 200);
}

/** pi-subagents 0.85.0 keeps the recovery descriptor beside the runs root, keyed by run id. */
function recoveryDescriptor(f: Fixture, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(f.subagentTemp, "async-subagent-launches", runId, "recovery-descriptor.json"), "utf8"));
}

for (const role of ["root", "lane"] as const) {
  test(`${role}: a workflow child start offered as a nested subagent_launch call is refused`, async () => {
    const f = nopushHome({ worker: true });
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, PROBE_EXTENSION, role === "root" ? ROOT_EXTENSION : LANE_EXTENSION],
      fauxScriptPath: writeFauxScript([
        { match: "PROBE_PLAIN", once: true, toolCalls: [{ name: "launch_probe", args: { key: "plain" } }] },
        { match: "PROBE_COMMAND", once: true, toolCalls: [{ name: "launch_probe", args: { key: "cmd", command: "git status" } }] },
        { match: ".*", text: "ok" },
      ]),
      agentDir: f.agentDir, subagentTempRoot: f.subagentTemp, cwd: f.cwd,
      extraArgs: ["--exclude-tools", "subagents_enable"],
    });
    try {
      for (const marker of ["PROBE_PLAIN", "PROBE_COMMAND"]) {
        const from = session.events.length;
        session.send({ id: marker, type: "prompt", message: marker });
        const end = await toolEndFor(session, "launch_probe", from);
        const outcome = JSON.parse(text(end)) as { offered: boolean; refusal: string | null };
        assert.equal(outcome.offered, true, "pi-subagents registered subagent_launch, so the child start reached the handlers");
        assert.match(outcome.refusal ?? "", /the subagent_launch call was refused: loop-guard: `subagent_launch` \(a workflow child start\) is refused/, marker);
        await session.waitFor((e) => session.events.indexOf(e) > session.events.indexOf(end) && e.type === "agent_end", 20_000);
      }
    } finally {
      await session.close();
    }
  });
}

test("root: a lane launch is pinned to nopush and its definition digest; a resume keeps nopush; a changed definition is refused", { timeout: 150_000 }, async () => {
  const f = nopushHome({ worker: true });
  const latest = join(freshDir("launcher-pin-stub-"), "latest-run.ts");
  writeFileSync(latest, `export default function (pi) {
  let latest;
  pi.events.on("subagent:async-started", (d) => { latest = d.id; });
  pi.on("tool_call", (e) => { if (e.toolName === "subagent" && e.input.id === "LATEST_TEST_RUN") e.input.id = latest; });
}
`);
  // A model-supplied requirement inside options would win pi-subagents' flattening; the root replaces it.
  const forged = { name: "nopush", definitionDigest: "0".repeat(64) };
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, latest, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "LAUNCH_ONE", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "PIN_CHILD_ONE", async: true, options: { requireLauncher: forged } } }] },
      { match: "RESUME_ONE", once: true, toolCalls: [{ name: "subagent", args: { action: "resume", id: "LATEST_TEST_RUN", message: "RESUME_MSG" } }] },
      { match: "LAUNCH_CHANGED", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "PIN_CHILD_CHANGED", async: true } }] },
      { match: ".*", text: "ok" },
    ]),
    agentDir: f.agentDir, subagentTempRoot: f.subagentTemp, cwd: f.cwd,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  expectDetachedRuns(f.subagentTemp, 0);
  try {
    const shipped = preflightDigest(f, "worker");
    assert.match(shipped, /^[0-9a-f]{64}$/);

    let from = session.events.length;
    session.send({ id: "launch", type: "prompt", message: "LAUNCH_ONE" });
    const launch = await toolEndFor(session, "subagent", from);
    assert.notEqual(launch.isError, true, `the pinned launch must start: ${text(launch)}`);
    const first = runIdOf(launch);
    expectDetachedRuns(f.subagentTemp, 1);
    // tool_execution_start reports the model's own arguments; the package's recovery descriptor records
    // the requirement it actually enforced. The forged all-zero digest would have refused this launch.
    assert.equal((toolStartFor(session, launch.toolCallId)?.args as Record<string, any>).options?.requireLauncher?.definitionDigest, forged.definitionDigest);
    const status = await completedStatus(f, first);
    assert.equal(status.launcher?.name, "nopush", "the lane ran under the nopush launcher");
    assert.deepEqual(recoveryDescriptor(f, first).requiredLauncher, { name: "nopush", definitionDigest: shipped });
    assert.equal(recoveryDescriptor(f, first).launcher, "nopush");

    from = session.events.length;
    session.send({ id: "resume", type: "prompt", message: "RESUME_ONE", streamingBehavior: "followUp" });
    const resume = await toolEndFor(session, "subagent", from);
    assert.notEqual(resume.isError, true, `the resume must start: ${text(resume)}`);
    const resumed = runIdOf(resume);
    assert.notEqual(resumed, first);
    expectDetachedRuns(f.subagentTemp, 2);
    const resumedStatus = await completedStatus(f, resumed);
    assert.equal(resumedStatus.launcher?.name, "nopush", "the resumed lane still runs under nopush");
    assert.deepEqual(recoveryDescriptor(f, resumed).requiredLauncher, { name: "nopush", definitionDigest: shipped },
      "the resume carries the launcher requirement forward");
    assert.equal(recoveryDescriptor(f, resumed).launcher, "nopush");

    // The installed definition changes after the root pinned it: pi-subagents refuses the launch.
    appendFileSync(join(f.agentDir, "agents", "worker.md"), "\nEdited after the root started.\n");
    assert.notEqual(preflightDigest(f, "worker"), shipped);
    const before = runs(f).length;
    from = session.events.length;
    session.send({ id: "changed", type: "prompt", message: "LAUNCH_CHANGED", streamingBehavior: "followUp" });
    const changed = await toolEndFor(session, "subagent", from);
    assert.equal(changed.isError, true, `a changed definition must be refused: ${text(changed)}`);
    assert.match(text(changed), new RegExp(`definition digest is [0-9a-f]{64}, but the call requires ${shipped}`));
    assert.equal(runs(f).length, before, "the refused launch started no run");
  } finally {
    await session.close();
  }
});

test("root: a lane agent that names no launcher is refused by the pinned requirement", { timeout: 60_000 }, async () => {
  const f = nopushHome({ worker: true, scout: false });
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: writeFauxScript([
      { match: "LAUNCH_SCOUT", once: true, toolCalls: [{ name: "subagent", args: { agent: "scout", task: "UNWRAPPED_CHILD", async: true } }] },
      { match: ".*", text: "ok" },
    ]),
    agentDir: f.agentDir, subagentTempRoot: f.subagentTemp, cwd: f.cwd,
    sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"],
  });
  expectDetachedRuns(f.subagentTemp, 0);
  try {
    const from = session.events.length;
    session.send({ id: "scout", type: "prompt", message: "LAUNCH_SCOUT" });
    const end = await toolEndFor(session, "subagent", from);
    assert.equal(end.isError, true, `an unwrapped lane must be refused: ${text(end)}`);
    assert.match(text(end), /Agent 'scout' has no launcher, but the call requires launcher 'nopush'/);
    assert.deepEqual(runs(f), [], "no run was started");
  } finally {
    await session.close();
  }
});
