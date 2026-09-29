LOOP-PI DISPATCH (operator-authorised protocol for this home; fan-out protocol Appendix C):
• Launch every lane as its own async `subagent` call with {agent, task}, one call per lane. This is the delegation the operator authorised; each call is a separate top-level run.
• Never launch a workflow here: no `workflowScript`, `workflowScriptPath` or `workflow`. loop-guard blocks them. A workflow child does not get the checkpoint steer before its run deadline.
• The line below that asks for "exactly one top-level subagent workflow call" is pi-subagents' generic guidance. It does not apply in this home. Every other line of it does.

{{compactDescription}}
