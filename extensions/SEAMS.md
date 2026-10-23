# loop-pi extension seams

The contracts the extensions code against. A change to one of them is made here first, then in
every extension it touches.

Comments in the source cite sections of the original design plan (C3: the agent set, C4: the
guard rules, C5: the preflight, C7: the continuation contract). This file and the tests are the
public statement of those contracts.

## Runtime facts

- pi 1.4.0 loads `.ts` extensions through jiti. An entry file default-exports
  `(pi: ExtensionAPI) => void | Promise<void>`. Type imports come from
  `@earendil-works/pi-coding-agent`; `@earendil-works/pi-ai` and `typebox` are pi's dependencies,
  not ours, and resolve through pi's loader at runtime. pi 1.4.0 publishes no
  `npm-shrinkwrap.json`, so npm hoists them to the top-level `node_modules`; never rely on either
  layout (`tsconfig.json` lists both, and the loop-wait test hook resolves from pi's directory).
- **Project trust (pi-subagents 0.81.0):** children follow the parent session's project trust, so
  with `defaultProjectTrust: "never"` a child no longer loads the target repository's `.pi/`
  settings, system prompt files, skills or extensions. Agent discovery is trust-gated too
  (`src/agents/agents.js` `buildAgentDiscoverySources`): an untrusted project contributes no
  `.agents` / `.pi/agents` or chain directories and no project agent settings, so repository agents
  no longer outrank the home's. `loop-pi-preflight` stays as the check for a trusted project.
- **Tool list (pi 1.4.0 / pi-subagents 0.81.0):** `toolActivation` is `"eager"`; never `"auto"`.
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
### Shared hook scripts

- Home dir: `getAgentDir()` exported by `@earendil-works/pi-coding-agent` (honours
  `PI_CODING_AGENT_DIR`). Guard hook scripts: `<agentDir>/scripts/backlog-guard.py` and
  `<agentDir>/scripts/staging-guard.py`, each run only when present or listed in settings
  `loopPi.requiredHookScripts` (a required one that is absent is an adapter failure), run as `python3 <script>` with a Codex-format JSON payload on
  stdin (`{"hookEventName":"PreToolUse","toolName":...,"toolInput":{...},"cwd":...}`); a deny is
  exit 0 with `hookSpecificOutput.permissionDecision == "deny"` on stdout.
### Child runtime

- `PI_SUBAGENTS_TEMP_ROOT` is honoured by pi-subagents (`src/shared/types.js:106`).
- pi-subagents child sessions are written under the parent's session dir:
  `<agentDir>/sessions/<cwd-slug>/<parent-session-basename>/<runId>/...`
  (`src/extension/index.js`, `getSubagentSessionRoot`); async run state under `$PI_SUBAGENTS_TEMP_ROOT`
  (`async-subagent-runs/`, `async-subagent-results/`).
- pi-subagents async completion message: `customType: "subagent-notify"`
  (`src/runs/background/notify.js:472`).
- `registerRequiredChildExtensions({ sessionId, extensions: [{ id, path }] })` from
  `pi-subagents/required-child-extensions`; returns `{ dispose() }`; one registration per parent
  session; call at `session_start` with `ctx.sessionManager.getSessionId()`, dispose at
  `session_shutdown`. The e2e child-block test (`loop-guard/e2e.test.ts`) proves an import from this extension shares
  the module instance pi-subagents itself uses. pi-subagents 0.81.0 fails the child launch closed
  when a required child extension fails to load or throws during startup ("Required child extension
  failed during startup"), so a lane-guard startup error aborts the lane rather than running it unguarded.
- pi-subagents 0.81.0 writes no `run-history.jsonl` (0.77.0 appended one row per async child). The
  run record is each child's `status.json` and `process-terminal.json` under its async dir.
- **Custom-message runs (pi 1.4.0):** `before_agent_start` also fires for runs started by
  `pi.sendMessage(..., { triggerTurn: true })` (loop-wait wakes, request-ceiling incidents, recovery
  and continuation nudges). The event is a union on `messageType`: `"user"` carries `prompt`,
  `"custom"` carries `message` and no prompt. A handler that reads the brief must skip `"custom"`
  (`loop-guard/lane.ts`). Such runs now pass through pi's full run preparation (system-prompt
  rebuild, `nextTurn` flush, compaction check), and `ctx.isIdle()` is false from the moment a run
  starts, including during `before_agent_start`; a second trigger in that window queues into the run.
- **Mutating-tool failure guard (pi-subagents 0.81.0):** child tool failures are determined by
  the result's `isError === true`, so successful output containing "failed" or "error" no longer
  counts as a failure. `home/extensions/subagent/config.json` retains its prior 1,000,000
  `control.failedToolAttemptsBeforeAttention` threshold; restoring finite attention is a separate
  policy choice. `extensions/subagent-control.test.ts` exercises successful and failed results.
- **GPT-6 effort behind codex-lb (pi-ai 1.4.0):** the catalogue marks the GPT-6 family
  `supportsMidConvoEffort`, and only Sign in with ChatGPT at `https://api.openai.com/v1` is exempt.
  Behind codex-lb every request would carry `reasoning.effort: "medium"` plus a `configuration_update`
  input item; codex-lb answers at medium, and request-ceiling's `portableRequest` rejects the item, so
  managed recovery is denied. The private overlay's `models.json` sets
  `providers.openai.compat.supportsMidConvoEffort: false`; `request-ceiling/effort-wire.test.ts`
  proves both shapes on the wire against the pinned CLI.
- **Declaration pinning (pi-subagents 0.81.0):** `pinToolDeclarations` defaults to true, so a resumed
  root keeps the `subagent` tool definition it recorded. 0.78.0 also declares a `contact_supervisor`
  stub at the root whenever `subagent` is registered (`extension/index.js`
  `registerPinnedTool(pi, topLevelSupervisorTool())`); it only errors there. The launcher passes
  `--exclude-tools subagents_enable,bg_wait,contact_supervisor`, and pi drops excluded names from the
  registry. Children are separate processes that build their own argument list and register the
  working tool only when the intercom bridge is active, so the exclusion changes no child's tools;
  the shipped `intercomBridge.mode` is `off`, which gives lanes no `contact_supervisor` at all.
  `extensions/subagent-tools.test.ts` reads the wire `tools` array for a root and a real child.
- Non-TTY stdin: pi in `--mode json`/`--print` waits on stdin. Tests close it (`stdio: ["ignore", ...]`
  or `</dev/null`). RPC mode keeps stdin open by design.
- **Push authority:** lanes never push. The lane guard refuses `git push` for every lane agent
  through `bash` and `watch_process`, including the parser's wrappers, aliases and fallback scan;
  only the root's own `bash` pushes. Force pushes remain blocked for all. The root guard still
  overwrites the entire `extensionBindings` tool input with
  `{"loop-pi.guard/1":{"agent":<selected agent>,"runDir"?:<run dir>}}` after validating the launch
  and removes any copy inside `options`; the binding carries identity and run dir only and grants
  nothing. Lane `subagent` calls that supply any `extensionBindings` are refused before launch. This
  is an honest-mistake fence, not an OS security boundary. Installed homes adopt it only after a
  lock bump.
- **Non-push launcher (pi-subagents 0.81.0):** every shipped agent names `launcher: nopush`. The user subagent config maps `runnerLaunchers.nopush`
  to `<agentDir>/bin/loop-pi-nopush`, managed by the installer. The wrapper sets Git environment
  `pushInsteadOf` rewrites for HTTPS, HTTP, SSH, `git@` and `git://` to an unknown helper scheme,
  disables terminal credential prompts, then execs the background runner's argv. Fetch and local
  bare pushes are unaffected. This is a script/task-runner honest-mistake fence, not an OS boundary:
  explicit remote push URLs, environment scrubbing, Git libraries ignoring that configuration and
  API writes remain outside it. Native required child extensions and identity bindings still load.
  Each nested async launch gets fresh Git routing environment, so its own agent must name the
  launcher. The native producer refuses launcher agents with explicit `async:false`, `clarify` or
  `foregroundOnly`; losing foreground non-push children of push lanes is intentional. Agents in
  one background runner must use the same launcher or none. **The name `nopush` is frozen:**
  native resume uses the recorded launcher name (including recorded absence), not the current agent
  file; removing the name refuses resumes, and runs launched before adoption remain unwrapped.

## Scratch candidate installation

The installer's paired `--candidate-source --scratch-root` flags require a disposable HOME
and install roots strictly inside it. Before invoking build/runtime tools or writing managed
files, candidate mode checks the existing home, bin and data trees without following directory
links, including build/staging descendants. Directory symlinks in those trees are refused;
file symlinks must resolve to existing targets inside scratch (npm's internal executable
links remain valid). Planned absent roots are allowed only beneath a validated existing directory
inside scratch, with a plain missing suffix; broken links and traversal errors are refused.
The scratch root itself is canonicalised (a symlink alias selects its target); existing destination
ancestors are checked against that canonical boundary before accepting missing descendants.
This is a static-topology mistake fence, not protection against adversarial same-account races
or an OS sandbox. Ordinary installations without the paired flags keep their existing behavior.

## Senior nesting

`senior` sets `maxSubagentDepth: 2` and `allowedAgents: scout, worker, reviewer`, matching the home's
global maximum of 2; no other agent has the `subagent` tool. pi-subagents 0.81.0 counts the root at
depth 0, its lane at 1 and that lane's child at 2, and intersects the parent's maximum with the
selected agent's maximum. A senior delegates only when its brief grants a count.

## Role by entry point

The model root loads `loop-guard/root.ts`; children receive `loop-guard/lane.ts` through
required-child registration, including agents declaring `extensions: []`.

### Unverified

This historical citation refers to the once-unverified shared module instance for
`registerRequiredChildExtensions`. It is now verified by `loop-guard/e2e.test.ts` on a real
pi process with the faux provider, as recorded under "Runtime facts"; it is not an open claim.

## Root launcher route

The installer's `DEFAULT_ROOT_ROUTE` is
`{provider: "openai", model: "gpt-6.1-sol", thinking: "high"}`. Settings
`loopPi.rootRoute` override those defaults. The generated model-root launcher places caller
arguments last, after its provider, model and thinking flags, so explicit caller flags win.

## Recorded timing seam

`extensions/call-timing/index.ts` retains assistant metadata `loopPiTiming` with
`{firstTokenAt: epoch ms | null, attempts: null, processingMs: int | null, headers: {x-request-id?, x-ratelimit-remaining-requests?, x-ratelimit-reset-requests?, service-tier?}}`.
The root launcher loads it, and loop-guard root registers it as a required
child extension (including children declaring `extensions: []`).

- pi 1.4.0 supports `after_provider_response` with response headers before stream consumption,
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

## Request progress seam

`extensions/call-timing/progress.ts` (wired by `call-timing/index.ts`, so the root and every child
carry it) records content-free progress for each model request: one record per agent-loop turn,
from `turn_start` to the assistant `message_end` (a pi agent-level retry is a new turn, so a new
record). The record is version `v: 1`; a consumer refuses any other `v`. It is written to a live
checkpoint and, at `message_end`, retained on the assistant message as `loopPiProgress`, beside
and independent of `loopPiTiming`, whose fields and `firstTokenAt` semantics are unchanged.

Fields. Times are local `Date.now()` epoch ms at the moment the extension observed the event;
"null" always means not observed (or not supported by the provider), never zero.

- Correlation: `session` (pi session id, null without a session context), `request` (a random
  UUID per record), `turn` (1-based ordinal of the turn in this session in this process), `pid`
  (the writing pi process), `provider` / `model` / `api` (the selected model's identifiers).
  `providerResponses` counts `after_provider_response` events in the record (a provider-internal
  retry that reaches headers again increments it; it is an observation, not an attempt count);
  `firstResponseAt` is the first of them; `providerRequestId` is the latest response's
  `x-request-id`, or null.
- Writer and loaded policy (additive, `extensions/call-timing/writer.ts`; a reader treats an absent
  or null value as unknown, never as a default): `pidStartedAt` is the writing process's start
  (`performance.timeOrigin`, floored epoch ms), so a reader can tell the writer from a later process
  that reused `pid` by comparing the live pid's kernel start time. `policy` is
  `{inactivityMs, absoluteMs, checkpointIntervalMs}`: the request ceiling's limits as installed in
  this process (null when no ceiling is installed, or two installs disagree) and the interval this
  session's ticker uses. Neither is re-read from settings, so a live upgrade that rewrites the home
  settings does not change what a running writer reports.
- Lifecycle: `state` is `active` while the request runs, `ended` at the assistant `message_end`
  (`stopReason` is then pi's stop reason, e.g. `stop`, `toolUse`, `length`, `error`, `aborted`),
  or `abandoned` when a turn or session boundary arrives first (`stopReason` null). `startedAt`
  is `turn_start`; `endedAt` is null until the end; `writtenAt` is the time the snapshot was
  taken (the freshness stamp); `ageMs` is `(endedAt ?? writtenAt) - startedAt`.
- Model progress, from pi's normalized `message_update` stream (every pi provider emits it):
  a model event is the start or end of a reasoning (`thinking_*`), text (`text_*`) or tool-call
  (`toolcall_*`) block, or a nonempty delta of one. `modelEvents` counts them;
  `firstModelEventAt` / `lastModelEventAt` bound them. `reasoning`, `text` and `toolCalls` each
  hold `{started, deltas, completed, firstAt, lastAt}` for their block kind. An encrypted-only
  reasoning item is visible as one `started` and one `completed` with no deltas, so
  `reasoning.completed` is the completed reasoning-item count; `reasoning.deltas` counts visible
  summary or reasoning text deltas. Counters start at 0 at `turn_start` and count what the stream
  delivered; nothing is reconstructed from the final message. Stream start and empty deltas are
  not model events. These are observations of activity, not a measure of useful work.
- Transport, from the raw `provider_stream_event` hook (parsed provider events before
  normalization; providers that do not call `onProviderStreamEvent` never fire it):
  `providerEvents` / `lastProviderEventAt` count every raw event, and `keepalives` /
  `lastKeepaliveAt` the recognised keepalives: `type` `keepalive` for the `openai-responses`,
  `azure-openai-responses` and `openai-codex-responses` APIs, `ping` for `anthropic-messages`.
  All four stay null until the first raw event, so a silent stream and a provider without the hook
  both read null. For any other API the keepalive pair stays null for the whole request: its
  keepalives cannot be recognised, so none is unknown, not zero. Raw events, response headers and
  keepalives never count as model progress. SSE comment lines never reach the hook. Only an event's
  `type` is compared, never stored.

Never recorded: prompts, reasoning or summary text, encrypted reasoning, output text, tool names,
arguments or results, request payloads, header values other than `x-request-id`, credentials.

Checkpoint: `<agentDir>/progress/<sessionId>.json` (`getAgentDir()`, so a child writes beside
its root under its own session id), one JSON record per session holding its latest request,
replaced atomically (an unpredictable temp name created exclusively, then renamed; mode 0600).
The first checkpoint of a session in a process removes that session's leftover
`<sessionId>.json.*.tmp` files. No file is written when the session id is
unknown or not `[A-Za-z0-9._-]{1,128}`. Write failures are ignored.

Retention: a checkpoint older than 14 days is deleted (no archive). The sweep runs inside
`writeCheckpoint`, after a successful write, at most once per hour per directory per process
(the first write in a process sweeps), so no separate timer or hook exists. A file is removed
only when all hold: it is a regular file named exactly `<sessionId>.json` in the producer's own
`progress/` directory (the directory itself is not a symlink, and each file is opened with
`O_NOFOLLOW|O_NONBLOCK`, so a symlink is never followed or removed and a FIFO, socket, device or
directory named like a checkpoint is skipped without blocking); it is not the writing session's
own checkpoint; it parses as a `v: 1` record whose `session` equals the file stem and whose
`writtenAt` is a finite number; its `pid` is a positive integer for which `process.kill(pid, 0)`
reports no such process (a live pid, `EPERM` included, keeps the file however old; pid reuse can
cause a false keep, never a false delete); both `writtenAt` and the file's mtime are more than 14 days
before now (a recently touched file is a live writer however old its record, and a future stamp
is not an age); and it is unchanged between the check and the unlink. Anything whose identity or
age cannot be established (unparseable, empty, another version, no or non-finite `writtenAt`,
missing or malformed `pid`, mismatched or null `session`, over 16 KB, not a regular file) is kept, never treated as expired.
Temp files, other extensions, transcripts, credentials and other homes are never touched. One
sweep opens at most 100 files and rotates its starting point, so a large directory is cleared
over successive sweeps. A writer that renames a fresh checkpoint over a 14-day-old file in the
instant between the final check and the unlink would lose it; its next write recreates it.

Cadence bound: one write at `turn_start`, one at the first model event, one at the end
(`ended` or `abandoned`), and one per `loopPi.progress.checkpointIntervalMs` while the request is
active (an integer 250 to 60000, default 5000; anything else is the default). So a request of age
A ms writes at most `3 + floor(A / interval)` times, whatever its event volume. The periodic write
refreshes `writtenAt` and `ageMs` even when the stream is silent.

Reading it: a record with `state: active` whose `writtenAt` is older than a few intervals, or
whose `pid` is gone, was interrupted (a killed process cannot write its end). Last-event times
exist only for requests run with this producer; they cannot be reconstructed for older ones.
`just verify-pi-progress [home]` prints the newest checkpoint's field names with only its
numbers (counts and times); every other value prints only as its type, such as `<str>`.

## Request ceiling

`extensions/request-ceiling/` is installed by both loop-guard entries (`installRequestCeiling`), so
the root and every lane carry it. pi 1.4.0 has no wall-clock bound on a streaming request:
`httpIdleTimeoutMs` is an idle timer reset by every streamed event, so a model that keeps streaming
reasoning never trips it, and the provider `timeoutMs` (`retry.provider.timeoutMs`) is cleared once
response headers arrive. The output budget is pi's model `maxTokens` (sent as `max_output_tokens`),
set per model in the home's `models.json` `modelOverrides`.

- Settings: `loopPi.requestCeiling: {inactivityMs, absoluteMs, maxFollowUps}`; defaults
  900000 (15 minutes), 4500000 (75 minutes) and 2. Limits must be positive finite numbers within
  Node's timer range; invalid values use their defaults. Legacy `wallClockMs` remains an explicit
  absolute-limit alias only when `absoluteMs` is absent. `maxFollowUps: 0` surfaces incidents
  without starting a turn. `session_start` resets the chain.
- Both limits run from `turn_start` to assistant `message_end`. Inactivity is measured from the
  latest observed model event, or turn start before any event; it uses the exact Request progress
  seam's normalized start/end/nonempty-delta semantics. Encrypted reasoning counts as activity;
  transport keepalives, response headers and empty deltas never reset inactivity. The absolute
  deadline never moves. A reached deadline is checked before accepting another progress event,
  so delayed timer delivery cannot reopen an expired allowance. `ctx.abort()` ends the run.
- Incident kind/class remain `wall-clock` / `loop-request-wall-clock-ceiling` for reader
  compatibility, while `limitType: inactivity|absolute`, `inactivityMs`, `absoluteMs`, `idleMs`
  and `lastModelEventAt` in notice details, plus matching snake-case file fields, identify the
  actual bound. `wallClockMs` / `wall_clock_ms` is the triggering limit, not request age.
  The earlier unconditional 14-minute limit is intentionally replaced: valid active reasoning may
  finish after an hour, while an active runaway is still stopped at 75 minutes. Model effort and
  `max_output_tokens` stay separately bounded by the selected model's settings; observed activity
  does not establish useful work.
- An assistant `length` stop with no text and no tool call is rewritten at `message_end` to
  `stopReason: "error"` with `EMPTY_LENGTH_ERROR`, which matches neither pi's retryable nor its
  context-overflow patterns: no identical retry, no compaction, and loop-continuation skips the
  error outcome instead of nudging.
- At `agent_settled` either incident sends one `loop-request-incident` custom message with
  `triggerTurn: true`, up to `maxFollowUps` in a row; any `stop` or `toolUse` response resets the
  chain. For opted recovery providers, the recovery safety authorizer and shared failure/episode
  budget additionally gate this continuation. A portable local-tool Responses timeout may continue
  after partial output only when the pinned failed-response boundary proves its tools never ran.
  Denied or exhausted managed recovery emits only the recovery controller's cause-specific notice,
  not a second actionable incident notice. Incident files are still retained. Other providers keep
  the existing bounded incident behavior.

## Retry recovery episode

The request-ceiling entries install a retry episode controller. `loopPi.retryRecovery`
accepts `episodeMs` (default 1200000), `providerIds` (default empty), and `maxAttempts`
(integer 1 through 5, default 5, counting the original failed attempt). The effective attempt limit
is also bounded by native `retry.maxRetries + 1` (native default 3 retries means 4 attempts);
`retry.enabled: false` means one attempt. Ceiling continuations also honor `maxFollowUps`.
Native retries and ceiling continuations consume the same consecutive-failure counter, not nested
budgets. Provider-internal retries must be disabled (`retry.provider.maxRetries` absent or zero,
which is the pinned Responses default): their attempts and classifications are not exposed at the
extension boundary, so configured internal retries refuse the opted request before dispatch.
CLI admission reads the supported SettingsManager merge of home and trusted project settings;
SDK adapters supplying settings must supply their effective runtime settings. Unknown settings
refuse configured managed admission rather than assuming zero hidden retries.
The episode and
proxy classification are enabled only for those provider ids; other providers retain their
existing retry policy. An episode starts at
its first safely recoverable assistant failure, at the local observation of that failure, and
includes subsequent waits and requests. Healthy first-request time is outside the episode.
Successful `stop` or `toolUse` completion or genuine interactive/RPC input received while idle
resets it. Reasoning activity does not reset or extend it. Queued input
cannot reset or extend an active episode. Compaction and extension
follow-ups do not. Settlement disarms the active timer but retains its deadline; expiry
aborts active work and refuses synthetic restart, without starting a replacement turn.
A denied protected or ambiguous attempt latches recovery off until idle genuine input or session/model
reset. `loop-recovery:may-follow-up` synchronously gates the per-request ceiling's synthetic
continuation; a timeout authorizes replay after output only for positively established portable
local-tool Responses requests whose failed-response tools did not run. Protected context, hosted
or ambiguous output, authentication and policy refusals never authorize replay.
The ceiling additionally queries `loop-recovery:ceiling-decision` synchronously with
`{consecutive, maxFollowUps, reply({managed, allowed, attempts, maxAttempts})}`. Only the ceiling
uses this richer response; the existing boolean wake query is unchanged. A managed refusal owns
its stop/exhaustion notice, and the ceiling records its incident without sending a duplicate.
`attempts` counts admitted Agent and native summary stream invocations at the surviving header
boundary exactly once, not payload callbacks or locally refused stale turns. The attempt cap can decrease but cannot increase during an active episode.
While halted or expired, extension-sourced input is handled without starting a model turn.
Child notices already appended to the transcript remain available. The loop-wait delivery adapter
uses the same synchronous query to append fired notices without triggering a refused turn.
An ordinary user input while idle still resets recovery; automatic input cannot reset its budget.
Changing providers disposes the previous episode. Ordinary user abort preserves its outcome.
The request-ceiling recovery controller synchronously emits `loop-recovery:abort` with `{}`
before calling `ctx.abort()` for episode expiry or halted recovery. This attributes the abort
without authorizing a replacement turn.
The per-request ceiling emits `loop-recovery:request-timeout` before abort so its failure
also starts the episode; ordinary user cancellation does not start one. Exhaustion posts
a visible `loop-recovery-exhausted` message with `triggerTurn: false`.

Only explicitly configured provider ids receive structured proxy classification and unique
`x-client-request-id` headers. Stable session affinity is unchanged. Classification observes
parsed provider errors before normalization; bounded status/code metadata is retained on the
assistant message, together with bounded `reason`, `outputObserved`, `requestPortable` and
`toolsExecuted` fields. Sanitized upstream classification/type/status/request correlation is
separate from the recovery disposition; known policy refusals (including `cyber_policy`) and
authentication refusals remain distinct and nonretryable, even if their body mentions a transient
error or context overflow. The visible stop includes its allowlisted upstream code. Server
correlation stays null when the pinned HTTP-error path exposes no response-header event; the
unique client request id remains available separately. Recovery metadata and stop notices never
retain error bodies or credentials; the existing native compaction diagnostic is unchanged.
Stop messages name the reason and ask the operator to inspect saved work
before resuming; one non-triggering `loop-recovery-required` notice surfaces the stop. On an armed
root the stop is not the end: loop-continuation classifies it and resumes it after a backoff, or
records an owner-actionable stop (see "Automatic root recovery"). Lanes are never auto-resumed.

For the pinned pi Responses runtime, a failed assistant response exits the agent loop before
local tool execution. Native retry omits only that failed attempt from model projection; earlier
completed tool calls and results remain. Therefore portable, originally unanchored Responses
requests with only local function/custom tools may retry a structured server `stream_incomplete`
even after partial text, reasoning or tool-call output. No local tool may have started in that
request, and observed hosted/unknown output items refuse replay. Input with unresolved or duplicate tool
calls/results, hosted items, bound files or explicit anchors is protected. Unknown structured errors,
authentication errors, unclassified nonretryable failures and explicit continuity refusals stop.
No-output errors recognized by pi as transient retain native retry behavior. For portable Responses requests without output, context-window overflow remains available to
native compaction. During an active opted-in episode, only the first static single-call native
summary is admitted, on positively known physical standard Responses routing with zero effective
provider retries and remaining shared count/deadline. Positive route provenance currently means
a static non-builtin compatibility registration exposed by the public registry, without native
provider replacement, custom streaming, OAuth or dynamic model refresh. The selected physical
model must match the registry route; free-form model sampling overrides are also declined because
they can inject hosted tools or bound state into an unobserved summary. Builtin/inherited and
models-file-only provenance is conservatively unknown here, not rerouted or silently trusted.
As with the Agent payload authorizer, arbitrary extensions replacing the global API implementation
or the route after this check need a separate compatibility proof; shipped extensions do not.
Two-call split-turn preparation and
unknown, virtual, custom-stream or auth-rerouted routes are conservatively declined before
summary dispatch. This deliberately declines some otherwise successful split compactions;
ordinary compaction outside recovery is unchanged, and eligible single-summary overflow still
succeeds. Subsequent opaque summary invocations are denied at the supported header boundary:
the local safety stop is latched before `loop-recovery:abort` and `ctx.abort()`. No summary
payload/response/raw-stream/message-end hooks are available, so the local notice reports
`opaque-summary-retry-not-authorized` with unknown/null upstream code/type/status/server id
and only the actual admitted client correlation, never a guessed refusal. Summary completion
clears only operation scope, not the episode counter or deadline. Cache warming is stopped by
the public decision hook during managed work and retained failed episodes. Supported abort
cancels the root operation, not the session or detached children; retained notifications and
stale-wake refusal still apply. An expired episode stops compaction as well. The request ceiling also retains its existing
bounded follow-up for an empty answer (including reasoning-only output), only with portable
local-tool context and no text or tool calls. Neither controller restarts the recovery budget.
Genuine operator cancellation remains aborted and latches automatic recovery off without posting
an upstream-failure notice. Harness-attributed timeouts use the existing custom incident continuation:
`ctx.abort()` is terminal in the pinned native retry machine, so rewriting an aborted assistant as
retryable cannot restart it. The Responses converter omits failed/aborted response tools and retains
earlier completed history. This continuation adds no fake user message and never resets the shared
attempt counter or original episode deadline. Native retry/backoff handles transport/server errors.
Count or elapsed-time exhaustion emits one non-triggering actionable notice naming its cause;
successful `stop` or `toolUse` completion resets the consecutive budget. Stale automatic input
cannot reopen a halted or exhausted episode. pi-subagents 0.81.0 wakes an idle root with a
turn-starting notice that never reaches `input`, so while a managed episode refuses automatic turns
(at `agent_settled`, or when an idle episode's deadline passes) recovery holds pi-subagents' shared
idle-wake reservation (`Symbol.for("pi.idle-wake.v1")`, keyed by the session manager, `sentAt`
`WAKE_HOLD`). pi-subagents then appends each notice with no turn (its `src/shared/parent-wake.js`
`sendMessage`). Recovery releases a hold it still owns on reset; pi-subagents clears it at the next
`agent_start`. A turn some other extension starts while halted is aborted at `turn_start` and
reports the original stop reason, so root recovery reads it as the same stop.
This is broader transient recovery, not an exactly-once guarantee for upstream hosted operations
or external work whose execution cannot be established. The portability check observes the
request-ceiling payload hook; shipped extensions do not subsequently replace it with bound or
hosted state. Arbitrary later payload-mutating extensions require their own compatibility proof.
The pi 1.4.0 retry API accepts text only: allowlisted server failures are normalized to the
standard `server error` wording at message_end; denied failures use a nonretryable explanation.
This is an adapter to pi's classifier, not a new retry loop. Header ids describe provider
invocations, not hidden SDK retries; use provider maxRetries zero for attempt-level proof.
The `server` class in `backoff.ts` (`SERVER_PATTERN`) mirrors the upstream-failure wordings that
pi-ai 1.3.0's `isRetryableAssistantError` (`utils/retry.js`) retries natively. Of the three newest,
pi-ai 1.2.0 already retries "The upstream provider returned an error"; "The service is temporarily
unavailable" and "Unable to forward upstream" are retried from pi-ai 1.3.0. A pi-ai bump re-reads that
list: a wording pi retries natively but this pattern misses is classed `other`, not `server`.

## Automatic root recovery

Plain-text authentication, quota and content-policy refusals retain an allowlisted category before
managed recovery replaces their text. Authentication and policy categories stop the root immediately. A quota category
permits two automatic root retries with the existing backoff, then stops with a quota incident.
The retry count is stored in version-1 `loop-root-quota-recovery` custom entries and restored
on session start; invalid entries exhaust the budget. Only genuine owner input writes a zero
reset. Child notifications, recovery turns and healthy automatic replies never renew it. Transport connection refusals remain eligible for the existing backoff;
this classification never authorizes tool replay or overrides operator cancellation.

loop-continuation (root only) resumes an armed root that stops on a failed model request, so an
owner's "continue" is no longer needed. Everything above (pi's native retry, the request ceiling,
the retry recovery episode) runs first and is unchanged; this acts only once that machinery has
left the root idle.

- Trigger: at `agent_settled`, while armed and the closeout does not count, the session branch's
  last assistant message is classified (`root-recovery.ts` `classifyRootStop`). An abort is the
  harness's only when this run saw `loop-recovery:request-timeout` or `loop-recovery:abort`;
  otherwise it is the operator's and is never resumed (any pending resume is cancelled).
- Classification, owner-actionable rows first (the detail names only the retry-recovery reason,
  the allowlisted upstream code and the status, never an error body):

  | Evidence on the failed message | Decision |
  |---|---|
  | `stop`/`toolUse`/`length`, or no assistant message | none |
  | aborted without a harness marker, or reason `operator-cancelled` | none |
  | reason `upstream-auth-refusal`; code `invalid_api_key`/`authentication_error`/`permission_denied`/`insufficient_permissions`; type `authentication_error`/`permission_error`; status 401/403; unmanaged text naming 401/403, unauthorized, forbidden, authentication | stop: `authentication` |
  | reason `upstream-policy-refusal`; a policy code (`cyber_policy`, `content_policy_violation`, `content_filter`, `policy_violation`, `safety_violation`); type `policy_error`; unmanaged text naming a policy or a refusal | stop: `policy` |
  | code `insufficient_quota`; unmanaged text naming quota, usage limit, billing, budget or balance | resume: `quota` at most twice per genuine owner-input interval; then stop: `quota` |
  | code `context_length_exceeded`; pi's context-overflow pattern; a summary-route reason (`summary-*`, `two-call-summary-not-authorized`, `opaque-summary-*`) | stop: `context-length` |
  | reason `unobservable-provider-retries` | stop: `configuration` |
  | `loop-recovery:request-timeout` this run (limit `inactivity` or unknown), or reason `safe-local-timeout`/`timeout-not-replayable` | resume: `stalled-request` |
  | the same with limit `absolute`, or the request ceiling's empty output-budget error | resume: `request-ceiling` |
  | any other error or harness abort (server errors, `stream_incomplete`, rate limits, `attempt-limit`, `episode-expired`, `ceiling-limit`, `protected-request`, `non-retryable-upstream`, unclassified) | resume: `provider-error` |

- Resume: after `min(baseDelayMs * 2^(n-1), maxDelayMs)` for the n-th resume since the root last
  completed a `stop` or `toolUse` message (`loopPi.rootRecovery: {enabled, baseDelayMs,
  maxDelayMs}`, defaults true, 60000, 900000), with no attempt limit while armed. A run that
  starts before the timer fires holds it, keeping its due time; that run's settle re-arms it.
  At expiry the root must still be armed, idle, without a counted closeout and still stopped on a
  failed message, else nothing is sent. Then loop-continuation appends a `judgement`
  `loop-pi auto-resume <n>: <cause> (<detail>) after <s> backoff` to the state log (by `ext`),
  emits `loop-recovery:resume`, and sends one `loop-root-recovery` custom message with
  `triggerTurn: true`. Wakes held while the episode was halted are already in the transcript.
- Stop: one `loop-root-recovery-stopped` root incident (`incidents/root/`, `loopPi.onIncident`), one
  `judgement` `loop-pi recovery stopped: <cause> (<detail>); the root waits for its owner`, and a
  visible error notice, once per failed message. The owner's own input cancels a pending resume.
- Healthy progress (`stop`/`toolUse`) resets the backoff to the base. Session start and shutdown
  drop a pending resume.

## Retry backoff

`installRetryBackoff` (in `extensions/request-ceiling/`, `backoff.ts` for the pure delay function)
is installed by both loop-guard entries next to `installRequestCeiling`. pi 1.4.0's agent-level
retry waits `retryDelayMs(settings.retry, attempt)` (`pi-ai` `utils/retry.js`): `baseDelayMs *
2^(n-1)` capped at `maxAgentDelayMs`, no jitter and no split by status. That wait cannot be replaced
from an extension, so the extension adds a wait in front of it.

- Seam: pi awaits extension `agent_end` handlers before `_handlePostAgentRun` decides to retry and
  sleeps its own delay, and `ctx.signal` is the live run's signal there, so an abort ends the wait.
  The retry decision uses pi-ai's public `isRetryableAssistantError`, `isContextOverflow` and
  `retryDelayMs`. pi's attempt counter is private; the extension mirrors it (increment per retried
  error, reset on any non-error assistant `message_end` and at `agent_settled`, when pi's is zero).
- Totals: a 429 (`429`, `rate limit`, `too many requests` in the error text) waits at least
  `loopPi.retryBackoff.rateLimitDelayMs` (default 60000) including pi's delay, plus up to 50% jitter. A 5xx (a `5xx`
  status, `overloaded`, `service unavailable`, `server error`, `internal error`, `bad gateway`,
  `temporarily unavailable`, `unable to forward upstream`, `upstream provider returned an error`)
  waits pi's delay plus a random extra in `[0, 0.5 * pi's delay)`. Every other retryable error also adds up to 50% jitter to
  pi's delay. Errors pi does not retry get no wait. `settings.retry` and `httpIdleTimeoutMs` stay
  pi's own; without the extension pi's backoff is unchanged.
- pi's `auto_retry_start` event still reports only pi's own `delayMs`, and is emitted after the
  extension's wait.

## Delivery after an operator abort

loop-wait (root) holds `loop-watch` and `loop-wake` messages, queued or newly fired, once
`agent_settled` reports `aborted: true`, so the root is not restarted by a wake the operator just
stopped. The held messages are persisted in the `loop-wait-state` snapshot (`heldMessages`) for as
long as the hold lasts, survive shutdown and reload, and are restored still held at `session_start`,
before timers and watchers are reconciled. They are dropped from the snapshot once delivered.

- The hold ends at the `agent_settled` that the owner's next input produces: an `input` event whose
  `source` is not `extension` marks it pending, and input alone sends nothing. If that settle is
  itself an abort, the hold continues.
- An abort preceded by `loop-recovery:request-timeout` (see "Request ceiling") or
  `loop-recovery:abort` (see "Retry recovery episode") is not the operator's and does not
  establish a wake hold. loop-wait records an ephemeral, nonpersisted marker, consumed at exactly
  one `agent_settled` (whether aborted or not), and reset at `agent_start` and `session_start`.
  Fired wakes can therefore be delivered after a recovery abort; genuine operator Esc still
  establishes the unchanged durable hold. An existing hold is not cleared merely by the marker.

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
- `loop-continuation:query-launch` `{ cwd?: string; reply(r: { reportPath: string | null; standingPath: string | null; standingSha256: string | null; rootContext?: object; concurrency?: number }) }`
  - loop-continuation answers from its frozen launch state. `reportPath` is the launch's closeout
    path (`codex/closeout-<name>-loop<N>.md`, v3 seam S1; the key is named for the persisted launch
    state). The state log is derived from it (S3): `closeout-` becomes `state-` and `.md` becomes
    `.jsonl` (`loop-state/core.ts` `deriveLogPath`, the one implementation; any other name derives
    none).
  - The reply may also carry `concurrency: number`, the charter's `lanes:` value: a bare
    positive integer (digits only), frozen at arm and restored with the continuation state on a
    resumed session. The key is absent, not null, when no launch is armed or the value is missing or
    malformed. Consumers treat it as optional.
  - The reply may also carry `launchedAt: string`, the ISO timestamp of the recognised launch prompt
    (`launch.launchTs`). It is absent, not null, when no launch is armed. Consumers treat it as
    optional (loop-status measures wall time from it, else from the session header).
- `loop-guard:push-recorded` `{ count: number }`: loop-guard's root entry, after a root `git push` or
  `gh pr merge` appended `count > 0` lines to the push log (the remote move was verified; a failed,
  rejected or up-to-date push emits nothing). loop-state listens (see "State-aware root context
  budget"). Lanes never emit it. Fire and forget: no reply.
- `loop-recovery:request-timeout` `{ limitType: "inactivity" | "absolute" }`: the request ceiling,
  synchronously before its `ctx.abort()`. `limitType` is additive; older readers ignore it.
- `loop-recovery:resume` `{}`: loop-continuation, synchronously before it sends an automatic root
  resume (see "Automatic root recovery"). The retry recovery controller resets an idle episode
  exactly as an owner's idle input would. Nothing else emits it: wakes, notices and ceiling
  follow-ups never reset the outage budget.
- `loop-guard` needs "is any async subagent run active" for its root rule. It owns detecting that
  (pi-subagents public API if one exists, else tracking `subagent` results and `subagent-notify`
  messages). No other extension provides it.

## Names and paths

- Model-facing tools: `watch_process` (root and lane entries), `watch_start`, `watch_stop`,
  `wake_at`, `wake_cancel` (root only).
- Custom message types (these start root turns, parsed by `parse_pi.py`): `loop-watch` (watcher
  exit or deadline), `loop-wake` (timer fired), `loop-continuation` (nudge), `loop-request-incident`
  (request ceiling follow-up; also starts lane turns), `loop-root-recovery` (automatic root resume;
  details `{attempt, cause, detail, delayMs}`). Persisted state uses
  `pi.appendEntry` with `customType` `loop-wait-state` and `loop-continuation-state`.
- loop-wait run dir: `<agentDir>/loop-wait/<sessionId>/`, receipts at
  `<run-dir>/receipts/<watch-id>.json` with fields (`phase`, `observations`,
  `last_observed_at`, `deadline`, `result`, `pid`, `command`, `interval_s`), written atomically
  (write temp + rename). Watcher output at `<run-dir>/logs/<watch-id>.log`.
- Continuation incident files: `<agentDir>/incidents/<sessionId>-<UTC timestamp>.json`. A root
  recovery stop: `<agentDir>/incidents/root/<sessionId>-<UTC>-recovery-stopped.json`
  `{v: 1, session, class: loop-root-recovery-stopped, at, home, cwd, cause, detail}`, then
  `loopPi.onIncident`.
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
  files declare `extensions: []`: the root guard registers `loop-guard/lane.ts` and, when present,
  `loop-wait/lane.ts` at `session_start` with `requireForAllRunners: true`. Registration failure
  refuses dispatch; runners that cannot honour the required extensions are refused, and required
  extension load or startup failure aborts the child before its task runs. This does not load
  loop-continuation in lanes: the root's ticker uploads their transcripts. pi homes are Mac-only; without lockf,
  uploads are not serialised across processes.
  Ignore failures. The installer lays the script out only when an overlay provides it.
- The agent set (the only names the root may spawn): `worker`, `senior`, `senior-escalation`,
  `reviewer`, `scout`. The installer moves any other agent file in an installed home to
  `<home>/backups/agents-<UTC>/`.
- Every agent file sets `inheritGlobalContext: false`; the installer appends the home's
  `lane-policy.md` after a `<!-- lane-policy -->` marker instead. An overlay may replace
  `lane-policy.md`, so the return contract is not in it: every agent carries the
  `lane-return` v3 block in its own body.
- `loop-state` (`core.ts` `parseLaneReturn`) accepts a `lane-return` block with `"v": 3` (lane.md),
  `"v": 2`, or no `v`; the `return` event takes the fields it knows (`status`, `base`, `check`,
  `exit`, `coderabbit`, `questions`, ...) and drops the rest (`patch`, `patch_sha256`, `tail`).
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
- Block-only repair output (`loop-state/repair.ts`): the recovery resume names its own file,
  `output: <run dir>/return-repairs/r-<32 hex>/block.md` with `outputMode: file-only`, so the
  package never overwrites the lane's bound report with the block. The root extension creates the
  directory (0700, exclusive; run dir and `return-repairs/` must be owned by this user and not group
  or world writable) and records the binding before the resume is requested; the package writes the
  file. The `loop-state-return-recovery` entry carries `repair: {binding: {root, output},
  original?: {path, bytes, sha256}}`, and its `done` entry adds `repaired: {path, bytes, sha256}`
  and `originalIntact` (the original output still matches its recorded identity).
  - Only the bound file supplies the repair's block: inline text and paths named by the completion
    are never trusted, a completion naming a different output file is refused, and the file must be
    a plain single-link UTF-8 file of at most 1 MiB, opened without following links.
  - A bound repair is accepted only from a completion whose `sessionId` is this session's, or from
    the resumed run's package `status.json` showing a terminal state for this session. Otherwise the
    completion is ignored and the recovery stays pending.
  - A restarted root uses the recorded binding, not its own new run dir. A binding is valid only
    with the exact allocated layout under a `root` that is still its own realpath. With no run dir
    (`LOOP_PI_RUN_DIR`) no resume is requested and the return is recorded failed.
- Root extensions also include `loop-state/index.ts`: it appends `dispatch` and `return` to
  `codex/state-<stem>-loop<N>.jsonl` (sibling of the closeout, S3) through `<agentDir>/bin/loop-state`
  for `subagent` calls whose brief starts `Lane: <id> · Task: <id> [(<title>)] · Tier: ...`, and injects the
  recovery digest (`loop-state-digest`, no turn) after compaction and at session start.
  Because only that exact header is recorded, the root's loop-guard entry refuses, in a run with the
  `loop-pi-proto` marker, a `subagent` launch (any roster agent: worker, senior, senior-escalation,
  reviewer, scout) whose `task` first non-empty line fails `parseBrief`. The refusal gives the exact
  form `Lane: <id> · Task: <ID> (<title>) · Tier: routine|guarded` and the offending line; a header
  with a missing colon (`Lane x · Task Y · Tier: routine`) is refused, never parsed leniently, so
  the guard, `parseBrief` and `laneIdFromBrief` keep one grammar. Resume, status and other
  management calls, and runs without the marker, are not checked. Nested launches by `senior`
  (lane entry) are not checked.
  Admit metadata may include resolved `tier` (`routine` or `guarded`) and `surfaces` (guarded
  owned-path matches). Dispatch metadata preserves `tier`, `surface` (a brief's `Surface:` line),
  `kind` and explicit constituent `tasks`. Native reviewer launches emit `kind: review`; a
  `Tasks:` line or comma-separated task header identifies constituents, whose admitted maximum tier
  is used only when every tier is known. Historical missing metadata stays unknown, never inferred
  from an agent name. `append` warns on stderr, without rejecting, for an `admit` without `tier`;
  the root extension shows such warnings through notify.
  Digest/query audit counts split implementation dispatches, review dispatches and reported
  CodeRabbit reviews by known tier, with a separate unknown bucket. These fields are telemetry,
  not authority or enforcement inputs.
  pi-subagents' async events carry `sessionId` as the parent's session file path
  (`getSessionFile() ?? getSessionId()`) and `deadlineAt` in epoch ms.
- Lane timers: loop-wait root arms a timer on `subagent:async-started` for this session (brief
  `Deadline:`, else `deadlineAt`, else `timeoutMs`) and cancels it on `subagent:async-complete` by
  run id.
- Idle nudge: at settle, loop-continuation reads `loop-state digest --json` for `live_lanes` only (v3
  roots write no `admit` events, so `admissible` is never read and need not be present). With no live
  lane in the log, no async subagent run this process saw start and not complete, no active
  time-gated evidence park, no `loop-wait` watcher and no timer but its own WAITING auto-arm, a
  WAITING or unmarked stop gets one `idle` nudge (`details.reason: "idle"`) telling the root to
  dispatch ready work from the board or close out per the contract, instead of a release. An
  unreadable digest or a missing loop-wait reply is unknown, never idle: the WAITING release and
  `unmarked` nudge apply as before. The idle nudge counts toward `MAX_NUDGES` (3); the stop after
  the third is released with one `loop-continuation-chain-exhausted` incident, as before. A counted
  closeout or `PAUSED:` releases. The nudge text never leads with an owner control phrase.
  WAITING and PAUSED lines are matched after stripping leading `[\s*_`>-]` and trailing
  `[\s.!*_`)]` decoration.
- Loop control files: every lane is refused writes to `codex/state-*`, `codex/charter-*`,
  `codex/launch-*` and `codex/closeout-*` (exact for edit/write, best effort for bash).
- `loop-state` records a failed run's return as failed but keeps the block's `landed`, `sha` and
  other fields, so its digest never re-admits a task whose lane may already have pushed, and shows
  such a task as `landed:<status>` rather than a clean `landed`.
- Runtime entry: each session appends `loop-pi-runtime` `{v:1, variant, models:{<id>:{service_tier}}}`
  at `session_start` (variant from the home receipt's `variant`).

## Launch arming

A root armed by this build writes the run marker `$LOOP_PI_RUN_DIR/loop-pi-proto` (`2\n`; the
content is a format version). Pre-execution refusals remain marker-gated; a lane that observed the
marker retains that decision for its session. Arming also retains the marker's evidence
(`protocol: 2`) in the existing audit snapshot without resnapshotting remote refs.
Deleting the marker cannot downgrade or suppress closeout, including after session restoration;
this does not enable marker-gated root or newly loaded child refusals retroactively. A root armed
by an older build keeps its old behaviour after an install. Arm-time refusals cannot be gated
(arming writes the marker). The threat model is a mistaken root or lane, not an adversarial one: edit and write
paths are exact, bash write detection is best-effort.

- **Arming** happens in the `input` hook: "You are the root" plus exactly one closeout path
  `codex/closeout-<name>-loop<N>.md` (v3 seam S1; no other token shape arms), or a bare
  `launch-*` path whose contents match. The charter is the one `codex/charter-*-loop<N>.md` the
  launch names, else the closeout's sibling (`closeout-` replaced by `charter-`). Its keys are the
  `key: value` lines between its `# Charter:` title and its first `## ` heading. Arming refuses
  (returns `handled`, no model turn) with no run dir, a cwd whose git toplevel is not the charter's
  repository, an optional charter `host:` other than this machine, a missing charter, an `open`
  already in the state log whose `charter_sha256` is not the charter's sha256, or a launch
  `Standing:` line whose path or sha256 differs from the charter's `standing:` key (`none` or no
  key means the launch carries none; a relative charter path resolves against the charter's
  repository; more than one launch line or a malformed one is a mismatch); incident
  `incidents/root/<sid>-<UTC>-arm-refused.json`. A first input naming a
  `codex/charter-*.md` path that does not arm gets a visible relaunch warning. On success it writes the
  marker, freezes the optional `Standing: <abs> sha256=<hex>` (the standing-authority registry
  entry; copy at `<run dir>/standing.md`; a missing file or bad hash gives none and an
  `incidents/standing/` record of class `loop-standing-rejected`, and the arm still succeeds), and
  appends `open` `--by ext` when the log has none; the root never writes it. The open carries
  `charter_sha256` (the charter's sha256, the closeout header's `Charter:` value), `first_wave` (the
  charter's `## First wave` task ids), `root` `llm`, `root_model` (the charter's `root:` value,
  `unknown` when absent) and `tier` only when the charter header states `tier: routine|guarded`
  (the charter has no run tier). Telemetry only, never a gate.
  `loop-continuation:query-launch` answers `standingPath` (the frozen copy) and `standingSha256`.

## Run-dir files and return caps

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
  the audit reports it UNGRANTED; `standing.md`;
  `returns/<runId>.md`; `worktrees/l<32 hex>/`. The lane binding carries optional `runDir`.
- **Idle-parent wake (pi-subagents 0.81.0):** a turn-starting notice to an idle root is sent as
  `sendMessage(notice, { triggerTurn: true })` (`src/shared/parent-wake.js`), which pi runs as a
  custom-message run: `before_agent_start` with `messageType: "custom"`, then the notice's own
  `message_start` / `message_end`. No `input` event and no user-role wake text exist (0.80.0 removed
  `PARENT_WAKE_TEXT`). While another extension holds the shared `Symbol.for("pi.idle-wake.v1")`
  reservation for the session, or the parent is held, the notice is appended with
  `triggerTurn: false` and no extension message events. In the model request only, 0.81.0 wraps every
  pi-subagents message in `<pi_subagents_notice type=... origin="automated message from the
  pi-subagents extension, not typed by the user">` (its `context` hook); the stored message is
  unchanged. A busy root still gets the notice as a steer with message events. So:
  loop-continuation counts a run any `SUBAGENT_WAKE_TYPES` notice starts (and a `subagent-notify`
  `message_start`) as the push that resets the nudge chain; loop-guard's root counts the same run as
  a wake for its status-polling rule; `isParentWake` still accepts the 0.76.1 to 0.79.x wake texts
  for a root on an older home; `wake.test.ts` pins the wake shape and the type list against the
  installed package. loop-guard releases a run for `watch_process` on `subagent:async-complete`,
  never on a notify message; and the lane caps its own return (below).
  pi-subagents 0.81.0 also holds the parent after any aborted turn (`ctx.hasUI && ctx.signal.aborted`
  at `agent_end`) until the next `agent_start`: while held, a completion starts no turn and ends with
  "The user stopped the parent turn ... do not resume the stopped task unless asked". It cannot tell
  an operator Esc from loop-pi's request-ceiling or recovery abort. loop-state
  (`loop-state/harness-hold.ts`) opens a window at `loop-recovery:request-timeout` or
  `loop-recovery:abort`, closes it at the next `agent_start`, persists it as `loop-pi-harness-hold`
  entries, and in its `context` hook replaces that line in held notices timestamped inside a window
  with a neutral loop-pi line. An operator Esc keeps the package's text. No wake is restored: after a
  continuing incident the incident's own turn clears the hold, and after a recovery stop the root
  waits for the owner, as the recovery notice already says.
  - **No window for an owner abort.** The ceiling timer and the recovery episode timer emit their
    abort marker only while `ctx.signal` is not already aborted. An owner Esc in the same run (a race
    of milliseconds) is the owner's stop: it opens no window and its held notices keep the package's text.
  - **Compaction.** pi 1.4.0 runs the `context` hook only on the agent loop's request path
    (`core/sdk.js` `transformContext` is the single caller of `emitContext`). Native compaction, manual
    and automatic, summarises the stored messages from `prepareCompaction` and never passes through it.
    loop-state therefore rewrites the same held notices in the `session_before_compact` preparation
    (`messagesToSummarize`, `turnPrefixMessages`), replacing the lists in place with rewritten copies;
    the stored messages are untouched. `harness-hold.test.ts` pins pi's callers of `emitContext`.
    A summary written before this rewrite existed keeps whatever it already said.
  - **`/reload` in an aborted run.** A `/reload` while an aborted run is still finishing closes the
    window (the `session_start` replay closes any open window) before `agent_end` re-sets
    pi-subagents' hold. That abort's held notices then keep the package's owner-stop text. This is the
    safe direction: the root reads a stop that may not have been the owner's, never the reverse.
- **Completion reminders (pi-subagents 0.81.0):** when a completion-woken turn ends with no tool call
  and no text, pi-subagents' own `agent_before_settle` handler appends a
  `subagent-completion-unanswered` reminder and continues the run once; if that turn is silent too it
  appends a terminal `subagent-completion-unhandled` notice without continuing
  (`src/runs/background/notify.js` `handleBeforeSettle`). Neither is a push. The package skips a
  settle that an earlier handler already continues, and loop-continuation skips its nudge when
  `continue` is already set, so one silent turn never gets both; after the terminal notice the nudge
  chain still applies.
- **Subagent `options` (pi-subagents 0.81.0):** a model `subagent` call carries most fields inside
  one `options` object, which the package flattens to `{...topLevel, ...options}` only inside its
  execute (`src/extension/subagent-options.js`). Every loop-pi `tool_call` reader of a subagent call
  (loop-guard root and lane, lane-worktrees, loop-state) reads the merged view from
  `loop-guard/subagent-view.ts`; a call, or a present `options`, that is not a plain object is
  refused by the root guard. A field loop-pi rewrites (`extensionBindings`, `lane`) is removed from
  `options` and set once at the top level; lane-worktrees refuses a `lane` given in both places with
  different values, as the package does. The exception is `steeringRecovery`, an `options` key: the
  root guard removes any top-level copy and sets `options.steeringRecovery = false` on every
  `action: "steer"`. With recovery on, a steer that misses the package's 3 s acknowledgement
  interrupts the child and waits a fixed 15 s for the pause; a child that pauses later is left paused
  with the message unapplied until an explicit `resume` (upstream issue 2956, still true in 0.79.2).
  With it off the message stays queued for the child's next boundary and nothing is interrupted.
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
    if not wholly kept in the head or tail. With no run dir it is left uncapped. The full copy is pi-subagents' saved output only when its structured completion (the
    async-complete payload's single result `savedOutputPath`) matches the notify's sole valid
    `details.runs[].runId`. Absent structured runs, the notify's last `Retention-managed async
    directory:` line supplies the legacy identity and directory check. A reference-only marker
    on the first line may name the copy; a path in the return body is never used. Batched or
    malformed structured identities never select one child's file, including that marker: retain
    the whole notify in a hash-named copy. Otherwise the fallback is `returns/<runId>.md`.
  - Either cap: the head ends before the earliest `lane-return` opener with no closing fence
    inside the kept head, including earlier blocks and incomplete opener header lines. A protected
    block wholly inside the head is not appended again. Head and tail are UTF-8-safe maxima, not
    guaranteed lengths: reserve the last complete block's byte length, the marker's byte length
    computed with the full input byte count, and three newline bytes before allocating the head,
    then the tail from the remaining budget. Every non-null capped result stays within its cap,
    including the protected block and marker. A cut is supported when that reserve fits the cap
    and the real consumer, `loop-state/core.ts` `parseLaneReturn`, preserves its exact outcome
    before and after the cut. For example a usable 12 KiB last block fits the lane cap with a full-copy
    path of up to 1,024 UTF-8 bytes (and an input byte count of up to 16 decimal digits). If the
    block or marker cannot fit, or the cut changes the parser outcome, leave the text whole
    rather than truncate the structured return, promote a stale success or lose the full-copy
    reference. In particular, the last fenced block can be malformed or otherwise unusable;
    protecting it alone must not hide an earlier latest usable failed return. Both cap boundaries
    preserve that failure exactly by declining an unsafe cut, and still retain the full copy.
    These deterministic oversized/unsafe-cut fallbacks, like a missing run dir, do not promise
    the byte cap. Malformed or annotated trailing fences that change neither outcome may still cap.
  - Root preview (pi-subagents 0.81.0): the notify itself keeps only the first 2,000 characters of
    each child's output inline (cut at a line end), then `…` and `Full output: <path> (<size>,
    <lines>). Read it if needed.`, where the path is the saved output or the run's artifact file
    (`src/runs/shared/single-output.js` `capInlineOutput`). Output is left whole only when it is
    short or no readable file holds it. A capped lane return therefore reaches the root as that
    preview; the lane's omission line, and so the path of the full text, is inside the pointed-at
    file. The async-complete payload is not previewed, so the `return` event still parses the
    lane's whole (lane-capped) output.
  - Block first: because the root model sees only that preview, every lane's final message puts its
    one `lane-return` block first and at most a few lines of prose after it (home agent files). The
    parser takes the last, here the only, block, and both caps keep a block at the start in the
    head.
  - Limit: an idle-wake notify (no root extension can rewrite it) holds one previewed lane return
    with its framing, but pi-subagents batches completions that finish together into one notify,
    which is stored at the sum of their previews. The `context` hook still caps what the model sees.
## Closeout and root fences

- **Closeout**: `/loop-closeout` (loop-wait) emits `pi.events.emit("loop-closeout", {lines, pending})`
  after its sweep; loop-continuation runs
  `loop-pi-audit closeout --run-dir <rd> --push-log <rd>/push-log.jsonl` plus, for a root armed with a
  charter, `--charter <path> --charter-sha256 <digest frozen at arm>` (`rootContext.goalPath` and
  `goalSha256`); lane-worktrees adds its sweep, and the root gets one `loop-closeout-audit` custom message (a push
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
  While the marker exists, a new governed (header-parsed) single-agent launch of `worker`, `senior` or
  `senior-escalation` is refused unless it is retained: `worktree: true` (or `isolation: "worktree"`,
  with no conflicting `worktree: false` or other isolation) together with a parseable `Landing:` line,
  or an explicit `cwd` that is, or is inside, the tree retained for that lane id and task (checked first;
  it takes the single-flight, allocation-ownership and confinement checks of a resume, is refused while
  that lane has a live or pending run, and has `isolation` replaced by `worktree: false` so the package
  allocates nothing; its run and relative cwd are recorded like any retained run). The refusal
  says to add `worktree: true` and `Landing: returns candidate`, and is evaluated before the
  conflicting-shape and shared-cwd passes below, so those shapes no longer reach native allocation
  for implementation agents. `scout` and `reviewer` launches, briefs with no header, workflows and
  multi-agent shapes, `action` calls (resume, status, ...) and runs with no protocol marker are not
  subject to it.
  Governed named single-agent tool launches not intercepted for root-owned
  retention (including omitted worktree flags resolved by package defaults and missing or
  unsupported Landing) by the remaining agents (`scout`, `reviewer`) bind version-1 lane metadata with an opaque `r<32hex>l<32hex>` key derived
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
  and package RPC runs. Lifecycle completion, startup reconciliation and shutdown copy patch
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
- **Scratch register and teardown** (`lane-worktrees/teardown.ts`, root only): tool
  `scratch_register(path, kind: worktree|gate|cache, keep?, disposable?)` records a scratch path the
  root created. The path must exist and is canonicalised with the native realpath. Refused: `/`; a
  path containing home, the agent dir, the session cwd or the run dir; anything inside the run dir
  (also checked by dev/ino ancestry); a main working tree or standalone repository; a plain
  directory inside a git dir or holding tracked files. A path with a `.git` pointer file, or
  `kind: worktree`, is recorded as a linked worktree (with its common dir), anything else as a
  plain dir; `disposable` applies only to a plain dir. Registering again changes `keep` or
  `disposable`.
  - Ledger `<run dir>/scratch-ledger.jsonl`: append-only, fsynced, opened without following links,
    one line per registration `{v: 1, at, path, kind, type: "worktree"|"dir", keep, disposable,
    dev, ino, commonDir?}`. The last registration of a path wins. A malformed line is ignored with a
    receipt warning; an unreadable ledger removes nothing.
  - Teardown runs on `loop-closeout` after the unchanged lane-worktrees sweep, and the closeout line
    gains `; teardown removed N, kept M, absent K (receipt <path>)`. Ledger entries are decided
    deepest first, and a path holding another registered or lane-worktrees path that is not removed
    is kept. A registered worktree is removed only when it is still the registered directory
    (dev/ino, no link) of the same repository, not locked, `git status --porcelain
    --untracked-files=all` is empty, it holds no ignored content outside `node_modules` (else kept
    with `ignored content present` and up to 20 paths in `ignored`), and HEAD is an ancestor of
    `refs/remotes/origin/HEAD` (unset: kept). It is rechecked, then removed with `git --git-dir
    <common> worktree remove <path>`, never `--force`. A plain dir is removed only when registered
    `disposable: true` without `keep`: renamed aside, proved to be the registered directory with no
    `.git` and no other filesystem beneath, then removed; on a mismatch it is renamed back.
  - Receipt `<run dir>/teardown.json`: `{v: 1, at, runDir, ledger, counts: {removed, kept,
    absent}, entries: [{path, source: ledger|lane-worktrees|discovered, kind?, outcome:
    removed|kept|absent, reason, ignored?}], warnings}`, written through a temp file and rename and
    rewritten at each closeout. A registered directory no longer at its registered path is
    searched for by dev/ino beneath the disposable roots (not following links, bounded to 10,000
    directories and 100,000 entries) before anything is removed. Found: it is kept and reported at
    its new location with `moved from <path>`, and every directory holding it is kept. Nothing at
    the registered path and not found: `absent`, with its identity still fencing every removal.
    Teardown fails before any removal and writes no receipt when the registered path holds
    something else and the identity is not found, when two ledger paths record one dev/ino, or when
    the search budget runs out. Linked worktrees of the registered repositories and the session
    repository that nobody registered are listed with source `discovered` and never touched.
- **loop-guard, root**: refuses `loop-state` with `--by ext|daemon`, a `by=` field other
  than `root`, `--run-dir`, a stdin `by` field or an `append` event on stdin from a file (`< file`),
  edit/write into the run dir, `~/repos/agent-docs/authority/` or the planner's
  `codex/charter-*` and `codex/launch-*` (exact for edit/write, best effort for bash), a second `subagent` status for the same target with no wake since (a return,
  `loop-watch`, `loop-wake`, input, session start or compaction), and `bash` timeouts over 900 s.
  **Lanes**: authority writes and `gh pr merge`.
- **loop-state**: `land` is `after-green` only (legacy `pre-green` lines still check and digest);
  `revert` by root with `reason=root-decision`; `park needs=budget`; `close reason=budget` needs a
  `compaction-failed` or `quota-exhausted` fact; judgements up to 4 KB; one `open` per log.
- **loop-pi-audit**: under retained marker evidence a default-branch move is accounted for only when every commit in
  `before..after` lies in a push-log `old..new` range for that repo and ref or touches only
  `backlog/`; commit metadata grants nothing. Two more commits are accounted for: one whose
  final message paragraph carries a `Claude-Session:` trailer and that a logged `actor: root` push
  was made on top of (FOREIGN: reported, not a violation, never a grant; both facts are required) and, where the charter's `authority:` names release-please for the repository, a
  release-please merge, its version tag, its release and the deletion of its `release-please--*`
  branch (GRANTED; a charter that no longer hashes to its arm-time digest grants nothing). Every other added, moved or deleted ref, tag or
  release fails the audit, except `refs/pull/*` (foreign). Another snapshotted remote whose
  unchanged URL is byte-identical to the canonical repository's (no scheme, user, host-case or
  path normalisation) receives only that canonical's exact `actor: root` `old..new` ranges. Only absolute
  URLs qualify (`scheme://`, scp-like `host:path`, absolute local path); a relative URL such as
  `../up.git` never transfers. A push the log
  never saw (watcher, subprocess, script) is UNGRANTED; author, committer and current SHA are never
  backfilled. Refusing such pushes before mutation in loop-guard was deliberately not chosen.

## Declared heavy gates

Only explicit `- gate: <name> | <exact command>` lines under LOOP.md's `## Mutexes` declare heavy gates. Names are case-sensitive ASCII identifiers (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`); the command is the remainder after the first `|`, with surrounding whitespace removed. Names and commands must be unique. Ordinary mutex prose remains advisory; entries outside this section and fenced examples are not gates. Malformed explicit entries fail closed.

Run a declared gate using a direct name-only `loop-gate-lock <name>` invocation on a shell-running tool. Both loop-guard entries refuse context-changing prefixes (`cd`, `env`, assignments, interpreter/shell wrappers), pipelines, compound commands, redirections and unsupported/unparseable shell forms around the wrapper. The guard evaluates the local worktree declaration against all existing rules and shared hooks, then replaces the tool's command with a shell-quoted wrapper invocation carrying guard-owned `--cwd <canonical execution cwd>` and `--sha256 <hash of the exact LOOP.md bytes>`. Model-supplied binding flags are refused. The public CLI executes in that bound cwd, independently of the calling shell's cwd and Git environment; it reads LOOP.md once and refuses a digest mismatch. Outside guarded tools, the CLI's name-only form discovers the local worktree by walking canonical cwd to `.git`, not by querying Git environment variables. Binding flags must be supplied together.

Explicit `git push` and `gh pr merge` declarations, including the existing parser's recognized wrappers, aliases and interpreter forms, are refused as gates for root and lanes: the gate wrapper has no attributable remote-move audit plan. Run remote moves as separate audited bash calls. This does not expand detection to concealed task-runner/script-file behavior.

The CLI runs the declared command with `/bin/bash -c` in the approved cwd, holding a kernel `fcntl.flock` until the child finishes, forwarding termination signals, and preserving the child's exit or terminating signal. The child inherits the flock descriptor, so killing the supervisor cannot release the lock while that descriptor remains open. Lock files are never unlinked on release.

The invariant production domain is **one OS account on one machine**, across all its repositories, worktrees and pi homes. The lock directory is the OS account database's home plus `.local/state/loop-pi/gate-locks`; the file is `<sha256(name)>.lock`. HOME, TMPDIR and LOOP_PI_GATE_LOCK_DIR cannot select a different domain; there is no CLI/environment test-domain override. Every directory component is opened relative to a held fd without symlink following. Ancestors must be root/account-owned and not group/other writable; account-home and state directories must be account-owned, with gate-locks exactly 0700. Lock files must be account-owned regular files, exactly 0600, with one hard link and no symlink. Unsafe paths fail closed rather than changing permissions or provisioning other users. Gate children do not inherit LOOP_PI_RUN_DIR, LOOP_PI_REPO, LOOP_PI_GATE_LOCK_DIR, GIT_* variables, BASH_ENV or ENV.

This remains the existing honest-mistake fence, not an OS security boundary against adversarial same-account code or deliberately concealed script/task-runner commands. There is no cross-user, cross-host or network-filesystem serialization guarantee. Proving tests use real account-domain locks with unique test names; private-path validation fixtures substitute account metadata only inside unit tests.

After declaration/path validation, the CLI queues best-effort version-1 JSON timing records for
stderr with `type=loop_gate_timing`, `invocation_uid` (fresh UUID), `lock_id` (the existing SHA-256
of the stable gate name), `event=waiting|acquired|finished`, and `observed_at_ms` (UTC epoch
milliseconds). No gate name, command, cwd, environment, child output or error text is included.
`waiting` is observed and queued before the blocking flock. Delivery may lag or be dropped,
preserves FIFO order, and completion drain is bounded after flock release. `acquired` reports
monotonic `wait_ms` measured only around
flock; `finished` reports that `wait_ms`, `execution_ms` measured around child spawn/wait,
`elapsed_ms` from wait start, and the child's `returncode` (negative for a terminating signal).
These are supervisor-observed intervals, not kernel child CPU time. Missing finished records,
including supervisor SIGKILL, are incomplete observations. Timing I/O failures never alter locking,
signal forwarding, child execution or exit status; no new file, destination option or lock override
is introduced. The existing lock domain and descriptor inheritance remain unchanged.

## Root activity and watch lifecycle events

The frozen version-1 state-log bodies are `watch {op: "start" | "stop", what: string, deadline: string}` and `heartbeat {at: string}`. Existing framing (`v`, `seq`, `ts`, `by`) is unchanged; extensions append with `by=ext`. No additional event fields are introduced.

- `loop-wait:state-event` carries `{event: {ev: "watch", op, what, deadline}, reply(recorded: Promise<boolean>)}`. The loop-state root replies synchronously, before awaiting, with the append outcome. Missing reply or a false outcome leaves the event pending in the branch-local `loop-wait-state` snapshot for restart. Successful recording removes that pending event. The root wait entry drains outstanding recording on orderly shutdown. Delivery is causal per instance (`what` plus `deadline`): a pending start is retried before its stop and must be acknowledged before that stop can be sent. A missing, false or rejected acknowledgement leaves the head and every successor durable in order. A later lifecycle event or restart retries the head; unrelated instances proceed independently. A transition arriving during an in-flight attempt stays queued behind it; if that attempt fails, both remain durable for the next trigger or restart. There is no idle retry loop. A start written before its acknowledgement was lost uses whole-instance exact-event deduplication before its stop is delivered. An unwritten start cannot be replayed after an acknowledged stop and falsely reopen that instance.
- `what` names an instance, not only a reusable label: `watch <id>: <label>` for processes, `wake <id>: <reason>` for timers. `deadline` is the exact ISO deadline stored by the corresponding manager. Stop reuses the start's `what` and `deadline`. This preserves the frozen schema and allows correlation and deduplication across restarts and repeated labels.
- Start is emitted by successful watch creation/timer arming (including continuation-owned and lane-deadline timers). Stop is emitted at process completion, deadline, explicit stop/cancel, closeout, orderly shutdown, and terminal reconciliation, independently of wake-message delivery/suppression. Replaying a timer start or terminal reconciliation does not append a duplicate exact event.
- Heartbeats observe root `turn_start`, root tool execution start/end, and assistant `message_end` only when a launch is armed. Session startup, timers, receipt polls, custom notifications and idle ticks are not root activity. There is no heartbeat timer. The log writer serializes and deduplicates heartbeat attempts under its append lock: first activity is recorded, then only activity at least 300 seconds after the last recorded heartbeat (including across restart, with backward clocks suppressed).
- `loop-state check` accepts new and old logs. Digests preserve legacy task/lane classification and expose new watch/heartbeat information only in logs that have these events; old digest output stays unchanged.

The protocol event table is owned by the protocol source. No authority fences, budgets, pins or model selection are changed.

## State-aware root context budget

The model root's continuation state freezes the accepted charter text, its SHA-256 and source path
(under the persisted `rootContext` field names `goalText`, `goalSha256`, `goalPath`), root cwd and run directory at arm. `loop-continuation:query-launch` exposes this optional
`rootContext` snapshot; old sessions without it do not acquire it by reading a moving charter.
The native system prompt remains Pi-owned. No authority is inferred from a model summary.

- **Two triggers.** The **backstop** below (80%, quiet fleet) is unchanged. The **push trigger**
  compacts earlier, at a batch boundary: loop-guard's `loop-guard:push-recorded` marks that a root
  push landed, and the first evaluated `agent_settled` after it compacts when usage is at or above
  the push share, default **55%** (about 480k of an 872k window, leaving roughly the same again
  before the backstop; lower values compact every batch and pay a cold prompt cache each time).
  `LOOP_PI_COMPACT_AFTER_PUSH_PERCENT` sets it to a whole number from 1 to 79; anything else
  uses the default. The push trigger does not require a quiet fleet and does not take the 80%
  latch: state is on disk, the digest names live lanes, and the settled-boundary and
  revision checks below still decline when input or a child completion arrives during preparation.
  With live children, pi-subagents' own post-compaction resume message may start one extra root
  turn. A push that did not reach the share is spent at that boundary; the next push is the next
  boundary. A push compaction that completes, or is declined for live work without an error,
  hands its attempt back, so the two-attempt allowance bounds failures only and a long loop
  compacts once per batch; a failed or aborted one still consumes it.
- The summary opens with a `Compaction trigger:` line naming the loop-pi context-budget
  extension (loop-state), that it was automatic, and the reason (a landed push at N% past the
  push share, or the 80% backstop), so the root knows why its context changed.
- `loop-state` checks Pi 1.4.0's public `ctx.getContextUsage()` at `agent_settled`, only when
  not aborted, `ctx.isIdle()`, no pending messages and no queued/running native async children.
  Active async work defers proactive compaction until a later settled boundary after completion;
  it does not consume an attempt or suppress the normal child completion wake. Quiet requires a
  supported current-session native status reply with zero displayed active children, zero occupied
  top-level capacity and a complete version-1 async snapshot: no omitted runs/children or byte-limit
  truncation, and only known terminal native job roots. Display nodes must have known kinds and
  states, but their cached step states are not job liveness: a completed native job can retain a
  running display step. The pinned projection keeps active materialized jobs as roots when their
  workflow parent is terminal; a running parent independently refuses quiet. Zero displayed steps
  alone does not prove zero queued/running jobs during native finalization. Unknown or incomplete status also defers
  without consuming an attempt; this includes native snapshots exceeding their current 20-run or
  32-KiB bounds. This avoids the
  pinned package treating proactive compaction as an operator request to resume the root. `percent` is a percentage, so the proactive
  trigger is **80%** (fraction 0.8), not 0.8%. It does not guess tokens from provider clocks.
  Unknown usage, missing methods or a missing frozen snapshot is a concrete unsupported boundary,
  not permission to restart. The latch survives in `loop-root-context-budget` custom entries:
  at most one attempt per high-usage generation; a known reading below 70% rearms it (10 percentage
  points of hysteresis). Null post-compaction usage never rearms it. There is no timer or retry. At most two
  proactive compaction attempts are admitted per same-session run, including preparation failures
  and native failures or aborts. The count and exact session/run binding persist alongside the
  latch; reload never resets them. Unknown legacy consumption conservatively exhausts the allowance.
- The extension drains its state append queue, obtains the CLI's bounded state digest and freezes
  the dispatch-count projection (implementation runs excluding `kind: review` and `recovery_of`,
  without resetting any consumed attempt). The summary consists only of frozen charter/root/run
  identity, frozen authority references/hashes, digest and that projection, at most 32,768 UTF-8
  bytes. Larger or unreadable state refuses this compaction; no structured state is cut to fit.
  The append-only state log stays authoritative for admits, dispatches, returns, parks and budgets.
- It calls **native same-session `ctx.compact({onComplete,onError})`** while idle and supplies
  that state summary through `session_before_compact`. A context-invisible custom attempt entry
  is the valid kept boundary, so all prior conversation is removed from model projection while
  raw entries remain on disk. Native `session_compact` still regenerates the digest. Success does
  not start a turn; failure/abort changes neither the log nor frozen runtime authority, and does
  not spawn/resume a child or replace/relaunch the root. Ordinary/native overflow compaction is
  unchanged. An input or child completion arriving during summary preparation makes it decline
  the proactive attempt rather than aborting live work.
- Provenance: pinned Pi extension and compaction docs; `ContextUsage`, `CompactOptions`,
  `ExtensionContext` in `dist/core/extensions/types.d.ts`; `AgentSession.getContextUsage`,
  `compact`, `isIdle`, `_emitAgentSettled` in `dist/core/agent-session.js`; metadata cut points in
  `dist/core/session-manager.js`. Physical model limits are Pi's responsibility, including virtual
  routes. pi-subagents 0.81.0's existing 2,000-character preview/full-file transport is unchanged.
  The full-return boundary is the resolved native package artifact written by `resolveSingleOutput`,
  not raw provider/session terminal text: `stripAcceptanceReport` extracts structured acceptance
  metadata and removes terminal whitespace before resolution. Substantive text and internal
  whitespace remain intact; the preview still points to the complete resolved artifact. This
  adds no raw-byte guarantee, wrapper or package change.
- The budget coordinator's session start/shutdown lifecycle is composed through loop-state's
  existing handlers, alongside dispatch/recovery initialization and queue shutdown.


## Durable return artifact

The optional version-1 `return.artifact` field is an absolute nonempty path without NUL. It is extension-owned metadata from the sole native completion result, never projected from lane-authored return JSON or a notification body. Existing return fields, event framing and all twelve event schemas remain strict; readers accept only this additive optional field. The path names the complete resolved native package artifact after acceptance metadata extraction and terminal whitespace normalization. It is not the native display envelope, which appends a saved-output reference. The existing lane cap may retain an even larger original response behind its omission marker; that separate full copy and marker remain unchanged, and the package artifact is never presented as that original response. Missing or invalid native metadata leaves the field absent, never invents a path. The CLI and catalogue reader validate its type without dereferencing it. Producers must ship only after the compatible reader has been adopted.

## Loop status line

`extensions/loop-status/` is a root-only extension (listed in the installer's root extension set
only; lanes never load it). It is the sole owner of the status key `loop-status`,
set with `ctx.ui.setStatus`; it sets no widget and clears the key at `session_shutdown`.

- The status line reads, and writes nothing to, existing seams: `loop-wait:query-timers` and
  `loop-wait:query-watchers` (the optional `deadline` of each watcher; no reply shows `timers ?` or
  `watchers ?`), the latest `loop-continuation-state` entry's `nudgeCount` against `MAX_NUDGES`, this
  session's live async runs (`subagent:async-started` / `subagent:async-complete`, counted the way
  loop-continuation counts them), and the newest `heartbeat` row in the tail of the loop-state log
  beside the launch closeout. The closeout path (`reportPath`), and `concurrency` for the slot cap, come from
  `loop-continuation:query-launch` once per launch.
- There is no timer. The line is rebuilt, coalesced to one microtask, on `subagent:async-started`,
  `subagent:async-complete`, `session_start`, `agent_start`, `agent_settled` and
  `tool_execution_end`, so heartbeat age and nudge count are as of that rebuild. Nothing is set
  without a UI.
- Format: `loop: <N>/<cap> lanes (or <N> lane(s) when no cap) · <N> timers · <N> watchers · next
  HH:MM (earliest timer or watcher deadline, if any) · root model time <P>% of <wall> (or ?, or
  absent before the first root request) · nudge <n>/<max> · hb <age> ago (or hb -)`.
- **Root model time.** `loop-status/modeltime.ts` sums the root's own model request durations and
  divides by the wall time since the launch (`loop-continuation:query-launch` `launchedAt`), else
  since the session header's timestamp. The only source is `loopPiProgress` (`startedAt`,
  `endedAt`, `state: "ended"`), which call-timing already persists on every root assistant message
  ("Request progress seam"), so nothing new is stored: the figure is rebuilt from
  `sessionManager.getEntries()` and is the same after a reload, a resume or a compaction (compaction
  never removes entries). A request is clipped to the window, so one that began before the launch
  counts only from it; the share is capped at 100%. Only the root's session is read: a lane's
  requests live in the lane's own session and are never counted, and a request pi makes outside an
  agent turn (a compaction summary) is not observed by call-timing, so it is not counted either.
  **Unknown fails closed:** unreadable entries or start time, a non-positive wall time, or
  assistant messages with no finished timing record (call-timing not loaded) show `root model time ?`
  and never produce a notice; a session with no assistant message yet shows no segment.
- **Wake notice.** An idle root is woken by a pi-subagents notice (a lane return or any other type
  in `SUBAGENT_WAKE_TYPES`) or by a `loop-watch` / `loop-wake` custom message from loop-wait (a watch
  exit or `wake_at`); each starts a custom-message run through `before_agent_start`. loop-status returns at most one
  message from that hook, `loop-model-time-notice`, one line:
  `Root model time is above 60% of wall time (<P>% of <wall>): combine reviews and keep ledgers to one-line appends.`
  It is added only when the share is strictly above `ROOT_MODEL_TIME_NOTICE_SHARE` (0.6) and the
  wall time is at least `ROOT_MODEL_TIME_NOTICE_MIN_WALL_MS` (30 minutes); otherwise, or when the
  share is unknown, the wake is untouched. It needs an armed launch (`launchedAt` from
  `query-launch`), so a plain session on a loop home never gets it. After one notice it repeats
  only when the share reaches a higher 10-point band or `ROOT_MODEL_TIME_NOTICE_EVERY_WAKES` (10)
  wakes later; that count is in memory and resets on reload. A pre-0.80 pi-subagents wake (an
  extension-sourced user prompt) is still recognised from its `input` event (source `extension`,
  `isParentWake`) paired with the same prompt text, so an operator typing that text gets no notice;
  the pairing is dropped at `agent_settled`. A wake that reaches a busy
  root as a steer starts no run and carries no notice. The notice is advisory text only: no request
  is blocked, wrapped or retried, and the wake text, push detection and nudge chain are unchanged.
- **Nested runs (pi-subagents 0.81.0).** `subagent status` lists the runs whose `status.json`
  `sessionId` is the asking session's file. A run a lane launches (depth 2) carries the lane's
  session file, so the root's own listing omits it and `status id=<run>` answers "Async run not
  found". Every child session sits under the launching session's directory
  (`<sessions>/<root basename>/...`), so `loop-status/descendants.ts` treats a live run whose
  `sessionId` is inside the root's directory as nested. It reads only
  `$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs/.active-runs` and each run's `status.json`, writes
  nothing, and skips anything it cannot parse. The extension then (a) appends a "Nested runs below
  this session's lanes" section, each with its parent lane run id when a listed lane's session file
  names it, to a no-id `subagent status` result; (b) answers `status id=<nested run or unique
  prefix>` in any state in place of "Async run not found", leaving every other result untouched;
  and (c) shows `(+N nested)` beside the lane count. Views (`fleet`, `transcript`) and `dir`
  lookups are never altered. An unset `PI_SUBAGENTS_TEMP_ROOT` shows no nested runs.
- A pi child's parent link is already recorded by pi-subagents: the child session header's
  `parentSession` is the launching session's file path. For a lane that file is always named
  `session.jsonl`, so a reader that wants the parent's id must resolve the path, not its basename.

### Child metadata observation

The root-only loop-status entry registers `/loop-children` and `/loop-inspect <asyncId> [childId]`.
Both produce a displayed custom message with `triggerTurn: false`; neither dispatches a model,
changes capacity/liveness, nor adds a tool. `/loop-children` queries the correlated version-1
native status RPC once (3 s bound) and displays `asyncSnapshot` step `agent`, `model`, `thinking`.
Unknown/old fields stay unknown; omission markers are shown as partial. Snapshot model metadata
can change after a reply and is not evidence of an answering provider.

`/loop-inspect` reads bounded (256 KiB), no-follow regular canonical status metadata for an
exact async ID. It validates the run ID and current-session ownership (including native session
succession) before selecting a child. It never invokes native stale reconciliation, opens a
transcript/output artifact or alters lifecycle state. Only the selected step's native
`resolvedModel.provider/model` supplies answering identity, matching the own-reply rule of
`/subagents-inspect-rpc`. Missing fields never fall back to history, labels or configured routes.
A multi-step run has no single answering child; select its native `step:0` or other child ID.
Workflow linked-child fallback and in-memory/nested aliases are unsupported and remain unknown.
The requested route comes from explicit `launchModel`, or a single-run recovery descriptor with
matching version/source-run ID. An old run without that evidence shows unknown; the current
status `model` is never mislabeled as the original request. Both commands reject observations
if the current session changes while awaiting their native dependencies. Native status RPC may
perform its ordinary status reconciliation; this view adds no lifecycle control. Metadata fields
are bounded and stripped of terminal controls. These fields describe Pi's recorded reply, not
an undisclosed backend behind a provider route. Package-internal import paths are version-pinned
compatibility seams; native reply-to-view parity and real root/child tests cover them.
