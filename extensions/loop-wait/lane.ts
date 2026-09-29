// loop-wait lane entry: registers watch_process only, per SEAMS.md ("Model-facing tools:
// watch_process (root and lane entries)"). Loaded as a required child extension so every lane
// and gate-runner gets a real, killable process wait instead of a shell `&`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runWatchProcess } from "./core.ts";

export const WatchProcessParams = Type.Object({
  command: Type.String({ description: "Shell command to run to completion (never append `&`)." }),
  deadline_s: Type.Number({ minimum: 1, maximum: 3600, description: "Kill the process and return if it has not exited by this deadline." }),
  tail_lines: Type.Number({ minimum: 1, description: "Number of trailing output lines to return." }),
});

export function registerWatchProcess(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "watch_process",
    label: "Watch process",
    description:
      "Run a shell command to completion or a deadline, whichever comes first. Blocks the tool call; " +
      "never spawns with a trailing `&`. Kills the process on deadline or abort and returns its exit " +
      "code, whether the deadline was hit, and a tail of its output.",
    promptSnippet: "watch_process(command, deadline_s, tail_lines) - run a command to completion or a deadline",
    parameters: WatchProcessParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runWatchProcess({
        command: params.command,
        deadlineS: params.deadline_s,
        tailLines: params.tail_lines,
        cwd: ctx.cwd,
        signal,
      });
      const summaryLines = [
        `exit_code=${result.exitCode ?? "null"} deadline_hit=${result.deadlineHit} signal=${result.signal ?? "none"}`,
        "--- tail ---",
        ...result.tail,
      ];
      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: { exit_code: result.exitCode, deadline_hit: result.deadlineHit, signal: result.signal, tail: result.tail },
      };
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerWatchProcess(pi);
}
