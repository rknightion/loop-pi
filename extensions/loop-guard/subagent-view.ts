// One view of a model `subagent` call for every guard that reads it.
//
// pi-subagents 0.77.0 takes most fields inside one `options` object and flattens it to
// `{...topLevel, ...options}` only inside its execute (src/extension/subagent-options.js), so a
// tool_call handler sees the raw shape. Every rule that reads a launch field reads this merged view
// instead of the top level alone; a field set in either place counts.

export type SubagentCallView =
  | { ok: true; view: Record<string, unknown> }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The call's fields with `options` lifted over the top level, as pi-subagents executes them.
 *  A call that is not a plain object, or a present `options` that is not one, is refused: the
 *  package rejects it too, and a guard must never read a shape it cannot see through. */
export function subagentCallView(input: unknown): SubagentCallView {
  if (!isPlainObject(input)) return { ok: false, reason: "loop-guard: a `subagent` call must be a plain object." };
  const { options, ...topLevel } = input;
  if (options === undefined) return { ok: true, view: topLevel };
  if (!isPlainObject(options)) {
    return { ok: false, reason: "loop-guard: `subagent` options must be a plain object." };
  }
  return { ok: true, view: { ...topLevel, ...options } };
}

/** The view, or `{}` when the call or its `options` is malformed (callers that only read identity fields). */
export function subagentFields(input: unknown): Record<string, unknown> {
  const result = subagentCallView(input);
  return result.ok ? result.view : {};
}

/** Removes `key` from the call wherever the model may have put it: the top level and `options`. */
export function deleteSubagentField(input: Record<string, unknown>, key: string): void {
  delete input[key];
  const options = input.options;
  if (isPlainObject(options)) delete options[key];
}

/** True when `key` is set at the top level or inside `options` (even a malformed `options`
 *  counts as set, so a refusal never depends on parsing it). */
export function hasSubagentField(input: unknown, key: string): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (record[key] !== undefined) return true;
  const options = record.options;
  return !!options && typeof options === "object" && (options as Record<string, unknown>)[key] !== undefined;
}

/** A native `steer` that misses its 3 s acknowledgement makes pi-subagents interrupt the child and
 *  wait a fixed 15 s for the pause before launching a replacement. A child that pauses later is left
 *  paused with the message unapplied (upstream issue 2956). The native slow-boundary e2e still
 *  reproduces this with pi-subagents 0.83.0 / pi 1.4.0. Steer calls therefore always carry
 *  `steeringRecovery: false`: the message stays queued for the child's next boundary and nothing is
 *  interrupted. pi-subagents' own RPC and slash steering force the same value. */
export function disableSteeringRecovery(input: Record<string, unknown>): void {
  if (typeof input.action !== "string" || input.action.trim() !== "steer") return;
  delete input.steeringRecovery;
  if (input.options === undefined) input.options = {};
  if (isPlainObject(input.options)) input.options.steeringRecovery = false;
}
