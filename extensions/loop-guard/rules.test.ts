// Table-driven tests for the pure rule engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  C3_AGENTS,
  evaluateBashCommand,
  evaluateBgWait,
  evaluateSubagentCall,
  evaluateWatchProcess,
  hasUnextractedSubstitution,
  isAsyncSubagentLaunch,
  parseCommand,
  type Role,
} from "./rules.ts";

// ---------------------------------------------------------------------------
// Every-role rules (C4 item 2): apply identically to "root" and "lane".
// ---------------------------------------------------------------------------

const EVERY_ROLE_DENY: { name: string; command: string; roles: Role[] }[] = [
  { name: "force push -f", command: "git push -f origin main", roles: ["root", "lane"] },
  { name: "force push --force", command: "git push --force origin main", roles: ["root", "lane"] },
  { name: "force push --force-with-lease", command: "git push --force-with-lease origin main", roles: ["root", "lane"] },
  { name: "force push +refspec", command: "git push origin +feature:main", roles: ["root", "lane"] },
  { name: "force push :refspec delete", command: "git push origin :feature", roles: ["root", "lane"] },
  { name: "force push --mirror", command: "git push --mirror origin", roles: ["root", "lane"] },
  { name: "force push --delete", command: "git push --delete origin feature", roles: ["root", "lane"] },
  { name: "force push -d short delete", command: "git push -d origin feature", roles: ["root", "lane"] },
  { name: "git add -A", command: "git add -A", roles: ["root", "lane"] },
  { name: "git add .", command: "git add .", roles: ["root", "lane"] },
  { name: "git add --all", command: "git add --all", roles: ["root", "lane"] },
  { name: "git commit -a", command: "git commit -a -m msg", roles: ["root", "lane"] },
  { name: "git commit --all", command: "git commit --all -m msg", roles: ["root", "lane"] },
  { name: "git commit -am combined", command: 'git commit -am "msg"', roles: ["root", "lane"] },
  { name: "nohup detaches", command: "nohup ./long-runner.sh", roles: ["root", "lane"] },
  { name: "disown detaches", command: "some-job; disown", roles: ["root", "lane"] },
  { name: "setsid detaches", command: "setsid ./long-runner.sh", roles: ["root", "lane"] },
  { name: "bare background &", command: "sleep 300 &", roles: ["root", "lane"] },
  { name: "background & mid-chain", command: "echo start & echo done", roles: ["root", "lane"] },
  {
    name: "force push hidden in bash -c (root sees the nested violation too)",
    command: "bash -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push hidden in command substitution",
    command: "echo $(git push --force origin main)",
    roles: ["root", "lane"],
  },
  {
    name: "force push hidden in backticks",
    command: "echo `git push --force origin main`",
    roles: ["root", "lane"],
  },
  {
    name: "force push hidden in a DOUBLE-quoted command substitution (double quotes do not suppress expansion)",
    command: 'echo "$(git push --force origin main)"',
    roles: ["root", "lane"],
  },
  {
    name: "background detach hidden in a DOUBLE-quoted backtick substitution",
    command: 'echo "`nohup x &`"',
    roles: ["root", "lane"],
  },
  {
    name: "force push behind env/timeout/nice wrappers",
    command: "env FOO=1 nice -n 10 timeout 30 git push --force origin main",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind git -c global option",
    command: "git -c user.name=x push --force origin main",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind a `time` wrapper",
    command: "time git push --force",
    roles: ["root", "lane"],
  },
  {
    name: "nohup behind an `exec` wrapper",
    command: "exec nohup x",
    roles: ["root", "lane"],
  },
  {
    // A refspec's own `+`/`:` syntax keeps forcing regardless of `--`
    // (verified live: `git push origin -- +feature:feature` still prints
    // "forced update"), unlike the plain `-f`/`--force` OPTION tokens, which
    // do lose their meaning after `--`. Pins the correct half of the `--`
    // fix below, so a later change does not swing the other way and start
    // ignoring `+refspec` after `--` too.
    name: "force push via +refspec syntax survives `--` (unlike the -f/-d option forms)",
    command: "git push origin -- +feature:feature",
    roles: ["root", "lane"],
  },
  // Combined short-flag clusters (item 1): a cluster containing `f` is a
  // force push exactly like a standalone `-f`.
  { name: "force push combined short flags -uf", command: "git push -uf origin main", roles: ["root", "lane"] },
  { name: "force push combined short flags -fu", command: "git push -fu origin main", roles: ["root", "lane"] },
  { name: "git add combined short flags -Av", command: "git add -Av", roles: ["root", "lane"] },
  { name: "git add combined short flags -vA", command: "git add -vA", roles: ["root", "lane"] },
  // Shell options before `-c` (item 2): unwrapped so the nested command is
  // evaluated for every role, not just skipped past.
  {
    name: "force push behind `bash -euo pipefail -c`",
    command: "bash -euo pipefail -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind `sh -e -c`",
    command: "sh -e -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind `bash -o pipefail -c`",
    command: "bash -o pipefail -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  // CodeRabbit finding (rules.ts:501-509): `+o`/`+O` (bash's option-DISABLE
  // form, e.g. `set +o pipefail`) and the uppercase `-O`/`+O` (shopt-style)
  // forms must be unwrapped exactly like `-o`, not treated as a positional
  // argument that stops the scan too early.
  {
    name: "force push behind `bash +o pipefail -c`",
    command: "bash +o pipefail -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind `bash +o history -c`",
    command: "bash +o history -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind `bash -O extglob -c` (uppercase shopt-style)",
    command: "bash -O extglob -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  {
    name: "force push behind `bash +O extglob -c` (uppercase shopt-style, disable form)",
    command: "bash +O extglob -c 'git push --force origin main'",
    roles: ["root", "lane"],
  },
  // git -c alias.<name>=<cmd> resolution (item 4).
  {
    name: "force push behind a git alias (git -c alias.up='push -f' up origin main)",
    command: 'git -c "alias.up=push -f" up origin main',
    roles: ["root", "lane"],
  },
  {
    name: "force push behind a `!`-shell git alias",
    command: 'git -c "alias.wtf=!git push --force origin main" wtf',
    roles: ["root", "lane"],
  },
  // CodeRabbit finding: git's own config-key lookup is case-insensitive for
  // alias names (verified live: `git -c alias.wtf=status WTF` runs
  // `status`, and `git -c alias.WTF=status wtf` also runs `status`), so a
  // mismatched-case alias name between the `-c` definition and the
  // invocation token must still resolve, not silently fall through
  // unexpanded.
  {
    name: "force push behind a `!`-shell git alias, defined lowercase and invoked uppercase",
    command: 'git -c "alias.wtf=!git push --force origin main" WTF',
    roles: ["root", "lane"],
  },
  {
    name: "force push behind a `!`-shell git alias, defined uppercase and invoked lowercase",
    command: 'git -c "alias.WTF=!git push --force origin main" wtf',
    roles: ["root", "lane"],
  },
  // git ignores an alias whose name shadows a real built-in subcommand (real
  // git behaviour: `git -c alias.push=status push ...` still runs the real
  // `push`, never `status`), so the guard must evaluate BOTH the unexpanded
  // command (which sees the literal "push" token and catches the real force
  // push) and the alias-expanded command, blocking if either is blocked -
  // never rely on a hardcoded built-in-name list (main-thread course
  // correction, 2026-09-27).
  {
    name: "force push survives an alias that shadows the real `push` built-in",
    command: 'git -c "alias.push=status" push --force origin main',
    roles: ["root", "lane"],
  },
];

const EVERY_ROLE_ALLOW: { name: string; command: string }[] = [
  { name: "plain non-force push", command: "git push origin main" },
  { name: "git add explicit pathspec", command: "git add foo.ts bar.ts" },
  { name: "git commit with explicit pathspec", command: "git commit -m msg -- foo.ts" },
  { name: "redirect both streams is not backgrounding", command: "some-cmd &> out.log" },
  { name: "stderr-to-stdout redirect is not backgrounding", command: "some-cmd 2>&1 | tee out.log" },
  { name: "&& is not backgrounding", command: "echo one && echo two" },
  { name: "plain read-only command", command: "ls -la" },
  {
    name: "SINGLE-quoted $(...) is real literal text, never expanded",
    command: "echo '$(git push --force origin main)'",
  },
  {
    name: "SINGLE-quoted backtick command is real literal text, never expanded",
    command: "echo '`nohup x &`'",
  },
  {
    name: "a flag's argument is not a flag: git commit -m \"-a\" -- f must not be blocked",
    command: 'git commit -m "-a" -- f',
  },
  {
    // CodeRabbit finding (rules.ts:667-671): a `!`-shell alias's own trailing
    // argument must be quoted before joining into the nested shellCommand,
    // so an argument that happens to contain shell metacharacters (here a
    // literal `;`) stays one inert string argument to `echo` rather than
    // being re-split into a second, separately-evaluated command.
    name: "a `!`-shell git alias's trailing argument is quoted, not re-split on embedded shell metacharacters",
    command: 'git -c "alias.wtf=!echo hi" wtf "a;git push --force origin main"',
  },
  {
    name: "plain non-force push with an unrelated combined short flag cluster",
    command: "git push -qu origin main",
  },
  {
    // CodeRabbit finding: after `--`, git push treats every remaining token
    // as a refspec, never as an option (verified live: `git push origin --
    // -f` fails with "src refspec -f does not match any", never force-pushes).
    name: "git push -- <refspec> : a refspec literally named -f after -- is not the force flag",
    command: "git push origin -- -f",
  },
];

for (const c of EVERY_ROLE_DENY) {
  for (const role of c.roles) {
    test(`every-role deny: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, true, `expected block for: ${c.command}`);
      assert.ok(decision.reason, "blocked decision must carry a reason");
    });
  }
}

for (const c of EVERY_ROLE_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`every-role allow: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Lane-only rules (C4 item 3)
// ---------------------------------------------------------------------------

// Design decision: lanes may deploy, change clusters and cloud resources, and ssh.
const LANE_ALLOWED_DEPLOYS: string[] = [
  "wrangler deploy",
  "kubectl apply -f manifest.yaml",
  "kubectl delete pod foo",
  "terraform apply -auto-approve",
  "helm upgrade foo ./chart",
  "ssh host.example.com uptime",
  "timeout 15s ssh host1 'cd /srv/app && docker compose up -d'",
];
for (const command of LANE_ALLOWED_DEPLOYS) {
  test(`lane allowed: ${command}`, () => {
    assert.equal(evaluateBashCommand(command, "lane").block, false, command);
  });
}

const LANE_ONLY_DENY: { name: string; command: string }[] = [
  { name: "gh release create", command: "gh release create v1.0.0" },
  { name: "gh api mutating -X POST", command: "gh api -X POST /repos/x/y/issues" },
  { name: "gh api mutating -f field", command: "gh api /repos/x/y/issues -f title=hi" },
  { name: "gh secret set", command: "gh secret set FOO --body bar" },
  { name: "vault write", command: "vault write secret/foo bar=baz" },
  { name: "vault kv put", command: "vault kv put secret/foo bar=baz" },
  { name: "bao kv put", command: "bao kv put secret/foo bar=baz" },
  { name: "op item create", command: "op item create --category login" },
  { name: "aws secretsmanager put-secret-value", command: "aws secretsmanager put-secret-value --secret-id x" },
  { name: "gh release edit", command: "gh release edit v1.0.0 --draft=false" },
  { name: "gh release delete", command: "gh release delete v1.0.0 --yes" },
  { name: "gh workflow run", command: "gh workflow run deploy.yml --ref main" },
  { name: "gh -R before release delete", command: "gh -R a/b release delete v1" },
  { name: "gh --repo before release delete", command: "gh --repo a/b release delete v1" },
  { name: "gh --repo= before release edit", command: "gh --repo=a/b release edit v1 --draft=false" },
  { name: "gh -Rvalue before release create", command: "gh -Ra/b release create v1" },
  { name: "gh -R inside workflow run", command: "gh workflow -R a/b run x.yml" },
  { name: "gh --repo= inside workflow run", command: "gh workflow --repo=a/b run x.yml" },
  { name: "gh --repo before secret set", command: "gh --repo a/b secret set FOO --body bar" },
  { name: "gh api --method=POST", command: "gh api --method=POST /repos/x/y/dispatches" },
  { name: "gh api -XPUT", command: "gh api -XPUT /repos/x/y/contents/a" },
  { name: "gh api --input", command: "gh api /repos/x/y/releases --input body.json" },
  { name: "gh api -ftitle=hi", command: "gh api /repos/x/y/issues -ftitle=hi" },
  { name: "aws secretsmanager behind a global option", command: "aws --region eu-west-2 secretsmanager create-secret --name x" },
  { name: "vault token create", command: "vault token create -policy=ci" },
  { name: "aws iam create-access-key", command: "aws iam create-access-key --user-name ci" },
  { name: "gcloud service account key", command: "gcloud iam service-accounts keys create k.json --iam-account a@b" },
  { name: "gh ssh-key add", command: "gh ssh-key add key.pub" },
  { name: "az ad sp credential reset", command: "az ad sp credential reset --id x" },
  { name: "write into codex/ops-*", command: "echo '{}' > codex/ops-c-loop1.json" },
  { name: "append into codex/state-*", command: "echo x 2>/dev/null >> repo/codex/state-c-loop1.jsonl" },
  { name: "tee into codex/goal-*", command: "tee codex/goal-c-loop1.md < /dev/null" },
];

for (const c of LANE_ONLY_DENY) {
  test(`lane-only deny: ${c.name} [lane]`, () => {
    const decision = evaluateBashCommand(c.command, "lane");
    assert.equal(decision.block, true, `expected lane block for: ${c.command}`);
  });
  test(`lane-only deny does not apply to root: ${c.name} [root]`, () => {
    const decision = evaluateBashCommand(c.command, "root");
    assert.equal(decision.block, false, `expected root allow for: ${c.command}`);
  });
}

// Inline interpreters are no longer blocked as such: a shell's script text is evaluated by the same rules, and a
// non-shell interpreter's code gets the fallback text scan.
const INLINE_INTERPRETER_ALLOW: { name: string; command: string }[] = [
  { name: "eval builtin with a harmless script", command: 'eval "echo hi"' },
  { name: "python -c", command: "python -c 'import os; print(os.getcwd())'" },
  { name: "python3 -e", command: "python3 -e 'print(1)'" },
  { name: "python3 -c print", command: 'python3 -c "print(1)"' },
  { name: "bash -c harmless", command: "bash -c 'echo hi'" },
  { name: "sh -c harmless", command: "sh -c 'echo hi'" },
  { name: "sh -e -c harmless", command: "sh -e -c 'echo hi'" },
  { name: "zsh -c harmless", command: "zsh -c 'ls -la'" },
  { name: "node -e", command: "node -e 'console.log(1)'" },
  { name: "node --eval", command: "node --eval 'console.log(1)'" },
  { name: "node -p", command: "node -p '1+1'" },
  { name: "python3.12 -c", command: "python3.12 -c 'print(1)'" },
  { name: "python2.7 -c", command: "python2.7 -c 'print(1)'" },
  { name: "python3 -Ic", command: "python3 -Ic 'print(1)'" },
  { name: "python3 -Sc", command: "python3 -Sc 'print(1)'" },
  { name: "perl -pi -e", command: "perl -pi -e 's/a/b/' f" },
  { name: "perl -0pi -e with parens", command: 'perl -0pi -e "s/COALESCE\\(a,b\\)/x/" f.sql' },
  { name: "ruby -e", command: "ruby -e 'puts 1'" },
  { name: "python code with a bitwise &", command: "python3 -c 'print(6 & 3)'" },
  { name: "python3 - heredoc", command: "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.'))\nPY" },
  { name: "node - heredoc", command: "node - <<'JS'\nconsole.log(1)\nJS" },
  { name: "here-string to python3", command: "python3 <<<'print(1)'" },
  { name: "cat heredoc piped into python3", command: "cat <<'PY' | python3\nprint(1)\nPY" },
  { name: "bash heredoc running python -c", command: "bash <<'EOF'\npython3 -c 'print(1)'\nEOF" },
];

for (const c of INLINE_INTERPRETER_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`inline interpreter allow: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command} (got ${decision.reason})`);
      assert.equal(decision.warning, undefined);
    });
  }
}

// Dangerous commands inside interpreter code or a shell script string still block.
const INLINE_EVERY_ROLE_DENY: { name: string; command: string }[] = [
  {
    name: "python3 -c subprocess force push (fallback scan of the code)",
    command: "python3 -c \"import subprocess; subprocess.run(['git','push','--force'])\"",
  },
  { name: "python os.system with nohup", command: "python3 -c 'import os; os.system(\"nohup ./x.sh\")'" },
  { name: "node -e execSync force push", command: "node -e 'require(\"child_process\").execSync(\"git push -f origin main\")'" },
  { name: "perl -e system git add -A", command: "perl -e 'system(\"git add -A\")'" },
  { name: "python3 - heredoc with a force push", command: "python3 - <<'PY'\nimport os\nos.system('git push --force')\nPY" },
  { name: "eval with a force push", command: 'eval "git push --force origin main"' },
  { name: "zsh -c with a force push", command: "zsh -c 'git push -f'" },
  { name: "python code backgrounding via a shell string", command: "python3 -c 'import os; os.system(\"sleep 9 &\")'" },
];

for (const c of INLINE_EVERY_ROLE_DENY) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`inline interpreter every-role deny: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, true, `expected block for: ${c.command}`);
      assert.ok(decision.reason);
    });
  }
}

const INLINE_LANE_ONLY_DENY: { name: string; command: string }[] = [
  { name: "python subprocess gh secret set", command: "python3 -c \"import subprocess; subprocess.run(['gh','secret','set','X'])\"" },
  { name: "node execSync gh release create", command: "node -e 'require(\"child_process\").execSync(\"gh release create v1\")'" },
  { name: "bash -c gh secret set", command: "bash -c 'gh secret set X --body y'" },
];

for (const c of INLINE_LANE_ONLY_DENY) {
  test(`inline interpreter lane-only deny: ${c.name} [lane]`, () => {
    assert.equal(evaluateBashCommand(c.command, "lane").block, true, c.command);
  });
  test(`inline interpreter lane-only deny does not apply to root: ${c.name} [root]`, () => {
    const decision = evaluateBashCommand(c.command, "root");
    assert.equal(decision.block, false, c.command);
    assert.equal(decision.warning, undefined);
  });
}

test("gh api without a mutating flag is allowed for lanes (read-only GET)", () => {
  const decision = evaluateBashCommand("gh api /repos/x/y/issues", "lane");
  assert.equal(decision.block, false);
});

test("read-only gh release, gh workflow and loop control reads are allowed for lanes", () => {
  for (const command of [
    "gh release view v1.0.0",
    "gh workflow list",
    "gh workflow view deploy.yml",
    "gh -R a/b release view v1",
    "gh workflow --repo a/b list",
    "gh api -X GET /repos/x/y",
    "cat codex/ops-c-loop1.json",
    "echo x > codex/report-c-loop1.md",
    "some-cmd > out.log 2>&1",
  ]) {
    assert.equal(evaluateBashCommand(command, "lane").block, false, command);
  }
});

test("gh release list (not create) is allowed for lanes", () => {
  const decision = evaluateBashCommand("gh release list", "lane");
  assert.equal(decision.block, false);
});

// ---------------------------------------------------------------------------
// Unparseable input: no fail-closed, no warning.
// A conservative text scan of the raw command blocks only when a dangerous
// pattern literally appears for that role; anything else is allowed silently.
// ---------------------------------------------------------------------------

const UNPARSEABLE_ALLOW: { name: string; command: string }[] = [
  { name: "unterminated quote, harmless", command: "echo 'unterminated" },
  { name: "unterminated heredoc, harmless", command: "cat <<EOF\nhello" },
  { name: "unterminated quote mentioning ssh as data", command: "grep ssh ~/.ssh/config 'x" },
  { name: "unterminated quote with a plain push", command: "git push origin main 'x" },
  { name: "unterminated quote with R&D in prose", command: "echo 'R&D notes and more" },
];

for (const c of UNPARSEABLE_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`unparseable allow (fallback scan clean): ${c.name} [${role}]`, () => {
      assert.equal(parseCommand(c.command, role), null, "fixture must really be unparseable");
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command} (got ${decision.reason})`);
      assert.equal(decision.warning, undefined, "no warning on unparseable input");
    });
  }
}

const UNPARSEABLE_EVERY_ROLE_DENY: { name: string; command: string }[] = [
  { name: "unterminated quote with nohup", command: "nohup ./long-runner.sh 'unterminated" },
  { name: "unterminated quote with setsid", command: "setsid ./x 'y" },
  { name: "unterminated quote with disown", command: "sleep 1; disown 'y" },
  { name: "unterminated quote with a trailing &", command: "echo 'x\nsleep 300 &" },
  { name: "unterminated quote with git push --force", command: "git push --force origin main 'x" },
  { name: "unterminated quote with git push -uf", command: "git push -uf origin 'x" },
  { name: "unterminated quote with +refspec", command: "git push origin +main:main 'x" },
  { name: "unterminated quote with :ref delete", command: "git push origin :feature 'x" },
  { name: "unterminated quote with --force-with-lease=", command: "git push --force-with-lease=main origin 'x" },
  { name: "unterminated quote with git add -A", command: "git add -A 'x" },
  { name: "unterminated quote with git commit -am", command: "git commit -am msg 'x" },
  { name: "unterminated heredoc hiding a force push", command: "cat <<EOF\ngit push --force" },
];

for (const c of UNPARSEABLE_EVERY_ROLE_DENY) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`unparseable every-role deny (fallback scan): ${c.name} [${role}]`, () => {
      assert.equal(parseCommand(c.command, role), null, "fixture must really be unparseable");
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, true, `expected block for: ${c.command}`);
      assert.ok(decision.reason);
    });
  }
}

const UNPARSEABLE_LANE_ONLY_DENY: { name: string; command: string }[] = [
  { name: "unterminated quote with timeout-wrapped secret write", command: "timeout 5 gh secret set X 'y" },
  { name: "unterminated quote with gh release create", command: "gh release create v1 'notes" },
  { name: "unterminated quote with mutating gh api", command: "gh api -X POST /repos/x/y 'z" },
  { name: "unterminated quote with a secret write", command: "gh secret set FOO --body 'bar" },
];

for (const c of UNPARSEABLE_LANE_ONLY_DENY) {
  test(`unparseable lane-only deny (fallback scan): ${c.name} [lane]`, () => {
    assert.equal(parseCommand(c.command, "lane"), null, "fixture must really be unparseable");
    assert.equal(evaluateBashCommand(c.command, "lane").block, true, c.command);
  });
  test(`unparseable lane-only deny does not apply to root: ${c.name} [root]`, () => {
    const decision = evaluateBashCommand(c.command, "root");
    assert.equal(decision.block, false, c.command);
    assert.equal(decision.warning, undefined);
  });
}

// ---------------------------------------------------------------------------
// Heredocs and here-strings. A heredoc body is
// data; its treatment depends on the command that receives it: inert for
// writers, a script for a shell (evaluated by the same rules for the same
// role), an inline script for an interpreter reading stdin (lane rule). An
// unquoted-delimiter body is expanded by the OUTER shell, so its `$(...)` and
// backticks run whatever the receiver is.
// ---------------------------------------------------------------------------

// Minimised from real lane commands the first live loop wrongly blocked as
// unparseable (guard-blocks.jsonl rows noted).
const HEREDOC_ALLOW: { name: string; command: string }[] = [
  { name: "row 4: cat > file with a quoted heredoc", command: "cat > codex/loop18-live/proof/x.mjs <<'EOF'\nconsole.log('hi')\nEOF" },
  {
    name: "row 2: cat > file, JS body with quotes, template literal and backticks, then chmod",
    command:
      "cat > p/inbox.mjs <<'EOF'\nimport playwright from '../web/index.js'\nconst o = new URL(`https://${h}`).origin\nif (!o) throw new Error('HTTPS console required')\nEOF\nchmod 600 p/inbox.mjs",
  },
  {
    name: "rows 19/28/33: mkdir -p && cat > file with a markdown body (apostrophes, $(), fences)",
    command:
      "mkdir -p /a/b/loop18-returns && cat > /a/b/loop18-returns/r.md <<'EOF'\n# Readback\n\nIt's blocked; `$(git push --force)` was never run.\n```\n{\"a\": 1}\n```\nEOF\nwc -l /a/b/loop18-returns/r.md",
  },
  {
    name: "row 21: mkdir -p; umask; cat > file heredoc; chmod",
    command: "mkdir -p d/out; umask 077; cat > d/x.mjs <<'EOF'\nimport { chromium } from 'p'\nEOF\nchmod 600 d/x.mjs",
  },
  { name: "row 26: tee >/dev/null with a quoted heredoc", command: "tee /a/source-map.md >/dev/null <<'EOF'\n# map\n- it's fine\nEOF" },
  { name: "row 24: apply_patch with a quoted heredoc", command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: a.mjs\n-import x from 'y'\n+import x from 'z'\n*** End Patch\nPATCH" },
  {
    name: "row 0: jq reading a here-string, curl in a $(...) with a $(<file) inside",
    command: "set -euo pipefail; response=$(curl -fsS -u \"u:$(<\"$token_file\")\" 'https://x/q'); jq -c '{v:[.data.result[]?.metric]}' <<<\"$response\"",
  },
  { name: "writer: quoted-body shell text is inert", command: "cat <<'EOF'\ngit push --force origin main\nnohup x &\nEOF" },
  { name: "writer: quoted-body $() and backticks are inert", command: "cat > f <<'EOF'\n$(git push --force) and `nohup x &`\nEOF" },
  { name: "writer: an escaped \\$( in an unquoted body is literal", command: "cat <<EOF\n\\$(git push --force)\nEOF" },
  { name: "writer: double-quoted delimiter body is inert", command: 'cat <<"EOF"\ngit push -f\nEOF' },
  { name: "writer: a delimiter-looking text mid-line does not end the body", command: "cat <<'EOF'\nsay EOF now\nEOF" },
  { name: "writer: two heredocs on one line", command: "cat <<'A' - <<'B'\nx\nA\ny\nB\necho done" },
  { name: "writer: <<- strips leading tabs from the delimiter line", command: "cat <<-'EOF'\n\tbody\n\tEOF\necho ok" },
  { name: "shell: a benign body evaluates clean (bash without -c is not an inline interpreter)", command: "bash <<'EOF'\ngit status --short\nEOF" },
  { name: "python3 -m module reading heredoc data", command: "python3 -m json.tool <<'EOF'\n{}\nEOF" },
  { name: "python3 script file reading heredoc data", command: "python3 tools/check.py <<'EOF'\ndata\nEOF" },
  { name: "a well-formed quoted regex with \\( is fine", command: "rg -n 'mutate\\(|method:\\s*POST|\\.post\\(' web/src -g '*.tsx' | head -130" },
  { name: "a trailing comment containing an apostrophe", command: "ls -la # it's a comment" },
];

for (const c of HEREDOC_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`heredoc allow: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command} (got ${decision.reason})`);
      assert.equal(decision.warning, undefined, `expected a clean parse for: ${c.command}`);
    });
  }
}

// A heredoc or here-string feeding a shell is a script: evaluated line by line
// for the same role, so every-role rules still bite.
const HEREDOC_EVERY_ROLE_DENY: { name: string; command: string }[] = [
  { name: "bash heredoc with a force push", command: "bash <<'EOF'\ngit push --force origin main\nEOF" },
  { name: "sh -s heredoc with git commit -a", command: "sh -s <<EOF\ngit commit -a -m x\nEOF" },
  { name: "bash heredoc with nohup", command: "bash <<'EOF'\nnohup ./long-runner.sh\nEOF" },
  { name: "zsh heredoc with a background &", command: "zsh <<'EOF'\nsleep 300 &\nEOF" },
  { name: "cat heredoc piped into sh", command: "cat <<'EOF' | sh\ngit push -f origin main\nEOF" },
  { name: "cat heredoc piped through a filter into bash", command: "cat <<'EOF' | tr a a | bash\ngit push -f origin main\nEOF" },
  { name: "delimiter text mid-line and indented does not end a shell body", command: "bash <<'EOF'\necho EOF\n  EOF\ngit push --force\nEOF" },
  { name: "command after the heredoc operator on the same line", command: "cat <<EOF; git push --force\nbody\nEOF" },
  { name: "command after two heredoc bodies", command: "cat <<'A' <<'B'\nx\nA\ny\nB\ngit push --force" },
  { name: "unquoted body $() runs in the outer shell even for cat", command: "cat > f <<EOF\n$(git push --force)\nEOF" },
  { name: "unquoted body backticks run in the outer shell", command: "cat <<EOF\n`git push --force`\nEOF" },
  { name: "single quotes are literal in an unquoted body, $() still runs", command: "cat <<EOF\nit's '$(git push --force)'\nEOF" },
  { name: "escaped \\$() reaches the inner shell unescaped", command: "bash <<EOF\n\\$(git push --force)\nEOF" },
  { name: "heredoc to a shell inside $(...)", command: "echo $(bash <<'EOF'\ngit push -f\nEOF\n)" },
  { name: "nested heredoc inside a shell heredoc", command: "bash <<'OUTER'\ncat <<'INNER' | sh\ngit push -f\nINNER\nOUTER" },
  { name: "<<- tab-stripped shell body", command: "bash <<-EOF\n\tgit push --force\n\tEOF" },
  { name: "here-string to bash", command: "bash <<<'git push --force origin main'" },
  { name: "here-string to sh with commit -a", command: 'sh <<<"git commit -a -m x"' },
  { name: "source /dev/stdin heredoc", command: "source /dev/stdin <<'EOF'\ngit push -f\nEOF" },
  { name: "sudo -s heredoc (wrapper with no command runs a shell)", command: "sudo -s <<'EOF'\ngit push -f\nEOF" },
  { name: "env-wrapped bash heredoc", command: "env FOO=1 bash <<'EOF'\ngit add -A\nEOF" },
  // The pre-pass must never mistake quoted text for a heredoc operator and
  // swallow the real commands on the following lines as a "body".
  { name: "a double-quoted << is text, the next line still runs", command: 'echo "a <<EOF"\ngit push --force\nEOF' },
  { name: "a single-quoted << is text, the next line still runs", command: "echo 'x <<EOF'\ngit push -f\nEOF" },
  { name: "a commented << is text, the next line still runs", command: "echo hi # cat <<EOF\ngit push --force\nEOF" },
  { name: "# right after $(...) is not a comment", command: "echo $(true)# ; git push --force" },
  { name: "# right after an escaped blank is not a comment", command: "echo a\\ # ; git push --force" },
  { name: "heredoc to a shell inside backticks", command: "echo `bash <<'EOF'\ngit push -f\nEOF\n`" },
  { name: "a spoofed placeholder word does not hide the real heredoc", command: "echo __loop_guard_heredoc_0__ | bash <<'EOF'\ngit push -f\nEOF" },
];

for (const c of HEREDOC_EVERY_ROLE_DENY) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`heredoc every-role deny: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, true, `expected block for: ${c.command}`);
      assert.doesNotMatch(decision.reason ?? "", /fallback scan/, "must block by the precise rules, not the fallback scan");
    });
  }
}

// Lane rules apply inside a shell heredoc body too.
test("heredoc lane-only deny: bash heredoc with gh secret set [lane]", () => {
  const decision = evaluateBashCommand("bash <<'EOF'\ngh secret set X --body y\nEOF", "lane");
  assert.equal(decision.block, true);
  assert.doesNotMatch(decision.reason ?? "", /fallback scan/, "must block by the precise rules");
});
test("heredoc lane-only deny does not apply to root: bash heredoc with gh secret set [root]", () => {
  const decision = evaluateBashCommand("bash <<'EOF'\ngh secret set X --body y\nEOF", "root");
  assert.equal(decision.block, false);
  assert.equal(decision.warning, undefined);
});

// An interpreter reading its script from stdin is no longer blocked as such
//; its script gets the fallback text scan.
const HEREDOC_INTERPRETER_ALLOW: { name: string; command: string }[] = [
  { name: "row 1/5/25: python3 - heredoc", command: "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.'))\nPY" },
  {
    name: "row 10: node --input-type=module - heredoc",
    command: "set -a; source host.env; set +a; node --input-type=module - <<'NODE'\nconsole.log(1)\nNODE",
  },
  { name: "row 11/14: mkdir -p && python3 - heredoc", command: "mkdir -p /a/b && python3 - <<'PY'\nprint(1)\nPY" },
  { name: "python3 with no script", command: "python3 <<'PY'\nprint(1)\nPY" },
  { name: "python -W value flag", command: "python3 -W ignore <<'PY'\nprint(1)\nPY" },
  { name: "ruby - heredoc", command: "ruby - <<'RB'\nputs 1\nRB" },
  { name: "perl - heredoc", command: "perl - <<'PL'\nprint 1\nPL" },
  { name: "deno run - heredoc", command: "deno run - <<'TS'\nconsole.log(1)\nTS" },
  { name: "bun - heredoc", command: "bun - <<'TS'\nconsole.log(1)\nTS" },
  { name: "node with no script", command: "node <<'JS'\nconsole.log(1)\nJS" },
  { name: "node - reading a piped file", command: "cat x.js | node -" },
];

for (const c of HEREDOC_INTERPRETER_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`heredoc interpreter allow: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command} (got ${decision.reason})`);
      assert.equal(decision.warning, undefined);
    });
  }
}

test("heredoc interpreter lane-only deny: python3 - heredoc running gh secret set [lane]", () => {
  const command = "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['gh', 'secret', 'set', 'X'])\nPY";
  assert.equal(evaluateBashCommand(command, "lane").block, true);
  assert.equal(evaluateBashCommand(command, "root").block, false);
});

// Input the heredoc parser cannot resolve gets the fallback text scan.
const HEREDOC_UNPARSEABLE_DENY: { name: string; command: string }[] = [
  { name: "unterminated shell heredoc hiding a force push", command: "bash <<'EOF'\ngit push --force\n" },
  // The heredoc pre-pass reads ANSI-C `$'...'` quoting correctly, but the
  // lexer does not know it, so the text after the escaped quote fails the
  // lex: the fallback scan still sees the force push, never a swallowed line.
  { name: "an ANSI-C quoted << followed by a force push", command: "echo $'it\\'s <<X'\ngit push --force\nX" },
];
const HEREDOC_UNPARSEABLE_ALLOW: { name: string; command: string }[] = [
  { name: "delimiter only matches with trailing text, so never terminates", command: "cat <<EOF\nbody\nEOF trailing" },
  { name: "heredoc operator with no delimiter", command: "cat <<" },
  { name: "unbalanced $( in an unquoted body", command: "cat <<EOF\n$(unbalanced\nEOF" },
  { name: "here-string with no word", command: "bash <<<" },
];

for (const c of HEREDOC_UNPARSEABLE_DENY) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`heredoc unparseable deny (fallback scan): ${c.name} [${role}]`, () => {
      assert.equal(parseCommand(c.command, role), null, "fixture must really be unparseable");
      assert.equal(evaluateBashCommand(c.command, role).block, true, c.command);
    });
  }
}
for (const c of HEREDOC_UNPARSEABLE_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`heredoc unparseable allow (fallback scan): ${c.name} [${role}]`, () => {
      assert.equal(parseCommand(c.command, role), null, "fixture must really be unparseable");
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, c.command);
      assert.equal(decision.warning, undefined);
    });
  }
}

// CodeRabbit finding (rules.ts:672-674): a git alias's own body that cannot
// itself be lexed (e.g. an unterminated quote) is never treated as an inert
// literal subcommand string; it gets the fallback text scan like any other
// unparseable input.
test("git alias body that cannot be lexed: fallback scan blocks a force push inside it", () => {
  const command = `git -c "alias.up=push -f '" up origin main`;
  assert.equal(evaluateBashCommand(command, "lane").block, true);
  assert.equal(evaluateBashCommand(command, "root").block, true);
});
test("git alias body that cannot be lexed: harmless body is allowed without a warning", () => {
  const command = `git -c "alias.up=push '" up origin main`;
  for (const role of ["root", "lane"] as Role[]) {
    const decision = evaluateBashCommand(command, role);
    assert.equal(decision.block, false, role);
    assert.equal(decision.warning, undefined, role);
  }
});

// Brace groups, subshells and process substitution are parsed (owner
// decision, 2026-09-28) so the precise rules apply to their contents.
const COMPOUND_EVERY_ROLE_DENY: { name: string; command: string }[] = [
  { name: "subshell wrapping a force push", command: "(git push --force)" },
  { name: "brace group wrapping a force push", command: "{ git push -f; }" },
  { name: "brace group with a redirect wrapping a force push", command: "{ date; git push --force origin main; } > out.log" },
  { name: "process substitution (<()) wrapping a force push", command: "cat <(git push --force)" },
  { name: "process substitution with git push -f", command: "diff -u <(git push -f origin main) <(true)" },
  { name: "process substitution (>()) form", command: "tee >(git push --force) < /dev/null" },
  { name: "nested subshell in a pipeline", command: "echo x | (cd /tmp && git add -A)" },
  { name: "force push in a do body", command: "for b in a b; do git push --force origin $b; done" },
  { name: "force push in an if/then body", command: "if true; then git push -f; fi" },
  { name: "force push after `!`", command: "! git push --force" },
  { name: "function body with a force push", command: "f() { git push --force; }; f" },
  { name: "background inside a brace group", command: "{ sleep 300 & }" },
];

for (const c of COMPOUND_EVERY_ROLE_DENY) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`compound every-role deny: ${c.name} [${role}]`, () => {
      assert.ok(parseCommand(c.command, role), "must parse, not fall back");
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, true, `expected block for: ${c.command}`);
    });
  }
}

test("compound lane-only deny: a secret write inside a subshell [lane], allowed for root", () => {
  assert.equal(evaluateBashCommand("(gh secret set X --body y)", "lane").block, true);
  assert.equal(evaluateBashCommand("(gh secret set X --body y)", "root").block, false);
});

// The two harmless commands from the owner's screenshot of root warnings
// (reconstructed from its description: a brace group redirected to a file
// under `set -euo pipefail`, and a diff of two process substitutions).
const SCREENSHOT_ALLOW: { name: string; command: string }[] = [
  {
    name: "set -euo pipefail with a brace group redirected to a file",
    command:
      "set -euo pipefail\n{ date -u +%FT%TZ; printf '%s\\n' \"loop status\"; git status --short; } > /tmp/loop-status.txt\ncat /tmp/loop-status.txt",
  },
  {
    name: "diff -u of two process substitutions || true; git log",
    command:
      "diff -u <(tail -n 40 a.log) <(awk '{print $1}' b.log) || true; git log --oneline -5",
  },
  { name: "brace group appended with >>", command: "{ echo a; echo b; } >> out.txt" },
  { name: "subshell with cd", command: "(cd /tmp && ls -la)" },
  { name: "while read loop fed by process substitution", command: "while read -r l; do echo \"$l\"; done < <(git ls-files)" },
  { name: "umask then write", command: "umask 077; printf x > f" },
  { name: "case statement", command: "case $x in a) echo a;; *) echo other;; esac" },
];

for (const c of SCREENSHOT_ALLOW) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`compound allow: ${c.name} [${role}]`, () => {
      const decision = evaluateBashCommand(c.command, role);
      assert.equal(decision.block, false, `expected allow for: ${c.command} (got ${decision.reason})`);
      assert.equal(decision.warning, undefined);
    });
  }
}

test("$(...) with a trailing space before the ')' is still parsed", () => {
  const parsed = parseCommand("echo $(git status )");
  assert.ok(parsed);
  assert.ok(parsed!.segments.some((s) => s.includes("git")));
});

// Defense in depth (course correction, main thread, 2026-09-27): after
// extraction, a raw `$(` or backtick surviving outside a single-quoted
// literal means the extractor missed something, not a proven-safe literal.
// Lanes fail closed on that; root's parseCommand(text) with no role omitted
// does not apply this check (matching its general "allow with a warning"
// posture for anything unparseable).

test("hasUnextractedSubstitution: false for ordinary text", () => {
  assert.equal(hasUnextractedSubstitution("git push origin main"), false);
});

test("hasUnextractedSubstitution: false for a single-quoted literal $(...)", () => {
  assert.equal(hasUnextractedSubstitution("echo '$(git push --force)'"), false);
});

test("hasUnextractedSubstitution: false for a single-quoted literal backtick", () => {
  assert.equal(hasUnextractedSubstitution("echo '`nohup x &`'"), false);
});

test("hasUnextractedSubstitution: true for a raw unquoted $(", () => {
  assert.equal(hasUnextractedSubstitution("echo $(git push --force)"), true);
});

test("hasUnextractedSubstitution: true for a raw backtick", () => {
  assert.equal(hasUnextractedSubstitution("echo `nohup x &`"), true);
});

// ---------------------------------------------------------------------------
// Root-only rules (C4 item 4): subagent allowlist, machine, acceptance/gate/
// workflow fields, watch_process while active, bg_wait.
// ---------------------------------------------------------------------------

test("C3_AGENTS matches SEAMS.md exactly", () => {
  assert.deepEqual(
    [...C3_AGENTS].sort(),
    [
      "complex-worker",
      "complex-worker-push",
      "super-worker",
      "super-worker-push",
      "megasuper-worker",
      "megasuper-worker-push",
      "gate-runner",
      "lane-worker",
      "lane-worker-push",
      "lane-worker-retry",
      "lane-worker-retry-push",
      "mapper",
      "mapper-deep",
      "rescue-astra",
      "rescue-sol",
      "reviewer",
      "reviewer-high",
      "security-reviewer",
      "lane-worker-low",
      "lane-worker-low-push",
      "triager",
      "ops",
      "ops-probe",
    ].sort(),
  );
});

for (const agent of C3_AGENTS) {
  test(`subagent allow: launching in-C3 agent '${agent}'`, () => {
    const decision = evaluateSubagentCall({ agent, task: "do the thing" });
    assert.equal(decision.block, false);
  });
}

test("subagent deny: agent outside C3 set", () => {
  const decision = evaluateSubagentCall({ agent: "scout", task: "recon" });
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /scout/);
});

test("subagent deny: builtin worker/oracle also outside C3", () => {
  for (const agent of ["worker", "oracle", "reviewer-general", "delegate"]) {
    const decision = evaluateSubagentCall({ agent, task: "do it" });
    assert.equal(decision.block, true, `expected block for agent '${agent}'`);
  }
});

test("subagent deny: machine field set", () => {
  const decision = evaluateSubagentCall({ agent: "lane-worker", task: "x", machine: "workmac" });
  assert.equal(decision.block, true);
});

test("subagent deny: acceptance field set", () => {
  const decision = evaluateSubagentCall({ agent: "lane-worker", task: "x", acceptance: { level: "checked" } });
  assert.equal(decision.block, true);
});

test("subagent deny: gate field set", () => {
  const decision = evaluateSubagentCall({ agent: "lane-worker", task: "x", gate: "npm test" });
  assert.equal(decision.block, true);
});

test("subagent deny: named workflow resource field set", () => {
  const decision = evaluateSubagentCall({ workflow: "run-ci", args: { command: "npm test" } });
  assert.equal(decision.block, true);
});

test("subagent allow: management action (list) is not a launch and is not agent-checked", () => {
  const decision = evaluateSubagentCall({ action: "list" });
  assert.equal(decision.block, false);
});

test("subagent allow: management get on a name outside C3 (inspection, not launch)", () => {
  // Documented known-allowed bypass: `agent` without `task` is a management
  // target, not a launch, so the C3 allowlist does not apply. See rules.ts
  // isSubagentLaunch() and the final report's bypass table.
  const decision = evaluateSubagentCall({ action: "get", agent: "scout" });
  assert.equal(decision.block, false);
});

test("subagent deny: a 0.74.0 `workflow` launch gets the one-call-per-lane reason", () => {
  for (const workflow of [true, "./codex/dispatch.js", "run-ci"]) {
    const decision = evaluateSubagentCall({ workflow });
    assert.equal(decision.block, true);
    assert.match(decision.reason ?? "", /own async `subagent` call/);
  }
});

test("subagent deny: a workflow under any action, including validate", () => {
  for (const action of ["validate", "schedule.create"]) {
    const decision = evaluateSubagentCall({ action, workflow: true });
    assert.equal(decision.block, true);
    assert.match(decision.reason ?? "", /may not carry a `workflow`/);
  }
});

test("subagent deny: workflowScript launch (Appendix C: one async call per lane, never a workflow)", () => {
  const decision = evaluateSubagentCall({ workflowScript: 'return runs.run("main", { agent: "lane-worker", task: "x" })' });
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /own async `subagent` call/);
});

test("subagent deny: workflowScriptPath launch", () => {
  const decision = evaluateSubagentCall({ workflowScriptPath: "codex/dispatch.js", async: true });
  assert.equal(decision.block, true);
});

test("subagent allow: validating a workflow script launches nothing", () => {
  const decision = evaluateSubagentCall({ action: "validate", workflowScriptPath: "codex/dispatch.js" });
  assert.equal(decision.block, false);
});

test("isAsyncSubagentLaunch: true for default (async omitted)", () => {
  assert.equal(isAsyncSubagentLaunch({ agent: "lane-worker", task: "x" }), true);
});

test("isAsyncSubagentLaunch: false when async:false", () => {
  assert.equal(isAsyncSubagentLaunch({ agent: "lane-worker", task: "x", async: false }), false);
});

test("isAsyncSubagentLaunch: false for a management action with no launch shape", () => {
  assert.equal(isAsyncSubagentLaunch({ action: "status" }), false);
});

test("watch_process deny: async run active", () => {
  assert.equal(evaluateWatchProcess(true).block, true);
});

test("watch_process allow: no async run active", () => {
  assert.equal(evaluateWatchProcess(false).block, false);
});

test("bg_wait always denied", () => {
  assert.equal(evaluateBgWait().block, true);
});

test("typed or spliced parser placeholder text cannot hide arguments", () => {
  for (const command of [
    "git push origin main __loop_guard_herestring__ --force",
    "git push origin __loop_guard_heredoc_0__ --force main",
    "git push __loop_guard_subst_0__ --force",
    // The lexer splices quoted pieces, so the marker text can be built without appearing literally.
    'git push origin main __loop_"guard"_herestring__ --force',
    "git push origin main __loop_'guard'_heredoc_0__ --force",
    "git push origin main \u0000 --force",
  ]) {
    assert.equal(evaluateBashCommand(command, "root").block, true, `root: ${command}`);
    assert.equal(evaluateBashCommand(command, "lane").block, true, command);
  }
});

// ---------------------------------------------------------------------------
// The 35 lane blocks recorded in the first live loop (rows of guard-blocks.jsonl whose reason
// started with "loop-guard:"), sanitised for publication: every identifier outside the shell and
// rule vocabulary is a stable pseudo-word of the same shape, and numbers and ids are remapped, so
// each command keeps its structure. Under the current rules every row is allowed for lanes and
// root (row 37, an `ssh` call, included), and nothing warns.
// ---------------------------------------------------------------------------

// Rows marked `added` are not recorded blocks: they pin a later rule change, with `lane_blocks`
// giving the lane verdict.
const REAL_LANE_BLOCKS: { row: number; tool: string; command: string; added?: boolean; lane_blocks?: boolean }[] = JSON.parse(
  readFileSync(new URL("./fixtures/real-lane-blocks.json", import.meta.url), "utf8"),
);

test("real lane blocks fixture has 35 recorded rows", () => {
  assert.equal(REAL_LANE_BLOCKS.filter((r) => !r.added).length, 35);
});

for (const r of REAL_LANE_BLOCKS) {
  const laneShouldBlock = r.lane_blocks === true;
  test(`real lane block row ${r.row} (${r.tool}): lane ${laneShouldBlock ? "blocked" : "allowed"}`, () => {
    const decision = evaluateBashCommand(r.command, "lane");
    assert.equal(decision.block, laneShouldBlock, `row ${r.row}: ${decision.reason ?? ""}`);
    if (laneShouldBlock) assert.match(decision.reason ?? "", /blocked for lanes|belong to the root/);
    assert.equal(decision.warning, undefined);
  });
  test(`real lane block row ${r.row} (${r.tool}): root allowed without a warning`, () => {
    const decision = evaluateBashCommand(r.command, "root");
    assert.equal(decision.block, false, `row ${r.row}: ${decision.reason ?? ""}`);
    assert.equal(decision.warning, undefined);
  });
}

// ---------------------------------------------------------------------------
// Protocol 2 (SEAMS S0/S1/S8): refusals that apply only when the run dir carries `loop-pi-proto`
// (`proto: true` in the guard context). Without the marker every command below keeps today's
// verdict. `protectedPath` is the run-dir / authority predicate the extension entries build; here
// a pure stand-in that refuses anything under a fake run dir.
// ---------------------------------------------------------------------------

const FAKE_RUN = "/runs/loop-a";
const fakeProtected = (path: string): string | undefined =>
  /^(\$LOOP_PI_RUN_DIR|\$\{LOOP_PI_RUN_DIR\})(\/|$)/.test(path) || path === FAKE_RUN || path.startsWith(`${FAKE_RUN}/`)
    ? `loop-guard: '${path}' is inside the loop run dir, which only the harness writes.`
    : undefined;
const P2 = { proto: true, protectedPath: fakeProtected, cwd: "/repo" };
const LEGACY = { proto: false, protectedPath: fakeProtected, cwd: "/repo" };

const ROOT_LOOP_STATE_DENY = [
  "loop-state append codex/state-a-loop1.jsonl land task=T-1 mode=after-green --by ext",
  "loop-state append codex/state-a-loop1.jsonl park task=T-1 --by daemon",
  "loop-state append codex/state-a-loop1.jsonl open goal_sha256=x --by=dispatcher",
  "/home/user/.loop-pi-x/bin/loop-state append codex/state-a-loop1.jsonl close reason=budget --by=ext",
  "python3 $HOME/.loop-pi-x/bin/loop-state append codex/state-a-loop1.jsonl revert sha=abc --by daemon",
  "cd /repo && loop-state append codex/state-a-loop1.jsonl gate scope=lane sha=a cmd=x exit=0 --by ext",
  "loop-state append codex/state-a-loop1.jsonl <<'EOF'\n{\"ev\":\"land\",\"task\":\"T-1\",\"by\":\"ext\"}\nEOF",
  "echo '{\"ev\":\"close\",\"reason\":\"budget\",\"by\": \"daemon\"}' | loop-state append codex/state-a-loop1.jsonl",
  "loop-state append codex/state-a-loop1.jsonl <<< '{\"ev\":\"land\",\"by\":\"root\"}'",
];

for (const command of ROOT_LOOP_STATE_DENY) {
  test(`proto root: loop-state carrying a non-root --by or a stdin by field is refused: ${command.split("\n")[0]}`, () => {
    const decision = evaluateBashCommand(command, "root", 0, true, P2);
    assert.equal(decision.block, true, command);
    assert.match(decision.reason ?? "", /loop-state/);
  });
  test(`legacy root (no marker): the same loop-state call keeps today's verdict: ${command.split("\n")[0]}`, () => {
    assert.equal(evaluateBashCommand(command, "root", 0, true, LEGACY).block, false, command);
  });
}

test("proto root: loop-state with --by root, no --by, a by word in a k=v text, digest and check stay allowed", () => {
  for (const command of [
    "loop-state append codex/state-a-loop1.jsonl land task=T-1 mode=after-green --by root",
    "loop-state append codex/state-a-loop1.jsonl judgement text='decided by: the root'",
    "loop-state append codex/state-a-loop1.jsonl <<'EOF'\n{\"ev\":\"judgement\",\"text\":\"x\"}\nEOF",
    "loop-state digest codex/state-a-loop1.jsonl --json",
    "loop-state check codex/state-a-loop1.jsonl",
    "echo --by ext",
  ]) {
    assert.equal(evaluateBashCommand(command, "root", 0, true, P2).block, false, command);
  }
});

const RUN_DIR_BASH_WRITES = [
  "echo x > $LOOP_PI_RUN_DIR/push-log.jsonl",
  "printf '%s\\n' '{}' >> ${LOOP_PI_RUN_DIR}/harness-facts.jsonl",
  "echo 2 | tee $LOOP_PI_RUN_DIR/loop-pi-proto",
  "cp /tmp/grants.json /runs/loop-a/audit-grants.json",
  "mv /tmp/x.md /runs/loop-a/returns/run-1.md",
  "mv /runs/loop-a/push-log.jsonl /tmp/old.jsonl",
  "rm -f /runs/loop-a/push-log.jsonl",
  "sed -i '' 's/a/b/' $LOOP_PI_RUN_DIR/push-log.jsonl",
  "bash -c 'echo 1 > $LOOP_PI_RUN_DIR/loop-pi-proto'",
];

for (const command of RUN_DIR_BASH_WRITES) {
  for (const role of ["root", "lane"] as Role[]) {
    test(`proto ${role}: a bash write into the run dir is refused: ${command}`, () => {
      const decision = evaluateBashCommand(command, role, 0, true, P2);
      assert.equal(decision.block, true, command);
      assert.match(decision.reason ?? "", /run dir/);
    });
    test(`legacy ${role}: a bash write into the run dir keeps today's verdict: ${command}`, () => {
      assert.equal(evaluateBashCommand(command, role, 0, true, LEGACY).block, false, command);
    });
  }
}

test("proto: reading the run dir (cat, cp out of it, jq) is allowed for root and lanes", () => {
  for (const command of [
    "cat $LOOP_PI_RUN_DIR/push-log.jsonl",
    "cp $LOOP_PI_RUN_DIR/push-log.jsonl /tmp/push-log.jsonl",
    "jq -c . /runs/loop-a/harness-facts.jsonl > /tmp/facts.json",
  ]) {
    for (const role of ["root", "lane"] as Role[]) {
      assert.equal(evaluateBashCommand(command, role, 0, true, P2).block, false, `${role}: ${command}`);
    }
  }
});

test("proto lane: gh pr merge is a release, refused without an ops grant", () => {
  for (const command of ["gh pr merge 12 --squash", "gh -R o/r pr merge 12 --merge --delete-branch", "env GH_PROMPT_DISABLED=1 gh pr merge --auto 3"]) {
    const decision = evaluateBashCommand(command, "lane", 0, true, P2);
    assert.equal(decision.block, true, command);
    assert.match(decision.reason ?? "", /gh pr merge/);
    assert.equal(evaluateBashCommand(command, "root", 0, true, P2).block, false, `root: ${command}`);
  }
});

test("legacy lane (no marker): gh pr merge keeps today's verdict", () => {
  assert.equal(evaluateBashCommand("gh pr merge 12 --squash", "lane", 0, true, LEGACY).block, false);
});

test("proto lane: gh pr merge passes only on an ops release surface whose allow fully matches", () => {
  const release = { surface: "release:svc", kind: "release", allow: ["gh pr merge [0-9]+ --squash"] };
  const deploy = { surface: "deploy:svc", kind: "deploy", allow: ["gh pr merge [0-9]+ --squash"] };
  assert.equal(evaluateBashCommand("gh pr merge 12 --squash", "lane", 0, true, { ...P2, ops: release }).block, false);
  assert.equal(evaluateBashCommand("gh pr merge 12 --merge", "lane", 0, true, { ...P2, ops: release }).block, true);
  const onDeploy = evaluateBashCommand("gh pr merge 12 --squash", "lane", 0, true, { ...P2, ops: deploy });
  assert.equal(onDeploy.block, true);
  assert.match(onDeploy.reason ?? "", /release/);
});

test("proto lane: gh pr view/list/checks stay allowed", () => {
  for (const command of ["gh pr view 12 --json state", "gh pr list --state open", "gh pr checks 12"]) {
    assert.equal(evaluateBashCommand(command, "lane", 0, true, P2).block, false, command);
  }
});

test("proto lane: bash writes into codex/grants-* are refused, reads are not", () => {
  for (const command of [
    "echo '{}' > codex/grants-2026-10-04-loop3.json",
    "jq . /tmp/g.json | tee codex/grants-2026-10-04-loop3.json",
    "rm codex/grants-*.json",
    "sed -i 's/a/b/' /repo/codex/grants-2026-10-04-loop3.json",
  ]) {
    const decision = evaluateBashCommand(command, "lane", 0, true, P2);
    assert.equal(decision.block, true, command);
    assert.match(decision.reason ?? "", /grants/);
    assert.equal(evaluateBashCommand(command, "lane", 0, true, LEGACY).block, false, `legacy: ${command}`);
  }
  assert.equal(evaluateBashCommand("cat codex/grants-2026-10-04-loop3.json", "lane", 0, true, P2).block, false);
  assert.equal(evaluateBashCommand("echo x > LOOP.md", "lane", 0, true, P2).block, false, "LOOP.md stays writable by lanes");
});

test("proto: an unparseable command still gets the run-dir and loop-state refusals (fallback scan)", () => {
  const unparseable = "echo 'unterminated; echo x > $LOOP_PI_RUN_DIR/push-log.jsonl";
  assert.equal(parseCommand(unparseable, "root"), null);
  assert.equal(evaluateBashCommand(unparseable, "root", 0, true, P2).block, true);
  const loopState = "loop-state append codex/state-a-loop1.jsonl land task=T --by ext 'oops";
  assert.equal(parseCommand(loopState, "root"), null);
  assert.equal(evaluateBashCommand(loopState, "root", 0, true, P2).block, true);
});

// Protocol 2 root loop-state hardening: a `by=` k=v other than root, stdin from a file (which the
// guard cannot read), and `--run-dir` (which would point the call at another run's facts).
const ROOT_LOOP_STATE_DENY_P2 = [
  "loop-state append codex/state-a-loop1.jsonl land task=T-1 mode=after-green by=ext",
  "loop-state append codex/state-a-loop1.jsonl park task=T-1 by=lane",
  "python3 $HOME/.loop-pi-x/bin/loop-state append codex/state-a-loop1.jsonl close reason=done by=daemon",
  "loop-state append codex/state-a-loop1.jsonl < /tmp/event.json",
  "loop-state append codex/state-a-loop1.jsonl </tmp/event.json",
  "cd /repo && loop-state append codex/state-a-loop1.jsonl 0< event.json",
  "loop-state append codex/state-a-loop1.jsonl land task=T-1 mode=after-green --run-dir /tmp/other-run",
  "loop-state append codex/state-a-loop1.jsonl close reason=budget --run-dir=/tmp/other-run",
  "loop-state digest codex/state-a-loop1.jsonl --run-dir /tmp/other-run",
  "LOOP_PI_RUN_DIR=/tmp/other loop-state append codex/state-a-loop1.jsonl close reason=budget",
  "env LOOP_PI_RUN_DIR=/tmp/other loop-state append codex/state-a-loop1.jsonl close reason=budget",
  "export LOOP_PI_RUN_DIR=/tmp/other; loop-state append codex/state-a-loop1.jsonl close reason=budget",
  "cat /tmp/event.json | loop-state append codex/state-a-loop1.jsonl",
];

for (const command of ROOT_LOOP_STATE_DENY_P2) {
  test(`proto root: loop-state by=, stdin from a file and --run-dir are refused: ${command}`, () => {
    const decision = evaluateBashCommand(command, "root", 0, true, P2);
    assert.equal(decision.block, true, command);
    assert.match(decision.reason ?? "", /loop-state/);
  });
  test(`legacy root (no marker): loop-state by=, stdin file and --run-dir keep today's verdict: ${command}`, () => {
    assert.equal(evaluateBashCommand(command, "root", 0, true, LEGACY).block, false, command);
  });
}

test("proto root: loop-state by=root, a by word inside another value, a heredoc and a digest stay allowed", () => {
  for (const command of [
    "loop-state append codex/state-a-loop1.jsonl land task=T-1 mode=after-green by=root",
    "loop-state append codex/state-a-loop1.jsonl judgement text=by=ext",
    "loop-state append codex/state-a-loop1.jsonl <<'EOF'\n{\"ev\":\"judgement\",\"text\":\"x < y\"}\nEOF",
    "loop-state digest codex/state-a-loop1.jsonl < /dev/null",
    "sort < /tmp/x.txt && loop-state check codex/state-a-loop1.jsonl",
  ]) {
    const decision = evaluateBashCommand(command, "root", 0, true, P2);
    assert.equal(decision.block, false, `${command}: ${decision.reason ?? ""}`);
  }
});

test("proto root: an unparseable loop-state call with by=, a stdin file or --run-dir is still refused (fallback scan)", () => {
  for (const command of [
    "loop-state append codex/state-a-loop1.jsonl land task=T by=ext 'oops",
    "loop-state append codex/state-a-loop1.jsonl < /tmp/e.json 'oops",
    "loop-state append codex/state-a-loop1.jsonl land --run-dir /tmp/r 'oops",
  ]) {
    assert.equal(parseCommand(command, "root"), null, command);
    assert.equal(evaluateBashCommand(command, "root", 0, true, P2).block, true, command);
  }
});

// Protocol 2 root fence: the root never writes the planner's files (ops, grants, launch, goal).
const ROOT_CONTROL_BASH_WRITES = [
  "echo x > codex/goal-2026-10-04-loop3.md",
  "printf '%s' '{}' >> /repo/codex/ops-2026-10-04-loop3.json",
  "jq . /tmp/g.json | tee codex/grants-2026-10-04-loop3.json",
  "cp /tmp/launch.txt codex/launch-2026-10-04-loop3.txt",
  "mv codex/goal-2026-10-04-loop3.md /tmp/goal.md",
  "sed -i '' 's/tier: routine/tier: guarded/' codex/goal-2026-10-04-loop3.md",
  "rm codex/launch-*",
  "bash -c 'echo x > codex/ops-2026-10-04-loop3.json'",
];

for (const command of ROOT_CONTROL_BASH_WRITES) {
  test(`proto root: a bash write into codex/ops|grants|launch|goal-* is refused: ${command}`, () => {
    const decision = evaluateBashCommand(command, "root", 0, true, P2);
    assert.equal(decision.block, true, command);
    assert.match(decision.reason ?? "", /root may not write/);
  });
  test(`legacy root (no marker): a bash write into a planner file keeps today's verdict: ${command}`, () => {
    assert.equal(evaluateBashCommand(command, "root", 0, true, LEGACY).block, false, command);
  });
}

test("proto root: reading planner files and writing state and report files stay allowed", () => {
  for (const command of [
    "cat codex/goal-2026-10-04-loop3.md",
    "cp codex/goal-2026-10-04-loop3.md /tmp/goal.md",
    "sha256sum codex/grants-2026-10-04-loop3.json > /tmp/sum",
    "echo x >> codex/report-2026-10-04-loop3.md",
    "loop-state append codex/state-2026-10-04-loop3.jsonl judgement text=x",
  ]) {
    const decision = evaluateBashCommand(command, "root", 0, true, P2);
    assert.equal(decision.block, false, `${command}: ${decision.reason ?? ""}`);
  }
});
