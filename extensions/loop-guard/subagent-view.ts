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
 *  A present `options` that is not a plain object is refused: the package rejects it too, and a
 *  guard must never read a shape it cannot see through. */
export function subagentCallView(input: unknown): SubagentCallView {
  if (!isPlainObject(input)) return { ok: true, view: {} };
  const { options, ...topLevel } = input;
  if (options === undefined) return { ok: true, view: topLevel };
  if (!isPlainObject(options)) {
    return { ok: false, reason: "loop-guard: `subagent` options must be a plain object." };
  }
  return { ok: true, view: { ...topLevel, ...options } };
}

/** The view, or `{}` when `options` is malformed (callers that only read identity fields). */
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
