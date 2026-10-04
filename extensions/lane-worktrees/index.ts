// lane-worktrees (root only; frozen seam S9). Keeps a candidate lane's worktree until its task lands
// or parks, so a lane resumed after it returned still has its working tree.
//
// pi-subagents removes the managed worktree of every single async run when the run ends, so loop-pi
// owns these worktrees instead. On a root `subagent` launch with `isolation: "worktree"` whose brief
// says `Landing: returns candidate` or `Landing: pushes branch <name>`, this extension runs
//   git worktree add -b loop/<run dir basename>/<lane id> $LOOP_PI_RUN_DIR/worktrees/<lane id> HEAD
// in the root repository, points the call's `cwd` at it and drops `isolation`. A launch that is then
// blocked (by loop-guard or anything else) gets its new worktree and branch removed again. A root
// `land` or `park` for the task (read from the state log after a `loop-state` call) removes the
// worktrees of lanes whose brief named it, once their runs have ended; after a land the branch is
// deleted when it is merged into the default branch, after a park it is kept. `/loop-closeout` and
// a quitting session sweep what is left. Everything is gated on the S0 protocol marker.
//
// Only `cwd`, `isolation` and `worktree` are touched; loop-guard's rewrite is `extensionBindings`.
// Both handlers mutate the same input object, so their order does not matter.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveLogPath } from "../loop-state/core.ts";
import { landParkEvents, laneBranch, launchedRunId, parseLaneBrief, safeLaneId, STATE_CUSTOM_TYPE } from "./core.ts";

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
  /** A land or park arrived while a run of this lane was live: remove once none is. */
  release?: "land" | "park";
}

interface Persisted {
  trees: Tree[];
  lastSeq: number | null;
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

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export default function (pi: ExtensionAPI) {
  const trees = new Map<string, Tree>();
  let lastSeq: number | null = null;
  let sessionKey = "";
  let lastCtx: ExtensionContext | null = null;
  const live = new Set<string>();
  // Tool call id -> the lane a launch or resume belongs to, and whether this call made its worktree.
  const pending = new Map<string, { lane: string; created: boolean; branchCreated: boolean }>();
  const bashCalls = new Set<string>();

  const runDir = (): string | undefined => process.env.LOOP_PI_RUN_DIR || undefined;
  const markerPresent = (): boolean => {
    const dir = runDir();
    return dir !== undefined && existsSync(join(dir, PROTO_FILE));
  };

  function persist() {
    const data: Persisted = { trees: [...trees.values()], lastSeq };
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

  const isLive = (tree: Tree) => tree.runs.some((id) => live.has(id));

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

  async function removeWorktree(repo: string, path: string): Promise<boolean> {
    if (!existsSync(path)) return true;
    const r = await git(repo, ["worktree", "remove", "--force", path]);
    if (r.code !== 0) warn(`could not remove ${path}: ${r.stderr.trim()}`);
    return r.code === 0;
  }

  /** Remove a lane's worktree; after a land delete its branch when merged, after a park keep it. */
  async function release(tree: Tree, why: "land" | "park") {
    if (isLive(tree)) {
      tree.release = why;
      persist();
      return;
    }
    if (!(await removeWorktree(tree.repo, tree.path))) return;
    trees.delete(tree.lane);
    persist();
    if (why === "land" && (await merged(tree.repo, tree.branch))) {
      const r = await git(tree.repo, ["branch", "-D", tree.branch]);
      if (r.code !== 0) warn(`could not delete merged branch ${tree.branch}: ${r.stderr.trim()}`);
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
  }

  /** The closeout sweep: remove every remaining worktree (live lanes' are kept), delete merged branches. */
  async function sweep(fallbackRepo: string | null): Promise<string> {
    const dir = runDir();
    if (!dir) return "";
    const root = join(dir, "worktrees");
    let removed = 0;
    const keptLive: string[] = [];
    const failed: string[] = [];
    const repos = new Set<string>();
    const names = existsSync(root) ? readdirSync(root) : [];
    for (const name of names) {
      const path = join(root, name);
      const tree = trees.get(name);
      if (tree && isLive(tree)) {
        keptLive.push(name);
        continue;
      }
      const repo = tree?.repo ?? fallbackRepo;
      if (!repo) {
        failed.push(name);
        continue;
      }
      repos.add(repo);
      if (await removeWorktree(repo, path)) {
        removed++;
        trees.delete(name);
      } else {
        failed.push(name);
      }
    }
    for (const tree of trees.values()) repos.add(tree.repo);
    if (fallbackRepo) repos.add(fallbackRepo);
    let deleted = 0;
    const unmerged: string[] = [];
    const prefix = `refs/heads/loop/${basename(dir)}/`;
    for (const repo of repos) {
      await git(repo, ["worktree", "prune"]);
      const refs = await git(repo, ["for-each-ref", "--format=%(refname)", prefix]);
      for (const ref of refs.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const branch = ref.replace(/^refs\/heads\//, "");
        const lane = branch.slice(branch.lastIndexOf("/") + 1);
        if (keptLive.includes(lane)) continue;
        if (await merged(repo, branch)) {
          if ((await git(repo, ["branch", "-D", branch])).code === 0) deleted++;
        } else {
          unmerged.push(branch);
        }
      }
    }
    persist();
    const parts = [`lane-worktrees: removed ${removed} worktree(s), deleted ${deleted} merged branch(es)`];
    parts.push(unmerged.length ? `kept unmerged: ${unmerged.join(", ")}` : "no unmerged lane branches");
    if (keptLive.length) parts.push(`kept live: ${keptLive.join(", ")}`);
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
    live.clear();
    lastSeq = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
        const data = (entry as CustomEntry<Persisted>).data;
        trees.clear();
        for (const tree of data?.trees ?? []) trees.set(tree.lane, tree);
        lastSeq = typeof data?.lastSeq === "number" ? data.lastSeq : null;
      }
    }
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
      const target = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : undefined;
      const tree = target ? [...trees.values()].find((t) => t.runs.some((id) => id === target || id.startsWith(target))) : undefined;
      if (tree) pending.set(event.toolCallId, { lane: tree.lane, created: false, branchCreated: false });
      return;
    }
    if (input.action !== undefined || typeof input.agent !== "string" || input.isolation !== "worktree") return;
    const brief = parseLaneBrief(input.task);
    if (!brief) return;
    const dir = runDir()!;
    if (!safeLaneId(brief.lane)) {
      return { block: true, reason: `lane-worktrees: lane id '${brief.lane}' cannot name a worktree directory or branch; use letters, digits, '.', '_' and '-'.` };
    }
    const requested = typeof input.cwd === "string" && input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)) : ctx.cwd;
    const repo = await toplevel(requested);
    if (!repo) return { block: true, reason: `lane-worktrees: ${requested} is not inside a git repository, so the lane worktree cannot be made.` };
    const path = join(dir, "worktrees", brief.lane);
    const branch = laneBranch(dir, brief.lane);
    let created = false;
    let branchCreated = false;
    if (existsSync(path)) {
      const top = await toplevel(path);
      if (!top || real(top) !== real(path)) {
        return { block: true, reason: `lane-worktrees: ${path} exists and is not a lane worktree; pick another lane id.` };
      }
    } else {
      const valid = await git(repo, ["check-ref-format", "--branch", branch]);
      if (valid.code !== 0) return { block: true, reason: `lane-worktrees: ${branch} is not a valid branch name.` };
      const exists = (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      const add = exists
        ? await git(repo, ["worktree", "add", path, branch])
        : await git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
      if (add.code !== 0) return { block: true, reason: `lane-worktrees: git worktree add failed: ${add.stderr.trim()}` };
      created = true;
      branchCreated = !exists;
    }
    if (lastSeq === null) lastSeq = landParkEvents(readLog(), 0).maxSeq;
    const sub = relative(real(repo), real(requested));
    input.cwd = sub && !sub.startsWith("..") && !isAbsolute(sub) ? join(path, sub) : path;
    delete input.isolation;
    if (input.worktree === true) delete input.worktree;
    const previous = trees.get(brief.lane);
    trees.set(brief.lane, { lane: brief.lane, task: brief.task, path, branch, repo, runs: previous?.runs ?? [] });
    pending.set(event.toolCallId, { lane: brief.lane, created, branchCreated });
    persist();
    return undefined;
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
      if (p.created) {
        await removeWorktree(tree.repo, tree.path);
        if (p.branchCreated) await git(tree.repo, ["branch", "-D", tree.branch]);
        trees.delete(p.lane);
        persist();
      }
      return;
    }
    if (runId && !tree.runs.includes(runId)) tree.runs.push(runId);
    persist();
  });

  pi.events.on("subagent:async-started", (data) => {
    const d = data as { id?: unknown; sessionId?: unknown } | null;
    if (typeof d?.id === "string" && d.sessionId === sessionKey) live.add(d.id);
  });

  pi.events.on("subagent:async-complete", (data) => {
    const d = data as { runId?: unknown; id?: unknown } | null;
    const id = typeof d?.runId === "string" ? d.runId : typeof d?.id === "string" ? d.id : undefined;
    if (!id) return;
    live.delete(id);
    for (const tree of [...trees.values()]) {
      if (tree.release && tree.runs.includes(id) && !isLive(tree)) void release(tree, tree.release);
    }
  });

  pi.events.on(LOOP_CLOSEOUT_EVENT, (data) => {
    if (!markerPresent()) return;
    const d = data as { lines?: unknown; pending?: unknown } | null;
    const cwd = lastCtx?.cwd ?? process.cwd();
    const work = toplevel(cwd)
      .then((repo) => sweep(repo))
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

  pi.on("session_shutdown", async (event, ctx) => {
    // Only a quitting session ends the loop; a reload, resume or fork carries on in another runtime.
    if (event.reason !== "quit" || !markerPresent()) return;
    try {
      await sweep(await toplevel(ctx.cwd));
    } catch {
      // The sweep is best effort; /loop-closeout reports what is left.
    }
  });
}
