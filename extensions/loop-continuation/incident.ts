import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHAIN_EXHAUSTED_CLASS = "loop-continuation-chain-exhausted";
export const OPS_GRANTS_REJECTED_CLASS = "loop-ops-grants-rejected";

/** Incident bookkeeping must never trap the session. A `subdir` keeps the file out of the top-level watchdog sweep. */
export function writeIncident(
  agentDir: string,
  sessionId: string,
  cwd: string,
  cls: string = CHAIN_EXHAUSTED_CLASS,
  extra: Record<string, unknown> = {},
  subdir?: string,
): void {
  try {
    const dir = subdir ? join(agentDir, "incidents", subdir) : join(agentDir, "incidents");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const ts = at.replace(/[:.]/g, "-");
    const path = join(dir, `${sessionId || "unknown"}-${ts}.json`);
    const payload = {
      v: 1,
      session: sessionId || "unknown",
      class: cls,
      at,
      home: agentDir,
      cwd,
      ...extra,
    };
    writeFileSync(path, JSON.stringify(payload));
  } catch {
    // Incident bookkeeping must never trap the session.
  }
}
