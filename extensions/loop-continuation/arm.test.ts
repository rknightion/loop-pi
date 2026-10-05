// S0, S2, S3 and S4 through index.ts's `input` hook: arm-time checks refuse with `handled` and an
// incident; a good arm writes the protocol marker, freezes ops and audit grants and appends `open`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkArm, envelopeTaskIds, type ArmEnv } from "./arm.ts";
import { addAuthority, cleanupFixtures, fakePi, fresh, goalText, initRepo, loopFixture } from "./test-fixture.ts";

after(cleanupFixtures);

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const events = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const rootIncidents = (agentDir: string) => {
  const dir = join(agentDir, "incidents", "root");
  return existsSync(dir) ? readdirSync(dir).map((name) => ({ name, body: JSON.parse(readFileSync(join(dir, name), "utf8")) })) : [];
};

test("a good arm writes the marker, appends one open by ext from ## Run and the envelope, and answers query-launch", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    const result = await pi.input(f.launch);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(readFileSync(join(f.runDir, "loop-pi-proto"), "utf8"), "2\n");
    const opens = events(f.log).filter((e) => e.ev === "open");
    assert.equal(opens.length, 1);
    assert.deepEqual(
      { by: opens[0].by, goal_sha256: opens[0].goal_sha256, tier: opens[0].tier, root: opens[0].root, root_model: opens[0].root_model, envelope: opens[0].envelope },
      { by: "ext", goal_sha256: sha(readFileSync(f.goal)), tier: "guarded", root: "llm", root_model: "provider/model-a", envelope: ["T-1", "T-2"] },
    );
    assert.equal(pi.query().reportPath, f.report);
    assert.equal(rootIncidents(f.agentDir).length, 0);

    // A relaunch from the same goal arms again without a second open.
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    assert.equal(events(f.log).filter((e) => e.ev === "open").length, 1);
  } finally {
    pi.restore();
  }
});

test("each failed arm check is refused with handled, an arm-refused incident and a visible reason, and nothing armed", async () => {
  const cases: { name: string; setup: () => { fixture: ReturnType<typeof loopFixture>; runDir: string | null; cwd?: string }; reason: RegExp }[] = [
    { name: "no run dir", setup: () => ({ fixture: loopFixture(), runDir: null }), reason: /LOOP_PI_RUN_DIR is not set/ },
    { name: "run dir missing", setup: () => ({ fixture: loopFixture(), runDir: "/nonexistent/loop-run-dir" }), reason: /does not exist/ },
    {
      name: "wrong repository",
      setup: () => {
        const other = fresh("loop-cont-other-");
        initRepo(other);
        const fixture = loopFixture();
        return { fixture, runDir: fixture.runDir, cwd: other };
      },
      reason: /is not the goal's repository/,
    },
    {
      name: "not a repository",
      setup: () => {
        const fixture = loopFixture();
        return { fixture, runDir: fixture.runDir, cwd: fresh("loop-cont-plain-") };
      },
      reason: /not inside a git repository/,
    },
    { name: "wrong host", setup: () => { const fixture = loopFixture({ host: "no-such-host-zz9" }); return { fixture, runDir: fixture.runDir }; }, reason: /runs on host no-such-host-zz9/ },
    {
      name: "missing goal",
      setup: () => {
        const fixture = loopFixture();
        rmSync(fixture.goal);
        return { fixture, runDir: fixture.runDir };
      },
      reason: /cannot be read/,
    },
    {
      name: "goal changed since open",
      setup: () => {
        const fixture = loopFixture();
        writeFileSync(fixture.log, `${JSON.stringify({ v: 1, seq: 1, ts: "2026-10-04T00:00:00Z", by: "ext", ev: "open", goal_sha256: "0".repeat(64), tier: "guarded", root: "llm", root_model: "m", envelope: [] })}\n`);
        return { fixture, runDir: fixture.runDir };
      },
      reason: /goal changed since the loop opened/,
    },
  ];
  for (const c of cases) {
    const { fixture: f, runDir, cwd } = c.setup();
    const pi = await fakePi({ agentDir: f.agentDir, cwd: cwd ?? f.repo, runDir });
    try {
      const result = await pi.input(f.launch);
      assert.deepEqual(result, { action: "handled" }, c.name);
      const incidents = rootIncidents(f.agentDir);
      assert.equal(incidents.length, 1, c.name);
      assert.match(incidents[0].name, /^sess-1-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-arm-refused\.json$/, c.name);
      assert.deepEqual(Object.keys(incidents[0].body).sort(), ["at", "class", "cwd", "reason", "session", "v"], c.name);
      assert.equal(incidents[0].body.class, "loop-arm-refused");
      assert.equal(incidents[0].body.session, "sess-1");
      assert.equal(incidents[0].body.v, 1);
      assert.equal(incidents[0].body.cwd, cwd ?? f.repo);
      assert.match(incidents[0].body.reason, c.reason, c.name);
      assert.ok(pi.notes.some((n) => n.type === "error" && c.reason.test(n.message)), `${c.name}: the reason is shown`);
      assert.equal(pi.query().reportPath, null, `${c.name}: not armed`);
      if (runDir && existsSync(runDir)) assert.equal(existsSync(join(runDir, "loop-pi-proto")), false, `${c.name}: no marker`);
      assert.equal(events(f.log).filter((e) => e.ev === "open" && e.goal_sha256 !== "0".repeat(64)).length, 0, `${c.name}: no open`);
    } finally {
      pi.restore();
    }
  }
});

test("the goal's host matches this machine's short name case-insensitively", async () => {
  const f = loopFixture({ host: hostname().split(".")[0].toUpperCase() });
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
  } finally {
    pi.restore();
  }
});

test("checkArm also accepts the scutil LocalHostName, and refuses with both names shown", () => {
  const f = loopFixture({ host: "studio-mac" });
  const env = (names: string[]): ArmEnv => ({
    runDir: f.runDir,
    cwd: f.repo,
    gitToplevel: () => f.repo,
    hostNames: () => names,
    readFile: (p) => readFileSync(p),
    realpath: (p) => p,
  });
  assert.equal(checkArm(f, env(["host-a", "studio-mac"])).ok, true);
  const refused = checkArm(f, env(["host-a", "host-b"]));
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /host-a \/ host-b/);
});

test("loopPi.onIncident runs detached with {file}; a notifier that fails to start is ignored", async () => {
  const f = loopFixture();
  const out = join(fresh("loop-cont-notify-"), "notified.txt");
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ loopPi: { onIncident: ["sh", "-c", 'cat "$1" > "$2"', "sh", "{file}", out] } }));
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: null });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "handled" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.parse(readFileSync(out, "utf8")).class, "loop-arm-refused");
  } finally {
    pi.restore();
  }
  const g = loopFixture();
  writeFileSync(join(g.agentDir, "settings.json"), JSON.stringify({ loopPi: { onIncident: ["/nonexistent/notifier", "{file}"] } }));
  const pi2 = await fakePi({ agentDir: g.agentDir, cwd: g.repo, runDir: null });
  try {
    assert.deepEqual(await pi2.input(g.launch), { action: "handled" });
  } finally {
    pi2.restore();
  }
});

test("a first input naming a goal file that does not arm gets the relaunch warning, not a refusal", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.goal), { action: "continue" });
    assert.deepEqual(pi.notes, [
      { message: "This did not arm a loop root: paste the launch file path (codex/launch-...) to relaunch with its grants.", type: "warning" },
    ]);
    assert.deepEqual(await pi.input("an ordinary message"), { action: "continue" });
    assert.deepEqual(await pi.input(`later: see ${f.goal}`), { action: "continue" });
    assert.equal(pi.notes.length, 1, "only the first input is checked");
    assert.equal(rootIncidents(f.agentDir).length, 0);
  } finally {
    pi.restore();
  }
});

test("Audit grants are frozen into the run dir with their digest and exposed on query-launch; a bad line gives none and an ops incident", async () => {
  const f = loopFixture();
  const grantsPath = join(f.repo, "codex", "grants-x-loop3.json");
  const grants = JSON.stringify({ [f.repo]: { refs: [], automation: [] }, bot_actors: ["release-app[bot]"] });
  writeFileSync(grantsPath, grants);
  addAuthority(f, `audit grants: ${grantsPath} sha256=${sha(grants)}`);
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    await pi.input(`${f.launch}\nAudit grants: ${grantsPath} sha256=${sha(grants)}`);
    const copy = join(f.runDir, "audit-grants.json");
    assert.equal(readFileSync(copy, "utf8"), grants);
    writeFileSync(grantsPath, "{}");
    assert.equal(readFileSync(copy, "utf8"), grants, "a later edit of the source does not reach the frozen copy");
    const answer = pi.query();
    assert.equal(answer.auditGrantsPath, copy);
    assert.equal(answer.auditGrantsSha256, sha(grants));
    assert.equal(answer.ops, null);
  } finally {
    pi.restore();
  }

  const g = loopFixture();
  // The goal and the launch agree on the digest; the file does not match it, so the freeze refuses it.
  addAuthority(g, `audit grants: ${join(g.repo, "codex", "grants.json")} sha256=${"0".repeat(64)}`);
  const pi2 = await fakePi({ agentDir: g.agentDir, cwd: g.repo, runDir: g.runDir });
  try {
    writeFileSync(join(g.repo, "codex", "grants.json"), "{}");
    assert.deepEqual(await pi2.input(`${g.launch}\nAudit grants: ${join(g.repo, "codex", "grants.json")} sha256=${"0".repeat(64)}`), { action: "continue" });
    const answer = pi2.query();
    assert.equal(answer.auditGrantsPath, null);
    assert.equal(answer.auditGrantsSha256, null);
    assert.equal(existsSync(join(g.runDir, "audit-grants.json")), false);
    const files = readdirSync(join(g.agentDir, "incidents", "ops"));
    assert.equal(files.length, 1);
    const incident = JSON.parse(readFileSync(join(g.agentDir, "incidents", "ops", files[0]), "utf8"));
    assert.equal(incident.class, "loop-audit-grants-rejected");
    assert.match(incident.reason, /sha256 does not match/);
  } finally {
    pi2.restore();
  }
});

test("a launch file of the existing shape (cmd line, goal named in the text, Ops grants) still arms from its bare path", async () => {
  const f = loopFixture();
  const ops = JSON.stringify({ v: 1, ops: [{ surface: "deploy:svc", kind: "deploy", allow: ["just deploy"], secret_paths: [] }] });
  const opsPath = join(f.repo, "codex", "ops-2026-10-04-loop3.json");
  writeFileSync(opsPath, ops);
  addAuthority(f, `ops: ${opsPath} sha256=${sha(ops)}`);
  const launchFile = join(f.repo, "codex", "launch-2026-10-04-loop3.txt");
  writeFileSync(
    launchFile,
    [
      "cmd: loop-pi --thinking medium",
      "You are the root. Read ~/docs/loop/contract.md, ~/docs/loop/harness-pi.md",
      `and ${f.goal} in full. Write ${f.report} as the terminal action.`,
      `Ops grants: ${opsPath} sha256=${sha(ops)}`,
      "",
    ].join("\n"),
  );
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(launchFile), { action: "continue" });
    const answer = pi.query();
    assert.equal(answer.reportPath, f.report);
    assert.equal(answer.opsPath, opsPath);
    assert.deepEqual(answer.ops, JSON.parse(ops));
    assert.equal(answer.auditGrantsPath, null);
    assert.equal(events(f.log).filter((e) => e.ev === "open").length, 1, JSON.stringify(pi.notes));
  } finally {
    pi.restore();
  }
});

test("envelope task ids come from the task cells in order, with titles and backticks stripped", () => {
  assert.deepEqual(envelopeTaskIds(goalText()), ["T-1", "T-2"]);
  assert.deepEqual(envelopeTaskIds("## Envelope\n| task | x |\n|---|---|\n| A1 (t) | y |\n## Other\n| B | z |\n"), ["A1"]);
});

test("a goal whose ## Run lacks root-model still arms, with a warning that open was not written", async () => {
  const f = loopFixture({ rootModel: null });
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    assert.equal(events(f.log).length, 0);
    assert.ok(pi.notes.some((n) => n.type === "warning" && /open was not appended.*root-model/.test(n.message)), JSON.stringify(pi.notes));
  } finally {
    pi.restore();
  }
});

test("the launch's Ops and Audit grants lines must be the goal's ## Authority ops and audit grants lines, or the arm is refused", async () => {
  const opsBody = JSON.stringify({ v: 1, ops: [{ surface: "deploy:svc", kind: "deploy", allow: ["just deploy"], secret_paths: [] }] });
  const auditBody = JSON.stringify({ "/r": { refs: [] } });
  const other = JSON.stringify({ v: 1, ops: [] });
  type Case = { name: string; authority: (p: Record<string, string>) => string[]; launch: (p: Record<string, string>) => string[]; refused: RegExp | null };
  const cases: Case[] = [
    { name: "both match", authority: (p) => [`ops: ${p.ops} sha256=${sha(opsBody)}`, `audit grants: \`${p.audit}\` sha256=${sha(auditBody)}`], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(opsBody)}`, `Audit grants: ${p.audit} sha256=${sha(auditBody)}`], refused: null },
    { name: "a repo-relative goal path", authority: () => [`ops: codex/ops-x-loop3.json sha256=${sha(opsBody)}`, "audit grants: none"], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(opsBody)}`], refused: null },
    { name: "older goal: no audit grants line, no launch line", authority: (p) => [`ops: ${p.ops} sha256=${sha(opsBody)}`], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(opsBody)}`], refused: null },
    { name: "goal ops none, launch carries Ops grants", authority: () => ["ops: none", "audit grants: none"], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(opsBody)}`], refused: /launch carries an Ops grants line but the goal's ## Authority ops is none/ },
    { name: "goal has no ops line, launch carries Ops grants", authority: () => [], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(opsBody)}`], refused: /Ops grants line but the goal's ## Authority ops is absent/ },
    { name: "goal audit none, launch carries Audit grants", authority: () => ["ops: none", "audit grants: none"], launch: (p) => [`Audit grants: ${p.audit} sha256=${sha(auditBody)}`], refused: /Audit grants line but the goal's ## Authority audit grants is none/ },
    { name: "no goal audit line, launch carries Audit grants", authority: () => ["ops: none"], launch: (p) => [`Audit grants: ${p.audit} sha256=${sha(auditBody)}`], refused: /Audit grants line but the goal's ## Authority audit grants is absent/ },
    { name: "a different ops file with its own valid digest", authority: (p) => [`ops: ${p.ops} sha256=${sha(opsBody)}`], launch: (p) => [`Ops grants: ${p.other} sha256=${sha(other)}`], refused: /Ops grants file .*ops-wide\.json is not the goal's ops file/ },
    { name: "the same ops file, another digest", authority: (p) => [`ops: ${p.ops} sha256=${sha(opsBody)}`], launch: (p) => [`Ops grants: ${p.ops} sha256=${sha(other)}`], refused: /Ops grants sha256 .* is not the goal's ops sha256/ },
    { name: "a goal ops file the launch omits", authority: (p) => [`ops: ${p.ops} sha256=${sha(opsBody)}`], launch: () => [], refused: /names .*ops-x-loop3\.json but the launch has no Ops grants line/ },
    { name: "a different audit grants digest", authority: (p) => ["ops: none", `audit grants: ${p.audit} sha256=${sha(auditBody)}`], launch: (p) => [`Audit grants: ${p.audit} sha256=${"0".repeat(64)}`], refused: /Audit grants sha256 0+ is not the goal's audit grants sha256/ },
  ];
  for (const c of cases) {
    const f = loopFixture();
    const p = { ops: join(f.repo, "codex", "ops-x-loop3.json"), audit: join(f.repo, "codex", "grants-x-loop3.json"), other: join(f.repo, "codex", "ops-wide.json") };
    writeFileSync(p.ops, opsBody);
    writeFileSync(p.audit, auditBody);
    writeFileSync(p.other, other);
    addAuthority(f, ...c.authority(p));
    const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
    try {
      const result = await pi.input([f.launch, ...c.launch(p)].join("\n"));
      if (c.refused === null) {
        assert.deepEqual(result, { action: "continue" }, `${c.name}: ${JSON.stringify(pi.notes)}`);
        assert.equal(rootIncidents(f.agentDir).length, 0, c.name);
        assert.equal(pi.query().reportPath, f.report, c.name);
        continue;
      }
      assert.deepEqual(result, { action: "handled" }, c.name);
      const incidents = rootIncidents(f.agentDir);
      assert.equal(incidents.length, 1, c.name);
      assert.equal(incidents[0].body.class, "loop-arm-refused", c.name);
      assert.match(incidents[0].body.reason, c.refused, c.name);
      assert.ok(pi.notes.some((n) => n.type === "error" && c.refused!.test(n.message)), `${c.name}: the reason is shown`);
      assert.equal(pi.query().reportPath, null, `${c.name}: not armed`);
      assert.equal(pi.query().ops, null, `${c.name}: no ops frozen`);
      assert.equal(existsSync(join(f.runDir, "loop-pi-proto")), false, `${c.name}: no marker`);
      assert.equal(existsSync(join(f.runDir, "audit-grants.json")), false, `${c.name}: no audit grants copy`);
    } finally {
      pi.restore();
    }
  }
});
