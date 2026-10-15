// Native Pi RPC + public faux provider: no live runtime homes or model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loopFixture, cleanupFixtures } from "../loop-continuation/test-fixture.ts";
import { cleanupAll, FAUX_EXTENSION, freshDir, PI_SUBAGENTS_PACKAGE_DIR, startPiRpc, waitForCondition, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

const STATE = fileURLToPath(new URL("./index.ts", import.meta.url));
const CONTINUATION = fileURLToPath(new URL("../loop-continuation/index.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
after(() => { cleanupAll(); cleanupFixtures(); });
const append = (log: string, ...args: string[]) => execFileSync(BIN, ["append", log, ...args], { timeout: 10_000, stdio: "pipe" });

for (const outcome of ["success", "failure", "abort"] as const) {
  test(`80% native same-session state compaction: ${outcome}`, { timeout: 60_000 }, async () => {
    const s = loopFixture({ root: "faux/faux-1" });
    const originalCharter = readFileSync(s.charter, "utf8");
    writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, packages: [PI_SUBAGENTS_PACKAGE_DIR], defaultProjectTrust: "never", subagents: { agentExcludeDirs: ["~/.agents"] } }));
    // Real authority hash checked at arm, plus an explicit consumed allowance in the frozen charter.
    const standingPath = join(s.repo, "codex", "standing.md");
    const standing = "# Standing authority\n";
    writeFileSync(standingPath, standing);
    const charterBody = originalCharter.replace("standing:   none", `standing:   ${standingPath} sha256=${hash(standing)}`) +
      "\n## Decisions\nAttempt ceiling 4; T-1 consumed 2; remaining 2.\n";
    writeFileSync(s.charter, charterBody);
    const observer = join(freshDir(), "observer.ts");
    const facts = join(s.repo, "facts.jsonl");
    writeFileSync(observer, `import { appendFileSync } from "node:fs";
      export default function(pi) {
        pi.on("session_before_compact", (e, ctx) => {
          appendFileSync(${JSON.stringify(facts)}, JSON.stringify({type:"before", idle:ctx.isIdle(), usage:ctx.getContextUsage(), id:ctx.sessionManager.getSessionId(), file:ctx.sessionManager.getSessionFile()}) + "\\n");
          ${outcome === "failure" ? 'return { cancel: true };' : outcome === "abort" ? 'ctx.abort(); return { cancel: true };' : ''}
        });
        pi.on("session_compact_failed", e => appendFileSync(${JSON.stringify(facts)}, JSON.stringify({type:"failed", aborted:e.aborted}) + "\\n"));
        pi.on("context_with_system", e => appendFileSync(${JSON.stringify(facts)}, JSON.stringify({type:"context", bytes:Buffer.byteLength(JSON.stringify(e.messages)), messages:e.messages.length}) + "\\n"));
      }`);
    const session = startPiRpc({
      extensions: [FAUX_EXTENSION, CONTINUATION, STATE, observer], agentDir: s.agentDir,
      subagentTempRoot: freshDir(), cwd: s.repo, sessionArgs: [],
      // A reason-bearing PAUSED line is the existing continuation stop contract.
      fauxScriptPath: writeFauxScript([{ match: ".*", text: "PAUSED: fixture awaits the next explicit input." }]), env: { LOOP_PI_RUN_DIR: s.runDir },
    });
    const rpc = async (type: string, id: string) => {
      session.send({ type, id });
      return (await session.waitFor(e => e.type === "response" && e.id === id)).data as any;
    };
    try {
      // Arm first, then populate actual CLI state, not a query-launch stub or a fake SDK context.
      session.send({ type: "prompt", id: "arm", message: s.launch + `\nStanding: ${standingPath} sha256=${hash(standing)}` });
      await session.waitFor(e => e.type === "agent_settled");
      const before = await rpc("get_state", "identity-before");
      append(s.log, "admit", "task=T-1", "source=first-wave", "owned=a/**", "accept=fixture", "tier=routine");
      append(s.log, "admit", "task=T-2", "source=first-wave", "owned=b/**", "accept=fixture", "tier=guarded");
      append(s.log, "dispatch", "lane=L1", "task=T-1", "agent=worker", "run=run-one", "base=fixture");
      append(s.log, "return", "lane=L1", "run=run-one", "status=failed");
      append(s.log, "dispatch", "lane=L2", "task=T-1", "agent=worker", "run=run-two", "base=fixture");
      append(s.log, "park", "task=T-2", "reason=fixture", "needs=owner");
      const ledgerHash = hash(readFileSync(s.log));
      // Public faux withUsageEstimate reports input plus cache-write on new prompt bytes.
      // 450k fresh characters yields ~225k/272k reported context tokens: above 80%, below
      // native overflow. No model/usage backfill or provider wrapper is used.
      session.send({ type: "prompt", id: "large", message: "history ".repeat(56_250) });
      await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 2);
      const attempts = session.events.filter(e => e.type === "compaction_start");
      assert.equal(attempts.length, 1, "native compaction must actually run proactively");
      const terminal = session.events.find(e => e.type === "compaction_end") as any;
      assert.equal(terminal.reason, "manual", "ctx.compact uses the native manual path");
      assert.equal(terminal.willRetry, false, "no automatic replacement turn");
      const observed = readFileSync(facts, "utf8").trim().split("\n").map(l => JSON.parse(l));
      const beforeFact = observed.find(r => r.type === "before");
      assert.equal(beforeFact.idle, false, "native compaction owns the idle operation by the before hook");
      assert.ok(beforeFact.usage.percent >= 80 && beforeFact.usage.percent < 94);
      assert.equal(beforeFact.id, before.sessionId);
      assert.equal(beforeFact.file, before.sessionFile);
      assert.equal(hash(readFileSync(s.log)), ledgerHash, "compaction never mutates admits/dispatches/parks/budgets");
      const afterState = await rpc("get_state", "identity-after");
      assert.equal(afterState.sessionId, before.sessionId);
      assert.equal(afterState.sessionFile, before.sessionFile);
      assert.equal(session.child.pid !== undefined && session.child.exitCode === null, true);
      assert.equal(session.events.filter(e => e.type === "agent_start").length, 2, "no root spawn or replacement model turn");
      assert.equal(session.events.filter(e => e.type === "tool_execution_start").length, 0, "no child autosponsor");
      const frozen = (await rpc("get_entries", "entries")).entries.filter((e: any) => e.customType === "loop-continuation-state").at(-1).data;
      assert.equal(frozen.rootContext.goalText, charterBody);
      assert.equal(frozen.standingSha256, hash(standing), "successful or failed compaction never changes frozen authority");
      if (outcome === "success") {
        assert.ok(terminal.result, "native compaction persisted a real result");
        const summary = terminal.result.summary;
        assert.ok(Buffer.byteLength(summary) <= 32768);
        assert.ok(summary.includes(charterBody), "the accepted charter, including consumed allowance, survives exactly");
        assert.match(summary, /implementation_dispatches.*T-1.*2/s);
        assert.ok(summary.includes(hash(standing)), "frozen authority hash survives");
        const projection = await rpc("get_messages", "projection");
        assert.ok(Buffer.byteLength(JSON.stringify(projection.messages)) < 50_000, "real native model projection is bounded");
        const rawBytes = readFileSync(before.sessionFile).length;
        assert.ok(rawBytes > 450_000, "full previous history stays on disk");
        // Editing the source charter cannot silently replace the frozen charter on a later compaction.
        writeFileSync(s.charter, originalCharter);
        session.send({ type: "prompt", id: "small", message: "short follow-up" });
        await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 3);
        const contexts = readFileSync(facts, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.type === "context");
        assert.ok(contexts.at(-1).bytes < 50_000, "the next real model request receives only bounded recovery context");
        session.send({ type: "prompt", id: "large-again", message: "history ".repeat(56_250) });
        await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 4);
        assert.equal(session.events.filter(e => e.type === "compaction_start").length, 2, "low known usage rearms the next generation");
        const next = session.events.filter(e => e.type === "compaction_end").at(-1) as any;
        assert.ok(next.result.summary.includes(charterBody), "later compaction still uses the original frozen charter");
        assert.equal(hash(readFileSync(s.log)), ledgerHash);
        session.send({ type: "prompt", id: "small-after-two", message: "short follow-up" });
        await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 5);
        session.send({ type: "prompt", id: "third-large", message: "history ".repeat(56_250) });
        await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 6);
        assert.equal(session.events.filter(e => e.type === "compaction_start").length, 2, "same-session run permits only two proactive attempts after rearm");
        const budgetState = (await rpc("get_entries", "capped-entries")).entries.filter((e: any) => e.customType === "loop-root-context-budget").at(-1).data;
        assert.equal(budgetState.attempts, 2);
        assert.equal(budgetState.binding, JSON.stringify([before.sessionId, before.sessionFile, s.runDir]));
      } else {
        assert.equal(terminal.result, undefined);
        assert.equal(terminal.aborted, true);
        assert.equal(observed.filter(r => r.type === "failed").length, 1);
      }
      // Failed/aborted attempts at still-high usage cannot cause a retry loop.
      if (outcome !== "success") {
        session.send({ type: "prompt", id: "still-high", message: "short follow-up" });
        await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 3);
        assert.equal(session.events.filter(e => e.type === "compaction_start").length, 1);
      }
    } finally { await session.close(); }
  });
}

// Prove native transport already meets the preview requirement; add no wrapper.
for (const explicitOutput of [true, false]) {
test(`native async public subagent return previews 2000 characters and retains the complete normalized package artifact: ${explicitOutput ? "explicit" : "default"}`, { timeout: 90_000 }, async (t) => {
  const s = loopFixture({ root: "faux/faux-1" });
  mkdirSync(join(s.agentDir, "agents"));
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ packages: [PI_SUBAGENTS_PACKAGE_DIR], defaultProjectTrust: "never", subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(s.agentDir, "agents", "worker.md"), ["---", "name: worker", "description: Fixture", "tools: read", "model: faux/faux-1", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "---", "Fixture"].join("\n"));
  const block = '```lane-return\n' + JSON.stringify({ v: 2, lane: "L1", status: "complete", sha: null, landed: false, base: "fixture", check: "fixture", exit: 0, tail: "ok", ci: null, coderabbit: null, questions: [] }) + '\n```';
  const full = block + '\n' + "native-output-line\n".repeat(500);
  // Independent scripted expectation for the resolved artifact, not saved-file readback or
  // an imported/duplicated normalizer. Only the terminal newline is absent in this fixture;
  // all 500 lines and the complete structured lane-return block must remain.
  const expectedArtifact = [block, ...Array(500).fill("native-output-line")].join("\n");
  const assertArtifact = (bytes: string | Buffer) => assert.equal(hash(bytes), hash(expectedArtifact), "complete resolved artifact integrity");
  const observer = join(freshDir(), "observer.ts");
  const completions = join(s.repo, "completed.jsonl");
  const actualRequests = join(s.repo, "requests.jsonl");
  writeFileSync(observer, `import { appendFileSync } from "node:fs"; export default function(pi) { pi.events.on("subagent:async-complete", d => appendFileSync(${JSON.stringify(completions)}, JSON.stringify({runId:d.runId, sessionId:d.sessionId, path:d.results?.[0]?.savedOutputPath ?? d.results?.[0]?.artifactPaths?.outputPath, output:d.results?.[0]?.output}) + "\\n")); pi.on("context_with_system", e => appendFileSync(${JSON.stringify(actualRequests)}, JSON.stringify(e.messages) + "\\n")); }`);
  const requestedOutput = explicitOutput ? join(s.runDir, "full-return.md") : undefined;
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, CONTINUATION, STATE, observer], agentDir: s.agentDir, subagentTempRoot: freshDir(), cwd: s.repo, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: s.runDir },
    fauxScriptPath: writeFauxScript([
      { match: "NATIVE_PREVIEW", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "Lane: L1 · Task: T-1 · Tier: routine\nObjective: CHILD_PREVIEW", async: true, worktree: false, ...(requestedOutput ? { output: requestedOutput } : {}) } }] },
      { match: "CHILD_PREVIEW", text: full },
      { match: ".*", text: "PAUSED: fixture awaits the next explicit input." },
    ]) });
  try {
    session.send({ type: "prompt", id: "arm", message: s.launch });
    await session.waitFor(e => e.type === "agent_settled");
    append(s.log, "admit", "task=T-1", "source=first-wave", "owned=a/**", "accept=fixture", "tier=routine");
    session.send({ type: "prompt", id: "spawn", message: "NATIVE_PREVIEW" });
    const ret = await waitForCondition(() => { try { return readFileSync(s.log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(r => r.ev === "return"); } catch { return undefined; } }, 60_000);
    assert.equal(ret.status, "complete", "the unpreviewed completion still supplies the return block");
    assert.equal(ret.check, "fixture");
    const output = ret.artifact;
    assert.ok(typeof output === "string" && output.startsWith("/"), "native full artifact path is durable in the strict state log");
    if (requestedOutput) assert.equal(output, requestedOutput);
    const saved = readFileSync(ret.artifact);
    // Fail-first evidence also runs this native boundary with the old raw-byte assertion.
    assert.throws(() => assert.equal(hash(saved), hash(full)), { code: "ERR_ASSERTION" }, "raw terminal bytes are not the resolved boundary");
    assertArtifact(saved);
    for (const damaged of [expectedArtifact.replace("native-output-line", "changed-output-line"),
      expectedArtifact.replace("\nnative-output-line\n", "\n native-output-line\n"), expectedArtifact.slice(0, 2000)]) {
      assert.throws(() => assertArtifact(damaged), { code: "ERR_ASSERTION" }, "substantive text, internal whitespace and truncation must fail");
    }
    t.diagnostic(JSON.stringify({ rawBytes: Buffer.byteLength(full), rawSha256: hash(full),
      expectedBytes: Buffer.byteLength(expectedArtifact), expectedSha256: hash(expectedArtifact), savedBytes: saved.length, savedSha256: hash(saved) }));
    const done = readFileSync(completions, "utf8").trim().split("\n").map(l => JSON.parse(l))[0];
    assert.equal(done.runId, ret.run);
    assert.equal(done.path, output);
    // Display is the complete normalized body plus native reference framing, not the artifact.
    const reference = `Output saved to: ${output} (${(Buffer.byteLength(expectedArtifact) / 1024).toFixed(1)} KB, ${expectedArtifact.split("\n").length} lines). Read this file if needed.`;
    assert.equal(done.output, explicitOutput ? expectedArtifact + "\n\n" + reference : expectedArtifact, "independent native display framing");
    assert.ok(done.output.startsWith(block), "completion retains the full structured return, not just preview metadata");
    // Idle notifications bypass extension message_end: read the real persisted/native projection.
    session.send({ type: "get_messages", id: "preview-projection" });
    const projected = await session.waitFor(e => e.type === "response" && e.id === "preview-projection");
    const content = (projected.data as any).messages.find((m: any) => m.customType === "subagent-notify").content as string;
    const start = content.indexOf(block);
    assert.ok(start >= 0, "preview retains the genuine leading return block");
    const cut = content.indexOf("\n…", start);
    assert.ok(cut > start && cut - start <= 2000, "native child-output preview is bounded independently of full bytes");
    assert.ok(content.includes(output), "preview points to the actual full output file");
    assert.ok(Buffer.byteLength(content) < 4000, "native framing plus preview stays bounded at root");
    const settledCount = session.events.filter(e => e.type === "agent_settled").length;
    session.send({ type: "prompt", id: "inspect", message: "inspect saved completion" });
    await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length > settledCount);
    const requests = readFileSync(actualRequests, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const request = requests.at(-1);
    const notify = request.find((m: any) => m.customType === "subagent-notify");
    assert.ok(notify, "the next actual provider request contains the native completion");
    assert.equal(notify.content, content, "the real request receives the same bounded native preview and actual path");
    assert.ok(!JSON.stringify(request).includes(expectedArtifact), "the complete artifact must stay out of the next real request");
    assertArtifact(readFileSync(ret.artifact));
  } finally { await session.close(); }
});

}

// Regression from the security proof: native manual compaction with a live child emits
// subagent-compaction-resume. Defer until native activity positively reaches zero.
test("live native child defers without consumption, completion wakes, then the same root compacts", { timeout: 120_000 }, async () => {
  const s = loopFixture({ root: "faux/faux-1" });
  mkdirSync(join(s.agentDir, "agents"));
  writeFileSync(join(s.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, packages: [PI_SUBAGENTS_PACKAGE_DIR], defaultProjectTrust: "never", subagents: { agentExcludeDirs: ["~/.agents"] } }));
  writeFileSync(join(s.agentDir, "agents", "worker.md"), ["---", "name: worker", "description: Fixture", "tools: read", "model: faux/faux-1", "extensions: []", `subagentOnlyExtensions: ${FAUX_EXTENSION}`, "---", "Fixture"].join("\n"));
  const block = '```lane-return\n' + JSON.stringify({ v: 2, lane: "L1", status: "complete", sha: null, landed: false, check: "fixture", exit: 0, coderabbit: null }) + '\n```';
  const session = startPiRpc({ extensions: [FAUX_EXTENSION, CONTINUATION, STATE], agentDir: s.agentDir, subagentTempRoot: freshDir(), cwd: s.repo, sessionArgs: [], extraArgs: ["--exclude-tools", "subagents_enable"], env: { LOOP_PI_RUN_DIR: s.runDir }, fauxScriptPath: writeFauxScript([
    { match: "SPAWN_LIVE", once: true, toolCalls: [{ name: "subagent", args: { agent: "worker", task: "Lane: L1 · Task: T-1 · Tier: routine\nObjective: CHILD_LIVE", async: true, worktree: false } }] },
    { match: "CHILD_LIVE", delayMs: 30_000, text: block },
    { match: ".*", text: "PAUSED: fixture awaits the next explicit input." },
  ]) });
  const rpc = async (type: string, id: string) => { session.send({ type, id }); return (await session.waitFor(e => e.type === "response" && e.id === id)).data as any; };
  try {
    session.send({ type: "prompt", id: "arm", message: s.launch });
    await session.waitFor(e => e.type === "agent_settled");
    const identity = await rpc("get_state", "identity");
    append(s.log, "admit", "task=T-1", "source=first-wave", "owned=a/**", "accept=fixture", "tier=routine");
    append(s.log, "admit", "task=T-2", "source=first-wave", "owned=b/**", "accept=fixture", "tier=guarded");
    append(s.log, "park", "task=T-2", "reason=fixture", "needs=owner");
    session.send({ type: "prompt", id: "spawn", message: "SPAWN_LIVE" });
    await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 2);
    await waitForCondition(() => { try { return readFileSync(s.log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.ev === "dispatch"); } catch { return undefined; } }, 10_000);
    session.send({ type: "prompt", id: "large", message: "history ".repeat(56_250) });
    await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 3);
    assert.equal(session.events.filter(e => e.type === "agent_start").length, 3, "only three explicit inputs start root turns while the child is live");
    assert.equal(session.events.filter(e => e.type === "compaction_start").length, 0, "active native child defers proactive compaction");
    const entries = (await rpc("get_entries", "deferred-entries")).entries;
    assert.equal(entries.filter((e: any) => e.customType === "loop-root-context-budget" && e.data.attempts > 0).length, 0, "deferral consumes no attempt");
    const beforeRows = readFileSync(s.log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(beforeRows.filter(row => row.ev === "return").length, 0, "the child is actually still live, not a timing inference");
    const dispatch = beforeRows.find(row => row.ev === "dispatch");
    assert.ok(dispatch, "real native dispatch was recorded");
    await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 4, 60_000);
    assert.equal(session.events.filter(e => e.type === "agent_start").length, 4, "normal native child-completion wake is intact");
    // The cached completion turn can measure below 80%. Supply a fresh public-boundary
    // high-usage generation after completion, rather than inventing usage at that turn.
    session.send({ type: "prompt", id: "fresh-high", message: "fresh ".repeat(40_000) });
    const terminal = await session.waitFor(e => e.type === "compaction_end", 60_000) as any;
    await session.waitFor(e => e.type === "agent_settled" && session.events.filter(x => x.type === "agent_settled").length === 5);
    assert.ok(terminal.result, "a genuine settled high-usage boundary after child completion compacts");
    assert.equal(session.events.filter(e => e.type === "agent_start").length, 5, "normal completion wake is intact and compaction adds no root turn");
    assert.equal(session.events.some(e => (e.message as any)?.customType === "subagent-compaction-resume"), false);
    assert.equal(session.events.filter(e => e.type === "compaction_start").length, 1);
    const afterIdentity = await rpc("get_state", "after-identity");
    assert.equal(afterIdentity.sessionId, identity.sessionId);
    assert.equal(afterIdentity.sessionFile, identity.sessionFile);
    const afterRows = readFileSync(s.log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(afterRows.filter(row => ["admit", "dispatch", "park"].includes(row.ev)), beforeRows.filter(row => ["admit", "dispatch", "park"].includes(row.ev)));
    assert.equal(afterRows.find(row => row.ev === "return" && row.run === dispatch.run)?.status, "complete");
    assert.ok(terminal.result.summary.includes(readFileSync(s.charter, "utf8")), "accepted charter remains exact");
    assert.ok(terminal.result.summary.includes(dispatch.run), "actual dispatched identity survives");
    assert.match(terminal.result.summary, /T-2.*parked/s, "parked state survives");
    assert.ok(session.events.some(e => (e.message as any)?.customType === "subagent-notify"), "normal completion notification remains delivered");
    const budget = (await rpc("get_entries", "after-entries")).entries.filter((e: any) => e.customType === "loop-root-context-budget").at(-1).data;
    assert.equal(budget.attempts, 1);
  } finally { await session.close(); }
});
