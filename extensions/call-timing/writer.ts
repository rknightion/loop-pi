// Writer identity and loaded request policy for progress checkpoints (SEAMS.md "Request progress
// seam", fields `pidStartedAt` and `policy`). Both are additive: a reader treats a missing or null
// value as unknown. Nothing here reads settings: the request limits are the ones the request
// ceiling captured when it was installed in this process, so an observer never has to derive them
// from settings on disk that a live upgrade may have changed since.
import { performance } from "node:perf_hooks";

export interface CeilingPolicy {
  inactivityMs: number;
  absoluteMs: number;
}

export interface RequestPolicy {
  inactivityMs: number | null;
  absoluteMs: number | null;
  checkpointIntervalMs: number;
}

// One slot per process on globalThis, so the request ceiling and call-timing agree even when the
// extension loader gives each extension its own module instance.
const SLOT = Symbol.for("loop-pi.request-ceiling.loaded-policy");
type Slot = { policy: CeilingPolicy | null; conflicted: boolean };

function slot(): Slot {
  const holder = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (holder[SLOT] ??= { policy: null, conflicted: false });
}

/**
 * Called by the request ceiling with the limits it enforces. A second install with different
 * limits in the same process makes the policy ambiguous, so it is published as unknown.
 */
export function publishCeilingPolicy(policy: CeilingPolicy): void {
  const current = slot();
  const next = { inactivityMs: policy.inactivityMs, absoluteMs: policy.absoluteMs };
  if (current.policy && (current.policy.inactivityMs !== next.inactivityMs || current.policy.absoluteMs !== next.absoluteMs)) {
    current.conflicted = true;
  }
  current.policy ??= next;
}

/** The limits the request ceiling loaded in this process, or null when none or an ambiguous set. */
export function loadedCeilingPolicy(): CeilingPolicy | null {
  const current = slot();
  return current.conflicted || !current.policy ? null : { ...current.policy };
}

export function requestPolicy(checkpointIntervalMs: number): RequestPolicy {
  const ceiling = loadedCeilingPolicy();
  return { inactivityMs: ceiling?.inactivityMs ?? null, absoluteMs: ceiling?.absoluteMs ?? null, checkpointIntervalMs };
}

/**
 * Epoch ms at which this process began (`performance.timeOrigin`), floored. With `pid` it lets a
 * reader tell this writer from a later process that reused the pid: the kernel start time of the
 * live pid must match it.
 */
export function processStartedAt(): number {
  return Math.floor(performance.timeOrigin);
}

/** Test seam only: forget the published policy. */
export function resetCeilingPolicyForTest(): void {
  const holder = globalThis as unknown as Record<symbol, Slot | undefined>;
  delete holder[SLOT];
}
