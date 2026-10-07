// Offline child-registration probe. Loaded before the host's input handler.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
        else {
          try {
            // Freeze the launch's runner identity, not just the logical result/status.
            const terminal = JSON.parse(readFileSync(join(result.data.details.asyncDir, "process-terminal.json"), "utf8"));
            if (process.env.LOOP_PI_TIMING_SPAWN_RESULT) writeFileSync(process.env.LOOP_PI_TIMING_SPAWN_RESULT,
              JSON.stringify({ ...result, runnerProcessInstanceId: terminal.runnerProcessInstanceId }));
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
      pi.events.emit("subagents:rpc:v1:request", {
        version: 1, requestId, method: "spawn", params: { agent: "lane-worker", task: "Exercise timing stream", async: true },
      });
    });
    return { action: "handled" as const };
  });
}
