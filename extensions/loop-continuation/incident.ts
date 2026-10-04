import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const CONTEXT_OVERFLOW_CLASS = "loop-root-context-overflow";

/** UTC timestamp for an incident file name: the ISO time with `:` and `.` replaced by `-`. */
export function incidentStamp(at: string): string {
  return at.replace(/[:.]/g, "-");
}

/**
 * Write `<agentDir>/incidents/root/<sessionId>-<UTC>-<suffix>.json` with exactly `payload`, and
 * return its path, or null when it could not be written. Never throws.
 */
export function writeRootIncident(agentDir: string, sessionId: string, at: string, suffix: string, payload: Record<string, unknown>): string | null {
  try {
    const dir = join(agentDir, "incidents", "root");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId || "unknown"}-${incidentStamp(at)}-${suffix}.json`);
    writeFileSync(path, JSON.stringify(payload));
    return path;
  } catch {
    return null;
  }
}

/** `loopPi.onIncident` from the home settings: one argv list, `{file}` replaced by the incident path. */
export function onIncidentArgv(settings: unknown, file: string): string[] | null {
  const argv = (settings as { loopPi?: { onIncident?: unknown } } | null)?.loopPi?.onIncident;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string") || argv[0] === "") return null;
  return (argv as string[]).map((a) => a.replaceAll("{file}", file));
}

/** Run `loopPi.onIncident` for an incident file, detached; every failure is ignored. */
export function runOnIncident(agentDir: string, file: string): void {
  try {
    let settings: unknown = null;
    try {
      settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    } catch {
      return;
    }
    const argv = onIncidentArgv(settings, file);
    if (!argv) return;
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // A missing or failing notifier is ignored.
    });
    child.unref();
  } catch {
    // Alerting must never trap the session.
  }
}
