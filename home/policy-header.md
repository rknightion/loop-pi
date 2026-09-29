# loop-pi home

This is `{{HOME}}`, a dedicated pi home used only for fan-out loop roots and their children. It is
not a Claude or Codex home: there is no hook runner, no MCP, no code-mode exec cell and no
`wait_agent`. The fan-out protocol's Appendix C (pi profile) governs loop mechanics; where these
instructions mention Codex- or Claude-only tools, use the pi equivalent.

- Long waits: lanes use `watch_process`; the root uses `watch_start` and `wake_at` and ends its turn
  with `WAITING: <what> until <deadline>`. Never background a process with `&`, `nohup`, `disown`
  or `setsid`.
- Models: only the model family this home's settings allow (`loopPi.modelFamily`, by default the
  gpt-6 family: `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`). Never pass a `model` override to
  `subagent`.
- Delegation and push rights are fixed per agent file. Spawn only the agents this home defines.
- Dispatch: launch each lane as its own async `subagent` call with `{agent, task}`. That is the
  operator-authorised protocol here. Never launch a workflow (`workflowScript`, `workflowScriptPath`,
  `workflow`); pi-subagents' "exactly one top-level workflow call" guidance does not apply in this home.
- `loop-guard` blocks plainly typed mistakes; it is not a security boundary. The closeout audit is
  the evidence that no ungranted remote change happened.
- This home's runtime is owned by `loop-pi-install`. Never edit its generated files, `auth.json` or
  the pinned prefix by hand; change the source or the overlay and re-run the installer.
