// Close-out support: read `loop-state digest <log> --json` for the launch's state log.
// Every failure (no binary, no log, a timeout, unusable output) yields null, and the caller
// then behaves as it did before close-out existed.

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
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
          resolve(error ? null : parseDigest(String(stdout)));
        },
      );
    } catch {
      resolve(null);
    }
  });
}
