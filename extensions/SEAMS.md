# loop-pi extension seams

The contracts the extensions code against. A change to one of them is made here first, then in
every extension it touches.

Comments in the source cite sections of the original design plan (C3: the agent set, C4: the
guard rules, C5: the preflight, C7: the continuation contract). This file and the tests are the
public statement of those contracts.

## Runtime facts

- pi 0.99.2 loads `.ts` extensions through jiti. An entry file default-exports
  `(pi: ExtensionAPI) => void | Promise<void>`. Type imports come from
  `@earendil-works/pi-coding-agent`; `@earendil-works/pi-ai` resolves through pi's loader at
  runtime (it is nested under pi-coding-agent in `node_modules`, not top level).
- **Project trust (pi-subagents 0.74.0):** children follow the parent session's project trust, so
  with `defaultProjectTrust: "never"` a child no longer loads the target repository's `.pi/`
  settings, system prompt files, skills or extensions. Agent discovery is not trust-gated:
  repository `.pi/agents` and `.agents/*.md` still outrank the home's agents. `loop-pi-preflight` stays.
- **Tool list (pi 0.99 / pi-subagents 0.74.0):** `toolActivation` is `"eager"`; never `"auto"`.
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
  the module instance pi-subagents itself uses.
- Non-TTY stdin: pi in `--mode json`/`--print` waits on stdin. Tests close it (`stdio: ["ignore", ...]`
  or `</dev/null`). RPC mode keeps stdin open by design.
- **Push grant (async single-agent launches):** the root guard overwrites the entire
  `extensionBindings` tool input with `{"loop-pi.guard/1":{"agent":<selected agent>}}` after
  validating the launch. pi-subagents 0.74.0 delivers it in `PI_SUBAGENT_EXTENSION_BINDINGS`
  to the detached child. Only `lane-worker-push`, `lane-worker-retry-push` and
  `complex-worker-push` may make plain `git push`; a missing, malformed or unknown identity
  denies pushes. The lane guard applies this to `bash` and `watch_process`, including the
  existing parser's wrappers, aliases and fallback scan. Force pushes remain blocked for all.
  The real-CLI faux-provider test proves denial, a push to a disposable local bare remote,
  and replacement of model-supplied bindings. This remains an honest-mistake fence, not an
  OS security boundary. Foreground/nested identity transport is not part of this proof;
  children without the binding deny pushes. Lane `subagent` calls that supply any
  `extensionBindings` are refused before launch, so nested callers cannot forge grants.
  Installed homes adopt it only after a lock bump.

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
- `loop-guard` needs "is any async subagent run active" for its root rule. It owns detecting that
  (pi-subagents public API if one exists, else tracking `subagent` results and `subagent-notify`
  messages). No other extension provides it.

## Names and paths

- Model-facing tools: `watch_process` (root and lane entries), `watch_start`, `watch_stop`,
  `wake_at`, `wake_cancel` (root only).
- Custom message types (these start root turns, parsed by `parse_pi.py`): `loop-watch` (watcher
  exit or deadline), `loop-wake` (timer fired), `loop-continuation` (nudge). Persisted state uses
  `pi.appendEntry` with `customType` `loop-wait-state` and `loop-continuation-state`.
- loop-wait run dir: `<agentDir>/loop-wait/<sessionId>/`, receipts at
  `<run-dir>/receipts/<watch-id>.json` with fields (`phase`, `observations`,
  `last_observed_at`, `deadline`, `result`, `pid`, `command`, `interval_s`), written atomically
  (write temp + rename). Watcher output at `<run-dir>/logs/<watch-id>.log`.
- Continuation incident files: `<agentDir>/incidents/<sessionId>-<UTC timestamp>.json`.
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
  `lane-worker`, `lane-worker-push`, `lane-worker-retry`, `lane-worker-retry-push`, `complex-worker`,
  `complex-worker-push`, `reviewer`,
  `reviewer-high`, `security-reviewer`, `rescue-sol`, `rescue-astra`.
