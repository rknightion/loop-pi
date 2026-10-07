// Close-out support: read `loop-state digest <log> --json` for the launch's state log.
// Every failure (no binary, no log, a timeout, unusable output) yields null, and the caller
// then behaves as it did before close-out existed.

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CloseOutDigest } from "./state.ts";

export const DIGEST_TIMEOUT_MS = 10_000;

/** `.../report-<name>-loop<N>.md` -> `.../state-<name>-loop<N>.jsonl` (the basename only). */
export function stateLogPath(reportPath: string): string {
  const name = basename(reportPath).replace(/^report-/, "state-").replace(/\.md$/, ".jsonl");
  return join(dirname(reportPath), name);
}

/** `<agentDir>/bin/loop-state` when executable, else `loop-state` for PATH lookup. */
export function loopStateBinary(agentDir: string): string {
  const local = join(agentDir, "bin", "loop-state");
  try {
    accessSync(local, constants.X_OK);
    return local;
  } catch {
    return "loop-state";
  }
}

function parseDigest(stdout: string): CloseOutDigest | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { live_lanes, admissible } = value as { live_lanes?: unknown; admissible?: unknown };
  if (typeof live_lanes !== "number" || !Number.isFinite(live_lanes)) return null;
  if (!Array.isArray(admissible)) return null;
  return { live_lanes, admissible: admissible.map(String) };
}

// `digest --json` names parked tasks but deliberately does not make them admissible by time.
// Read only the explicit clock condition of still-parked evidence-later tasks. Owner/authority,
// budget and dependency parks are not clock permission; the root must still reconcile on wake.
// This is local continuation input, not a change to the loop-state digest/event contract.
export function timeParkDeadline(log: string, parked: readonly string[]): string | null {
  try {
    const deadlines = new Map<string, string>();
    for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.ev === "close") deadlines.clear();
      if (typeof event.task !== "string") continue;
      if (event.ev === "park") {
        deadlines.delete(event.task);
        if (event.needs === "evidence-later" && typeof event.until === "string" &&
          /(?:Z|[+-]\d\d:\d\d)$/.test(event.until) && Number.isFinite(Date.parse(event.until))) {
          deadlines.set(event.task, event.until);
        }
      } else if (event.ev === "admit" || event.ev === "dispatch" || event.ev === "land" ||
        (event.ev === "accept" && event.accepted === true)) {
        deadlines.delete(event.task);
      }
    }
    const active = [...deadlines].filter(([task]) => parked.includes(task)).map(([, at]) => at);
    active.sort((a, b) => Date.parse(a) - Date.parse(b));
    return active[0] ?? null;
  } catch {
    // Missing, malformed or concurrently incomplete log: no inferred clock permission.
    return null;
  }
}

export interface ReadDigestOptions {
  agentDir: string;
  reportPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function readDigest(opts: ReadDigestOptions): Promise<CloseOutDigest | null> {
  const log = stateLogPath(opts.reportPath);
  if (!existsSync(log)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        loopStateBinary(opts.agentDir),
        ["digest", log, "--json"],
        { timeout: opts.timeoutMs ?? DIGEST_TIMEOUT_MS, env: opts.env ?? process.env, maxBuffer: 1 << 20 },
        (error, stdout) => {
          const digest = error ? null : parseDigest(String(stdout));
          if (digest) {
            const { parked } = JSON.parse(String(stdout));
            if (Array.isArray(parked) && parked.every((task) => typeof task === "string")) {
              const deadline = timeParkDeadline(log, parked);
              if (deadline) digest.timeParkDeadline = deadline;
            }
          }
          resolve(digest);
        },
      );
    } catch {
      resolve(null);
    }
  });
}
