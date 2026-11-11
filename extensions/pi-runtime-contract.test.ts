// Pinned pi runtime behaviour loop-pi relies on, proved through the real CLI over RPC with the
// public faux provider: no live homes, credentials or model calls.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll, FAUX_EXTENSION, freshDir, startPiRpc, writeFauxScript } from "./loop-guard/rpc-test-helpers.ts";

after(() => cleanupAll());

function probe(facts: string, body: string): string {
  const path = join(freshDir("pi-contract-probe-"), "probe.ts");
  writeFileSync(path, `import { appendFileSync } from "node:fs";
    const record = (value) => appendFileSync(${JSON.stringify(facts)}, JSON.stringify(value) + "\\n");
    export default function (pi) { ${body} }`);
  return path;
}

async function runOnce(opts: { agentDir: string; cwd: string; extension: string }) {
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, opts.extension], agentDir: opts.agentDir, cwd: opts.cwd,
    subagentTempRoot: freshDir("pi-contract-sub-"),
    fauxScriptPath: writeFauxScript([{ match: ".*", text: "done" }]),
  });
  try {
    session.send({ type: "prompt", id: "go", message: "go" });
    await session.waitFor(e => e.type === "agent_settled");
  } finally { await session.close(); }
}

const read = (facts: string) => readFileSync(facts, "utf8").trim().split("\n").map(line => JSON.parse(line));

test("setActiveTools treats the active tools as a set: reordering the same names keeps the declared order", async () => {
  const facts = join(freshDir("pi-contract-facts-"), "facts.jsonl");
  const extension = probe(facts, `
    pi.on("before_agent_start", () => {
      const before = pi.getActiveTools();
      pi.setActiveTools([...before].reverse());
      record({ before, after: pi.getActiveTools() });
    });`);
  await runOnce({ agentDir: freshDir("pi-contract-home-"), cwd: freshDir("pi-contract-repo-"), extension });
  const [{ before, after }] = read(facts);
  assert.ok(before.length >= 2, "the probe needs at least two active tools to reorder");
  assert.deepEqual(after, before, "a reordered set must not change the declared tool order (prompt cache stability)");
});

test("a saved do-not-trust decision is honoured for a folder with no trust-requiring resources", async () => {
  const facts = join(freshDir("pi-contract-facts-"), "facts.jsonl");
  const agentDir = freshDir("pi-contract-home-");
  // pi keys trust by the canonical path (macOS temp dirs sit behind the /var -> /private/var link).
  const repo = realpathSync(freshDir("pi-contract-repo-"));
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture\n");
  writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [repo]: false }));
  const extension = probe(facts, `pi.on("session_start", (_e, ctx) => record({ trusted: ctx.isProjectTrusted() }));`);
  await runOnce({ agentDir, cwd: repo, extension });
  assert.deepEqual(read(facts), [{ trusted: false }]);
});

// A bash call whose shell exits at once while a backgrounded descendant keeps the inherited
// stdout/stderr pipes open. pi waits for the pipes to fall idle (100 ms after the last chunk), so a
// quiet descendant never delays the call and the shell's own exit code is its result. A descendant
// that keeps writing holds the call to its deadline: that is a timeout, and since pi 1.5.1 the
// timeout message also reports the shell's exit code (the code is reported, never the call's result).
async function runBash(command: string, timeoutSeconds: number): Promise<{ isError: boolean; text: string }> {
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION], agentDir: freshDir("pi-contract-home-"), cwd: freshDir("pi-contract-repo-"),
    subagentTempRoot: freshDir("pi-contract-sub-"),
    fauxScriptPath: writeFauxScript([
      { match: "RUN_BASH", once: true, toolCalls: [{ name: "bash", args: { command, timeout: timeoutSeconds } }] },
      { match: ".*", text: "done" },
    ]),
  });
  try {
    session.send({ type: "prompt", id: "go", message: "RUN_BASH" });
    const ended = await session.waitFor(e => e.type === "tool_execution_end" && e.toolName === "bash", 60_000);
    await session.waitFor(e => e.type === "agent_settled", 30_000);
    const content = (ended.result as { content?: { type: string; text?: string }[] }).content ?? [];
    return { isError: ended.isError === true, text: content.map(item => item.text ?? "").join("\n") };
  } finally { await session.close(); }
}

test("bash: a shell that exits 0 while a quiet descendant holds the output pipes is a success, not a timeout", { timeout: 90_000 }, async () => {
  // The descendant is bounded (3 s) so a failed assertion leaves nothing running.
  const started = Date.now();
  const { isError, text } = await runBash("sleep 3 & echo shell_done", 30);
  assert.equal(isError, false, text);
  assert.match(text, /shell_done/);
  assert.doesNotMatch(text, /timed out/);
  assert.ok(Date.now() - started < 25_000, "the call must not wait out its 30 s deadline for the quiet descendant");
});

test("bash: a shell that exits 0 while a descendant keeps writing times out and reports the shell exit code", { timeout: 90_000 }, async () => {
  // The writer never ends on its own; the deadline's process-group kill stops it.
  const { isError, text } = await runBash("echo shell_done; (while :; do echo tick; sleep 0.02; done) & exit 0", 1);
  assert.equal(isError, true, "a descendant that keeps writing past the deadline is still a timeout");
  assert.match(text, /shell_done/);
  assert.match(text, /Command timed out after 1 seconds\. The shell exited with code 0 after \d+(\.\d+)? seconds, but background processes it started kept writing output until the timeout\./);
  assert.doesNotMatch(text, /Command exited with code/);
});
