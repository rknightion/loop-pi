// Ops grant class: the root-side launch check and the lane-side binding parse.
//
// An ops grant comes only from the ops file frozen at launch by loop-continuation, answered on
// `pi.events` `loop-continuation:query-launch` as `{reportPath, opsPath, ops}`. The root admits an
// `ops` launch only for a surface in that file and binds the full entry into the child's
// `loop-pi.guard/1` extension binding; the lane trusts nothing else. Pure: no pi imports, no I/O.

export const OPS_AGENT = "ops";
export const OPS_KINDS: ReadonlySet<string> = new Set(["deploy", "probe", "release", "secret-write", "credential-create"]);
export const QUERY_LAUNCH_EVENT = "loop-continuation:query-launch";
export const GUARD_NAMESPACE = "loop-pi.guard/1";

export interface OpsEntry {
  surface: string;
  kind: string;
  allow: string[];
  secret_paths?: string[];
  [key: string]: unknown;
}

export interface Decision {
  block: boolean;
  reason?: string;
}

// A surface id names a lock file, so it is a short printable token without path separators.
const SURFACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

export function isValidSurfaceId(surface: unknown): surface is string {
  return typeof surface === "string" && SURFACE_ID.test(surface);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The entry when it is well formed, else null. Every allow pattern must start with `^` and
 *  compile; an unanchored or broken pattern makes the whole entry invalid (fail closed). */
export function validateOpsEntry(entry: unknown): OpsEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  if (!isValidSurfaceId(e.surface)) return null;
  if (typeof e.kind !== "string" || !OPS_KINDS.has(e.kind)) return null;
  if (!isStringArray(e.allow)) return null;
  for (const pattern of e.allow) {
    if (!pattern.startsWith("^")) return null;
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
  }
  if (e.secret_paths !== undefined && !isStringArray(e.secret_paths)) return null;
  return e as OpsEntry;
}

/** The entries of a frozen ops value: the parsed ops file `{v:1, ops:[...]}`, or its `ops` array.
 *  Null when there is no grant at all or the value has neither shape. */
export function opsEntryList(ops: unknown): unknown[] | null {
  if (ops === null || ops === undefined) return null;
  if (Array.isArray(ops)) return ops;
  if (typeof ops === "object") {
    const o = ops as Record<string, unknown>;
    if (o.v === 1 && Array.isArray(o.ops)) return o.ops;
  }
  return null;
}

const OPS_SURFACE_LINE = /^[ \t]*Ops surface:[ \t]*(.*?)[ \t]*$/gm;

/** Every `Ops surface: <id>` line in a brief, in order (the id may be empty). */
export function opsSurfaceLines(task: string): string[] {
  return [...task.matchAll(OPS_SURFACE_LINE)].map((m) => m[1]);
}

interface LaunchChild {
  agent?: unknown;
  task?: unknown;
}

/** Every child a subagent call names: the top-level `{agent, task}` and any `tasks` / `chain`
 *  entries (including a chain step's `parallel` group). */
function launchChildren(input: Record<string, unknown>): LaunchChild[] {
  const children: LaunchChild[] = [{ agent: input.agent, task: input.task }];
  const push = (value: unknown) => {
    if (value && typeof value === "object") children.push(value as LaunchChild);
  };
  if (Array.isArray(input.tasks)) input.tasks.forEach(push);
  if (Array.isArray(input.chain)) {
    for (const step of input.chain) {
      push(step);
      const parallel = (step as Record<string, unknown> | null)?.parallel;
      if (Array.isArray(parallel)) parallel.forEach(push);
    }
  }
  return children;
}

export function isSingleLaunch(input: Record<string, unknown>): boolean {
  return (
    input.action === undefined &&
    typeof input.agent === "string" &&
    typeof input.task === "string" &&
    input.tasks === undefined &&
    input.chain === undefined
  );
}

export type OpsLaunchDecision = { block: true; reason: string } | { block: false; entry?: OpsEntry };

function refuse(reason: string): OpsLaunchDecision {
  return { block: true, reason: `loop-guard (ops): ${reason}` };
}

/** The root's ops check for one `subagent` call, run after evaluateSubagentCall allowed it.
 *
 *  - `Ops surface:` lines are refused in any brief other than a single `{agent: "ops", task}` launch.
 *  - Agent `ops` is refused anywhere but such a single launch, when no ops grants are frozen,
 *    without exactly one surface line, for a surface not in the frozen ops (or listed twice, or
 *    malformed), and while an ops run on that surface is active in this session.
 *  - Otherwise an `ops` launch returns the full entry to bind. Any other call returns no entry. */
export function evaluateOpsLaunch(
  input: Record<string, unknown>,
  ops: unknown,
  isSurfaceActive: (surface: string) => boolean,
): OpsLaunchDecision {
  const children = launchChildren(input);
  const single = isSingleLaunch(input);
  const opsSingle = single && input.agent === OPS_AGENT;
  if (!opsSingle) {
    if (children.some((c) => c.agent === OPS_AGENT) && input.action === undefined) {
      return refuse("agent `ops` may only be launched alone, as one `subagent` call with {agent: \"ops\", task}.");
    }
    if (children.some((c) => typeof c.task === "string" && opsSurfaceLines(c.task).length > 0)) {
      return refuse("an `Ops surface:` line is only valid in a brief for agent `ops`.");
    }
    return { block: false };
  }
  const lines = opsSurfaceLines(input.task as string);
  if (lines.length !== 1) {
    return refuse(`an ops brief must carry exactly one \`Ops surface: <id>\` line; found ${lines.length}.`);
  }
  const surface = lines[0];
  if (!isValidSurfaceId(surface)) {
    return refuse(`'${surface}' is not a valid ops surface id.`);
  }
  const entries = opsEntryList(ops);
  if (!entries) {
    return refuse("no ops grants are frozen for this loop (no `Ops grants:` line, a missing file or a sha256 mismatch).");
  }
  const matching = entries.filter((e) => (e as Record<string, unknown> | null)?.surface === surface);
  if (matching.length === 0) {
    return refuse(`surface '${surface}' is not in the frozen ops grants.`);
  }
  if (matching.length > 1) {
    return refuse(`surface '${surface}' appears more than once in the frozen ops grants.`);
  }
  const entry = validateOpsEntry(matching[0]);
  if (!entry) {
    return refuse(`the frozen ops entry for surface '${surface}' is malformed (kind, allow patterns anchored with ^, secret_paths).`);
  }
  if (isSurfaceActive(surface)) {
    return refuse(`an ops run on surface '${surface}' is already active in this session; wait for it to complete.`);
  }
  return { block: false, entry: JSON.parse(JSON.stringify(entry)) as OpsEntry };
}

export interface LaneOpsGrant {
  surface: string;
  entry: OpsEntry;
}

export interface LaneBinding {
  agent?: string;
  /** Set only for agent `ops` with a surface and a valid entry for that same surface. */
  ops?: LaneOpsGrant;
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
  if (agent !== OPS_AGENT) return { agent };
  const entry = validateOpsEntry(guard.entry);
  if (!entry || !isValidSurfaceId(guard.surface) || entry.surface !== guard.surface) return { agent };
  return { agent, ops: { surface: guard.surface, entry } };
}
