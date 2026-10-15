// Async child identity is supplied by the trusted root tool_call handler, never by the model or by
// prompt text. No identity grants a push: only the root pushes (SEAMS "Child runtime"), so the lane
// guard refuses `git push` outright. The binding carries identity and the run dir only.

export const GUARD_NAMESPACE = "loop-pi.guard/1";

export interface BindOptions {
  /** The loop run dir (SEAMS "Run-dir files"), bound so a lane without `LOOP_PI_RUN_DIR` in its
   *  environment can still refuse writes into the run dir. Ignored unless absolute. */
  runDir?: string;
}

/** True for an absolute, NUL-free path string: the only run dir a binding may carry. */
export function isBindableRunDir(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\u0000");
}

/** Replace, do not merge: no model-supplied namespace may grant authority. Binds `{agent}`, plus
 *  the optional `runDir` from `options`. */
export function bindLaneIdentity(input: Record<string, unknown>, agent: string, options: BindOptions = {}): void {
  const runDir = isBindableRunDir(options.runDir) ? { runDir: options.runDir } : {};
  input.extensionBindings = { [GUARD_NAMESPACE]: { agent, ...runDir } };
}

export interface LaneBinding {
  agent?: string;
  /** The loop run dir the root bound, when it is an absolute path. */
  runDir?: string;
}

/** Parse the child's `PI_SUBAGENT_EXTENSION_BINDINGS`. Missing or malformed input binds nothing. */
export function parseLaneBinding(raw: string | undefined): LaneBinding {
  if (!raw) return {};
  let bindings: unknown;
  try {
    bindings = JSON.parse(raw);
  } catch {
    return {};
  }
  const guard = (bindings as Record<string, unknown> | null)?.[GUARD_NAMESPACE] as Record<string, unknown> | undefined;
  if (!guard || typeof guard !== "object") return {};
  const agent = typeof guard.agent === "string" ? guard.agent : undefined;
  return isBindableRunDir(guard.runDir) ? { agent, runDir: guard.runDir } : { agent };
}
