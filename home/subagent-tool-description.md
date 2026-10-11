LOOP-PI DISPATCH (operator-authorised protocol for this home; fan-out protocol Appendix C):
• Launch every lane as its own async `subagent` call with {agent, task}, one call per lane. This is the delegation the operator authorised; each call is a separate top-level run.
• Never launch a workflow here: loop-guard refuses every `workflow` value, `workflow: "parallel"` included, and the removed `workflowScript` / `workflowScriptPath`. For parallel lanes make several single {agent, task} calls instead. A workflow child does not get the checkpoint steer before its run deadline.
• The lines below that offer `{workflow:"parallel",...}` and ask for "exactly one top-level subagent workflow call" are pi-subagents' generic guidance. They do not apply in this home. Every other line of it does.

{{compactDescription}}
