// Async child identity is supplied by the trusted root tool_call handler (or the dispatcher),
// never by the model or by prompt text. Missing/invalid identity denies pushes and ops grants.
import { GUARD_NAMESPACE, OPS_AGENTS, OPS_PROBE_AGENT, PROBE_KIND, isBindableRunDir, validateOpsEntry, type OpsEntry } from "./ops.ts";

const PUSH_AGENTS: ReadonlySet<string> = new Set([
  "lane-worker-push",
  "lane-worker-retry-push",
  "complex-worker-push",
  "super-worker-push",
  "megasuper-worker-push",
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

export interface BindOptions {
  /** The loop run dir (SEAMS S1), bound so a lane without `LOOP_PI_RUN_DIR` in its environment
   *  can still write the push log and refuse writes into the run dir. Ignored unless absolute. */
  runDir?: string;
}

/** Replace, do not merge: no model-supplied namespace may grant authority.
 *  Without `opsEntry` this binds `{agent}`. With it (agents `ops` and `ops-probe` only) it binds
 *  `{agent, surface, entry}` with a copy of the full frozen entry. An ops agent without a valid
 *  entry, `ops-probe` on an entry whose kind is not `probe`, or an entry for any other agent,
 *  throws: the caller must not launch. `options.runDir` adds the optional `runDir` field. */
export function bindLaneIdentity(input: Record<string, unknown>, agent: string, opsEntry?: OpsEntry, options: BindOptions = {}): void {
  const runDir = isBindableRunDir(options.runDir) ? { runDir: options.runDir } : {};
  if (opsEntry === undefined) {
    if (OPS_AGENTS.has(agent)) throw new Error(`loop-guard: agent ${agent} requires its ops entry; refusing to bind.`);
    input.extensionBindings = { [GUARD_NAMESPACE]: { agent, ...runDir } };
    return;
  }
  if (!OPS_AGENTS.has(agent)) throw new Error(`loop-guard: only agent ops or ops-probe takes an ops entry, not '${agent}'.`);
  const entry = validateOpsEntry(JSON.parse(JSON.stringify(opsEntry)));
  if (!entry) throw new Error("loop-guard: the ops entry is malformed; refusing to bind.");
  if (agent === OPS_PROBE_AGENT && entry.kind !== PROBE_KIND) {
    throw new Error(`loop-guard: agent ops-probe binds only kind probe, not '${entry.kind}'; refusing to bind.`);
  }
  input.extensionBindings = { [GUARD_NAMESPACE]: { agent, surface: entry.surface, entry, ...runDir } };
}
