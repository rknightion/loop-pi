// Test-only child extension: `block_sync` writes a saved-work file in the child's cwd, then blocks
// the child's process synchronously for `ms`. A pi-subagents async child runs its session inside
// the runner process, so the block also stops the runner's control inbox: a steer acknowledgement
// and an interrupt both wait until the block ends. That is the "slow boundary" a busy child shows
// the parent. Never shipped (test-support/ is excluded from builds).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "block_sync",
    label: "Block synchronously",
    description: "Write saved-work.txt, then block this process for ms milliseconds.",
    parameters: Type.Object({ ms: Type.Number({ minimum: 0 }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      writeFileSync(join(ctx.cwd, "saved-work.txt"), `saved before a ${params.ms} ms block\n`);
      if (params.ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, params.ms);
      return { content: [{ type: "text", text: `blocked ${params.ms} ms` }], details: {} };
    },
  });
}
