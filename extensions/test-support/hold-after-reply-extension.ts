// Test-only child extension: holds the child's run open for `HOLD_MS` after its final reply by
// awaiting `agent_end` on the event loop (never a synchronous block, so the runner keeps serving its
// control inbox). pi-subagents ends a clean child 1 s after its terminal event and force-settles it
// within 3 s more, so a steer sent in that window reaches a live child that has already answered.
// Never shipped (test-support/ is excluded from builds).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOLD_MS = 5_000;

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, HOLD_MS));
  });
}
