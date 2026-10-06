// Root-owned retention (SEAMS Lane worktrees): pi-subagents' single async finalizer captures a
// patch, then removes its native worktree/branch even after a blocked checkpoint. Named candidate,
// branch and lands-after-green lanes therefore run in our retained cwd with native worktree:false.
// Only root land/park or explicit closeout releases clean terminal trees; quit/reload and child
// completion do not. Opaque allocation metadata is mapped back to original lane/task in state.
//
// Only `cwd`, `isolation` and `worktree` are touched; loop-guard's rewrite is `extensionBindings`.
// Both handlers mutate the same input object, so their order does not matter.
//
// A worktree with uncommitted changes (`git status --porcelain` not empty) is never removed: it is
// kept and named "kept dirty" in the warning and the sweep line. After a session start (reload or
// resume) the runs recorded before it have unknown liveness: they count as live until pi-subagents'
// own status file for the run (`<async dir>/status.json`, `state` other than queued or running) says
// the run ended. No status file means unknown, and the worktree is kept.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveLogPath } from "../loop-state/core.ts";
import { landParkEvents, laneBranch, lanePath, launchedRunId, parseLaneBrief, safeLaneId, STATE_CUSTOM_TYPE } from "./core.ts";
import { relativeGitdir } from "./metadata.ts";
import { allocationIdentity, confinedPath, prepareParent, registerAllocation, verifyAllocation, verifyRunCwd, type AllocationIdentity } from "./identity.ts";

const PROTO_FILE = "loop-pi-proto";
const GIT_TIMEOUT_MS = 10 * 60_000;
export const LOOP_CLOSEOUT_EVENT = "loop-closeout";

interface Tree {
  lane: string;
  task: string;
  path: string;
  branch: string;
  repo: string;
  runs: string[];
  /** Resolved allocation base; failed-launch rollback cannot delete a branch that moved. */
  base?: string;
  /** Run id -> original cwd relative to this worktree (empty string means its root). */
  runCwds?: Record<string, string>;
  /** Non-reused allocation nonce and the exact filesystem/Git registration it owns. */
  allocation?: string;
  identity?: AllocationIdentity;
  /** Original gitdir pointer bytes, before verified relative conversion. */
  gitdirPreimage?: string;
  /** Run id -> the pi-subagents async directory its launch result named (`details.asyncDir`). */
  asyncDirs?: Record<string, string>;
  /** A land or park arrived while a run of this lane was live: remove once none is. */
  release?: "land" | "park";
  /** A release found uncommitted changes, so the worktree was kept. */
  keptDirty?: boolean;
  keptUnknown?: boolean;
}

interface Persisted {
  trees: Tree[];
  lastSeq: number | null;
  retiredRuns?: string[];
}

interface Git {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<Git> {
  return new Promise((done) => {
    try {
      execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      });
    } catch (error) {
      done({ code: -1, stdout: "", stderr: String(error) });
    }
  });
}

// pi-subagents' terminal run states (`runs/background/async-job-tracker.js`, isTerminalJobStatus);
// `queued` and `running` are its active states (`active-run-index.js`, isActiveAsyncState).
const ENDED_STATES = new Set(["complete", "failed", "partial", "paused", "stopped", "rejected"]);

/** pi-subagents' async run root (`src/shared/types.js`: PI_SUBAGENTS_TEMP_ROOT, else tmpdir/pi-subagents-uid-<uid>). */
function defaultAsyncRoot(): string | null {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return join(resolve(configured), "async-subagent-runs");
  if (typeof process.getuid === "function") return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`, "async-subagent-runs");
  return null;
}

/** Whether pi-subagents' status file says the run ended; false when it is active, absent or unreadable. */
export function runEndedPerStatus(runId: string, asyncDir: string | undefined): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return false;
  const dir = asyncDir && isAbsolute(asyncDir) && basename(asyncDir) === runId ? asyncDir : (() => {
    const root = defaultAsyncRoot();
    return root ? join(root, runId) : null;
  })();
  if (!dir) return false;
  try {
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { state?: unknown };
    return typeof status?.state === "string" && ENDED_STATES.has(status.state);
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export default function (pi: ExtensionAPI) {
  const trees = new Map<string, Tree>();
  const retiredRuns = new Set<string>();
  let lastSeq: number | null = null;
  let sessionKey = "";
  let lastCtx: ExtensionContext | null = null;
  const live = new Set<string>();
  // Runs recorded before the last session start whose end this runtime has not seen.
  const unknown = new Set<string>();
  // Tool call id -> the lane a launch or resume belongs to, and whether this call made its worktree.
  const pending = new Map<string, { lane: string; created: boolean; branchCreated: boolean; cwd: string }>();
  const bashCalls = new Set<string>();
  const allocating = new Set<string>();
  const releasing = new Set<string>();

  const runDir = (): string | undefined => process.env.LOOP_PI_RUN_DIR || undefined;
  const markerPresent = (): boolean => {
    const dir = runDir();
    return dir !== undefined && existsSync(join(dir, PROTO_FILE));
  };

  function persist() {
    const data: Persisted = { trees: [...trees.values()], lastSeq, retiredRuns: [...retiredRuns] };
    try {
      pi.appendEntry(STATE_CUSTOM_TYPE, data);
    } catch {
      // State persistence is best effort.
    }
  }

  function warn(message: string) {
    try {
      lastCtx?.ui.notify(`lane-worktrees: ${message}`, "warning");
    } catch {
      // A warning must never trap the session.
    }
  }

  function stateLog(): string | null {
    let reportPath: unknown;
    pi.events.emit("loop-continuation:query-launch", {
      reply: (r: { reportPath?: unknown } | null | undefined) => {
        reportPath = r?.reportPath;
      },
    });
    return typeof reportPath === "string" && reportPath ? deriveLogPath(reportPath) : null;
  }

  function readLog(): string {
    const log = stateLog();
    if (!log || !existsSync(log)) return "";
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  }

  const runLive = (tree: Tree, id: string): boolean => {
    if (live.has(id)) return true;
    if (!unknown.has(id)) return false;
    if (runEndedPerStatus(id, tree.asyncDirs?.[id])) {
      unknown.delete(id);
      return false;
    }
    return true;
  };
  const isLive = (tree: Tree) => allocating.has(tree.lane) || [...pending.values()].some((p) => p.lane === tree.lane) || tree.runs.some((id) => runLive(tree, id));

  /** The default branch refs a lane branch may have been merged into: origin's HEAD, then the root's branch. */
  async function defaultRefs(repo: string): Promise<string[]> {
    const refs: string[] = [];
    const origin = await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (origin.code === 0 && origin.stdout.trim()) {
      const ref = origin.stdout.trim();
      refs.push(ref, `refs/heads/${ref.replace(/^refs\/remotes\/origin\//, "")}`);
    }
    const head = await git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
    if (head.code === 0 && head.stdout.trim()) refs.push(head.stdout.trim());
    return [...new Set(refs)];
  }

  async function merged(repo: string, branch: string): Promise<boolean> {
    for (const ref of await defaultRefs(repo)) {
      if (ref === `refs/heads/${branch}`) continue;
      const exists = await git(repo, ["show-ref", "--verify", "--quiet", ref]);
      if (exists.code !== 0) continue;
      if ((await git(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, ref])).code === 0) return true;
    }
    return false;
  }

  /** Deletion requires the exact recorded owner, canonical confinement and no local data at all. */
  async function removeWorktree(tree: Tree): Promise<"removed" | "dirty" | "unknown" | "failed"> {
    if (!await verifyAllocation(tree.identity, runDir(), tree.path, tree.repo, tree.branch, git)) return "unknown";
    const status = await git(tree.path, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]);
    if (status.code !== 0 || status.stdout.trim() !== "") return "dirty";
    // Recheck after the asynchronous status read. Never follow a newly replaced parent/path.
    if (!await verifyAllocation(tree.identity, runDir(), tree.path, tree.repo, tree.branch, git)) return "unknown";
    const r = await git(tree.repo, ["worktree", "remove", tree.path]);
    if (r.code !== 0) warn(`could not remove ${tree.path}: ${r.stderr.trim()}`);
    return r.code === 0 ? "removed" : "failed";
  }

  /** Compare-and-delete the unused allocation ref, retaining commits even after a launch error. */
  async function deleteUnusedBranch(tree: Tree) {
    if (!tree.base) return;
    const r = await git(tree.repo, ["update-ref", "-d", `refs/heads/${tree.branch}`, tree.base]);
    if (r.code !== 0) warn(`kept branch ${tree.branch}: allocation base changed or could not be verified`);
  }

  function retire(tree: Tree) {
    for (const id of tree.runs) retiredRuns.add(id);
    trees.delete(tree.lane);
    persist();
  }

  /** Remove a lane's worktree; after a land delete its branch when merged, after a park keep it. */
  async function release(tree: Tree, why: "land" | "park") {
    if (releasing.has(tree.lane)) return;
    if (isLive(tree)) {
      tree.release = why;
      persist();
      return;
    }
    releasing.add(tree.lane);
    try {
      const removed = await removeWorktree(tree);
      if (removed === "dirty") {
        delete tree.release;
        tree.keptDirty = true;
        persist();
        warn(`kept dirty: ${tree.lane} (${tree.path}) has uncommitted changes after the ${why} of ${tree.task}; not removed`);
        return;
      }
      if (removed === "unknown") {
        delete tree.release;
        tree.keptUnknown = true;
        persist();
        warn(`kept unknown: ${tree.lane} (${tree.path}) allocation ownership or confinement changed; not removed`);
        return;
      }
      if (removed !== "removed") return;
      retire(tree);
      if (why === "land" && (await merged(tree.repo, tree.branch))) {
        const r = await git(tree.repo, ["branch", "-D", tree.branch]);
        if (r.code !== 0) warn(`could not delete merged branch ${tree.branch}: ${r.stderr.trim()}`);
      }
    } finally {
      releasing.delete(tree.lane);
    }
  }

  async function scanLog() {
    if (lastSeq === null || trees.size === 0) return;
    const { events, maxSeq } = landParkEvents(readLog(), lastSeq);
    lastSeq = maxSeq;
    persist();
    for (const event of events) {
      for (const tree of [...trees.values()]) if (tree.task === event.task) await release(tree, event.ev);
    }
    // A release that waited on a run whose end was only visible in pi-subagents' status file.
    for (const tree of [...trees.values()]) if (tree.release && !isLive(tree)) await release(tree, tree.release);
  }

  /** Explicit closeout removes only recorded allocations; never infer ownership from directory names. */
  async function sweep(): Promise<string> {
    let removed = 0;
    let deleted = 0;
    const keptLive: string[] = [];
    const keptDirty: string[] = [];
    const keptUnknown: string[] = [];
    const failed: string[] = [];
    const unmerged: string[] = [];
    for (const tree of [...trees.values()]) {
      if (isLive(tree) || releasing.has(tree.lane)) {
        keptLive.push(tree.lane);
        continue;
      }
      releasing.add(tree.lane);
      try {
        const outcome = await removeWorktree(tree);
        if (outcome === "removed") {
          removed++;
          retire(tree);
          if (await merged(tree.repo, tree.branch)) {
            if ((await git(tree.repo, ["branch", "-D", tree.branch])).code === 0) deleted++;
          } else {
            unmerged.push(tree.branch);
          }
        } else if (outcome === "dirty") {
          keptDirty.push(tree.lane);
          tree.keptDirty = true;
        } else if (outcome === "unknown") {
          keptUnknown.push(tree.lane);
          tree.keptUnknown = true;
        } else {
          failed.push(tree.lane);
        }
      } finally {
        releasing.delete(tree.lane);
      }
    }
    persist();
    const parts = [`lane-worktrees: removed ${removed} worktree(s), deleted ${deleted} merged branch(es)`];
    parts.push(unmerged.length ? `kept unmerged: ${unmerged.join(", ")}` : "no unmerged lane branches");
    if (keptLive.length) parts.push(`kept live: ${keptLive.join(", ")}`);
    if (keptDirty.length) parts.push(`kept dirty: ${keptDirty.join(", ")}`);
    if (keptUnknown.length) parts.push(`kept unknown: ${keptUnknown.join(", ")}`);
    if (failed.length) parts.push(`could not remove: ${failed.join(", ")}`);
    return parts.join("; ");
  }

  async function toplevel(cwd: string): Promise<string | null> {
    const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    sessionKey = ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId();
    trees.clear();
    retiredRuns.clear();
    live.clear();
    unknown.clear();
    lastSeq = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
        const data = (entry as CustomEntry<Persisted>).data;
        trees.clear();
        for (const tree of data?.trees ?? []) trees.set(tree.lane, tree);
        retiredRuns.clear();
        for (const id of data?.retiredRuns ?? []) retiredRuns.add(id);
        lastSeq = typeof data?.lastSeq === "number" ? data.lastSeq : null;
      }
    }
    // This runtime saw none of these runs start, so it cannot see them end: liveness is unknown.
    for (const tree of trees.values()) for (const id of tree.runs) unknown.add(id);
  });

  pi.on("tool_call", async (event, ctx) => {
    lastCtx = ctx;
    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command === "string" && command.includes("loop-state")) bashCalls.add(event.toolCallId);
      return;
    }
    if (event.toolName !== "subagent" || !markerPresent()) return;
    const input = event.input as Record<string, unknown>;
    if (input.action === "resume") {
      const target = typeof input.id === "string" ? input.id.trim() : typeof input.runId === "string" ? input.runId.trim() : typeof input.dir === "string" ? basename(resolve(input.dir)) : undefined;
      if (target && [...retiredRuns].some((id) => id === target || id.startsWith(target))) return { block: true, reason: "lane-worktrees: this run's allocation was explicitly released; same-protocol resume is refused." };
      const matches = target ? [...trees.values()].flatMap((tree) => tree.runs.filter((id) => id === target || id.startsWith(target)).map((id) => ({ tree, id }))) : [];
      if (matches.length > 1) return { block: true, reason: "lane-worktrees: ambiguous resume target; use an exact run id." };
      if (matches.length === 1) {
        const { tree, id } = matches[0];
        if (isLive(tree) || releasing.has(tree.lane) || tree.release) return { block: true, reason: "lane-worktrees: the lane is live or awaiting root release; it cannot resume concurrently." };
        if (!await verifyAllocation(tree.identity, runDir(), tree.path, tree.repo, tree.branch, git)) return { block: true, reason: "lane-worktrees: resume refused because retained allocation ownership or confinement is unknown." };
        if (isLive(tree) || releasing.has(tree.lane) || !trees.has(tree.lane)) return { block: true, reason: "lane-worktrees: allocation became live or was released during resume verification." };
        const cwd = tree.runCwds?.[id];
        if (!verifyRunCwd(tree.path, cwd)) return { block: true, reason: "lane-worktrees: resume refused because recorded cwd is missing, linked, invalid or outside the retained worktree." };
        pending.set(event.toolCallId, { lane: tree.lane, created: false, branchCreated: false, cwd: cwd! });
      }
      return;
    }
    if (input.action !== undefined || typeof input.agent !== "string" || (input.isolation !== "worktree" && input.worktree !== true)) return;
    // Only the named single-agent surface is ours. Leave workflows and malformed/conflicting
    // public inputs to their existing validator; never turn a refused shape into a valid launch.
    if (input.workflow !== undefined || input.workflowScript !== undefined || input.tasks !== undefined || input.chain !== undefined) return;
    if ((input.isolation === "worktree" && input.worktree === false) || (input.isolation !== undefined && input.isolation !== "worktree")) return;
    const brief = parseLaneBrief(input.task);
    if (!brief) return;
    const dir = runDir()!;
    if (!safeLaneId(brief.lane)) {
      return { block: true, reason: `lane-worktrees: lane id '${brief.lane}' cannot name a worktree directory or branch; use letters, digits, '.', '_' and '-'.` };
    }
    const previous = trees.get(brief.lane);
    if (allocating.has(brief.lane) || releasing.has(brief.lane) || (previous && (isLive(previous) || previous.release))) {
      return { block: true, reason: "lane-worktrees: a lane allocation or run is already live; use disjoint lane ownership." };
    }
    if (previous && previous.task !== brief.task) return { block: true, reason: "lane-worktrees: this lane id already belongs to another task." };
    allocating.add(brief.lane);
    let created = false;
    let branchCreated = false;
    const allocation = previous?.allocation ?? randomUUID();
    let path = previous?.path ?? "";
    let branch = previous?.branch ?? "";
    let allocationTree = previous;
    let repo: string | null = null;
    try {
      const requested = typeof input.cwd === "string" && input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)) : ctx.cwd;
      repo = await toplevel(requested);
      if (!repo) return { block: true, reason: `lane-worktrees: ${requested} is not inside a git repository, so the lane worktree cannot be made.` };
      if (previous && real(previous.repo) !== real(repo)) return { block: true, reason: "lane-worktrees: this lane belongs to another repository." };
      const root = prepareParent(dir);
      path = previous?.path ?? lanePath(root, brief.lane, allocation);
      branch = previous?.branch ?? laneBranch(root, brief.lane, allocation);
      confinedPath(root, path, !previous);
      if (previous) {
        if (!await verifyAllocation(previous.identity, dir, path, repo, branch, git)) return { block: true, reason: `lane-worktrees: ${path} is not this lane's recorded allocation; refusing reuse.` };
      } else {
        const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
        if (status.code !== 0 || status.stdout.trim()) return { block: true, reason: "lane-worktrees: worktree isolation requires a clean git working tree." };
        const baseRef = input.baseRef ?? "HEAD";
        if (typeof baseRef !== "string" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseRef) || (await git(repo, ["check-ref-format", "--allow-onelevel", baseRef])).code !== 0) {
          return { block: true, reason: "lane-worktrees: baseRef must be HEAD or a supported named Git ref, not a commit ID or revision expression." };
        }
        const base = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
        if (base.code !== 0) return { block: true, reason: `lane-worktrees: baseRef could not be resolved: ${base.stderr.trim()}` };
        if (existsSync(path) || (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) return { block: true, reason: "lane-worktrees: new allocation identity already exists; refusing adoption." };
        confinedPath(root, path, true);
        const add = await git(repo, ["worktree", "add", "-b", branch, path, base.stdout.trim()]);
        if (add.code !== 0) return { block: true, reason: `lane-worktrees: git worktree add failed: ${add.stderr.trim()}` };
        created = true;
        branchCreated = true;
        allocationTree = { lane: brief.lane, task: brief.task, path, branch, repo, runs: [], allocation, base: base.stdout.trim() };
        // Journal even a verification failure: an unknown allocation must be kept, not guessed away.
        trees.set(brief.lane, allocationTree);
        persist();
        registerAllocation(root, path, allocation);
        allocationTree.identity = await allocationIdentity(root, path, repo, branch, allocation, git);
      }
      const preimage = previous?.gitdirPreimage ?? await relativeGitdir(path, async () => {
        const head = await git(path, ["rev-parse", "--verify", "HEAD"]);
        return head.code === 0 ? head.stdout.trim() : "";
      });
      allocationTree!.identity = await allocationIdentity(root, path, repo, branch, allocation, git);
      const sub = relative(real(repo), real(requested));
      const cwd = sub && !sub.startsWith("..") && !isAbsolute(sub) ? join(path, sub) : path;
      const nested = relative(path, cwd);
      if (!await verifyAllocation(allocationTree!.identity, dir, path, repo, branch, git)) throw new Error("allocation changed before launch binding");
      if (!verifyRunCwd(path, nested)) throw new Error("candidate cwd is missing, linked or invalid");
      if (lastSeq === null) lastSeq = landParkEvents(readLog(), 0).maxSeq;
      input.cwd = cwd;
      delete input.isolation;
      input.worktree = false; // Omission would re-enable the package's configured worktree default.
      trees.set(brief.lane, { ...allocationTree!, gitdirPreimage: preimage });
      pending.set(event.toolCallId, { lane: brief.lane, created, branchCreated, cwd: nested });
      persist();
      return undefined;
    } catch (error) {
      if (created && repo && allocationTree && (await removeWorktree(allocationTree)) === "removed") {
        if (branchCreated) await deleteUnusedBranch(allocationTree);
        retire(allocationTree);
      } else if (created && allocationTree) {
        allocationTree.keptUnknown = true;
        persist();
        warn(`kept unknown: ${brief.lane} allocation verification failed; manual recovery required`);
      }
      return { block: true, reason: `lane-worktrees: allocation verification failed: ${String(error)}` };
    } finally {
      allocating.delete(brief.lane);
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (bashCalls.delete(event.toolCallId)) {
      await scanLog();
      return;
    }
    const p = pending.get(event.toolCallId);
    if (!p) return;
    pending.delete(event.toolCallId);
    const tree = trees.get(p.lane);
    if (!tree) return;
    const runId = launchedRunId(event.result);
    if (event.isError && !runId) {
      // Blocked or failed before a run started: undo only what this call made.
      if (p.created && (await removeWorktree(tree)) === "removed") {
        if (p.branchCreated) await deleteUnusedBranch(tree);
        retire(tree);
      }
      return;
    }
    if (runId && !tree.runs.includes(runId)) tree.runs.push(runId);
    if (runId) tree.runCwds = { ...tree.runCwds, [runId]: p.cwd };
    const asyncDir = (event.result as { details?: { asyncDir?: unknown } } | undefined)?.details?.asyncDir;
    if (runId && typeof asyncDir === "string" && isAbsolute(asyncDir)) tree.asyncDirs = { ...tree.asyncDirs, [runId]: asyncDir };
    persist();
    // A terminal notification may precede the tool result; drain a root release that waited on it.
    if (tree.release && !isLive(tree)) await release(tree, tree.release);
  });

  pi.events.on("subagent:async-started", (data) => {
    const d = data as { id?: unknown; sessionId?: unknown } | null;
    if (typeof d?.id === "string" && d.sessionId === sessionKey) {
      live.add(d.id);
      unknown.delete(d.id);
    }
  });

  pi.events.on("subagent:async-complete", (data) => {
    const d = data as { runId?: unknown; id?: unknown } | null;
    const id = typeof d?.runId === "string" ? d.runId : typeof d?.id === "string" ? d.id : undefined;
    if (!id) return;
    live.delete(id);
    unknown.delete(id);
    for (const tree of [...trees.values()]) {
      if (tree.release && tree.runs.includes(id) && !isLive(tree)) void release(tree, tree.release);
    }
  });

  pi.events.on(LOOP_CLOSEOUT_EVENT, (data) => {
    if (!markerPresent()) return;
    const d = data as { lines?: unknown; pending?: unknown } | null;
    const work = sweep()
      .then((line) => {
        if (line && Array.isArray(d?.lines)) (d.lines as string[]).push(line);
        try {
          if (line) lastCtx?.ui.notify(line, "info");
        } catch {
          // A notification must never trap the session.
        }
      });
    if (Array.isArray(d?.pending)) (d.pending as Promise<unknown>[]).push(work);
  });

  pi.on("session_shutdown", () => {
    // Quit/reload is not root release authority. Keep candidates and original run context resumable.
    persist();
  });
}
