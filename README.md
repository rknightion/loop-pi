# loop-pi

loop-pi runs long, multi-agent coding loops on the [pi coding agent](https://github.com/earendil-works/pi)
with [pi-subagents](https://github.com/nicobailon/pi-subagents). A loop is one root session that
plans the job and dispatches lanes (child sessions, each with one agent file and one task), waits
for them without spending model calls, and closes out with an audit of what changed on the remote.

It exists because the Codex CLI root in the same kind of loop polls while it waits: every status
check is a model call, and over a long run those calls add up. pi gives an extension API that can
hold a root idle until something actually happens.

The loop contract itself (run contract, lane briefs, waits, closeout) is the
[fan-out protocol](https://github.com/rknightion/fan-out-protocol): `loop/contract.md`, with pi in
`loop/harness-pi.md`.

## What is in it

Three pi extensions, a home template and an installer:

- `extensions/loop-guard` fences plainly typed mistakes in the root and every lane: force and
  delete pushes, backgrounding with `&`, `nohup`, `disown` or `setsid`, a `subagent` call
  overriding the pinned model or run deadline, models outside the configured family. It also runs optional guard scripts
  (see below). The root entry registers the lane entries as required child extensions, so every
  child is fenced whatever its own agent file says.
- `extensions/loop-wait` gives lanes `watch_process` and the root `watch_start`, `wake_at` and
  `wake_cancel`, so a wait is a timer or a process watcher rather than a polling loop. A fired
  timer or a finished watcher starts the next root turn.
- `extensions/loop-continuation` re-prompts a root that stops before the loop is finished, detects
  launch files, and triggers an optional transcript sync script.
- `extensions/request-ceiling` bounds each model request in the root and every lane by wall-clock
  time, and turns an output-budget stop with no output into an incident. Either one sends the
  session a follow-up message that starts its next turn, a bounded number of times in a row.
  It also adds jitter to pi's retry wait after a 5xx and holds a 429 retry to a flat 60 s.
- `home/` holds the agent files (mapper, lane-worker, reviewer, ops, ops-probe and so on), the pi
  settings and the policy header for the dedicated loop home.
- `bin/loop-pi-install` builds a pinned runtime, validates it, installs one pi home and writes a
  launcher. `bin/loop-pi-preflight` refuses a target repository that is not safe to loop in, and
  `bin/loop-pi-audit` snapshots remote state before a run and reports every ungranted remote change
  at closeout.

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
| `rootRoute` | `{"provider": "openai", "model": "gpt-6.1-sol", "thinking": "medium"}` | the root's model, and the fallback when a session selects one outside the family |
| `requiredHookScripts` | `[]` | guard scripts that must exist; a missing required one blocks every lane tool call |
| `onIncident` | `[]` | argv of a notifier run, detached, whenever the loop writes an incident file; `{file}` in any element is replaced by the incident's absolute path. Failures are ignored. loop-pi ships no notifier: an overlay sets this to its own command |

The agent files name `openai/gpt-6.1-sol` and `openai/gpt-6-*` models. If you use another family, replace the agent files
through the overlay and set `modelFamily` and `rootRoute` to match; the installer refuses a build
where they disagree.

### Ops agents

`ops` runs the commands of one granted ops surface of any kind (deploy, probe, release, secret
write). `ops-probe` is the same shape with `thinking: low` for read-only probes, readbacks and
summaries, and may only be bound to a surface of `kind: probe`. Both are single-flight and are
bound to their surface by the root guard.

### Guard scripts

loop-guard runs `<home>/scripts/backlog-guard.py` and `<home>/scripts/staging-guard.py` before
shell, edit and write calls, when they exist. Each gets a JSON payload on stdin
(`{"hookEventName": "PreToolUse", "toolName": ..., "toolInput": {...}, "cwd": ...}`) and denies by
printing `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": ...}}`.
Samples of both live in `extensions/test-support/hook-scripts/`. List a script in
`requiredHookScripts` when its absence should stop lanes rather than be skipped.

### Closeout grants

`loop-pi-audit compare BEFORE AFTER --grants grants.json` (or `closeout --grants`)
uses exact snapshot repository paths as keys. An entry remains either a list of exact refs,
or an object with `refs` and `allow_non_fast_forward` lists. Objects can also predeclare
actor-bound automation, independently of those lists:

```json
{
  "<repository path>": {
    "refs": ["refs/heads/main"],
    "automation": [
      {"ref_prefix": "refs/heads/renovate/", "actor": "dependency-app[bot]"},
      {"ref": "refs/heads/release-please--branches--main", "actor": "release-app[bot]"}
    ]
  }
}
```

Each automation item requires an exact GitHub App bot push actor login: a nonempty bot name
ending in literal `[bot]`. Human or other nonbot actor declarations are malformed, even if
push records match, and exit 2. Each item has exactly one of `ref` (an exact branch) or
`ref_prefix` (a branch namespace longer than `refs/heads/`, ending in `/`). Unknown keys or
malformed items exit 2. Read the login from the forge's activity API, not the commit metadata
or a pull request's author display. No wildcards are accepted.

Automation covers creation, movement, rewriting or deletion only when the read-only GitHub
activity API for that remote and ref accounts for the complete before-to-after SHA chain
between the snapshot timestamps, with every entry attributed to that one actor. All activity
pages are read. Missing, unavailable, malformed or mixed-actor evidence grants nothing; the
ordinary audit verdict remains unchanged. Covered changes have a separate `automation` report
line with full old/new SHAs and actor. Neither `main`, either snapshot's default branch, tags,
nor an unresolved default branch can be covered this way. This never grants another ref or
permits the root's own ungranted pushes. Declare grants before a run, not to repair an old audit.

### Protocol 2 closeout

A run dir that holds a `loop-pi-proto` file (written by `loop-continuation` when it arms a root)
is a protocol 2 run. For those, and only those, `closeout` judges a move of a remote's default
branch commit by commit instead of by grant:

```sh
loop-pi-audit closeout --grants grants.json --grants-sha256 <hex> --push-log push-log.jsonl
```

- `--grants-sha256 HEX` is the hash frozen for the grants file at launch. A file whose bytes differ
  is refused with exit 2 before it covers anything. A protocol 2 closeout without it warns.
- `--push-log FILE` is the loop's push log (default `<run-dir>/push-log.jsonl`), one JSON object
  per successfully updated ref with `repo`, `ref`, `old` and `new`.
- A `refs/heads/<default branch>` entry in the grants file is ignored, with a warning. The move is
  granted only when every commit in `before..after` lies in some logged `old..new` range for that
  repository and ref, or touches only paths under `backlog/`, or lies in a range that a login in
  that repository's `bot_actors` itself pushed or merged inside the snapshot window, according to
  GitHub's activity API (push records, never commit author or committer metadata; missing evidence
  grants nothing). Every `bot_actors` entry must be an exact App bot login (`^[A-Za-z0-9-]+\[bot\]$`),
  or the grants file is refused with exit 2. Anything else is `UNGRANTED` and printed in a `note:` line. A foreign commit between two logged pushes is
  therefore flagged, as is any commit after the last logged push. The fast-forward check still
  applies, and a derived `HEAD` move follows the default branch's verdict.
- Other branches, tags and releases are judged exactly as before. `bot_actors` sits beside `refs`
  in a repository's grants object: `{"<repo>": {"refs": ["HEAD"], "bot_actors": ["some-app[bot]"]}}`.
- `compare` applies the same rules when given `--run-dir DIR` for a run dir with the marker; it
  never reads `LOOP_PI_RUN_DIR`. With no marker, behaviour is unchanged.

### State log (`loop-state`)

`loop-state append <log> <ev> k=v ...` validates every event; `check` and `digest` read the log.
A log takes one `open`. Only `land mode=after-green` is accepted for new appends (older logs with
`pre-green` still check and digest). `revert` accepts `reason=root-decision`. `park needs=budget`
is valid; `close reason=budget` in a protocol 2 run (`--run-dir DIR` or `LOOP_PI_RUN_DIR`) is
refused unless `harness-facts.jsonl` records a `compaction-failed` or `quota-exhausted` fact. When
`LOOP_PI_RUN_DIR` holds `loop-pi-proto`, a different `--run-dir` is ignored with a warning. `by` is
not a `k=v` field; use `--by`. A string-list field accepts a JSON array or a comma-separated string, `judgement` text may be 4,096
bytes, and an unknown field's error lists the event's allowed fields.

## Limits, stated plainly

- **Pinned pi.** The runtime is pinned to `@earendil-works/pi-coding-agent` 1.0.2 and
  pi-subagents 0.75.0. The extensions use pi's extension API, which still changes between minor
  releases; a bump means re-running the tests and a real loop, not just the installer.
- **Not a sandbox.** loop-guard is a fence against honest mistakes, parsed from the command text.
  A determined model can get round it (an interpreter, an encoded string, a file it writes and then
  runs). The closeout audit, not the guard, is the evidence that nothing ungranted changed on a
  remote. Run loops only where a mistake is recoverable.
- **One model family.** The guard enforces the configured family and the model names in the agent
  files, not whether your provider actually serves them.
- **The tests never call a model.** They drive real pi processes against a scripted `faux`
  provider. That proves the wiring, not how a given model behaves in a loop.

## Development

`just setup` installs dependencies and the git hooks; `just check` is the gate (formatting, type
check, the extension and Python tests, and the leak scan). See `AGENTS.md`.

## Licence

MIT. See `LICENSE`.
