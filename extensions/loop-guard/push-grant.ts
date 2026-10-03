// Async child identity is supplied by the trusted root tool_call handler (or the dispatcher),
// never by the model or by prompt text. Missing/invalid identity denies pushes and ops grants.
import { GUARD_NAMESPACE, OPS_AGENT, validateOpsEntry, type OpsEntry } from "./ops.ts";

const PUSH_AGENTS: ReadonlySet<string> = new Set([
  "lane-worker-push",
  "lane-worker-retry-push",
  "complex-worker-push",
  "lane-worker-low-push",
]);

export function hasLanePushGrant(rawBindings: string | undefined): boolean {
  if (!rawBindings) return false;
  try {
    const bindings = JSON.parse(rawBindings);
    const agent = bindings?.[GUARD_NAMESPACE]?.agent;
    return typeof agent === "string" && PUSH_AGENTS.has(agent);
  } catch {
    return false;
  }
}

/** Replace, do not merge: no model-supplied namespace may grant authority.
 *  Without `opsEntry` this binds `{agent}`. With it (agent `ops` only) it binds
 *  `{agent: "ops", surface, entry}` with a copy of the full frozen entry. Agent `ops` without a
 *  valid entry, or an entry for any other agent, throws: the caller must not launch. */
export function bindLaneIdentity(input: Record<string, unknown>, agent: string, opsEntry?: OpsEntry): void {
  if (opsEntry === undefined) {
    if (agent === OPS_AGENT) throw new Error("loop-guard: agent ops requires its ops entry; refusing to bind.");
    input.extensionBindings = { [GUARD_NAMESPACE]: { agent } };
    return;
  }
  if (agent !== OPS_AGENT) throw new Error(`loop-guard: only agent ops takes an ops entry, not '${agent}'.`);
  const entry = validateOpsEntry(JSON.parse(JSON.stringify(opsEntry)));
  if (!entry) throw new Error("loop-guard: the ops entry is malformed; refusing to bind.");
  input.extensionBindings = { [GUARD_NAMESPACE]: { agent: OPS_AGENT, surface: entry.surface, entry } };
}
