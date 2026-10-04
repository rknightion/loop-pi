# loop-pi extension seams

The contracts the extensions code against. A change to one of them is made here first, then in
every extension it touches.

Comments in the source cite sections of the original design plan (C3: the agent set, C4: the
guard rules, C5: the preflight, C7: the continuation contract). This file and the tests are the
public statement of those contracts.

## Runtime facts

- pi 1.0.2 loads `.ts` extensions through jiti. An entry file default-exports
  `(pi: ExtensionAPI) => void | Promise<void>`. Type imports come from
  `@earendil-works/pi-coding-agent`; `@earendil-works/pi-ai` and `typebox` are pi's dependencies,
  not ours, and resolve through pi's loader at runtime. pi 1.0.2 publishes no
  `npm-shrinkwrap.json`, so npm hoists them to the top-level `node_modules`; never rely on either
  layout (`tsconfig.json` lists both, and the loop-wait test hook resolves from pi's directory).
- **Project trust (pi-subagents 0.75.0):** children follow the parent session's project trust, so
  with `defaultProjectTrust: "never"` a child no longer loads the target repository's `.pi/`
  settings, system prompt files, skills or extensions. Agent discovery is not trust-gated:
  repository `.pi/agents` and `.agents/*.md` still outrank the home's agents. `loop-pi-preflight` stays.
- **Tool list (pi 1.0.2 / pi-subagents 0.75.0):** `toolActivation` is `"eager"`; never `"auto"`.
  codex-lb never acknowledges a request carrying an `additional_tools` item, which pi sends for a
  mid-conversation tool addition when a model's `compat.supportsAdditionalTools` is true. The overlay
  sets that and `supportsToolSearch` false for every family model, so a changed tool list is resent
  whole (proved live 2026-10-01: 120 s `upstream_request_timeout` with the flags on, 1.6 s with them
  off). pi's built-in extensions are switched off in `settings.json`; `bg_wait` and
  `subagents_enable` are excluded at the launcher. Unused pi-subagents feature groups are in
  `disabledFeatures`; `workflow-scripts` stays enabled and guarded, because disabling it swaps
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
  the module instance pi-subagents itself uses. pi-subagents 0.75.0 fails the child launch closed
  when a required child extension fails to load or throws during startup ("Required child extension
  failed during startup"), so a lane-guard startup error aborts the lane rather than running it unguarded.
- pi-subagents 0.75.0 appends a row for every launched async child (agent, outcome, duration and a
  sha256 `taskHash`; the task text itself is stored as `[redacted]`) to `<agentDir>/run-history.jsonl`
  in the loop-pi home, not the target repository.
- Non-TTY stdin: pi in `--mode json`/`--print` waits on stdin. Tests close it (`stdio: ["ignore", ...]`
  or `</dev/null`). RPC mode keeps stdin open by design.
- **Push grant (async single-agent launches):** the root guard overwrites the entire
  `extensionBindings` tool input with `{"loop-pi.guard/1":{"agent":<selected agent>}}` after
  validating the launch. pi-subagents 0.75.0 delivers it in `PI_SUBAGENT_EXTENSION_BINDINGS`
  to the detached child. For directly bound detached children, only `lane-worker-push`,
  `lane-worker-retry-push` and `complex-worker-push` may make plain `git push`;
  a missing, malformed or unknown identity
  denies pushes. The lane guard applies this to `bash` and `watch_process`, including the
  existing parser's wrappers, aliases and fallback scan. Force pushes remain blocked for all.
  The real-CLI faux-provider test proves denial, a push to a disposable local bare remote,
  and replacement of model-supplied bindings. This remains an honest-mistake fence, not an
  OS security boundary. **Foreground nested children inherit the detached parent's push
  grant, even when the nested agent is not one of the three push agents.** pi-subagents
  0.75.0 creates foreground children in the parent's process and does not apply per-child
  `processEnv` there; the lane extension therefore reads the parent's binding. Denying
  that inheritance requires a supported per-session identity transport, not parsing prompt
  text or mutating shared process environment. A child without a binding denies pushes,
  but a foreground child of a granted parent is not such a child. Lane `subagent` calls
  that supply any `extensionBindings` are refused before launch; this prevents explicit
  binding forgery, not foreground inheritance. Briefs must not treat the guard as enforcing
  a separate no-push right on a granted lane's foreground descendants.
  Installed homes adopt it only after a lock bump.

## Request ceiling

`extensions/request-ceiling/` is installed by both loop-guard entries (`installRequestCeiling`), so
the root and every lane carry it. pi 1.0.2 has no wall-clock bound on a streaming request:
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
is installed by both loop-guard entries next to `installRequestCeiling`. pi 1.0.2's agent-level
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
  neither its bound nor the pi process. The ticker exists because lanes run with `--no-extensions`,
  so only the root's process can upload their transcripts. pi homes are Mac-only; without lockf,
  uploads are not serialised across processes.
  Ignore failures. The installer lays the script out only when an overlay provides it.
- The agent set (the only names the root may spawn): `mapper`, `mapper-deep`, `gate-runner`,
  `lane-worker`, `lane-worker-push`, `lane-worker-low`, `lane-worker-low-push`, `lane-worker-retry`,
  `lane-worker-retry-push`, `complex-worker`, `complex-worker-push`, `reviewer`, `reviewer-high`,
  `security-reviewer`, `rescue-sol`, `rescue-astra`, `ops`, `triager`.
- Every agent file sets `inheritGlobalContext: false`; the installer appends the home's
  `lane-policy.md` after a `<!-- lane-policy -->` marker instead. An overlay may replace
  `lane-policy.md`, so the return contract is not in it: every agent but `triager` carries the
  `lane-return` v2 block in its own body, and `triager` its `triage` block.
- A return with no usable `lane-return` block is `failed`, for the loop-state extension and the
  dispatcher alike. `loop-state` folds a `gate-runner` dispatch into a live lane only, never a task.
- Root extensions also include `loop-state/index.ts`: it appends `dispatch` and `return` to
  `codex/state-<stem>-loop<N>.jsonl` (sibling of the report) through `<agentDir>/bin/loop-state`
  for `subagent` calls whose brief starts `Lane: <id> · Task: <id> [(<title>)] · Tier: ...`, and injects the
  recovery digest (`loop-state-digest`, no turn) after compaction and at session start.
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
  only for a surface in the frozen ops file with no active ops run on it. The lane allows a
  lane-forbidden command only on a full `^(?:pattern)$` match of `entry.allow`, a secret write only to
  an exact `entry.secret_paths` member, and credential creation only for kind `credential-create`.
  Single-flight is a kernel flock under `~/.local/state/loop-pi/ops-locks/<surface>.lock` (override
  `LOOP_PI_OPS_LOCK_DIR`); coverage is per machine. Every lane is refused writes to `codex/ops-*`,
  `codex/state-*` and `codex/goal-*`.
- Dispatcher: `loop-pi-dispatch[-variant]` runs a pi session with only `dispatcher/index.ts` and the
  in-process `loop-dispatch/idle` model, which answers pi-subagents' completion turns without a
  model call. It spawns lanes over the `subagents:rpc:v1` bus with the same identity binding and
  fail-closed child registration, writes every state event itself, and runs `loop-pi-audit
  closeout` and `loopPi.onClose` (argv lists with `{log}` and `{report}`) before it exits.
  A composed gate is green only for a parsed return with status `complete`, `exit` 0 and a `sha`
  that is null or the gated tip; the `gate` event records the reported exit (null stays null) and
  SHA. A run pi-subagents reports failed or timed out (`success: false` at the top level or on
  `results[0]`, `results[0].timedOut`, or `results[0].outputPartial`, which pi-subagents emits from
  the release after 0.75.0) never counts as complete, whatever its lane-return block says.
  - Dispatcher: a failed gate run is red with its exit recorded as null; a failed triager parks its
    task. A work lane that may have pushed without finishing parks for its owner and stops new work
    (never gated, never retried, closes `blocked`): a failed run whose block claims landed, a
    `partial` or `blocked` return that claims landed, or any return without a complete landed claim
    whose task's owned files changed on main since its dispatch base (owned files are disjoint across
    live lanes, so such a change is this lane's). A fetch that fails throws instead of reading a
    stale `origin/<branch>`; a park whose main check fails says so in its reason.
  - `loop-state` (model roots) records a failed run's return as failed but keeps the block's
    `landed`, `sha` and other fields, so its digest never re-admits a task whose lane may already
    have pushed, and shows such a task as `landed:<status>` rather than a clean `landed`.
  A pre-green land `loop-state` refuses is recorded as an after-green land plus a park, and
  stops new work. The dispatcher reads LOOP.md exactly as `loop-state` does (nothing stripped).
- Red baseline: LOOP.md may carry `baseline-red: <TASK-ID> - <reason>` (main is known red; the named
  task owns making it green). `loop-state` refuses `land mode=pre-green` in that repo, and the
  dispatcher predicate refuses it before `open`, so only an LLM root runs it. That root's composed
  gate runs on the batch's base SHA and on the integrated SHA, counts as green when every check or
  test failing on the integrated SHA also fails on the base SHA, and records both failing lists in a
  `judgement` event. `gate-runner` gates both SHAs when the brief's Gate line names a base.
- Runtime entry: each session appends `loop-pi-runtime` `{v:1, variant, models:{<id>:{service_tier}}}`
  at `session_start` (variant from the home receipt's `variant`).
