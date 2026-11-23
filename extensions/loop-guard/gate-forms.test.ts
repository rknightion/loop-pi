// Ordinary shell forms around a declared gate wrapper: accepted when they stay in this worktree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadGateDeclarations, worktreeContains } from "./gates.ts";
import { bindGateExecution, evaluateBashCommand, wrappedGateCommands } from "./rules.ts";
import laneExtension from "./lane.ts";
import rootExtension from "./root.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../bin/loop-gate-lock");

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-forms-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  mkdirSync(join(repo, "codex"));
  mkdirSync(join(repo, "sub"));
  mkdirSync(join(repo, "nested", ".git"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(repo, "LOOP.md"), "## Mutexes\n- gate: heavy | printf ok\n- gate: failing | printf partial; exit 3\n");
  return { base, repo, outside: join(base, "outside") };
}

function handler(extension: typeof rootExtension) {
  let call: Function | undefined;
  extension({ on(event: string, f: Function) { if (event === "tool_call") call = f; }, events: { on() {}, emit() {} } } as any);
  return call!;
}

for (const role of ["root", "lane"] as const) {
  test(`${role}: the declared gate runs with ordinary shell forms inside its own worktree`, () => {
    const { base, repo } = fixture();
    try {
      const context = { gates: loadGateDeclarations(repo), cwd: repo, inWorktree: worktreeContains(repo) };
      for (const command of [
        "GATERUN_K8S_IDENTITY=L01 loop-gate-lock heavy",
        "env CI=1 NO_COLOR=1 loop-gate-lock heavy",
        `cd '${repo}' && loop-gate-lock heavy`,
        "cd sub && loop-gate-lock heavy",
        "cd sub && cd .. && loop-gate-lock heavy",
        "loop-gate-lock heavy | tail -40",
        "loop-gate-lock heavy 2>&1 | tail -n 40",
        "timeout 3600 loop-gate-lock heavy",
        "timeout -k 30 --signal=TERM 90m loop-gate-lock heavy",
        "export CI=1 && loop-gate-lock heavy",
        `cd '${repo}' && export CI=1 && GATERUN_K8S_IDENTITY=L01 timeout 5400 bin/loop-gate-lock heavy 2>&1 | tail -40`,
      ]) {
        const verdict = evaluateBashCommand(command, role, 0, context);
        assert.equal(verdict.block, false, `${command}: ${verdict.reason}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test(`${role}: shell forms around the gate never cover a push, merge, deploy, credential read, outside write or other command`, () => {
    const { base, repo, outside } = fixture();
    try {
      const context = { gates: loadGateDeclarations(repo), cwd: repo, inWorktree: worktreeContains(repo) };
      const refused: Record<string, string[]> = {
        push: ["loop-gate-lock heavy && git push origin HEAD", "git push origin HEAD && loop-gate-lock heavy",
          "cd sub && git push && loop-gate-lock heavy"],
        merge: ["loop-gate-lock heavy && gh pr merge 1 --squash", "gh pr merge 1 --auto && loop-gate-lock heavy"],
        deploy: ["loop-gate-lock heavy && wrangler deploy", "npm run deploy && loop-gate-lock heavy",
          "loop-gate-lock heavy 2>&1 | tail -5 && kubectl apply -f deploy.yaml"],
        credentials: ["cat ~/.aws/credentials && loop-gate-lock heavy", "loop-gate-lock heavy | cat - ~/.ssh/id_ed25519",
          "cd ~/.ssh && loop-gate-lock heavy", "AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws/credentials loop-gate-lock heavy"],
        // tee is not accepted anywhere, inside the worktree or out: the gate's output comes back through the tool.
        write: ["loop-gate-lock heavy | tee gate.log", "loop-gate-lock heavy 2>&1 | tee -a gate.log | tail -n 20",
          `loop-gate-lock heavy | tee '${join(outside, "gate.log")}'`, "loop-gate-lock heavy | tee ../gate.log",
          "loop-gate-lock heavy 2>&1 | tee .git/hooks/pre-commit", `loop-gate-lock heavy > '${join(outside, "gate.log")}'`,
          "loop-gate-lock heavy > gate.log", `cd '${outside}' && loop-gate-lock heavy`, "cd nested && loop-gate-lock heavy",
          "cd .. && loop-gate-lock heavy", "cd - && loop-gate-lock heavy", "loop-gate-lock heavy | tee /tmp/*.log"],
        chainedAfter: ["loop-gate-lock heavy && rm -rf build", "loop-gate-lock heavy; curl https://example.invalid",
          "loop-gate-lock heavy || true", "loop-gate-lock heavy | sh", "loop-gate-lock heavy | tail -5 | xargs rm",
          "loop-gate-lock heavy && loop-gate-lock heavy", "loop-gate-lock heavy & wait"],
        contextChange: ["GIT_DIR=/unused loop-gate-lock heavy", "env GIT_WORK_TREE=/ loop-gate-lock heavy", "PATH=/tmp loop-gate-lock heavy",
          "BASH_ENV=startup.sh loop-gate-lock heavy", "export LD_PRELOAD=x.so && loop-gate-lock heavy", "env -i loop-gate-lock heavy",
          "env -C / loop-gate-lock heavy", "sudo loop-gate-lock heavy", "nice loop-gate-lock heavy", "( loop-gate-lock heavy )",
          "{ loop-gate-lock heavy; }", "! loop-gate-lock heavy", "loop-gate-lock heavy < input.txt", "timeout 1h bash -c 'loop-gate-lock heavy'",
          "loop-gate-lock heavy --cwd / --sha256 0", "loop-gate-lock other"],
      };
      for (const [kind, commands] of Object.entries(refused)) {
        for (const command of commands) {
          assert.equal(evaluateBashCommand(command, role, 0, context).block, true, `${kind}: ${command}`);
        }
      }
      // Without the file system check the guard cannot place a cd target, so it refuses it; tee is never accepted.
      const noPathCheck = { gates: context.gates, cwd: repo };
      assert.equal(evaluateBashCommand("cd sub && loop-gate-lock heavy", role, 0, noPathCheck).block, true);
      assert.equal(evaluateBashCommand("loop-gate-lock heavy | tee gate.log", role, 0, noPathCheck).block, true);
      assert.equal(evaluateBashCommand("CI=1 loop-gate-lock heavy | tail -5", role, 0, noPathCheck).block, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test(`${role}: tee is refused and a cd, even through a symlink, changes nothing that runs`, () => {
    const { base, repo, outside } = fixture();
    try {
      symlinkSync(outside, join(repo, "escape"));
      symlinkSync(join(repo, "sub"), join(repo, "codex", "link"));
      const context = { gates: loadGateDeclarations(repo), cwd: repo, inWorktree: worktreeContains(repo), proto: true };
      // tee through a symlinked directory: the lexical path stays inside, tee would follow the link out.
      const escape = evaluateBashCommand("loop-gate-lock heavy | tee escape/../gate.log", role, 0, context);
      assert.equal(escape.block, true);
      assert.match(escape.reason!, /output is returned.*tee is not accepted/);
      for (const command of [
        "cd codex/link && cd .. && loop-gate-lock heavy | tee charter-test.md",
        "cd .git/hooks && loop-gate-lock heavy",
        "cd .git && loop-gate-lock heavy",
        "cd escape && loop-gate-lock heavy",
      ]) {
        assert.equal(evaluateBashCommand(command, role, 0, context).block, true, command);
      }
      // A cd through a symlink that stays in the checkout is accepted, and the bound command carries no cd:
      // it is exactly the command bound without the cd steps.
      const hopped = "cd codex/link && cd .. && loop-gate-lock heavy 2>&1 | tail -5";
      assert.equal(evaluateBashCommand(hopped, role, 0, context).block, false);
      const bound = bindGateExecution(hopped, context.gates);
      assert.equal(bound, bindGateExecution("loop-gate-lock heavy 2>&1 | tail -5", context.gates));
      assert.doesNotMatch(bound, /\bcd\b/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test(`${role}: one parser decides both gate detection and binding, whatever the prefix count`, () => {
    const { base, repo } = fixture();
    try {
      writeFileSync(join(repo, "LOOP.md"), "## Mutexes\n- gate: heavy | printf ok\n- gate: unsafe | git push --force origin HEAD\n");
      const context = { gates: loadGateDeclarations(repo), cwd: repo, inWorktree: worktreeContains(repo) };
      const prefixes = "A=1 ".repeat(17);
      for (const command of [`${prefixes}loop-gate-lock unsafe`, `${prefixes}loop-gate-lock heavy; true`, `${prefixes}loop-gate-lock heavy | sh`]) {
        assert.equal(evaluateBashCommand(command, role, 0, context).block, true, command);
      }
      assert.deepEqual(wrappedGateCommands("CI=1 timeout 60 loop-gate-lock unsafe 2>&1 | tail -5", context.gates), ["git push --force origin HEAD"]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

for (const [role, extension] of [["root", rootExtension], ["lane", laneExtension]] as const) {
  test(`${role}: the bound command keeps the shell form and reports the gate's own exit status`, async () => {
    const { base, repo } = fixture();
    try {
      const call = handler(extension);
      const ctx = { cwd: repo, ui: { notify() {} } };
      // No `timeout` here: macOS has no timeout command; the evaluation tests above cover that prefix.
      const input = { command: `cd sub && CI=1 '${cli}' heavy 2>&1 | tail -n 5` };
      const verdict = await call({ toolName: "bash", input }, ctx);
      assert.equal(verdict?.block ?? false, false, verdict?.reason);
      // The cd is checked but not run: the gate runs in the bound cwd whatever a cd says.
      assert.ok(input.command.startsWith("env -u BASH_ENV -u ENV bash -c 'set -o pipefail; CI="), input.command);
      assert.doesNotMatch(input.command, /\bcd\b/);
      assert.match(input.command, /--cwd '\\''[^']+'\\'' --sha256 '\\''[0-9a-f]{64}'\\'' 2>&1 \| '\\''tail'\\'' /);
      // /bin/sh is what watch_process runs a command with; it need not know pipefail itself.
      const run = spawnSync("/bin/sh", ["-c", input.command], { cwd: repo, timeout: 20_000, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      // The wrapper's timing lines share the merged stream, so the gate's own output sits among them.
      assert.match(run.stdout, /(?:^|\n|\})ok(?:\{|\n|$)/);

      const failing = { command: `'${cli}' failing 2>&1 | tail -n 1` };
      assert.equal((await call({ toolName: "bash", input: failing }, ctx))?.block ?? false, false);
      for (const shell of ["/bin/sh", "bash"]) {
        const failed = spawnSync(shell, ["-c", failing.command], { cwd: repo, timeout: 20_000, encoding: "utf8" });
        assert.equal(failed.status, 3, `${shell}: a pipe to tail hid the gate's failure`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
