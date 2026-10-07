// Offline child-registration probe. Loaded before the host's input handler.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("input", async (event) => {
    if (event.text !== "SPAWN_TIMING") return { action: "handled" as const };
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("child spawn timed out")); }, 10_000);
      const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (result: any) => {
        clearTimeout(timer);
        off();
        if (!result.success) reject(new Error(JSON.stringify(result)));
        else resolve();
      });
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1, requestId, method: "spawn", params: { agent: "lane-worker", task: "Exercise timing stream", async: true },
      });
    });
    return { action: "handled" as const };
  });
}
