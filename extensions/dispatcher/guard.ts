// Thin adapter onto loop-guard for every dispatcher spawn: the same subagent rule and identity
// binding the root's tool_call handler applies, since an RPC spawn never passes through tool_call.

import { bindLaneIdentity } from "../loop-guard/push-grant.ts";
import { evaluateSubagentCall } from "../loop-guard/rules.ts";

// The dispatcher is the v2 scheduler: it still spawns the retired v2 agent names, which SEAMS S4
// removed from the root's roster. It keeps them through this explicit roster until the dispatcher
// is retired; nothing in the shipped home defines these agents, so it cannot launch one.
export const DISPATCHER_AGENTS: ReadonlySet<string> = new Set([
  "mapper", "mapper-deep", "gate-runner", "lane-worker", "lane-worker-push", "lane-worker-retry", "lane-worker-retry-push",
  "complex-worker", "complex-worker-push", "super-worker", "super-worker-push", "megasuper-worker", "megasuper-worker-push",
  "reviewer", "reviewer-high", "security-reviewer", "rescue-astra-medium", "rescue-astra", "lane-worker-low",
  "lane-worker-low-push", "triager", "ops", "ops-probe",
]);

type Bind = (input: Record<string, unknown>, agent: string, opsEntry?: Record<string, unknown>, options?: { runDir?: string }) => void;

/** Checks and binds one spawn's params in place. Returns the refusal reason, if any. */
export function guardSpawn(params: Record<string, unknown>, agent: string): string | undefined {
  const decision = evaluateSubagentCall(params, DISPATCHER_AGENTS);
  if (decision.block) return decision.reason ?? "loop-guard refused the subagent call";
  (bindLaneIdentity as unknown as Bind)(params, agent, undefined, { runDir: process.env.LOOP_PI_RUN_DIR });
  return undefined;
}
