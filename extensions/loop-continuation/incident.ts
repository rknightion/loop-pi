import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Incident bookkeeping must never trap the session. */
export function writeIncident(agentDir: string, sessionId: string, cwd: string): void {
  try {
    const dir = join(agentDir, "incidents");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const ts = at.replace(/[:.]/g, "-");
    const path = join(dir, `${sessionId || "unknown"}-${ts}.json`);
    const payload = {
      v: 1,
      session: sessionId || "unknown",
      class: "loop-continuation-chain-exhausted",
      at,
      home: agentDir,
      cwd,
    };
    writeFileSync(path, JSON.stringify(payload));
  } catch {
    // Incident bookkeeping must never trap the session.
  }
}
