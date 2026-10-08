# loop-pi extension seams

The contracts the extensions code against. A change to one of them is made here first, then in
every extension it touches.

Comments in the source cite sections of the original design plan (C3: the agent set, C4: the
guard rules, C5: the preflight, C7: the continuation contract). This file and the tests are the
public statement of those contracts.

## Runtime facts

- pi 1.0.4 loads `.ts` extensions through jiti. An entry file default-exports
  `(pi: ExtensionAPI) => void | Promise<void>`. Type imports come from
  `@earendil-works/pi-coding-agent`; `@earendil-works/pi-ai` and `typebox` are pi's dependencies,
  not ours, and resolve through pi's loader at runtime. pi 1.0.4 publishes no
  `npm-shrinkwrap.json`, so npm hoists them to the top-level `node_modules`; never rely on either
  layout (`tsconfig.json` lists both, and the loop-wait test hook resolves from pi's directory).
- **Project trust (pi-subagents 0.76.1):** children follow the parent session's project trust, so
  with `defaultProjectTrust: "never"` a child no longer loads the target repository's `.pi/`
  settings, system prompt files, skills or extensions. Agent discovery is not trust-gated:
  repository `.pi/agents` and `.agents/*.md` still outrank the home's agents. `loop-pi-preflight` stays.
- **Tool list (pi 1.0.4 / pi-subagents 0.76.1):** `toolActivation` is `"eager"`; never `"auto"`.
  codex-lb never acknowledges a request carrying an `additional_tools` item, which pi sends for a
  mid-conversation tool addition when a model's `compat.supportsAdditionalTools` is true. The overlay
  sets that and `supportsToolSearch` false for every family model, so a changed tool list is resent
  whole (proved live 2026-10-01: 120 s `upstream_request_timeout` with the flags on, 1.6 s with them
  off). pi's built-in extensions are switched off in `settings.json`; `bg_wait` and
  `subagents_enable` are excluded at the launcher. Unused pi-subagents feature groups are in
  `disabledFeatures`; `lane-metadata` stays enabled because lane-worktrees binds `lane.key` on governed
  native launches, and `workflow-scripts` stays enabled and guarded, because disabling it swaps
  `workflow` for unguarded `tasks` / `chain`.
- Installed layout: `<prefix>/extensions/<name>/...` next to `<prefix>/node_modules/`
  (pi-subagents at `<prefix>/node_modules/pi-subagents`). In the source checkout the same relative
  layout holds (`extensions`, `node_modules`). Resolve siblings with
  `new URL("./lane.ts", import.meta.url)`, never from `process.cwd()`.
- Home dir: `getAgentDir()` exported by `@earendil-works/pi-coding-agent` (honours
  `PI_CODING_AGENT_DIR`). Guard hook scripts: `<agentDir>/scripts/backlog-guard.py` and
  `<agentDir>/scripts/staging-guard.py`, each run only when present or listed in settings
  `loopPi.requiredHookScripts` (a required one that is absent is an adapter failure), run as `python3 <script>` with a Codex-format JSON payload on
  stdin (`{"hookEventName":"PreToolUse","toolName":...,"toolInput":{...},"cwd":...}`); a deny is
  exit 0 with `hookSpecificOutput.permissionDecision == "deny"` on stdout.
- `PI_SUBAGENTS_TEMP_ROOT` is honoured by pi-subagents (`src/shared/types.js:103`).
- pi-subagents child sessions are written under the parent's session dir:
  `<agentDir>/sessions/<cwd-slug>/<parent-session-basename>/<runId>/...`
  (`src/extension/index.js`, `getSubagentSessionRoot`); async run state under `$PI_SUBAGENTS_TEMP_ROOT`
  (`async-subagent-runs/`, `async-subagent-results/`).
- pi-subagents async completion message: `customType: "subagent-notify"`
  (`src/runs/background/notify.js:430`).
- `registerRequiredChildExtensions({ sessionId, extensions: [{ id, path }] })` from
  `pi-subagents/required-child-extensions`; returns `{ dispose() }`; one registration per parent
  session; call at `session_start` with `ctx.sessionManager.getSessionId()`, dispose at
  `session_shutdown`. The e2e child-block test (`loop-guard/e2e.test.ts`) proves an import from this extension shares
  the module instance pi-subagents itself uses. pi-subagents 0.76.1 fails the child launch closed
  when a required child extension fails to load or throws during startup ("Required child extension
  failed during startup"), so a lane-guard startup error aborts the lane rather than running it unguarded.
- pi-subagents 0.76.1 appends a row for every launched async child (agent, outcome, duration and a
  sha256 `taskHash`; the task text itself is stored as `[redacted]`) to `<agentDir>/run-history.jsonl`
  in the loop-pi home, not the target repository.
- Non-TTY stdin: pi in `--mode json`/`--print` waits on stdin. Tests close it (`stdio: ["ignore", ...]`
  or `</dev/null`). RPC mode keeps stdin open by design.
- **Push grant (async single-agent launches):** the root guard overwrites the entire
  `extensionBindings` tool input with `{"loop-pi.guard/1":{"agent":<selected agent>}}` after
  validating the launch. pi-subagents 0.76.1 delivers it in `PI_SUBAGENT_EXTENSION_BINDINGS`
  to the detached child. For directly bound detached children, only `lane-worker-push`,
  `lane-worker-retry-push` and `complex-worker-push` may make plain `git push`;
  a missing, malformed or unknown identity
  denies pushes. The lane guard applies this to `bash` and `watch_process`, including the
  existing parser's wrappers, aliases and fallback scan. Force pushes remain blocked for all.
  The real-CLI faux-provider test proves denial, a push to a disposable local bare remote,
  and replacement of model-supplied bindings. This remains an honest-mistake fence, not an
  OS security boundary. **Foreground nested children inherit the detached parent's push
  grant, even when the nested agent is not one of the three push agents.** pi-subagents
  0.76.1 creates foreground children in the parent's process and does not apply per-child
  `processEnv` there; the lane extension therefore reads the parent's binding. Denying
  that inheritance requires a supported per-session identity transport, not parsing prompt
  text or mutating shared process environment. A child without a binding denies pushes,
  but a foreground child of a granted parent is not such a child. Lane `subagent` calls
  that supply any `extensionBindings` are refused before launch; this prevents explicit
  binding forgery, not foreground inheritance. Briefs must not treat the guard as enforcing
  a separate no-push right on a granted lane's foreground descendants.
  Installed homes adopt it only after a lock bump.

## Recorded timing seam

`extensions/call-timing/index.ts` retains assistant metadata `loopPiTiming` with
`{firstTokenAt: epoch ms | null, attempts: null, processingMs: int | null, headers: {x-request-id?, x-ratelimit-remaining-requests?, x-ratelimit-reset-requests?, service-tier?}}`.
The root launcher loads it, and both loop-guard root and dispatcher register it as a required
child extension (including children declaring `extensions: []`).

- pi 1.0.4 supports `after_provider_response` with response headers before stream consumption,
  `message_update` with normalized assistant deltas, and `message_end` replacement before session
  persistence. No provider, request payload, retry policy or upstream behavior is changed.
- `firstTokenAt` is the local `Date.now()` at the first nonempty text, thinking or tool-call delta,
  not stream start, an empty delta, or a guessed timestamp from final content. It measures extension
  delivery of normalized content, not raw HTTP bytes or a provider's token clock. A response without
  such a delta has null timing. Turn/session boundaries clear state; the last observed response's
  headers replace rather than merge earlier responses. Hooks without an active turn are ignored.
- Only the four named response headers are retained, matched case-insensitively and stored with
  lowercase names. No request headers or full response headers are recorded. `processingMs` is the
  nonnegative 32-bit integer supplied by `openai-processing-ms`, or null if absent/invalid; no
  rounding, truncation or inference from elapsed time. `service-tier` is a response header only,
  never substituted from the request setting or response body.
- `attempts` stays null: pi's provider-internal retries have no authoritative extension counter.
  Catalogue readers use `firstTokenAt - message.timestamp` for `ttft_ms` and explicit
  `attempts` / `processingMs` only, with absent or invalid values NULL. Null attempts is compatible
  with the existing reader; natural live evidence remains open.
- The response-header event has no request identity. This emitter scopes observations to the
  agent's serialized turn, not arbitrary nested model calls or idle cache warming. Providers that
  do not implement pi's instrumentation hooks yield missing headers, not invented values.

## Request ceiling

`extensions/request-ceiling/` is installed by both loop-guard entries (`installRequestCeiling`), so
the root and every lane carry it. pi 1.0.4 has no wall-clock bound on a streaming request:
`httpIdleTimeoutMs` is an idle timer reset by every streamed event, so a model that keeps streaming
reasoning never trips it, and the provider `timeoutMs` (`retry.provider.timeoutMs`) is cleared once
response headers arrive. The output budget is pi's model `maxTokens` (sent as `max_output_tokens`),
set per model in the home's `models.json` `modelOverrides`.

- Settings: `loopPi.requestCeiling: {wallClockMs, maxFollowUps}`; defaults 840000 (under the
  watchdog's 15-minute stall reading) and 2. A wall-clock value that is not a positive number within
  Node's timer range falls back to the default; `maxFollowUps: 0` surfaces every incident without
  starting a turn. `session_start` resets the chain.
- The timer runs from `turn_start` (one model request per agent-loop turn; a retry is a new turn)
  to the assistant `message_end`. If it fires first, `ctx.abort()` ends the run.
- An assistant `length` stop with no text and no tool call is rewritten at `message_end` to
  `stopReason: "error"` with `EMPTY_LENGTH_ERROR`, which matches neither pi's retryable nor its
  context-overflow patterns: no identical retry, no compaction, and loop-continuation skips the
  error outcome instead of nudging.
- At `agent_settled` either incident sends one `loop-request-incident` message with
  `triggerTurn: true`, up to `maxFollowUps` in a row; any `stop` or `toolUse` response resets the
  chain. Past the limit the message is appended without a turn and the `-exhausted` incident is
  written; the session then stops for the watchdog to see.

## Retry backoff

`installRetryBackoff` (in `extensions/request-ceiling/`, `backoff.ts` for the pure delay function)
is installed by both loop-guard entries next to `installRequestCeiling`. pi 1.0.4's agent-level
retry waits `retryDelayMs(settings.retry, attempt)` (`pi-ai` `utils/retry.js`): `baseDelayMs *
2^(n-1)` capped at `maxAgentDelayMs`, no jitter and no split by status. That wait cannot be replaced
from an extension, so the extension adds a wait in front of it.

- Seam: pi awaits extension `agent_end` handlers before `_handlePostAgentRun` decides to retry and
  sleeps its own delay, and `ctx.signal` is the live run's signal there, so an abort ends the wait.
  The retry decision uses pi-ai's public `isRetryableAssistantError`, `isContextOverflow` and
  `retryDelayMs`. pi's attempt counter is private; the extension mirrors it (increment per retried
  error, reset on any non-error assistant `message_end` and at `agent_settled`, when pi's is zero).
- Totals: a 429 (`429`, `rate limit`, `too many requests` in the error text) waits a flat
  `loopPi.retryBackoff.rateLimitDelayMs` (default 60000) including pi's delay. A 5xx (a `5xx`
  status, `overloaded`, `service unavailable`, `server error`, `internal error`, `bad gateway`)
  waits pi's delay plus a random extra in `[0, 0.5 * pi's delay)`. Every other retryable error keeps
  pi's delay. Errors pi does not retry get no wait. `settings.retry` and `httpIdleTimeoutMs` stay
  pi's own; without the extension pi's backoff is unchanged.
- pi's `auto_retry_start` event still reports only pi's own `delayMs`, and is emitted after the
  extension's wait.

## Test harness

- Tests live beside the code as `*.test.ts`, run with `node --test` from the repository root (Node 26 strips
  types). `node --test extensions/<name>/` must run one suite; `npm test` runs all.
- Live models are never used. `extensions/test-support/faux-extension.ts` registers provider
  `faux`, model `faux-1`, scripted by `LOOP_PI_FAUX_SCRIPT` (rules matched against the latest
  non-assistant text; see its header). Proven: a bash tool call and follow-up reply under
  `--mode json`. Load it with `--extension` in root and children (register it as an extra
  required child extension in child tests).
- CLI: `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. Every test run uses
  a fresh `mkdtemp` `PI_CODING_AGENT_DIR` and `PI_SUBAGENTS_TEMP_ROOT`, plus `PI_OFFLINE=1`,
  `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`. Never touch `~/.pi` or `~/.loop-pi-personal`.
- `test-support/` and `fixtures/` directories are excluded from installed builds.

## Cross-extension contract (`pi.events`, synchronous handlers)

`pi.events.emit` runs handlers synchronously until their first `await`; handlers below must reply
before any `await`. A missing reply means the provider extension is not loaded; callers fail safe.

- `loop-wait:query-timers` `{ reply(timers: { id: string; at: string /*ISO*/; reason: string }[]) }`
  - loop-wait root answers with every armed, unfired, uncancelled timer.
- `loop-wait:arm-timer` `{ at: string /*ISO*/; reason: string; reply(r: { id: string; at: string }) }`
  - loop-wait root arms a timer exactly as `wake_at` would.
- `loop-wait:query-watchers` `{ reply(ws: { id: string; label: string; pid: number; phase: string }[]) }`
- `loop-continuation:query-launch` `{ cwd?: string; reply(r: { reportPath: string; opsPath: string | null; ops: object | null } | null) }`
  - loop-continuation answers from its frozen launch state. `ops` is the parsed ops file read and
    hash-checked once at launch detection; a missing, mismatched or invalid file gives `ops: null`
    and an `incidents/ops/` record. Later edits to the file are ignored.
- `loop-guard` needs "is any async subagent run active" for its root rule. It owns detecting that
  (pi-subagents public API if one exists, else tracking `subagent` results and `subagent-notify`
  messages). No other extension provides it.

## Names and paths

- Model-facing tools: `watch_process` (root and lane entries), `watch_start`, `watch_stop`,
  `wake_at`, `wake_cancel` (root only).
- Custom message types (these start root turns, parsed by `parse_pi.py`): `loop-watch` (watcher
  exit or deadline), `loop-wake` (timer fired), `loop-continuation` (nudge), `loop-request-incident`
  (request ceiling follow-up; also starts lane turns). Persisted state uses
  `pi.appendEntry` with `customType` `loop-wait-state` and `loop-continuation-state`.
- loop-wait run dir: `<agentDir>/loop-wait/<sessionId>/`, receipts at
  `<run-dir>/receipts/<watch-id>.json` with fields (`phase`, `observations`,
  `last_observed_at`, `deadline`, `result`, `pid`, `command`, `interval_s`), written atomically
  (write temp + rename). Watcher output at `<run-dir>/logs/<watch-id>.log`.
- Continuation incident files: `<agentDir>/incidents/<sessionId>-<UTC timestamp>.json`.
- Request incident files: `<agentDir>/incidents/request/<sessionId>-<UTC timestamp>-<kind>-<attempt>[-exhausted].json`,
  `{v: 1, session, class, at, home, cwd, model, elapsed_ms, wall_clock_ms, attempt}` with class
  `loop-request-wall-clock-ceiling` or `loop-request-empty-length-stop`, plus `-exhausted` when the
  follow-up chain is used up. A subdirectory, because the watchdog moves any top-level incident
  whose class is not the continuation class to `bad/`.
- Transcript sync trigger (loop-continuation, `transcript-sync.ts`), aligned with the Claude/Codex
  hooks: spawn detached `python3 <agentDir>/scripts/sync-transcripts.py --home <agentDir>` under
  `/usr/bin/lockf -k` on the same `$TMPDIR/.agent-transcript-sync-<home>.flock` those hooks use, when
  the script exists. Checkpoints on `input`, `tool_execution_end` and a 60-second session ticker run
  at most once per 5 minutes after the last successful upload of either kind
  (`<agentDir>/.transcript-checkpoint-state.json`, shared by every pi process on the home) and skip
  when an upload holds the lock. `agent_settled` and `session_shutdown` always upload, waiting up to
  120 s for the lock. A python wrapper inside the detached process group bounds each upload
  (checkpoint 90 s, lifecycle 180 s) and kills the group, lock included, so a hung upload outlives
  neither its bound nor the pi process. Lanes load required child extensions even when their agent
  files declare `extensions: []`: the dispatcher registers `loop-guard/lane.ts` and, when present,
  `loop-wait/lane.ts` at `session_start` with `requireForAllRunners: true`. Registration failure
  refuses dispatch; runners that cannot honour the required extensions are refused, and required
  extension load or startup failure aborts the child before its task runs. This does not load
  loop-continuation in lanes: the root's ticker uploads their transcripts. pi homes are Mac-only; without lockf,
  uploads are not serialised across processes.
  Ignore failures. The installer lays the script out only when an overlay provides it.
- The agent set (the only names the root may spawn): `mapper`, `mapper-deep`, `gate-runner`,
  `lane-worker`, `lane-worker-push`, `lane-worker-low`, `lane-worker-low-push`, `lane-worker-retry`,
  `lane-worker-retry-push`, `complex-worker`, `complex-worker-push`, `reviewer`, `reviewer-high`,
  `security-reviewer`, `rescue-sol`, `rescue-astra`, `ops`, `ops-probe`, `triager`.
- Every agent file sets `inheritGlobalContext: false`; the installer appends the home's
  `lane-policy.md` after a `<!-- lane-policy -->` marker instead. An overlay may replace
  `lane-policy.md`, so the return contract is not in it: every agent but `triager` carries the
  `lane-return` v2 block in its own body, and `triager` its `triage` block.
- A return with no usable `lane-return` block is ultimately `failed`. Model-root `loop-state`
  first attempts exactly one package-owned resume asking for the block, correlating the revived
  run to the original lane and run; a refused resume or another missing block falls back to failed
  without recursive resumes or duplicate accounting. Each native resume has its own dispatch and
  return under the package's new run id. Ordinary tool resumes inherit the recorded source brief
  unless a replacement brief supplies a new lane/task; unknown or ambiguous sources are not guessed.
  A block-only recovery dispatch additionally records `recovery_of: <original run id>`: its live
  lifecycle is independent, but it never replaces the task's implementation dispatch or outcome.
  The recovered block is returned separately for the original run, preserving any original failure.
  Restarts restore that linkage without issuing another resume. Older unlinked, overlapping runs
  remain conservative: a first non-complete outcome from overlapping work prevents a later complete
  outcome from hiding unfinished work, but replayed returns never replace a live successor's state.
  Stale `landed: true` claims remain attached to the task of their own dispatch and constrain admission
  without terminating a live successor. The older landed-claim safety contract below is unchanged.
  The dispatcher retains immediate failed behavior. `loop-state` folds a `gate-runner` dispatch into
  a live lane only, never a task.
- Root extensions also include `loop-state/index.ts`: it appends `dispatch` and `return` to
  `codex/state-<stem>-loop<N>.jsonl` (sibling of the report) through `<agentDir>/bin/loop-state`
  for `subagent` calls whose brief starts `Lane: <id> · Task: <id> [(<title>)] · Tier: ...`, and injects the
  recovery digest (`loop-state-digest`, no turn) after compaction and at session start.
  Admit metadata may include resolved `tier` (`routine` or `guarded`) and `surfaces` (explicit
  ops surfaces or guarded owned-path matches). Dispatch metadata preserves `tier`, `surface`,
  `kind` and explicit constituent `tasks`. `Ops surface:` takes precedence over `Surface:` in
  a brief. Native reviewer launches emit `kind: review`; a `Tasks:` line or comma-separated task
  header identifies constituents, whose admitted maximum tier is used only when every tier is
  known. Historical missing metadata stays unknown, never inferred from an agent name.
  Digest/query audit counts split implementation dispatches, review dispatches and reported
  CodeRabbit reviews by known tier, with a separate unknown bucket. These fields are telemetry,
  not authority or enforcement inputs.
  pi-subagents' async events carry `sessionId` as the parent's session file path
  (`getSessionFile() ?? getSessionId()`) and `deadlineAt` in epoch ms.
- Lane timers: loop-wait root arms a timer on `subagent:async-started` for this session (brief
  `Deadline:`, else `deadlineAt`, else `timeoutMs`) and cancels it on `subagent:async-complete` by
  run id.
- Close-out: at settle, loop-continuation reads `loop-state digest --json`; with no live lanes, no
  admissible task and nothing else armed it nudges `close-out` instead of releasing a WAITING.
  WAITING and PAUSED lines are matched after stripping leading `[\s*_`>-]` and trailing
  `[\s.!*_`)]` decoration.
- Ops lanes: the root binds `{"loop-pi.guard/1":{"agent":"ops","surface":"<id>","entry":{...}}}`
  only for a surface in the frozen ops file with no active ops run on it. `ops-probe` binds the same
  way, only to a `kind: probe` entry. Allow patterns need no leading `^`: the lane full-matches. The lane allows a
  lane-forbidden command only on a full `^(?:pattern)$` match of `entry.allow`, a secret write only to
  an exact `entry.secret_paths` member, and credential creation only for kind `credential-create`.
  Single-flight is a kernel flock under `~/.local/state/loop-pi/ops-locks/<surface>.lock` (override
  `LOOP_PI_OPS_LOCK_DIR`); coverage is per machine. Every lane is refused writes to `codex/ops-*`,
  `codex/state-*` and `codex/goal-*`, and under protocol 2 `codex/grants-*`.
- Dispatcher: `loop-pi-dispatch[-variant]` runs a pi session with only `dispatcher/index.ts` and the
  in-process `loop-dispatch/idle` model, which answers pi-subagents' completion turns without a
  model call. It spawns lanes over the `subagents:rpc:v1` bus with the same identity binding and
  fail-closed child registration, writes every state event itself, and runs `loop-pi-audit
  closeout` and `loopPi.onClose` (argv lists with `{log}` and `{report}`) before it exits.
  A composed gate is green only for a parsed return with status `complete`, `exit` 0 and a `sha`
  that is null or the gated tip; the `gate` event records the reported exit (null stays null) and
  SHA. A run pi-subagents reports failed or timed out (`success: false` at the top level or on
  `results[0]`, `results[0].timedOut`, or `results[0].outputPartial`, which pi-subagents emits since
  0.76.0) never counts as complete, whatever its lane-return block says.
  - Dispatcher: a failed gate run is red with its exit recorded as null; a failed triager parks its
    task. A work lane that may have pushed without finishing parks for its owner and stops new work
    (never gated, never retried, closes `blocked`): a failed run whose block claims landed, a
    `partial` or `blocked` return that claims landed, or any return without a complete landed claim
    whose task's owned files changed on main since its dispatch base (owned files are disjoint across
    live lanes, so such a change is this lane's). A fetch that fails throws instead of reading a
    stale `origin/<branch>`: before a spawn it refuses that spawn, parks the task with the fetch error
    and stops new work (closes `blocked`); a park whose main check fails says so in its reason.
  - `loop-state` (model roots) records a failed run's return as failed but keeps the block's
    `landed`, `sha` and other fields, so its digest never re-admits a task whose lane may already
    have pushed, and shows such a task as `landed:<status>` rather than a clean `landed`.
  Every land is `mode=after-green`; there is no land before green. The dispatcher reads LOOP.md exactly as `loop-state` does (nothing stripped).
- Red baseline: LOOP.md may carry `baseline-red: <TASK-ID> - <reason>` (main is known red; the named
  task owns making it green). The dispatcher predicate refuses that repo before `open`, so only an
  LLM root runs it. That root's composed
  gate runs on the batch's base SHA and on the integrated SHA, counts as green when every check or
  test failing on the integrated SHA also fails on the base SHA, and records both failing lists in a
  `judgement` event. `gate-runner` gates both SHAs when the brief's Gate line names a base.
- Runtime entry: each session appends `loop-pi-runtime` `{v:1, variant, models:{<id>:{service_tier}}}`
  at `session_start` (variant from the home receipt's `variant`).

## Protocol 2

A root armed by this build writes `$LOOP_PI_RUN_DIR/loop-pi-proto` (`2\n`). Pre-execution refusals
remain marker-gated; a lane that observed protocol 2 retains that decision for its session. Arming
also retains protocol evidence in the existing audit snapshot without resnapshotting remote refs.
Deleting the marker cannot downgrade or suppress closeout, including after session restoration;
this does not enable marker-gated root or newly loaded child refusals retroactively. A root armed
by an older build keeps its old behaviour after an install. Arm-time refusals cannot be gated
(arming writes the marker). The threat model is a mistaken root or lane, not an adversarial one: edit and write
paths are exact, bash write detection is best-effort.

- **Arming** happens in the `input` hook: "You are the root" plus one report path, or a bare
  `launch-*` path. It refuses (returns `handled`, no model turn) with no run dir, a cwd whose git
  toplevel is not the goal's repository, a goal `## Run` `host:` other than this machine, a
  missing goal, or a launch `Ops grants:` / `Audit grants:` / `Standing:` line whose path or sha256
  differs from the goal's `## Authority` `ops:` / `audit grants:` / `standing:` line (a goal `none`
  or no line means the launch carries none; a relative goal path resolves against the goal's
  repository; more than one launch line or a malformed one is a mismatch); incident
  `incidents/root/<sid>-<UTC>-arm-refused.json`. A first input naming a
  `codex/goal-*.md` path that does not arm gets a visible relaunch warning. On success it writes the
  marker, freezes `Ops grants:` and the optional `Audit grants: <abs> sha256=<hex>` (copy at
  `<run dir>/audit-grants.json`; a bad hash gives none and an `incidents/ops/` record of class
  `loop-audit-grants-rejected`), freezes the optional `Standing: <abs> sha256=<hex>` (the
  standing-authority registry entry; copy at `<run dir>/standing.md`; a missing file or bad hash
  gives none and an `incidents/ops/` record of class `loop-standing-rejected`, and the arm still
  succeeds), and appends `open` `--by ext` when the log has none.
  `loop-continuation:query-launch` adds optional `auditGrantsPath`, `auditGrantsSha256`,
  `standingPath` (the frozen copy) and `standingSha256`.
- **Run-dir files** (root and lanes may not write them, except inside `worktrees/l<32 hex>/`):
  `loop-pi-proto`; `harness-facts.jsonl`
  `{v:1, ts, kind: compaction-failed|quota-exhausted|context-overflow, session, detail}`;
  `push-log.jsonl` `{v:1, ts, actor: root|lane, agent, lane, repo, remote, ref, old, new}` written
  by loop-guard after every successful push (`old` from `ls-remote` before it; `new` is the local
  commit the refspec's source named, logged only when the remote ref now equals it, so a foreign
  push after it is never absorbed and a no-op push logs nothing) and every successful `gh pr merge`
  (`old` the remote base branch before, `new` the PR's merge commit, only when it is MERGED and the
  base branch equals it); `repo` is the main checkout (`dirname` of the common git dir, so linked
  worktrees match), `--show-toplevel` only as a fallback. Only a push spelled as its own shell
  command is logged, so a lane's bash call that runs `git push` or `gh pr merge` inside an
  interpreter's code or stdin script, a git alias's shell body or unparseable text is refused, as is
  any push through `watch_process`; an undetected one (a script file, a task runner) is unlogged and
  the audit reports it UNGRANTED; `audit-grants.json`; `standing.md`;
  `returns/<runId>.md`; `worktrees/l<32 hex>/`. The lane binding carries optional `runDir`.
- **Ops command forms**: known interpreter network clients require a match against the frozen
  surface's full enclosing command. Compound commands, nested shells and stdin scripts cannot
  inherit a grant for only an inner invocation; wrapped forms require their complete form to be
  explicitly allowed. Unparseable known-network commands always fail closed, including wildcard
  grants. Granted literal curl/ssh forms and local-only parsing
  remain usable. This is an honest-mistake fence, not a sandbox or a new endpoint permission.
- **Idle-parent wake (pi-subagents 0.76.1):** a notice to an idle root is appended with
  `triggerTurn: false`, which pi emits to RPC/UI listeners but to no extension `message_start` or
  `message_end`; pi-subagents then starts the turn with the extension-sourced user message
  `Subagent updates above.` (`source: "extension"`). A busy root still gets the notice as a steer
  with message events. So: loop-continuation counts that wake input as the push that resets the
  nudge chain; loop-guard releases a run for `watch_process` on `subagent:async-complete`, never on
  a notify message; the dispatcher lets the wake prompt through to its idle model; and the lane caps
  its own return (below).
- **Return cap** (lane: loop-guard's lane entry at the child's assistant `message_end`; root:
  loop-state at `message_end`, plus the `context` hook for already-stored messages).
  - Lane: the last non-empty text part of an assistant message with no tool call and no error (the
    part pi-subagents' `getFinalOutput` returns) over 14,336 bytes becomes up to its first 4,096 bytes, an
    omission line naming `<run dir>/returns/lane-<lane id or session id>-<sha16>.md` (the full
    text), the last `lane-return` block if not wholly kept in the head or tail, and up to its last
    6,144 bytes. It is
    replaced in place without its text signature; other parts are untouched. With no run dir it is
    left whole. Every child that loads the lane entry is capped, foreground children included, and
    the lane's own session keeps only the capped text. A lane's output, its async-complete payload
    and pi-subagents' saved output file are therefore the capped text: the `return` event is parsed
    from it, and the full text is behind the lane's omission line.
  - Root: a `subagent-notify` message over 16,384 bytes becomes up to its first 6,144 bytes, an
    omission line naming the full copy, up to its last 8,192 bytes and the last `lane-return` block
    if not wholly kept in the head or tail. With no run dir it is left uncapped. The dispatcher's RPC completion path applies the same
    cap. The full copy is pi-subagents' saved output only when its structured completion (the
    async-complete payload's single result `savedOutputPath`, for the notify's own last
    `Retention-managed async directory:` line) or a reference-only marker on the first line of the
    lane's output names it; a path in the return body is never used. Otherwise `returns/<runId>.md`.
  - Either cap: the head ends before the earliest `lane-return` opener with no closing fence
    inside the kept head, including earlier blocks and incomplete opener header lines. A protected
    block wholly inside the head is not appended again. Head and tail are UTF-8-safe maxima, not
    guaranteed lengths: reserve the last complete block's byte length, the marker's byte length
    computed with the full input byte count, and three newline bytes before allocating the head,
    then the tail from the remaining budget. Every non-null capped result stays within its cap,
    including the protected block and marker. A cut is supported when that reserve fits the cap
    and both real consumers, `loop-state/core.ts` and `dispatcher/brief.ts` `parseLaneReturn`,
    preserve their exact outcomes before and after the cut. Their fence grammar and malformed-block
    handling differ; neither outcome may change. For example a usable 12 KiB last block fits the lane cap with a full-copy
    path of up to 1,024 UTF-8 bytes (and an input byte count of up to 16 decimal digits). If the
    block or marker cannot fit, or the cut changes either parser outcome, leave the text whole
    rather than truncate the structured return, promote a stale success or lose the full-copy
    reference. In particular, the last fenced block can be malformed or otherwise unusable;
    protecting it alone must not hide an earlier latest usable failed return. Both cap boundaries
    preserve that failure exactly by declining an unsafe cut, and still retain the full copy.
    These deterministic oversized/unsafe-cut fallbacks, like a missing run dir, do not promise
    the byte cap. Malformed or annotated trailing fences that change neither outcome may still cap.
  - Limit: an idle-wake notify (no root extension can rewrite it) holds one capped lane return in
    16 KB with its framing, but pi-subagents batches completions that finish together into one
    notify, which is stored at their sum. The `context` hook still caps what the model sees.
- **Closeout**: `/loop-closeout` (loop-wait) emits `pi.events.emit("loop-closeout", {lines, pending})`
  after its sweep; loop-continuation runs
  `loop-pi-audit closeout --run-dir <rd> [--grants <rd>/audit-grants.json --grants-sha256 <hex>] --push-log <rd>/push-log.jsonl`,
  lane-worktrees adds its sweep, and the root gets one `loop-closeout-audit` custom message (a push
  that resets the nudge chain).
- **Incidents**: `incidents/root/<sid>-<UTC>-context-overflow.json`
  `{v, session, class: loop-root-context-overflow, at, home, cwd, live_runs, detail}`, once per
  overflow episode while a lane is live. `loopPi.onIncident` (argv list, `{file}` replaced) runs
  detached for root incidents; failures are ignored.
- **Lane worktrees** (`lane-worktrees/`, root only): named single-agent `subagent` launches requesting
  `isolation: "worktree"` or `worktree: true` with `Landing: returns candidate`, `pushes branch` or
  `lands-after-green` use root-owned retention. Allocation binds the retained cwd and explicitly
  sets `worktree: false` to suppress native package allocation. Complete, partial and blocked
  checkpoint returns do not release the tree; same-protocol resume uses the existing run/context
  in that cwd. State records each run's relative cwd; resume (including after reload) requires a
  unique run match, the original allocation and a directory-only, symlink-free walk of that cwd
  inside the worktree. Missing cwd evidence or an ambiguous prefix refuses resume.
  A root `land` or `park`, or explicit root closeout, may release a clean terminal
  tree; session quit/reload alone never releases candidates. Live, unknown and dirty trees remain
  kept. Branch/path components use neutral stable opaque run/lane identifiers, not brief text,
  tracker IDs or private labels; extension state keeps the original lane-to-allocation mapping.
  Gitdir pointers become equivalent relative targets after canonical target and HEAD verification.
  The allocation marker is `<common-git-dir>/worktrees/<id>/loop-pi-allocation`.
  Failed launches undo only their own allocation and delete its branch only if it still points to
  the recorded allocation base. After session start, earlier runs remain live
  until their async `status.json` is terminal; absent status keeps them. Merged branches may be
  removed on authorised release, unmerged branches retained. State entry: `lane-worktrees-state`.
  Under protocol 2, governed named single-agent tool launches not intercepted for root-owned
  retention (including omitted worktree flags resolved by package defaults and missing or
  unsupported Landing) bind version-1 lane metadata with an opaque `r<32hex>l<32hex>` key derived
  from the canonical run directory and original lane/task pair. Explicit shared-cwd requests,
  workflows, conflicting shapes and RPC launches keep their existing handling. Existing lane
  fields are preserved; malformed lane version/key is refused before naming is changed, and
  the package still validates all other fields. The original brief, task identity and guard-owned
  `extensionBindings` are unchanged. Optional `nativeNames [{key,lane,task,runs}]` in
  `lane-worktrees-state` records native launch and tool-resume run correlations when results provide
  a run id; multiple naming-identity prefix matches refuse, while package validation remains
  authoritative for target resolution, ownership and revival. This map is best-effort correlation,
  not allocation or cleanup authority: it neither rewrites old refs nor changes package cleanup
  or guarantees native resumability. Existing root-owned retained-worktree release rules are unchanged.
  Durable patch retention is separate: `lane-patches-state` correlates named single-agent tool
  and dispatcher RPC runs. Lifecycle completion, startup reconciliation and shutdown copy patch
  bytes into `<run-dir>/lane-patches/<sha256(run-id)>/` outside the package's prunable async tree.
  Content-addressed blobs and a locked, fsynced manifest preserve versions and exact lane/run/task
  identity. Capture rejects symlink/conflicting authority and warns on journal failure without
  skipping byte capture. The package's pruning and version pins remain unchanged.
  `lane-worktrees:patch-decision` is a trusted extension-bus event with exact `runId` and
  `decision: landed|rejected`; matching recorded content hashes are required before any future
  cleanup is permitted. Task-only land/accept, child completion, park and closeout never change
  disposition. No automatic root decision producer or durable cleanup caller is enabled:
  missing decisions conservatively retain copies indefinitely. This does not retain workflows
  or multi-agent launches, restore already-pruned bytes, or change retained-worktree release.
- **loop-guard, root**: refuses `loop-state` with `--by ext|daemon|dispatcher`, a `by=` field other
  than `root`, `--run-dir`, a stdin `by` field or an `append` event on stdin from a file (`< file`),
  edit/write into the run dir, `~/repos/agent-docs/authority/` or the planner's
  `codex/ops-*`, `codex/grants-*`, `codex/launch-*` and `codex/goal-*` (exact for edit/write, best
  effort for bash), a second `subagent` status for the same target with no wake since (a return,
  `loop-watch`, `loop-wake`, input, session start or compaction), and `bash` timeouts over 900 s.
  **Lanes**: `codex/grants-*` and authority writes, `gh pr merge` outside an ops `release` surface.
- **loop-state**: `land` is `after-green` only (legacy `pre-green` lines still check and digest);
  `revert` by root with `reason=root-decision`; `park needs=budget`; `close reason=budget` needs a
  `compaction-failed` or `quota-exhausted` fact; judgements up to 4 KB; one `open` per log.
- **loop-pi-audit**: under retained protocol 2 evidence a default-branch move is granted only when every commit in
  `before..after` lies in a push-log `old..new` range for that repo and ref, touches only
  `backlog/`, or lies in a range a declared `bot_actors` login (`<login>[bot]`) itself pushed or
  merged, per GitHub's activity API; commit metadata grants nothing. A default-branch grant entry is
  ignored with a warning.

## Declared heavy gates

Only explicit `- gate: <name> | <exact command>` lines under LOOP.md's `## Mutexes` declare heavy gates. Names are case-sensitive ASCII identifiers (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`); the command is the remainder after the first `|`, with surrounding whitespace removed. Names and commands must be unique. Ordinary mutex prose remains advisory; entries outside this section and fenced examples are not gates. Malformed explicit entries fail closed.

Run a declared gate using a direct name-only `loop-gate-lock <name>` invocation on a shell-running tool. Both loop-guard entries refuse context-changing prefixes (`cd`, `env`, assignments, interpreter/shell wrappers), pipelines, compound commands, redirections and unsupported/unparseable shell forms around the wrapper. The guard evaluates the local worktree declaration against all existing rules and shared hooks, then replaces the tool's command with a shell-quoted wrapper invocation carrying guard-owned `--cwd <canonical execution cwd>` and `--sha256 <hash of the exact LOOP.md bytes>`. Model-supplied binding flags are refused. The public CLI executes in that bound cwd, independently of the calling shell's cwd and Git environment; it reads LOOP.md once and refuses a digest mismatch. Outside guarded tools, the CLI's name-only form discovers the local worktree by walking canonical cwd to `.git`, not by querying Git environment variables. Binding flags must be supplied together.

Explicit `git push` and `gh pr merge` declarations, including the existing parser's recognized wrappers, aliases and interpreter forms, are refused as gates for root and lanes: the gate wrapper has no attributable remote-move audit plan. Run remote moves as separate audited bash calls. This does not expand detection to concealed task-runner/script-file behavior.

The CLI runs the declared command with `/bin/bash -c` in the approved cwd, holding a kernel `fcntl.flock` until the child finishes, forwarding termination signals, and preserving the child's exit or terminating signal. The child inherits the flock descriptor, so killing the supervisor cannot release the lock while that descriptor remains open. Lock files are never unlinked on release.

The invariant production domain is **one OS account on one machine**, across all its repositories, worktrees and pi homes. The lock directory is the OS account database's home plus `.local/state/loop-pi/gate-locks`; the file is `<sha256(name)>.lock`. HOME, TMPDIR and LOOP_PI_GATE_LOCK_DIR cannot select a different domain; there is no CLI/environment test-domain override. Every directory component is opened relative to a held fd without symlink following. Ancestors must be root/account-owned and not group/other writable; account-home and state directories must be account-owned, with gate-locks exactly 0700. Lock files must be account-owned regular files, exactly 0600, with one hard link and no symlink. Unsafe paths fail closed rather than changing permissions or provisioning other users. Gate children do not inherit LOOP_PI_RUN_DIR, LOOP_PI_REPO, LOOP_PI_GATE_LOCK_DIR, GIT_* variables, BASH_ENV or ENV.

This remains the existing honest-mistake fence, not an OS security boundary against adversarial same-account code or deliberately concealed script/task-runner commands. There is no cross-user, cross-host or network-filesystem serialization guarantee. Proving tests use real account-domain locks with unique test names; private-path validation fixtures substitute account metadata only inside unit tests.

## Root activity and watch lifecycle events

The frozen version-1 state-log bodies are `watch {op: "start" | "stop", what: string, deadline: string}` and `heartbeat {at: string}`. Existing framing (`v`, `seq`, `ts`, `by`) is unchanged; extensions append with `by=ext`. No additional event fields are introduced.

- `loop-wait:state-event` carries `{event: {ev: "watch", op, what, deadline}, reply(recorded: Promise<boolean>)}`. The loop-state root replies synchronously, before awaiting, with the append outcome. Missing reply or a false outcome leaves the event pending in the branch-local `loop-wait-state` snapshot for restart. Successful recording removes that pending event. The root wait entry drains outstanding recording on orderly shutdown. Delivery is causal per instance (`what` plus `deadline`): a pending start is retried before its stop and must be acknowledged before that stop can be sent. A missing, false or rejected acknowledgement leaves the head and every successor durable in order. A later lifecycle event or restart retries the head; unrelated instances proceed independently. A transition arriving during an in-flight attempt stays queued behind it; if that attempt fails, both remain durable for the next trigger or restart. There is no idle retry loop. A start written before its acknowledgement was lost uses whole-instance exact-event deduplication before its stop is delivered. An unwritten start cannot be replayed after an acknowledged stop and falsely reopen that instance.
- `what` names an instance, not only a reusable label: `watch <id>: <label>` for processes, `wake <id>: <reason>` for timers. `deadline` is the exact ISO deadline stored by the corresponding manager. Stop reuses the start's `what` and `deadline`. This preserves the frozen schema and allows correlation and deduplication across restarts and repeated labels.
- Start is emitted by successful watch creation/timer arming (including continuation-owned and lane-deadline timers). Stop is emitted at process completion, deadline, explicit stop/cancel, closeout, orderly shutdown, and terminal reconciliation, independently of wake-message delivery/suppression. Replaying a timer start or terminal reconciliation does not append a duplicate exact event.
- Heartbeats observe root `turn_start`, root tool execution start/end, and assistant `message_end` only when a launch is armed. Session startup, timers, receipt polls, custom notifications and idle ticks are not root activity. There is no heartbeat timer. The log writer serializes and deduplicates heartbeat attempts under its append lock: first activity is recorded, then only activity at least 300 seconds after the last recorded heartbeat (including across restart, with backward clocks suppressed).
- `loop-state check` accepts new and old logs. Digests preserve legacy task/lane classification and expose new watch/heartbeat information only in logs that have these events; old digest output stays unchanged.

The protocol event table is owned by the protocol source. No authority fences, budgets, pins, model selection or dispatcher behavior are changed.
