// Test-only companion extension for root.test.ts's compaction-race scenario. Loaded alongside
// root.ts, it arms a loop-wait timer through the SEAMS.md `loop-wait:arm-timer` pi.events channel
// the instant compaction begins (`session_before_compact` fires synchronously, in-process, with
// no IPC jitter), so the race is deterministic instead of depending on wall-clock timing across
// an RPC round trip. Not loaded outside this test; not part of the installed extension set.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => {
    pi.events.emit("loop-wait:arm-timer", {
      at: new Date(Date.now() + 150).toISOString(),
      reason: "compaction-race-test",
      reply: () => {
        // no-op: the test observes the resulting loop-wake message instead of this reply.
      },
    });
  });
}
