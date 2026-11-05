// Lane launcher pin (pi-subagents 0.85.0 `requireLauncher`). Every shipped lane agent names
// `launcher: nopush`. The root pins each lane agent's definition digest once, when its session
// starts, using pi-subagents' own preflight (the digest `requireLauncher` is documented against),
// and every root launch then carries `requireLauncher: {name: "nopush", definitionDigest}`.
// pi-subagents refuses the launch unless the agent it resolves runs under that launcher with that
// exact definition: an agent file edited after the root started, a definition that shadows the
// shipped one, or an agent that names no launcher are all refused by the package itself.

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { deleteSubagentField } from "./subagent-view.ts";

/** The launcher every lane runs under (home/agents/*.md frontmatter, SEAMS "Non-push launcher"). */
export const LANE_LAUNCHER = "nopush";

export type LanePin = { digest: string } | { error: string };

function insideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Pins one agent: the digest pi-subagents' preflight computes for the definition a launch from
 *  `cwd` resolves, which must be a file in this home's `agents/` directory (the installed one). */
export async function pinLaneDefinition(agent: string, cwd: string, projectTrusted: boolean | undefined): Promise<LanePin> {
  try {
    const result = await resolveSubagentLaunchContract({ agent, cwd, ...(projectTrusted === undefined ? {} : { projectTrusted }) });
    if (!result.ok) return { error: result.message };
    const shipped = realpathSync(join(getAgentDir(), "agents"));
    let file: string;
    try {
      file = realpathSync(result.contract.agent.filePath);
    } catch {
      file = result.contract.agent.filePath;
    }
    if (!insideDir(shipped, file)) {
      return { error: `it resolves to '${result.contract.agent.filePath}', not an agent file installed under '${shipped}'` };
    }
    return { digest: result.contract.agent.definitionDigest };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Pins every agent in `agents`; a failure pins that agent to its refusal reason. */
export async function pinLaneDefinitions(
  agents: Iterable<string>,
  cwd: string,
  projectTrusted: boolean | undefined,
): Promise<Map<string, LanePin>> {
  const pins = new Map<string, LanePin>();
  for (const agent of agents) pins.set(agent, await pinLaneDefinition(agent, cwd, projectTrusted));
  return pins;
}

/** Replace, never merge: any model-supplied `requireLauncher` (top level or inside `options`, where
 *  pi-subagents would let it win) is removed and the root's pin set at the top level. */
export function bindRequiredLauncher(input: Record<string, unknown>, definitionDigest: string): void {
  deleteSubagentField(input, "requireLauncher");
  input.requireLauncher = { name: LANE_LAUNCHER, definitionDigest };
}

/** The refusal for a launch whose agent could not be pinned. */
export function unpinnedLaneReason(agent: string, reason: string): string {
  return (
    `loop-guard: lane agent '${agent}' could not be pinned to launcher '${LANE_LAUNCHER}' when this root started ` +
    `(${reason}), so it cannot be launched. Fix the installed agent file and restart the root.`
  );
}
