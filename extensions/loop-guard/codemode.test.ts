// pi's built-in codemode tool runs a model-written script whose `tools.<name>()` calls go through
// the session's tool pipeline (`ctx.executeTool`). The loop guard is only as strong as that claim:
// a call a script makes must meet the same `tool_call` decision as the same call made directly,
// and guard state the root keys on the tool call id (the push log) must still be written. These
// tests drive the real pinned pi CLI with the faux provider and the shipped home settings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { hermeticFixtureEnv } from "../test-support/hermetic-env.ts";
import { FAUX_EXTENSION, LANE_EXTENSION, ROOT_EXTENSION, cleanupAll, freshDir, startPiRpc, waitForCondition, writeFauxScript, type RpcEvent } from "./rpc-test-helpers.ts";

after(cleanupAll);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: hermeticFixtureEnv(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

// pi starts slowly on a starved host; these bound only how long a hang takes to report.
const STARTUP_MS = 180_000;
const TEST_MS = 600_000;

const SHIPPED = JSON.parse(readFileSync(new URL("../../home/settings.json", import.meta.url), "utf8"));

/** A pi home carrying the shipped settings that decide which built-in tools load and start active. */
function shippedHome(): string {
  const home = freshDir("codemode-home-");
  const { extensions, defaultTools, codemode } = SHIPPED;
  writeFileSync(join(home, "settings.json"), JSON.stringify({ extensions, defaultTools, codemode }));
  return home;
}

/** A repository with a bare origin, and a run dir with the protocol marker. */
function fixture() {
  const repo = freshDir("codemode-repo-");
  const remote = freshDir("codemode-remote-");
  const runDir = freshDir("codemode-run-");
  git(repo, "init", "-b", "main");
  git(remote, "init", "--bare");
  git(repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "one");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  return { repo, remote, runDir };
}

type Call = { name: string; args: Record<string, unknown> };

/** A codemode script that makes every call at once and returns each outcome in order. */
function script(calls: Call[]): string {
  const started = calls.map((call) => `tools.${call.name}(${JSON.stringify(call.args)})`).join(",\n  ");
  return [
    `const settled = await Promise.allSettled([\n  ${started},\n]);`,
    "return JSON.stringify(settled.map((s) => s.status === 'fulfilled' ? { ok: typeof s.value === 'string' ? s.value : JSON.stringify(s.value) } : { error: String(s.reason && s.reason.message || s.reason) }));",
  ].join("\n");
}

const text = (event: RpcEvent): string =>
  ((event.result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []).map((block) => block.text ?? "").join("\n");

const ends = (events: RpcEvent[], nested: boolean) =>
  events.filter((e) => e.type === "tool_execution_end" && e.toolName !== "codemode" && Boolean(e.parentToolCallId) === nested);

/**
 * Run `forbidden` once as direct model calls, then once from one codemode script that also makes
 * an allowed call, and return both sets of results.
 */
async function directAndNestedIn(extension: string, forbidden: Call[], allowed: Call, fx: ReturnType<typeof fixture>) {
  const { repo, runDir } = fx;
  const faux = writeFauxScript([
    { match: "DIRECT_CALLS", once: true, toolCalls: forbidden },
    { match: "NESTED_CALLS", once: true, toolCalls: [{ name: "codemode", args: { code: script([...forbidden, allowed, ...forbidden]) } }] },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, extension],
    fauxScriptPath: faux,
    agentDir: shippedHome(),
    subagentTempRoot: freshDir(),
    cwd: repo,
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "d", type: "prompt", message: "DIRECT_CALLS" });
    await waitForCondition(() => (ends(session.events, false).length >= forbidden.length ? true : undefined), STARTUP_MS);
    await session.waitFor((e) => e.type === "agent_end", STARTUP_MS);
    const direct = ends(session.events, false);
    session.send({ id: "n", type: "prompt", message: "NESTED_CALLS" });
    const outer = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "codemode", STARTUP_MS);
    return { repo, runDir, direct, nested: ends(session.events, true), outer, events: session.events };
  } finally {
    await session.close();
  }
}

function assertSameRefusals(run: Awaited<ReturnType<typeof directAndNestedIn>>, forbidden: Call[], pattern: RegExp) {
  assert.equal(run.outer.isError ?? false, false, `the script itself ran: ${text(run.outer)}`);
  assert.equal(run.direct.length, forbidden.length);
  for (const event of run.direct) {
    assert.equal(event.isError, true, JSON.stringify(event));
    assert.match(text(event), pattern);
  }
  // Every nested call is a tool call of its own, with its own id under the codemode call's id.
  const outerId = String(run.outer.toolCallId);
  assert.equal(run.nested.length, forbidden.length * 2 + 1, JSON.stringify(run.nested.map((e) => [e.toolName, e.toolCallId])));
  assert.equal(new Set(run.nested.map((e) => e.toolCallId)).size, run.nested.length, "each nested call has its own id");
  for (const event of run.nested) {
    assert.equal(event.parentToolCallId, outerId);
    assert.ok(String(event.toolCallId).startsWith(`${outerId}/`), String(event.toolCallId));
  }
  // The same calls are refused with the same reason, both times they are made from the script.
  const results = JSON.parse(text(run.outer).slice(text(run.outer).indexOf("[{"))) as { ok?: string; error?: string }[];
  const refusals = [...results.slice(0, forbidden.length), ...results.slice(forbidden.length + 1)];
  const directReasons = run.direct.map(text);
  for (const [index, refusal] of refusals.entries()) {
    assert.equal(refusal.ok, undefined, `nested call ${index} was not refused: ${JSON.stringify(refusal)}`);
    assert.ok(refusal.error?.includes(directReasons[index % forbidden.length]), `${refusal.error} != ${directReasons[index % forbidden.length]}`);
  }
  assert.match(String(results[forbidden.length].ok), /NESTED_ALLOWED/, "the allowed call beside them still ran");
}

test("root: bash and write calls the guard refuses directly are refused identically from a codemode script", { timeout: TEST_MS }, async () => {
  const runDirFixture = fixture();
  const target = join(runDirFixture.runDir, "harness-facts.jsonl");
  const calls: Call[] = [
    { name: "bash", args: { command: "git push --force origin main" } },
    { name: "write", args: { path: target, content: "forged\n" } },
  ];
  const run = await directAndNestedIn(ROOT_EXTENSION, calls, { name: "bash", args: { command: "echo NESTED_ALLOWED" } }, runDirFixture);
  assertSameRefusals(run, calls, /loop-guard: (force-push forms are blocked|.* is inside the loop run dir)/);
  assert.equal(existsSync(target), false, "no refused write reached the run dir");
  assert.throws(() => git(runDirFixture.remote, "rev-parse", "refs/heads/main"), "no refused push reached the remote");
});

test("lane: if a lane reached codemode, its nested push and loop-control write are refused like direct ones", { timeout: TEST_MS }, async () => {
  const runDirFixture = fixture();
  mkdirSync(join(runDirFixture.repo, "codex"), { recursive: true });
  const calls: Call[] = [
    { name: "bash", args: { command: "git push origin HEAD:refs/heads/main" } },
    { name: "write", args: { path: "codex/state-forged.md", content: "forged\n" } },
  ];
  const run = await directAndNestedIn(LANE_EXTENSION, calls, { name: "bash", args: { command: "echo NESTED_ALLOWED" } }, runDirFixture);
  assertSameRefusals(run, calls, /loop-guard: (lanes never push|lanes may not write)/);
  assert.equal(existsSync(join(runDirFixture.repo, "codex", "state-forged.md")), false);
  assert.throws(() => git(runDirFixture.remote, "rev-parse", "refs/heads/main"), "no refused push reached the remote");
});

test("root: pushes made at once from one codemode script are each logged under their own tool call id", { timeout: TEST_MS }, async () => {
  const { repo, remote, runDir } = fixture();
  const head = git(repo, "rev-parse", "HEAD");
  const faux = writeFauxScript([
    {
      match: "NESTED_PUSHES",
      once: true,
      toolCalls: [{ name: "codemode", args: { code: script([
        { name: "bash", args: { command: "git push origin HEAD:refs/heads/one" } },
        { name: "bash", args: { command: "git push origin HEAD:refs/heads/two" } },
      ]) } }],
    },
    { match: ".*", text: "done" },
  ]);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION],
    fauxScriptPath: faux,
    agentDir: shippedHome(),
    subagentTempRoot: freshDir(),
    cwd: repo,
    extraArgs: ["--exclude-tools", "subagents_enable"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "NESTED_PUSHES" });
    const outer = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "codemode", STARTUP_MS);
    assert.equal(outer.isError ?? false, false, text(outer));
    await session.waitFor((e) => e.type === "agent_end", STARTUP_MS);
    assert.equal(git(remote, "rev-parse", "refs/heads/one"), head);
    assert.equal(git(remote, "rev-parse", "refs/heads/two"), head);
    const log = join(runDir, "push-log.jsonl");
    const lines = (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => [line.actor, line.ref, line.new]).sort(), [["root", "refs/heads/one", head], ["root", "refs/heads/two", head]]);
  } finally {
    await session.close();
  }
});

test("lanes cannot reach codemode: a lane's plain tools allowlist leaves it unregistered under the shipped settings", { timeout: TEST_MS }, async () => {
  const { repo, runDir } = fixture();
  const marker = join(freshDir("codemode-marker-"), "reached");
  const faux = writeFauxScript([
    { match: "TRY_CODEMODE", once: true, toolCalls: [{ name: "codemode", args: { code: `await tools.bash({ command: ${JSON.stringify(`touch ${marker}`)} }); return "ran";` } }] },
    { match: ".*", text: "done" },
  ]);
  // pi-subagents passes a lane's frontmatter `tools:` to its child as a complete allowlist.
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, LANE_EXTENSION],
    fauxScriptPath: faux,
    agentDir: shippedHome(),
    subagentTempRoot: freshDir(),
    cwd: repo,
    extraArgs: ["--tools", "read,bash,edit,write,grep,find,ls"],
    env: { LOOP_PI_RUN_DIR: runDir },
  });
  try {
    session.send({ id: "p", type: "prompt", message: "TRY_CODEMODE" });
    const end = await session.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "codemode", STARTUP_MS);
    assert.equal(end.isError, true, text(end));
    assert.match(text(end), /not found/i);
    assert.equal(existsSync(marker), false);
  } finally {
    await session.close();
  }
});
