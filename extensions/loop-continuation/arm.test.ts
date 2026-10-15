// Arming through index.ts's `input` hook: arm-time checks against the v3 charter refuse with
// `handled` and an incident; a good arm writes the protocol marker, freezes audit grants and
// standing, and appends `open` itself (the root never writes it).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkArm, firstWaveTaskIds, type ArmEnv } from "./arm.ts";
import { charterText, cleanupFixtures, fakePi, fresh, initRepo, loopFixture, setCharterKeys } from "./test-fixture.ts";

after(cleanupFixtures);

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const events = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const rootIncidents = (agentDir: string) => {
  const dir = join(agentDir, "incidents", "root");
  return existsSync(dir) ? readdirSync(dir).map((name) => ({ name, body: JSON.parse(readFileSync(join(dir, name), "utf8")) })) : [];
};

test("a good arm writes the marker, appends one open by ext from the charter's keys and first wave, and answers query-launch", async () => {
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
      { by: "ext", goal_sha256: sha(readFileSync(f.charter)), tier: "routine", root: "llm", root_model: "sol / medium", envelope: ["T-1", "T-2"] },
    );
    assert.equal(pi.query().reportPath, f.report);
    assert.equal(rootIncidents(f.agentDir).length, 0);

    // A relaunch from the same charter arms again without a second open.
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    assert.equal(events(f.log).filter((e) => e.ev === "open").length, 1);
  } finally {
    pi.restore();
  }
});

test("arming retains protocol in an existing pre-arm snapshot without replacing its evidence", async () => {
  const f = loopFixture();
  const before = { taken_at: "2026-10-04T00:00:00Z", repos: { [f.repo]: { fixture: "original remote state" } } };
  const path = join(f.runDir, "audit-before.json");
  writeFileSync(path, JSON.stringify(before));
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...before, protocol: 2 });
    rmSync(join(f.runDir, "loop-pi-proto"));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).protocol, 2);
  } finally {
    pi.restore();
  }
});

test("a malformed pre-arm snapshot refuses arming instead of silently losing protocol evidence", async () => {
  const f = loopFixture();
  const path = join(f.runDir, "audit-before.json");
  writeFileSync(path, "broken snapshot");
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "handled" });
    assert.equal(pi.query().reportPath, null);
    assert.equal(readFileSync(path, "utf8"), "broken snapshot");
    assert.match(rootIncidents(f.agentDir)[0].body.reason, /could not retain protocol/);
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
      reason: /is not the charter's repository/,
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
      name: "missing charter",
      setup: () => {
        const fixture = loopFixture();
        rmSync(fixture.charter);
        return { fixture, runDir: fixture.runDir };
      },
      reason: /cannot be read/,
    },
    {
      name: "an Ops grants line (v3 has no ops lane)",
      setup: () => {
        const fixture = loopFixture();
        fixture.launch += `\nOps grants: ${join(fixture.repo, "codex", "ops-x-loop3.json")} sha256=${"a".repeat(64)}`;
        return { fixture, runDir: fixture.runDir };
      },
      reason: /carries an Ops grants line; v3 has no ops lane/,
    },
    {
      name: "charter changed since open",
      setup: () => {
        const fixture = loopFixture();
        writeFileSync(fixture.log, `${JSON.stringify({ v: 1, seq: 1, ts: "2026-10-04T00:00:00Z", by: "ext", ev: "open", goal_sha256: "0".repeat(64), tier: "guarded", root: "llm", root_model: "m", envelope: [] })}\n`);
        return { fixture, runDir: fixture.runDir };
      },
      reason: /charter changed since the loop opened/,
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

test("the charter's host matches this machine's short name case-insensitively", async () => {
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
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ loopPi: { onIncident: ["sh", "-c", 'cat "$1" > "$2.tmp" && mv "$2.tmp" "$2"', "sh", "{file}", out] } }));
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

test("a first input naming a charter file that does not arm gets the relaunch warning, not a refusal", async () => {
  const f = loopFixture();
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.charter), { action: "continue" });
    assert.deepEqual(pi.notes, [
      { message: "This did not arm a loop root: paste the launch file path (codex/launch-...) to relaunch it.", type: "warning" },
    ]);
    assert.deepEqual(await pi.input("an ordinary message"), { action: "continue" });
    assert.deepEqual(await pi.input(`later: see ${f.charter}`), { action: "continue" });
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
  setCharterKeys(f, `audit grants: ${grantsPath} sha256=${sha(grants)}`);
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
  // The charter and the launch agree on the digest; the file does not match it, so the freeze refuses it.
  setCharterKeys(g, `audit grants: ${join(g.repo, "codex", "grants.json")} sha256=${"0".repeat(64)}`);
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

test("Standing is frozen into the run dir with its digest and exposed on query-launch; a bad hash or a missing file gives none and an ops incident", async () => {
  const f = loopFixture();
  const standingPath = join(f.repo, "authority", "owner__repo.md");
  const body = "# Standing authority\n\n## Grants\n- read anything\n\n## Fences\n- no deletes\n";
  mkdirSync(join(f.repo, "authority"), { recursive: true });
  writeFileSync(standingPath, body);
  setCharterKeys(f, `standing: ${standingPath} sha256=${sha(body)}`);
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(`${f.launch}\nStanding: ${standingPath} sha256=${sha(body).toUpperCase()}`), { action: "continue" });
    const copy = join(f.runDir, "standing.md");
    assert.equal(readFileSync(copy, "utf8"), body);
    writeFileSync(standingPath, "# edited\n");
    assert.equal(readFileSync(copy, "utf8"), body, "a later edit of the source does not reach the frozen copy");
    const answer = pi.query();
    assert.equal(answer.standingPath, copy);
    assert.equal(answer.standingSha256, sha(body));
    assert.equal(existsSync(join(f.agentDir, "incidents", "ops")), false);
  } finally {
    pi.restore();
  }

  for (const c of [
    { name: "digest mismatch", write: true, reason: /sha256 does not match/ },
    { name: "missing file", write: false, reason: /cannot be read/ },
  ]) {
    const g = loopFixture();
    const path = join(g.repo, "authority", "owner__repo.md");
    mkdirSync(join(g.repo, "authority"), { recursive: true });
    if (c.write) writeFileSync(path, "# not what the charter pinned\n");
    // The charter and the launch agree on the digest; the file does not match it (or is absent), so the freeze refuses it.
    setCharterKeys(g, `standing: ${path} sha256=${"0".repeat(64)}`);
    const pi2 = await fakePi({ agentDir: g.agentDir, cwd: g.repo, runDir: g.runDir });
    try {
      assert.deepEqual(await pi2.input(`${g.launch}\nStanding: ${path} sha256=${"0".repeat(64)}`), { action: "continue" }, c.name);
      const answer = pi2.query();
      assert.equal(answer.reportPath, g.report, `${c.name}: the arm still succeeds`);
      assert.equal(answer.standingPath, null, c.name);
      assert.equal(answer.standingSha256, null, c.name);
      assert.equal(existsSync(join(g.runDir, "standing.md")), false, c.name);
      const files = readdirSync(join(g.agentDir, "incidents", "ops"));
      assert.equal(files.length, 1, c.name);
      const incident = JSON.parse(readFileSync(join(g.agentDir, "incidents", "ops", files[0]), "utf8"));
      assert.equal(incident.class, "loop-standing-rejected", c.name);
      assert.match(incident.reason, c.reason, c.name);
      assert.equal(incident.standing_path, path, c.name);
    } finally {
      pi2.restore();
    }
  }
});

test("a launch file of the v3 shape (cmd line, charter named in the text, Standing) arms from its bare path", async () => {
  const f = loopFixture();
  const body = "# Standing authority\n";
  const standingPath = join(f.repo, "codex", "owner__repo.md");
  writeFileSync(standingPath, body);
  setCharterKeys(f, `standing: ${standingPath} sha256=${sha(body)}`);
  const launchFile = join(f.repo, "codex", "launch-2026-10-04-loop3.txt");
  writeFileSync(
    launchFile,
    [
      "cmd: loop-pi --thinking medium",
      "You are the root. Read ~/docs/loop/contract.md, ~/docs/loop/harness-pi.md",
      `and ${f.charter} in full. Write ${f.report} as the terminal action.`,
      `Standing: ${standingPath} sha256=${sha(body)}`,
      "",
    ].join("\n"),
  );
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(launchFile), { action: "continue" });
    const answer = pi.query();
    assert.equal(answer.reportPath, f.report);
    assert.equal(answer.opsPath, null);
    assert.equal(answer.ops, null);
    assert.equal(answer.standingSha256, sha(body));
    assert.equal(answer.auditGrantsPath, null);
    assert.equal(events(f.log).filter((e) => e.ev === "open").length, 1, JSON.stringify(pi.notes));
  } finally {
    pi.restore();
  }
});

test("first-wave task ids come from the task cells in order, with titles, backticks and template placeholders stripped", () => {
  assert.deepEqual(firstWaveTaskIds(charterText()), ["T-1", "T-2"]);
  assert.deepEqual(firstWaveTaskIds("## First wave\n| Task | x |\n|---|---|\n| A1 (t) | y |\n| <ID> (<title>) | z |\n## Other\n| B | z |\n"), ["A1"]);
});

test("a charter with no root key still gets its open, appended by continuation with root_model unknown", async () => {
  const f = loopFixture({ root: null });
  const pi = await fakePi({ agentDir: f.agentDir, cwd: f.repo, runDir: f.runDir });
  try {
    assert.deepEqual(await pi.input(f.launch), { action: "continue" });
    const opens = events(f.log).filter((e) => e.ev === "open");
    assert.equal(opens.length, 1, JSON.stringify(pi.notes));
    assert.equal(opens[0].by, "ext");
    assert.equal(opens[0].root_model, "unknown");
    assert.equal(opens[0].goal_sha256, sha(readFileSync(f.charter)));
  } finally {
    pi.restore();
  }
});

test("the launch's Audit grants and Standing lines must be the charter's audit grants and standing keys, or the arm is refused", async () => {
  const auditBody = JSON.stringify({ "/r": { refs: [] } });
  const standingBody = "# Standing authority\n## Grants\n## Fences\n";
  type Case = { name: string; keys: (p: Record<string, string>) => string[]; launch: (p: Record<string, string>) => string[]; refused: RegExp | null };
  const cases: Case[] = [
    { name: "both match", keys: (p) => [`audit grants: \`${p.audit}\` sha256=${sha(auditBody)}`, `standing: ${p.standing} sha256=${sha(standingBody)}`], launch: (p) => [`Audit grants: ${p.audit} sha256=${sha(auditBody)}`, `Standing: ${p.standing} sha256=${sha(standingBody)}`], refused: null },
    { name: "a repo-relative charter path", keys: () => [`standing: codex/owner__repo.md sha256=${sha(standingBody)}`], launch: (p) => [`Standing: ${p.standing} sha256=${sha(standingBody)}`], refused: null },
    { name: "charter audit none, launch carries Audit grants", keys: () => ["audit grants: none"], launch: (p) => [`Audit grants: ${p.audit} sha256=${sha(auditBody)}`], refused: /Audit grants line but the charter's audit grants is none/ },
    { name: "no charter audit key, launch carries Audit grants", keys: () => [], launch: (p) => [`Audit grants: ${p.audit} sha256=${sha(auditBody)}`], refused: /Audit grants line but the charter's audit grants is absent/ },
    { name: "a different audit grants digest", keys: (p) => [`audit grants: ${p.audit} sha256=${sha(auditBody)}`], launch: (p) => [`Audit grants: ${p.audit} sha256=${"0".repeat(64)}`], refused: /Audit grants sha256 0+ is not the charter's audit grants sha256/ },
    { name: "charter standing none, no launch line", keys: () => ["standing: none"], launch: () => [], refused: null },
    { name: "charter standing none, launch carries Standing", keys: () => ["standing: none"], launch: (p) => [`Standing: ${p.standing} sha256=${sha(standingBody)}`], refused: /launch carries a Standing line but the charter's standing is none/ },
    { name: "a charter standing file the launch omits", keys: (p) => [`standing: ${p.standing} sha256=${sha(standingBody)}`], launch: () => [], refused: /names .*owner__repo\.md but the launch has no Standing line/ },
    { name: "a different standing digest", keys: (p) => [`standing: ${p.standing} sha256=${sha(standingBody)}`], launch: (p) => [`Standing: ${p.standing} sha256=${"0".repeat(64)}`], refused: /Standing sha256 0+ is not the charter's standing sha256/ },
    { name: "a different standing file", keys: (p) => [`standing: ${p.standing} sha256=${sha(standingBody)}`], launch: (p) => [`Standing: ${p.audit} sha256=${sha(standingBody)}`], refused: /Standing file .*grants-x-loop3\.json is not the charter's standing file/ },
    { name: "a malformed charter standing key", keys: () => ["standing: somewhere"], launch: () => [], refused: /charter's standing key is neither none nor/ },
    { name: "two Standing lines", keys: (p) => [`standing: ${p.standing} sha256=${sha(standingBody)}`], launch: (p) => [`Standing: ${p.standing} sha256=${sha(standingBody)}`, `Standing: ${p.standing} sha256=${sha(standingBody)}`], refused: /Standing line is malformed \(the launch carries more than one Standing line\)/ },
    { name: "a relative Standing path", keys: (p) => [`standing: ${p.standing} sha256=${sha(standingBody)}`], launch: () => [`Standing: authority/owner__repo.md sha256=${sha(standingBody)}`], refused: /Standing line is malformed \(the Standing path is not absolute\)/ },
  ];
  for (const c of cases) {
    const f = loopFixture();
    const p = { audit: join(f.repo, "codex", "grants-x-loop3.json"), standing: join(f.repo, "codex", "owner__repo.md") };
    writeFileSync(p.audit, auditBody);
    writeFileSync(p.standing, standingBody);
    if (c.keys(p).length) setCharterKeys(f, ...c.keys(p));
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
      assert.equal(existsSync(join(f.runDir, "loop-pi-proto")), false, `${c.name}: no marker`);
      assert.equal(existsSync(join(f.runDir, "audit-grants.json")), false, `${c.name}: no audit grants copy`);
      assert.equal(existsSync(join(f.runDir, "standing.md")), false, `${c.name}: no standing copy`);
    } finally {
      pi.restore();
    }
  }
});
