# loop-pi

loop-pi runs long, multi-agent coding loops on the [pi coding agent](https://github.com/earendil-works/pi)
with [pi-subagents](https://github.com/nicobailon/pi-subagents). A loop is one root session that
plans the job and dispatches lanes (child sessions, each with one agent file and one task), waits
for them without spending model calls, and closes out with an audit of what changed on the remote.

It exists because the Codex CLI root in the same kind of loop polls while it waits: every status
check is a model call, and over a long run those calls add up. pi gives an extension API that can
hold a root idle until something actually happens.

The loop contract itself (run contract, charter, lane briefs, waits, closeout) lives in a separate
loop protocol: a harness-neutral contract plus one harness file per runtime, `harness-pi.md` for pi.

## What is in it

Three pi extensions, a home template and an installer:

- `extensions/loop-guard` fences plainly typed mistakes in the root and every lane: force and
  delete pushes, any `git push` from a lane (only the root pushes), backgrounding with `&`, `nohup`, `disown` or `setsid`, a `subagent` call
  overriding the pinned model or run deadline, models outside the configured family. It also runs optional guard scripts
  (see below). The root entry registers the lane entries as required child extensions, so every
  child is fenced whatever its own agent file says.
- `extensions/loop-wait` gives lanes `watch_process` and the root `watch_start`, `wake_at` and
  `wake_cancel`, so a wait is a timer or a process watcher rather than a polling loop. A fired
  timer or a finished watcher starts the next root turn.
- `extensions/loop-continuation` arms the root on a v3 launch ("You are the root" plus one
  `codex/closeout-<name>-loop<N>.md` path, or a bare `launch-*` file path), checks it against the
  run's `codex/charter-*` file and appends the state log's `open` itself. It re-prompts a root that
  stops before the loop is finished (a counted closeout or `PAUSED:` ends that; a root with no live
  lane and nothing armed to wake it is told to dispatch ready work or close out), and triggers an
  optional transcript sync script.
- Recovery is automatic for an armed root: when a provider error, a stalled request or a
  request-ceiling abort leaves it stopped, loop-continuation resumes it after a backoff that starts
  at 1 minute and doubles to a 15-minute cap (`loopPi.rootRecovery`), with no attempt limit, and
  records each resume as a `judgement` in the state log. Authentication, quota, policy and
  context-length failures still stop the root and write an incident; an operator's abort is never
  resumed. Lanes are not auto-resumed.
- `extensions/request-ceiling` bounds each model request in the root and every lane by 15 minutes
  without observed model progress and 75 minutes absolute elapsed time (both configurable), and
  turns an output-budget stop with no output into an incident. Transport keepalives cannot extend
  inactivity; active encrypted reasoning may continue past an hour. Either one sends the
  session a follow-up message that starts its next turn, a bounded number of times in a row.
  It also adds jitter to pi's retry wait after a 5xx and holds a 429 retry to a flat 60 s.
- `home/` holds the five agent files (`worker`, `senior`, `senior-escalation`, `reviewer`, `scout`),
  the lane policy, the pi settings and the policy header for the dedicated loop home.
- `bin/loop-pi-install` builds a pinned runtime, validates it, installs one pi home and writes a
  launcher. `bin/loop-pi-preflight` refuses a target repository that is not safe to loop in, and
  `bin/loop-pi-audit` snapshots remote state before a run and reports every remote change the
  run's push log does not account for at closeout.

`extensions/SEAMS.md` is the contract between the extensions: event names, file layout, the hook
script payload and the settings keys.

## Install

You need Node 22.19 or later, npm, Python 3.10 or later and git, on macOS or Linux.

```sh
git clone https://github.com/rknightion/loop-pi && cd loop-pi
python3 bin/loop-pi-install --home ~/.loop-pi --launcher loop-pi
loop-pi --version
```

Then give the home provider credentials the way pi documents them for its agent directory, or
supply a `models.json` through an overlay (below).

The installer copies the source into an absent staging directory, runs `npm ci`, checks the pins,
`pi --version`, the agent set and the model family, loads the root and lane entries once over pi's
RPC mode, and only then moves the build to `~/.local/share/loop-pi/<pi version>-<hash>`. Older
builds stay for rollback. It then updates the home file by file and never touches `auth.json` or
sessions. `--check` reports drift and writes nothing.

Add `--overlay DIR` (and `--var KEY=VALUE` for any `{{KEY}}` your overlay files use) to add
anything private without editing this tree:

```
my-overlay/home/models.json      provider config (start from examples/models.example.json)
my-overlay/home/settings.json    deep-merged over home/settings.json
my-overlay/home/**               any other home file to add or replace
my-overlay/policy.md             appended to the home's AGENTS.md
my-overlay/scripts/*.py          guard and hook scripts, installed to <home>/scripts/
```

Settings under `loopPi` in `home/settings.json` (or your overlay):

| Key | Default | Meaning |
|---|---|---|
| `modelFamily` | `{"provider": "openai", "pattern": "^gpt-6(\\.[0-9]+)?(-[a-z0-9]+)+$", "name": "gpt-6"}` | the only models the root and lanes may run |
| `rootRoute` | `{"provider": "openai", "model": "gpt-6.1-sol", "thinking": "high"}` | the root's model, and the fallback when a session selects one outside the family |
| `requiredHookScripts` | `[]` | guard scripts that must exist; a missing required one blocks every lane tool call |
| `onIncident` | `[]` | argv of a notifier run, detached, whenever the loop writes an incident file; `{file}` in any element is replaced by the incident's absolute path. Failures are ignored. loop-pi ships no notifier: an overlay sets this to its own command |

The agent files name `openai/gpt-6.1-sol` and `openai/gpt-6-*` models. If you use another family, replace the agent files
through the overlay and set `modelFamily` and `rootRoute` to match; the installer refuses a build
where they disagree.

### Agents

| Agent | Model / thinking | Writes | Job |
|---|---|---|---|
| `worker` | `gpt-6.1-sol` / medium | yes | one task in its own worktree; hands back an uncommitted candidate |
| `senior` | `gpt-6.1-sol` / high | yes | judgement, shared contracts and compose or board batches; the only agent that may spawn children (`scout`, `worker`, `reviewer`), at most two levels deep, when its brief grants a count |
| `senior-escalation` | `gpt-6-astra` / high | yes | the same work after repair rounds failed, or when the owner names it |
| `reviewer` | `gpt-6.1-sol` / high | no | reads a diff or patch and returns PASS or FAIL with findings by severity |
| `scout` | `gpt-6.1-sol` / low | no | read-only mapping, sweeps, wave drafts, CI or log reduction |

Each body is short and points at the run's `LANE.md`, which the brief's `Rules:` line names, for the
working rules and the `lane-return` block. The installer appends `home/lane-policy.md`, the generic
lane rules, to every agent file that sets `inheritGlobalContext: false`.

No lane pushes: the lane guard refuses `git push` and its wrappers whatever the agent, and every agent
runs behind the `nopush` launcher as a second fence. Implementation lanes hand back an uncommitted
candidate; compose and board lanes commit locally. When an install ships a different agent set, the
installer moves any `agents/*.md` file in the home that the build no longer ships into
`<home>/backups/agents-<timestamp>/` instead of deleting it, and `--check` reports it as `STALE`.

### Guard scripts

loop-guard runs `<home>/scripts/backlog-guard.py` and `<home>/scripts/staging-guard.py` before
shell, edit and write calls, when they exist. Each gets a JSON payload on stdin
(`{"hookEventName": "PreToolUse", "toolName": ..., "toolInput": {...}, "cwd": ...}`) and denies by
printing `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": ...}}`.
Samples of both live in `extensions/test-support/hook-scripts/`. List a script in
`requiredHookScripts` when its absence should stop lanes rather than be skipped.

### Closeout audit

The launcher runs `loop-pi-audit begin <repo>` before the root starts, recording every remote's
refs, the local tags and the GitHub releases in `<run dir>/audit-before.json`; `loop-pi-audit add
<repo>` adds another repository for a cross-repo charter. `/loop-closeout` runs

```sh
loop-pi-audit closeout --run-dir <run dir> --push-log <run dir>/push-log.jsonl \
  --charter <charter> --charter-sha256 <digest frozen at arm>
```

which snapshots the same repositories again and compares. A run dir that holds a `loop-pi-proto`
file (written by `loop-continuation` when it arms a root), or a snapshot that retains that
evidence, judges a move of a remote's default branch commit by commit:

- `--push-log FILE` is the loop's push log (default `<run-dir>/push-log.jsonl`), one JSON object
  per successfully updated ref with `repo`, `ref`, `old` and `new`, written by loop-guard after the
  root's own pushes.
- The move is accounted for only when every commit in `before..after` lies in some logged
  `old..new` range for that repository and ref, touches only paths under `backlog/`, or is one of
  the two cases below. Anything else is `UNGRANTED` and printed in a `note:` line, including any
  commit after the last logged push. The fast-forward check still applies, and a derived `HEAD`
  move follows the default branch's verdict.
- **Foreign commit.** A commit that is not in a logged push is reported as `FOREIGN`, and does not
  fail the audit, only when two independent facts hold. Its message ends with a `Claude-Session:
  <id>` trailer in the final paragraph (Claude Code writes it on every commit it makes; a loop-pi
  root writes none), and it is the `old`, or an ancestor of the `old`, of a logged `actor: root`
  push, so the root pushed on top of it. The trailer alone is text anyone can write and the receipt
  alone cannot tell a sibling session from an unlogged writer of this run, so neither downgrades
  `UNGRANTED` by itself: an unattributed commit, a trailer with no root push over it (including a
  sibling's push after the last logged push) and a lane receipt all stay `UNGRANTED`. It is never a
  grant, and Git author and committer are still never read. The report names the session.
- **Release authority.** `closeout` is given the charter frozen at arm (`--charter FILE
  --charter-sha256 HEX`; `compare` takes the same flags). A charter that no longer hashes to the
  digest grants nothing. An entry under the charter's `authority:` key grants releases when one of
  its clauses (split at `.` and `;`) names `release-please` and contains no `no`, `not`, `never`,
  `without`, `except` or similar. The entry covers the repositories it names (`owner/name` of a
  remote URL, or an absolute path); an entry naming none covers the charter's own repository, the
  parent of its `codex/` folder. On a covered repository these are `GRANTED`: a default-branch
  commit whose subject is `chore(...): release ...` and that changes
  `.release-please-manifest.json`; a new version tag (`v1.2.3`, `name-v1.2.3`, `name@1.2.3`) whose
  commit is such a merge in this audit, as a remote ref or a local tag; the GitHub release for a
  granted tag; and the deletion of a `release-please--*` branch once such a merge is accounted for.
  Anything else on the repository, including a release-shaped commit that lacks the manifest change,
  a tag on another commit and a moved or added release branch, stays `UNGRANTED`.
- Another snapshotted remote whose unchanged URL is byte-identical to the canonical repository's
  (no scheme, user, host-case or path normalisation) receives only that canonical's exact
  `actor: root` `old..new` ranges. Only absolute URLs qualify (`scheme://`, scp-like `host:path`,
  absolute local path); a relative URL such as `../up.git` never transfers.
- A push the log never saw (watcher, subprocess, script) is `UNGRANTED` unless the foreign rule
  above applies; author, committer and current SHA are never backfilled. Refusing such pushes
  before mutation in loop-guard was deliberately not chosen.
- Any other added, moved or deleted ref, tag or release is reported and fails the audit (exit 1),
  except `refs/pull/*` changes, which are reported as foreign.
- `compare BEFORE AFTER` applies the same rules when given `--run-dir DIR` for a run dir with the
  marker or `--push-log FILE`; it never reads `LOOP_PI_RUN_DIR`.

### State log (`loop-state`)

`loop-state append <log> <ev> k=v ...` validates every event; `check` and `digest` read the log.
The extensions write the run's events themselves: `open` at arm (`charter_sha256`, `root`,
`root_model`, `first_wave`, and `tier` only when the charter states one), `dispatch` and `return`
per lane, `watch` and `heartbeat` for root activity, and `judgement` for automatic recovery.
`digest <log> --json` gives `live_lanes` after a compaction.
The state log records a lane only when its brief's first non-empty line is exactly
`Lane: <id> · Task: <ID> (<title>) · Tier: routine|guarded`; in a marked run the root's guard
refuses any `subagent` launch whose first line differs, and says the form to use. The root
compacts itself, with a summary that names the context-budget extension, once a root push has
landed and context use passes `LOOP_PI_COMPACT_AFTER_PUSH_PERCENT` (default 55), without waiting for
a quiet fleet; the 80 percent backstop still waits for one. A log takes one `open`. Only `land mode=after-green` is accepted for new appends (older logs with
`pre-green` still check and digest). `revert` accepts `reason=root-decision`. `park needs=budget`
is valid; `close reason=budget` in a marked run (`--run-dir DIR` or `LOOP_PI_RUN_DIR` holding
`loop-pi-proto`) is refused unless `harness-facts.jsonl` records a `compaction-failed` or `quota-exhausted` fact. When
`LOOP_PI_RUN_DIR` holds `loop-pi-proto`, a different `--run-dir` is ignored with a warning. `by` is
not a `k=v` field; use `--by`. A string-list field accepts a JSON array or a comma-separated string, `judgement` text may be 4,096
bytes, and an unknown field's error lists the event's allowed fields.

## Limits, stated plainly

- **Pinned pi.** The runtime is pinned to `@earendil-works/pi-coding-agent` 1.3.0 and
  pi-subagents 0.78.0. The extensions use pi's extension API, which still changes between minor
  releases; a bump means re-running the tests and a real loop, not just the installer.
- **Not a sandbox.** loop-guard is a fence against honest mistakes, parsed from the command text.
  A determined model can get round it (an interpreter, an encoded string, a file it writes and then
  runs). The closeout audit, not the guard, is the evidence of what changed on a remote. Run loops only where a mistake is recoverable.
- **One model family.** The guard enforces the configured family and the model names in the agent
  files, not whether your provider actually serves them.
- **The tests never call a model.** They drive real pi processes against a scripted `faux`
  provider. That proves the wiring, not how a given model behaves in a loop.

## Development

`just setup` installs dependencies and the git hooks; `just check` is the gate (formatting, type
check, the extension and Python tests, and the leak scan). See `AGENTS.md`.

## Licence

MIT. See `LICENSE`.
