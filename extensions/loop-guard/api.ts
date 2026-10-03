// loop-guard's launch-time policy for any spawner that is not the root's own tool_call handler
// (the dispatcher). Not an extension entry: import it, never load it with `--extension`.
// A spawner must call evaluateSubagentCall and evaluateOpsLaunch, refuse on a block, then
// bindLaneIdentity(input, agent, entry) before spawning.
export { evaluateSubagentCall, type Decision, type SubagentInput } from "./rules.ts";
export { bindLaneIdentity } from "./push-grant.ts";
export { evaluateOpsLaunch, QUERY_LAUNCH_EVENT, type OpsEntry, type OpsLaunchDecision } from "./ops.ts";
