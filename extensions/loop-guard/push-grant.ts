// Async child identity is supplied by the trusted root tool_call handler,
// never by the model or by prompt text. Missing/invalid identity denies pushes.
const PUSH_AGENTS: ReadonlySet<string> = new Set([
  "lane-worker-push",
  "lane-worker-retry-push",
  "complex-worker-push",
]);

export function hasLanePushGrant(rawBindings: string | undefined): boolean {
  if (!rawBindings) return false;
  try {
    const bindings = JSON.parse(rawBindings);
    const agent = bindings?.["loop-pi.guard/1"]?.agent;
    return typeof agent === "string" && PUSH_AGENTS.has(agent);
  } catch {
    return false;
  }
}

/** Replace, do not merge: no model-supplied namespace may grant authority. */
export function bindLaneIdentity(input: Record<string, unknown>): void {
  input.extensionBindings = { "loop-pi.guard/1": { agent: input.agent } };
}
