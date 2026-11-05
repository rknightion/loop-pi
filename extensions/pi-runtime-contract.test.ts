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
