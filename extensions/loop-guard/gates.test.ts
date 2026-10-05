import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadGateDeclarations, parseGateDeclarations } from "./gates.ts";
import { evaluateBashCommand, wrappedGateCommands } from "./rules.ts";

const declarations = parseGateDeclarations("## Mutexes\n- prose about just check\n- gate: heavy | just check\n");

test("only explicit unfenced Mutexes entries declare gates", () => {
  assert.deepEqual(parseGateDeclarations("- gate: outside | false\n## Mutexes\n- plain prose\n```\n- gate: example | false\n```\n- gate: heavy | printf hello | wc -c\n### Detail\n- gate: other | true\n## End\n- gate: outside | false\n"), {
    gates: [{ name: "heavy", command: "printf hello | wc -c" }, { name: "other", command: "true" }],
  });
  for (const line of ["- gate: broken", "- gate: unsafe/name | true", "- gate: empty | ",
    "- gate: a | true\n- gate: a | false", "- gate: a | true\n- gate: b | true"]) {
    assert.ok(parseGateDeclarations(`## Mutexes\n${line}`).error, line);
  }
});

test("gate discovery reads the local worktree LOOP.md from subdirectories", () => {
  const repo = mkdtempSync(join(tmpdir(), "guard-gates-"));
  try {
    writeFileSync(join(repo, ".git"), "gitdir: /unused-administrative-pointer\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "LOOP.md"), "## Mutexes\n- gate: heavy | just check\n");
    const loaded = loadGateDeclarations(join(repo, "src"));
    assert.deepEqual(loaded.gates, declarations.gates);
    assert.match(loaded.sha256!, /^[0-9a-f]{64}$/);
    assert.ok(loaded.cwd?.endsWith("/src"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

for (const role of ["root", "lane"] as const) {
  test(`${role}: naked declared gates are refused, correct wrapper allowed, prose inert`, () => {
    for (const command of ["just check", "just check --verbose", "env FOO=bar just check", "bash -c 'just check'",
      "echo $(just check)", "true && just check", "sh <<'EOF'\njust check\nEOF"]) {
      const result = evaluateBashCommand(command, role, 0, true, { gates: declarations });
      assert.equal(result.block, true, command);
      assert.match(result.reason!, /loop-gate-lock heavy/);
    }
    for (const command of ["loop-gate-lock heavy", "bin/loop-gate-lock heavy"]) {
      assert.equal(evaluateBashCommand(command, role, 0, true, { gates: declarations }).block, false, command);
      assert.deepEqual(wrappedGateCommands(command, declarations), ["just check"]);
    }
    for (const command of ["loop-gate-lock wrong", "loop-gate-lock heavy -- just check", "loop-gate-lock heavy && just check",
      "env FOO=bar loop-gate-lock heavy", "bash -c 'loop-gate-lock heavy'", "loop-gate-lock heavy > log.json"]) {
      assert.equal(evaluateBashCommand(command, role, 0, true, { gates: declarations }).block, true, command);
    }
    assert.equal(evaluateBashCommand("echo 'just check'", role, 0, true, { gates: declarations }).block, false);
    assert.equal(evaluateBashCommand("just check", role, 0, true, { gates: parseGateDeclarations("## Mutexes\n- just check is heavy") }).block, false);
    assert.equal(evaluateBashCommand("true", role, 0, true, { gates: parseGateDeclarations("## Mutexes\n- gate: malformed") }).block, true);
  });

  test(`${role}: wrapper never bypasses existing guard rules`, () => {
    for (const command of ["git push --force", "git add -A", "git commit -a", "sleep 1 &", "nohup true"]) {
      const gates = { gates: [{ name: "unsafe", command }] };
      assert.equal(evaluateBashCommand("loop-gate-lock unsafe", role, 0, true, { gates }).block, true, command);
    }
    const gates = { gates: [{ name: "nested", command: "loop-gate-lock nested" }] };
    assert.equal(evaluateBashCommand("loop-gate-lock nested", role, 0, true, { gates }).block, true);
    const protectedGates = { gates: [{ name: "protected", command: "echo x > protected.json" }] };
    assert.equal(evaluateBashCommand("loop-gate-lock protected", role, 0, true, {
      gates: protectedGates, proto: true, protectedPath: () => "protected path",
    }).block, true);
  });

  test(`${role}: compound exact command is enforced without declaring its isolated parts`, () => {
    const gates = { gates: [{ name: "compound", command: "npm ci && just check" }] };
    assert.equal(evaluateBashCommand("env TEST=1 bash -c 'npm ci && just check'", role, 0, true, { gates }).block, true);
    assert.equal(evaluateBashCommand("npm ci", role, 0, true, { gates }).block, false);
    assert.equal(evaluateBashCommand("loop-gate-lock compound", role, 0, true, { gates }).block, false);
  });
}

test("lane: unsafe declared release, secret and ungranted push stay blocked", () => {
  for (const command of ["gh release create v1", "gh api -X POST repos/x/y", "git push", "gh secret set TOKEN --body value"]) {
    const gates = { gates: [{ name: "unsafe", command }] };
    assert.equal(evaluateBashCommand("loop-gate-lock unsafe", "lane", 0, false, { gates }).block, true, command);
  }
});
