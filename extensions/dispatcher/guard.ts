// Thin adapter onto loop-guard for every dispatcher spawn: the same subagent rule and identity
// binding the root's tool_call handler applies, since an RPC spawn never passes through tool_call.

import { bindLaneIdentity } from "../loop-guard/push-grant.ts";
import { evaluateSubagentCall } from "../loop-guard/rules.ts";

type Bind = (input: Record<string, unknown>, agent: string, opsEntry?: Record<string, unknown>) => void;

/** Checks and binds one spawn's params in place. Returns the refusal reason, if any. */
export function guardSpawn(params: Record<string, unknown>, agent: string): string | undefined {
  const decision = evaluateSubagentCall(params);
  if (decision.block) return decision.reason ?? "loop-guard refused the subagent call";
  (bindLaneIdentity as unknown as Bind)(params, agent);
  return undefined;
}
