// Regressions from independent checkout-identity and unlogged-root-mutation reproductions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import rootExtension from "./root.ts";
import laneExtension from "./lane.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../bin/loop-gate-lock");
function handler(extension: typeof rootExtension) {
  let call: Function | undefined;
  extension({ on(event: string, f: Function) { if (event === "tool_call") call = f; }, events: { on() {}, emit() {} } } as any);
  return call!;
}

for (const [role, extension] of [["root", rootExtension], ["lane", laneExtension]] as const) {
  test(`${role}: visible context-changing wrapper forms fail closed`, async () => {
    const base = mkdtempSync(join(tmpdir(), "gate-identity-"));
    try {
      for (const repo of [base, join(base, "other")]) {
        mkdirSync(join(repo, ".git"), { recursive: true });
        writeFileSync(join(repo, "LOOP.md"), `## Mutexes\n- gate: shared | printf ${repo === base ? "safe" : "changed"}\n`);
      }
      const call = handler(extension);
      const ctx = { cwd: base, ui: { notify() {} } };
      for (const command of [
        `cd '${join(base, "other")}' && '${cli}' shared`,
        `env GIT_WORK_TREE='${join(base, "other")}' '${cli}' shared`,
        `bash -c "cd '${join(base, "other")}' && '${cli}' shared"`,
        `python3 -c "import os; os.system('cd ${join(base, "other")} && loop-gate-lock shared')"`,
        "python3 <<'PY'\nimport os\nos.system('loop-gate-lock shared')\nPY",
      ]) {
        const verdict = await call({ toolName: "bash", input: { command } }, ctx);
        assert.equal(verdict?.block, true, `unchecked alternate checkout: ${command}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test(`${role}: approval binds execution cwd and exact declaration bytes`, async () => {
    const base = mkdtempSync(join(tmpdir(), "gate-binding-"));
    try {
      mkdirSync(join(base, ".git"));
      writeFileSync(join(base, "LOOP.md"), "## Mutexes\n- gate: shared | printf safe > result.json\n");
      const input = { command: `'${cli}' shared` };
      const verdict = await handler(extension)({ toolName: "bash", input }, { cwd: base, ui: { notify() {} } });
      assert.equal(verdict?.block ?? false, false, verdict?.reason);
      assert.match(input.command, /--cwd/);
      assert.match(input.command, /--sha256/);
      const startup = join(base, "startup.sh");
      writeFileSync(startup, "printf unchecked > startup-result.json\n");
      const run = spawnSync("/bin/sh", ["-c", input.command], {
        cwd: "/", env: { ...process.env, GIT_WORK_TREE: "/", GIT_DIR: "/unused", BASH_ENV: startup }, timeout: 10_000, encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readFileSync(join(base, "result.json"), "utf8"), "safe");
      assert.equal(existsSync(join(base, "startup-result.json")), false, "unchecked shell startup script ran");
      writeFileSync(join(base, "LOOP.md"), "## Mutexes\n- gate: shared | printf changed > result.json\n");
      const changed = spawnSync("bash", ["-c", input.command], { cwd: realpathSync(base), timeout: 10_000, encoding: "utf8" });
      assert.equal(changed.status, 78, "changed declaration was executed after approval");
      assert.match(changed.stderr, /declaration.*changed/i);
      assert.equal(readFileSync(join(base, "result.json"), "utf8"), "safe");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

test("root: explicit declared push and PR merge gates cannot evade the audit plan", async () => {
  const base = mkdtempSync(join(tmpdir(), "gate-audit-"));
  try {
    mkdirSync(join(base, ".git"));
    for (const command of ["git push origin HEAD", "gh pr merge 1 --merge", "bash -c 'git push origin HEAD'"]) {
      writeFileSync(join(base, "LOOP.md"), `## Mutexes\n- gate: remote-move | ${command}\n`);
      const verdict = await handler(rootExtension)({ toolName: "bash", input: { command: "loop-gate-lock remote-move" } },
        { cwd: base, ui: { notify() {} } });
      assert.equal(verdict?.block, true, `unaudited remote move: ${command}`);
      assert.match(verdict.reason, /push|merge/);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
