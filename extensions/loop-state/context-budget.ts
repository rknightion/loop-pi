// Pi 1.1.0 public idle/usage/compaction APIs only. See the state-aware context seam.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FrozenRootContext } from "../loop-continuation/state.ts";

export const CONTEXT_BUDGET_STATE = "loop-root-context-budget";
export const COMPACT_PERCENT = 80;
export const REARM_PERCENT = 70;
/** Share of the context window past which a root compacts after a landed push. Well below the
 *  80 percent backstop so a long loop compacts at a batch boundary, with room to grow before the next. */
export const PUSH_COMPACT_PERCENT = 55;
export const PUSH_COMPACT_PERCENT_ENV = "LOOP_PI_COMPACT_AFTER_PUSH_PERCENT";
export const MAX_COMPACTIONS = 2;
export const ROOT_SUMMARY_MAX_BYTES = 32768;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const INSTRUCTIONS = "loop-state: frozen-root-state/1";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The push share: the environment's whole-number percentage in 1..79, else the default. */
export function pushCompactPercent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PUSH_COMPACT_PERCENT_ENV];
  if (typeof raw === "string" && /^\d{1,2}$/.test(raw.trim())) {
    const value = Number(raw.trim());
    if (value >= 1 && value < COMPACT_PERCENT) return value;
  }
  return PUSH_COMPACT_PERCENT;
}

/** Why this extension compacted the root; named in the summary the root reads afterwards. */
export interface CompactionTrigger {
  reason: "landed-push" | "context-backstop";
  percent: number;
  threshold: number;
}

export interface RootLaunchContext {
  rootContext?: FrozenRootContext;
  standingPath?: string | null;
  standingSha256?: string | null;
}

/** A bounded snapshot; never open conversation archives or inspect model text. */
function ledgerBytes(log: string): Buffer {
  const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw new Error("state ledger is not a bounded regular file");
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > MAX_LOG_BYTES) throw new Error("state ledger exceeds 4 MiB");
    return buffer.subarray(0, bytes);
  } finally { closeSync(fd); }
}

export function stateSummary(ctx: ExtensionContext, launch: RootLaunchContext, log: string, digest: string, trigger?: CompactionTrigger): { summary: string; logSha256: string } {
  const frozen = launch.rootContext;
  if (!frozen) throw new Error("session has no arm-time frozen charter/root snapshot; no moving-file fallback");
  if (frozen.sessionId !== ctx.sessionManager.getSessionId() || frozen.sessionFile !== (ctx.sessionManager.getSessionFile() ?? null) ||
      frozen.cwd !== ctx.cwd || frozen.runDir !== process.env.LOOP_PI_RUN_DIR) throw new Error("frozen root/session/run identity does not match");
  if (sha256(frozen.goalText) !== frozen.goalSha256) throw new Error("frozen charter hash does not match");
  const bytes = ledgerBytes(log);
  const rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const open = rows.find(row => row.ev === "open");
  if (open?.charter_sha256 !== frozen.goalSha256) throw new Error("state open does not match frozen charter");
  // Count unique actual implementation run IDs, not briefs, notifications or repaired blocks.
  // These counts are a projection, never authority to reset/raise the charter's attempt budgets.
  const runs = new Map<string, any>();
  for (const row of rows) if (row.ev === "dispatch") runs.set(row.run, row);
  const counts: Record<string, number> = {};
  for (const row of runs.values()) {
    if (row.recovery_of || row.kind === "review" ||
        ["reviewer", "scout"].includes(row.agent)) continue;
    for (const task of new Set<string>(row.tasks ?? row.task.split(","))) counts[task] = (counts[task] ?? 0) + 1;
  }
  const identity = {
    sessionId: frozen.sessionId, sessionFile: frozen.sessionFile, cwd: frozen.cwd,
    runDir: frozen.runDir, charterPath: frozen.goalPath, charterSha256: frozen.goalSha256,
    stateLog: log, stateLogSha256: sha256(bytes),
    authority: {
      standingPath: launch.standingPath ?? null, standingSha256: launch.standingSha256 ?? null,
    },
    implementation_dispatches: counts,
    // Complete causal ID/outcome projection, even when the CLI digest elides older detail.
    // Free-text returns/judgements are not conversation recovery; the hashed ledger retains them.
    state_projection: rows.filter(row => !["heartbeat", "watch", "judgement"].includes(row.ev)).map(row =>
      Object.fromEntries(["seq", "ev", "by", "task", "tasks", "lane", "run", "agent", "kind", "tier", "recovery_of",
        "status", "needs", "until", "accepted", "sha", "landed", "mode", "exit"].filter(key => key in row).map(key => [key, row[key]]))),
  };
  const why = !trigger ? [] : [
    "Compaction trigger: the loop-pi context-budget extension (loop-state) compacted this root automatically; " +
      "it was not an operator request and not a failure, and nothing was lost that the state log does not hold. " +
      (trigger.reason === "landed-push"
        ? `Reason: a push landed while context use was ${Math.round(trigger.percent)} percent, past the ${trigger.threshold} percent push share.`
        : `Reason: context use reached ${Math.round(trigger.percent)} percent, the ${trigger.threshold} percent backstop.`),
  ];
  const summary = [
    ...why,
    "Same root, same session. Recover from the frozen charter and append-only state, not prior conversation.",
    "Compaction grants no authority, resets no consumed attempts and sponsors no child or root restart.",
    "Dispatch counts below are recorded runs only; the frozen charter retains prior lineage, ceilings and remaining allowance.",
    "## Frozen root/run identity and authority references", JSON.stringify(identity),
    "## Frozen charter", frozen.goalText,
    "## State digest", digest,
  ].join("\n");
  if (Buffer.byteLength(summary, "utf8") > ROOT_SUMMARY_MAX_BYTES) throw new Error("state recovery summary exceeds 32768 bytes; no lossy cut");
  return { summary, logSha256: identity.stateLogSha256 };
}

// Native status DTO admission, kept separate from display entries and caller text.
export function nativeChildrenQuiet(data: any): boolean {
  const fleet = data?.fleet;
  const snapshot = data?.asyncSnapshot;
  const terminalStates = ["complete", "failed", "partial", "paused", "stopped", "rejected"];
  const knownStates = ["queued", "running", ...terminalStates];
  const knownDisplay = (node: any): boolean => node !== null && typeof node === "object"
    && typeof node.id === "string" && node.id !== ""
    && ["subagent", "workflow", "step", "host-step"].includes(node.kind)
    && knownStates.includes(node.state)
    && (node.children === undefined || Array.isArray(node.children) && node.children.every(knownDisplay));
  const terminalJob = (node: any): boolean => knownDisplay(node)
    && ["subagent", "workflow"].includes(node.kind) && terminalStates.includes(node.state);
  // Both directions can lag: terminal displayed steps do not close a running job,
  // and a terminal job can retain running step metadata. Judge the native job roots.
  // The pinned projection keeps queued/running materialized jobs as roots whenever
  // their workflow parent is not running; a running parent also refuses quiet.
  // Capacity is supplementary: abandoned slot release is not terminal job proof.
  return fleet?.version === 1 && fleet.totalActive === 0 && fleet.omitted === 0
    && fleet.topLevelAsyncCapacity?.used === 0
    && Number.isSafeInteger(fleet.topLevelAsyncCapacity?.limit) && fleet.topLevelAsyncCapacity.limit >= 0
    && snapshot?.kind === "pi-subagents.async-status-snapshot" && snapshot.version === 1
    && snapshot.omitted?.runs === 0 && snapshot.omitted.byteLimitExceeded === false
    && snapshot.omitted.children === 0
    && Array.isArray(snapshot.runs) && snapshot.runs.every(terminalJob);
}

export function installContextBudget(pi: ExtensionAPI, services: {
  drain(): Promise<unknown>;
  quiet(): Promise<boolean>;
  prepare(ctx: ExtensionContext, trigger: CompactionTrigger): Promise<{ summary: string; log: string; logSha256: string } | null>;
  warn(message: string): void;
}) {
  let latched = false;
  let revision = 0;
  let attempts = 0;
  // A push landed since the last settled boundary. Spent at the next evaluated boundary.
  let pushLanded = false;
  let binding = "";
  let pending: { summary: string; log: string; logSha256: string; revision: number; anchor: string } | null = null;
  const persist = () => pi.appendEntry(CONTEXT_BUDGET_STATE, { v: 1, latched, attempts, binding });
  const changed = () => { revision++; };
  pi.on("input", changed);
  pi.on("agent_start", changed);
  // Completion activity is composed by the owner, alongside its existing completion handler.
  // The owner composes these lifecycle methods with its existing session handlers.
  const sessionStart = (ctx: ExtensionContext) => {
    changed();
    pending = null;
    latched = false;
    attempts = 0;
    binding = JSON.stringify([ctx.sessionManager.getSessionId?.() ?? null, ctx.sessionManager.getSessionFile?.() ?? null, process.env.LOOP_PI_RUN_DIR ?? null]);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONTEXT_BUDGET_STATE) continue;
      if ((entry.data as any)?.v !== 1) { attempts = MAX_COMPACTIONS; latched = true; continue; }
      const data = entry.data as { binding?: unknown; attempts?: unknown; latched?: unknown };
      if (data.binding !== undefined && data.binding !== binding) continue;
      latched = data.latched === true;
      // Missing legacy count/binding is unknown consumption, never a fresh allowance.
      attempts = data.binding === binding && typeof data.attempts === "number" && Number.isInteger(data.attempts)
        && data.attempts >= 0 && data.attempts <= MAX_COMPACTIONS ? Math.max(attempts, data.attempts) : MAX_COMPACTIONS;
    }
  };
  pi.on("session_before_compact", (event) => {
    if (!pending || event.reason !== "manual" || event.customInstructions !== INSTRUCTIONS) return;
    try {
      if (event.signal.aborted || pending.revision !== revision || sha256(ledgerBytes(pending.log)) !== pending.logSha256) return { cancel: true };
      return { compaction: { summary: pending.summary, firstKeptEntryId: pending.anchor, tokensBefore: event.preparation.tokensBefore, details: { kind: "frozen-root-state", v: 1 } } };
    } catch { return { cancel: true }; } // Never fall through to model summarization on a lost ledger.
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted || pending) return;
    if (typeof ctx.isIdle !== "function" || typeof ctx.hasPendingMessages !== "function" ||
        typeof ctx.getContextUsage !== "function" || typeof ctx.compact !== "function") {
      services.warn("context budget unsupported: native idle/usage/compact methods missing");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.tokens === null || !Number.isFinite(usage.percent) || usage.contextWindow <= 0) {
      services.warn("context budget unsupported: active model context usage is unknown");
      return;
    }
    if (usage.percent < REARM_PERCENT && latched) { latched = false; persist(); }
    // A landed push is a batch boundary: state is on disk, so the fleet need not be quiet. It is
    // spent here whether or not it compacts; the next push is the next boundary.
    const threshold = pushCompactPercent();
    const viaPush = pushLanded && usage.percent >= threshold;
    pushLanded = false;
    const backstop = usage.percent >= COMPACT_PERCENT;
    if (!viaPush && (!backstop || latched)) return;
    if (attempts >= MAX_COMPACTIONS) return;
    const observed = revision;
    if (!viaPush) {
      try { if (!await services.quiet()) return; }
      catch { services.warn("context budget deferred: native child activity unavailable"); return; }
      if (revision !== observed || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      latched = true;
    }
    const trigger: CompactionTrigger = viaPush
      ? { reason: "landed-push", percent: usage.percent, threshold }
      : { reason: "context-backstop", percent: usage.percent, threshold: COMPACT_PERCENT };
    attempts++;
    persist(); // Preparation failures consume this generation too; no repeated automatic attempts.
    // A push compaction that completes, or is declined without an error, hands its attempt back:
    // the allowance bounds failures, and a long loop compacts once per batch.
    let release = false;
    try {
      await services.drain();
      const prepared = await services.prepare(ctx, trigger);
      if (!prepared || revision !== observed || !ctx.isIdle() || ctx.hasPendingMessages()) { release = viaPush && !!prepared; return; }
      persist(); // Context-invisible native kept boundary after all queued entries.
      const anchor = ctx.sessionManager.getBranch().at(-1);
      if (anchor?.type !== "custom" || anchor.customType !== CONTEXT_BUDGET_STATE) throw new Error("native custom attempt anchor missing");
      pending = { ...prepared, revision: observed, anchor: anchor.id };
      // Await callbacks, not an invented return promise. Native compact stays in this session.
      // Pi defers prompts received during agent_settled until this handler finishes.
      await new Promise<void>(done => ctx.compact({ customInstructions: INSTRUCTIONS,
        onComplete: () => { release = viaPush; done(); }, onError: error => { services.warn(`state compaction stopped: ${error.message}`); done(); },
      }));
    } catch (error) {
      services.warn(`context budget unsupported: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pending = null;
      if (release) { attempts--; persist(); }
    }
  });
  return {
    sessionStart, sessionShutdown: changed, completed: changed, started: changed,
    /** The root's push to the remote was recorded: the next settled boundary may compact. */
    landed: () => { pushLanded = true; },
  };
}
