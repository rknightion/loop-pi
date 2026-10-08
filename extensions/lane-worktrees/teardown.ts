// Close-time teardown of root scratch paths (SEAMS Lane worktrees). The root registers every scratch
// path it creates (a worktree, a gate dir, a cache dir) with `scratch_register`; each registration is
// one JSON line in `<run dir>/scratch-ledger.jsonl`. At closeout this module removes only:
//   - a registered linked git worktree that is still the registered object, clean (no tracked
//     changes, no untracked files) and whose HEAD is an ancestor of origin's default branch, with
//     `git worktree remove` and never `--force`;
//   - a registered non-worktree directory the root explicitly marked disposable, after it is moved
//     aside and proved to be the registered object holding no Git data and no other filesystem.
// Everything else (keep-flagged, dirty, unlanded, locked, replaced, protected, unregistered) is left
// in place and listed with its reason in `<run dir>/teardown.json`. Nothing is inferred from a
// directory name, and nothing outside this run's ledger is removed. The checks are honest-mistake
// fences, not an OS sandbox against a concurrent adversarial rename by the same account.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { confinedRoot, type GitProbe } from "./identity.ts";

export const LEDGER_FILE = "scratch-ledger.jsonl";
export const RECEIPT_FILE = "teardown.json";
export const SCRATCH_KINDS = ["worktree", "gate", "cache"] as const;
export type ScratchKind = (typeof SCRATCH_KINDS)[number];

export interface LedgerEntry {
  v: 1;
  at: string;
  /** Canonical absolute path (no symbolic link in any component). */
  path: string;
  /** The root's label for the path. */
  kind: ScratchKind;
  /** What the path was at registration: a linked git worktree or a plain directory. */
  type: "worktree" | "dir";
  keep: boolean;
  /** Only a `dir` can be disposable; a worktree is removed only when clean and landed. */
  disposable: boolean;
  dev: number;
  ino: number;
  /** Canonical git common dir of a registered worktree. */
  commonDir?: string;
}

export interface ReceiptEntry {
  path: string;
  source: "ledger" | "lane-worktrees" | "discovered";
  kind?: string;
  outcome: "removed" | "kept" | "absent";
  reason: string;
  /** Up to 20 ignored paths (outside node_modules) that kept a clean landed worktree. */
  ignored?: string[];
}

export interface Receipt {
  v: 1;
  at: string;
  runDir: string;
  ledger: string;
  counts: { removed: number; kept: number; absent: number };
  entries: ReceiptEntry[];
  warnings: string[];
}

export interface RegisterInput {
  path: string;
  kind: ScratchKind;
  keep?: boolean;
  disposable?: boolean;
}

export interface Context {
  /** The root session's cwd; relative registrations resolve against it. */
  cwd: string;
  /** Locations a removable path may never contain (home, agent dir, session cwd). */
  protect: string[];
  git: GitProbe;
}

// The native realpath returns the on-disk spelling. The JS one keeps the caller's casing on a
// case-insensitive volume, so a re-cased spelling of a protected path would compare as different.
const realpath = realpathSync.native;

function canonical(path: string): string {
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

/** `child` is `parent` or lies beneath it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

const idOf = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;

/** dev:ino of an existing path and of every ancestor, or an empty set when it cannot be read. */
function ancestry(path: string): Set<string> {
  const ids = new Set<string>();
  try {
    let current = realpath(path);
    for (;;) {
      ids.add(idOf(lstatSync(current)));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // An unreadable path proves nothing either way; the spelling checks still apply.
  }
  return ids;
}

/**
 * Why `path` may never be removed by teardown, or null. Containment is checked twice: on canonical
 * spellings and on filesystem identity (dev/ino ancestry), so no spelling of a path escapes it.
 */
function protectedReason(path: string, runRoot: string, protect: string[]): string | null {
  const inRun = "inside the loop run directory, which holds the loop's evidence";
  if (dirname(path) === path) return "the filesystem root is never removed";
  if (within(runRoot, path)) return inRun;
  for (const p of protect) if (within(path, canonical(p))) return `contains a protected location (${canonical(p)})`;
  if (within(path, runRoot)) return "contains the loop run directory";
  let self: string;
  try {
    self = idOf(lstatSync(path));
  } catch {
    return null; // Absent: nothing to remove.
  }
  try {
    if (ancestry(path).has(idOf(lstatSync(runRoot)))) return inRun;
  } catch {
    // The run root was checked by the caller.
  }
  for (const p of protect) if (ancestry(p).has(self)) return `contains a protected location (${canonical(p)})`;
  if (ancestry(runRoot).has(self)) return "contains the loop run directory";
  return null;
}

/** A directory that is itself (no symbolic link) at its canonical path. */
function directoryId(path: string): { dev: number; ino: number } {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error("not a directory, or a symbolic link");
  if (realpath(path) !== path) throw new Error("a path component is a symbolic link or the path is not canonical");
  return { dev: s.dev, ino: s.ino };
}

function dotGit(path: string): "file" | "dir" | "other" | null {
  try {
    const s = lstatSync(join(path, ".git"));
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface WorktreeFacts {
  commonDir: string;
  gitDir: string;
}

/** Prove `path` is the top of a linked worktree (never a main working tree or a standalone clone). */
async function worktreeFacts(path: string, git: GitProbe): Promise<WorktreeFacts> {
  const pointer = dotGit(path);
  if (pointer !== "file") throw new Error(pointer === "dir" ? "a main working tree or standalone repository, never a removable worktree" : "not a linked git worktree (no .git pointer file)");
  const r = await git(path, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"]);
  const [top, common, gitDir] = r.stdout.split("\n").map((line) => line.trim());
  if (r.code !== 0 || !top || !common || !gitDir) throw new Error(`git could not describe the worktree: ${r.stderr.trim()}`);
  if (canonical(top) !== path) throw new Error("the path is not the top of its worktree");
  const facts = { commonDir: canonical(common), gitDir: canonical(gitDir) };
  if (facts.commonDir === facts.gitDir) throw new Error("a main working tree, never a removable worktree");
  if (dirname(facts.gitDir) !== join(facts.commonDir, "worktrees")) throw new Error("the worktree's git dir is outside its repository");
  return facts;
}

/** Why a plain directory cannot be a disposable scratch dir, or null. */
async function plainDirReason(path: string, git: GitProbe): Promise<string | null> {
  if (dotGit(path) !== null) return "holds a .git entry: a repository or worktree is never removed as a plain directory";
  const inside = await git(path, ["rev-parse", "--is-inside-git-dir", "--is-inside-work-tree"]);
  if (inside.code !== 0) return null; // Not inside any repository.
  const [inGitDir, inWorkTree] = inside.stdout.split("\n").map((line) => line.trim());
  if (inGitDir === "true") return "inside a git directory";
  if (inWorkTree === "true") {
    const tracked = await git(path, ["ls-files", "-z", "--", "."]);
    if (tracked.code !== 0) return `could not list tracked files: ${tracked.stderr.trim()}`;
    if (tracked.stdout !== "") return "holds files tracked by its enclosing repository";
  }
  return null;
}

function runRootOf(runDir: string): string {
  return realpath(confinedRoot(runDir));
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  return openSync(path, flags | constants.O_NOFOLLOW, mode);
}

function appendLine(file: string, line: string): void {
  const fd = openNoFollow(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("the scratch ledger is not a regular file");
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Validate and record one scratch path. Throws with the refusal reason. */
export async function registerScratch(runDir: string, input: RegisterInput, ctx: Context, now = new Date()): Promise<LedgerEntry> {
  const runRoot = runRootOf(runDir);
  if (!SCRATCH_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${SCRATCH_KINDS.join(", ")}`);
  if (typeof input.path !== "string" || !input.path.trim()) throw new Error("path is required");
  const requested = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
  let path: string;
  try {
    path = realpath(requested);
  } catch {
    throw new Error(`${requested} does not exist; create the path before registering it`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
  const guard = protectedReason(path, runRoot, ctx.protect);
  if (guard) throw new Error(`${path} cannot be registered: ${guard}`);
  const pointer = dotGit(path);
  let entry: LedgerEntry;
  if (pointer === "file" || input.kind === "worktree") {
    const facts = await worktreeFacts(path, ctx.git).catch((error: Error) => {
      throw new Error(`${path} cannot be registered as a worktree: ${error.message}`);
    });
    entry = { v: 1, at: now.toISOString(), path, kind: input.kind, type: "worktree", keep: input.keep === true, disposable: false, dev: stat.dev, ino: stat.ino, commonDir: facts.commonDir };
  } else {
    const reason = await plainDirReason(path, ctx.git);
    if (reason) throw new Error(`${path} cannot be registered: ${reason}`);
    entry = { v: 1, at: now.toISOString(), path, kind: input.kind, type: "dir", keep: input.keep === true, disposable: input.disposable === true, dev: stat.dev, ino: stat.ino };
  }
  appendLine(join(runRoot, LEDGER_FILE), JSON.stringify(entry));
  return entry;
}

function validEntry(value: unknown): value is LedgerEntry {
  const e = value as LedgerEntry;
  return !!e && typeof e === "object" && e.v === 1 && typeof e.path === "string" && isAbsolute(e.path)
    && (SCRATCH_KINDS as readonly string[]).includes(e.kind) && (e.type === "worktree" || e.type === "dir")
    && typeof e.keep === "boolean" && typeof e.disposable === "boolean" && Number.isFinite(e.dev) && Number.isFinite(e.ino)
    && (e.type === "dir" || typeof e.commonDir === "string");
}

/** The ledger's entries, the last registration of a path winning. */
export function readLedger(runDir: string): { entries: LedgerEntry[]; warnings: string[] } {
  const file = join(runRootOf(runDir), LEDGER_FILE);
  let text = "";
  try {
    const fd = openNoFollow(file, constants.O_RDONLY);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("the scratch ledger is not a regular file");
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], warnings: [] };
    return { entries: [], warnings: [`scratch ledger unreadable, nothing registered is removed: ${(error as Error).message}`] };
  }
  const byPath = new Map<string, LedgerEntry>();
  const warnings: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (!validEntry(value)) throw new Error("invalid entry");
      byPath.delete(value.path);
      byPath.set(value.path, value);
    } catch {
      warnings.push(`scratch ledger line ${index + 1} is malformed and was ignored`);
    }
  });
  return { entries: [...byPath.values()], warnings };
}

function sameObject(path: string, entry: LedgerEntry): boolean {
  try {
    const id = directoryId(path);
    return id.dev === entry.dev && id.ino === entry.ino;
  } catch {
    return false;
  }
}

async function worktreeOutcome(entry: LedgerEntry, ctx: Context): Promise<Omit<ReceiptEntry, "path" | "source" | "kind">> {
  const kept = (reason: string) => ({ outcome: "kept" as const, reason });
  const path = entry.path;
  let facts: WorktreeFacts;
  try {
    facts = await worktreeFacts(path, ctx.git);
  } catch (error) {
    return kept(`no longer the registered worktree: ${(error as Error).message}`);
  }
  if (facts.commonDir !== entry.commonDir) return kept(`belongs to a different repository (${facts.commonDir}) than the one registered`);
  const list = await ctx.git(facts.commonDir, ["--git-dir", facts.commonDir, "worktree", "list", "--porcelain", "-z"]);
  const record = list.stdout.split("\0\0").map((r) => r.split("\0")).find((r) => r.some((field) => field.startsWith("worktree ") && canonical(field.slice("worktree ".length)) === path));
  if (list.code !== 0 || !record) return kept("not registered with its repository as a worktree");
  if (record.some((field) => field === "locked" || field.startsWith("locked "))) return kept("locked worktree");
  const status = await ctx.git(path, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return kept(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim()) return kept("dirty: uncommitted changes or untracked files");
  // git worktree remove deletes ignored files too. Only dependency installs are regenerable enough.
  const ignoredStatus = await ctx.git(path, ["status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=all"]);
  if (ignoredStatus.code !== 0) return kept(`git status failed: ${ignoredStatus.stderr.trim()}`);
  const ignored = ignoredStatus.stdout.split("\0").filter((item) => item.startsWith("!! ")).map((item) => item.slice(3))
    .filter((item) => !item.split("/").includes("node_modules"));
  if (ignored.length) return { outcome: "kept", reason: "ignored content present", ignored: ignored.slice(0, 20) };
  const head = await ctx.git(path, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) return kept("HEAD could not be resolved");
  const origin = await ctx.git(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const ref = origin.stdout.trim();
  if (origin.code !== 0 || !ref) return kept("origin's default branch is unknown (refs/remotes/origin/HEAD is not set), so landing cannot be proved");
  const landed = await ctx.git(path, ["merge-base", "--is-ancestor", head.stdout.trim(), ref]);
  if (landed.code === 1) return kept(`unlanded: HEAD ${head.stdout.trim().slice(0, 12)} is not on ${ref}`);
  if (landed.code !== 0) return kept(`landing check failed: ${landed.stderr.trim()}`);
  // Recheck after the asynchronous probes: still the same object, repository and checkout.
  if (!sameObject(path, entry)) return kept("the path changed during teardown");
  try {
    if ((await worktreeFacts(path, ctx.git)).commonDir !== entry.commonDir) return kept("the path changed during teardown");
  } catch {
    return kept("the path changed during teardown");
  }
  // Never --force: git itself refuses a worktree that became dirty or locked meanwhile.
  const removed = await ctx.git(facts.commonDir, ["--git-dir", facts.commonDir, "worktree", "remove", path]);
  if (removed.code !== 0) return kept(`git worktree remove refused: ${removed.stderr.trim()}`);
  return { outcome: "removed", reason: `clean and landed on ${ref}; removed with git worktree remove` };
}

/** Lstat walk: refuse Git data anywhere and any other filesystem mounted beneath. */
function disposableContentReason(root: string, dev: number, blocking: Set<string>): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, item.name);
      if (item.name === ".git") return `holds Git data at ${relative(root, child) || "."}`;
      if (!item.isDirectory()) continue;
      const s = lstatSync(child);
      if (s.isSymbolicLink() || !s.isDirectory()) continue;
      if (s.dev !== dev) return `crosses a filesystem boundary at ${relative(root, child)}`;
      if (blocking.has(idOf(s))) return `holds a registered path that is not removed at ${relative(root, child)}`;
      stack.push(child);
    }
  }
  return null;
}

async function dirOutcome(entry: LedgerEntry, ctx: Context, blocking: Set<string>): Promise<Omit<ReceiptEntry, "path" | "source" | "kind">> {
  const kept = (reason: string) => ({ outcome: "kept" as const, reason });
  const path = entry.path;
  if (!entry.disposable) return kept("not marked disposable at registration");
  const before = await plainDirReason(path, ctx.git);
  if (before) return kept(before);
  // Move the directory aside first, then prove the moved object is the one registered. A swap of
  // the path or a parent for a link moves that link, which fails the identity check and goes back.
  const tomb = join(dirname(path), `.${basename(path)}.teardown-${randomUUID()}`);
  try {
    lstatSync(tomb);
    return kept("teardown name collision; not removed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return kept(`could not prepare removal: ${(error as Error).message}`);
  }
  if (!sameObject(path, entry)) return kept("the path changed during teardown");
  try {
    renameSync(path, tomb);
  } catch (error) {
    return kept(`could not move aside for removal: ${(error as Error).message}`);
  }
  const restore = (reason: string) => {
    try {
      renameSync(tomb, path);
      return kept(reason);
    } catch (error) {
      return kept(`${reason}; left at ${tomb} because it could not be moved back: ${(error as Error).message}`);
    }
  };
  let s;
  try {
    s = lstatSync(tomb);
  } catch (error) {
    return kept(`moved object vanished: ${(error as Error).message}`);
  }
  if (s.isSymbolicLink() || !s.isDirectory() || s.dev !== entry.dev || s.ino !== entry.ino) return restore("the path is not the directory registered (replaced, moved or now a link)");
  let content: string | null;
  try {
    content = disposableContentReason(tomb, entry.dev, blocking);
  } catch (error) {
    content = `could not inspect contents: ${(error as Error).message}`;
  }
  if (content) return restore(content);
  try {
    // Node's recursive rm unlinks symbolic links rather than following them.
    rmSync(tomb, { recursive: true });
  } catch (error) {
    return kept(`removal failed part-way; what is left is at ${tomb}: ${(error as Error).message}`);
  }
  return { outcome: "removed", reason: "registered disposable directory removed" };
}

/**
 * `survivors`: every other registered or lane-worktrees path that is not removed in this pass.
 * A path holding one is kept, whatever else holds, so removing it cannot take the survivor too.
 */
async function ledgerOutcome(entry: LedgerEntry, runRoot: string, ctx: Context, survivors: string[]): Promise<ReceiptEntry> {
  const base = { path: entry.path, source: "ledger" as const, kind: entry.kind };
  if (entry.keep) return { ...base, outcome: "kept", reason: "keep flag set at registration" };
  const guard = protectedReason(entry.path, runRoot, ctx.protect);
  if (guard) return { ...base, outcome: "kept", reason: guard };
  const nested = survivors.filter((other) => other !== entry.path && within(entry.path, other));
  if (nested.length) return { ...base, outcome: "kept", reason: `holds a registered path that is not removed: ${nested.join(", ")}` };
  const blocking = new Set<string>();
  for (const other of survivors) {
    try {
      blocking.add(idOf(lstatSync(other)));
    } catch {
      // An absent survivor cannot be removed with this path.
    }
  }
  try {
    lstatSync(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...base, outcome: "absent", reason: "already absent" };
    return { ...base, outcome: "kept", reason: `could not inspect: ${(error as Error).message}` };
  }
  if (!sameObject(entry.path, entry)) return { ...base, outcome: "kept", reason: "the path is not the directory registered (replaced, moved or now a link)" };
  try {
    return { ...base, ...(entry.type === "worktree" ? await worktreeOutcome(entry, ctx) : await dirOutcome(entry, ctx, blocking)) };
  } catch (error) {
    return { ...base, outcome: "kept", reason: `teardown error: ${(error as Error).message}` };
  }
}

/** Linked worktrees of these repositories that nobody registered: listed, never touched. */
async function discovered(commonDirs: Set<string>, known: Set<string>, git: GitProbe): Promise<ReceiptEntry[]> {
  const found: ReceiptEntry[] = [];
  for (const commonDir of commonDirs) {
    const list = await git(commonDir, ["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"]);
    if (list.code !== 0) continue;
    const records = list.stdout.split("\0\0").map((r) => r.split("\0").filter(Boolean)).filter((r) => r.length);
    // The first record is the main working tree (or the bare repository): never scratch.
    for (const record of records.slice(1)) {
      const field = record.find((f) => f.startsWith("worktree "));
      if (!field) continue;
      const path = canonical(field.slice("worktree ".length));
      if (known.has(path)) continue;
      known.add(path);
      const prunable = record.some((f) => f === "prunable" || f.startsWith("prunable "));
      found.push({ path, source: "discovered", kind: "worktree", outcome: "kept", reason: `unregistered: not in this run's ledger${prunable ? " (git reports it prunable)" : ""}; left for a human decision` });
    }
  }
  return found;
}

function writeReceipt(runRoot: string, receipt: Receipt): string {
  const target = join(runRoot, RECEIPT_FILE);
  const temp = join(runRoot, `.${RECEIPT_FILE}.${randomUUID()}.tmp`);
  const fd = openNoFollow(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  return target;
}

export interface TeardownInput extends Context {
  runDir: string;
  /** Outcomes of lane-worktrees' own retained allocations from the closeout sweep. */
  recorded: ReceiptEntry[];
  /** Every path lane-worktrees records, so discovery never lists them as unregistered. */
  recordedPaths: string[];
  now?: Date;
}

/** Remove what is provably finished, list everything else, and write the receipt. */
export async function teardown(input: TeardownInput): Promise<{ receipt: Receipt; file: string }> {
  const runRoot = runRootOf(input.runDir);
  const { entries, warnings } = readLedger(runRoot);
  const results: ReceiptEntry[] = [...input.recorded];
  // lane-worktrees' own allocations are reported by its sweep alone, never handled twice.
  const lane = new Set<string>([...input.recordedPaths, ...input.recorded.map((r) => r.path)].map(canonical));
  const owned = entries.filter((e) => !lane.has(e.path));
  // Deepest first, so a parent is decided after everything registered inside it.
  const depth = (path: string) => path.split(sep).length;
  const ordered = [...owned].sort((x, y) => depth(y.path) - depth(x.path));
  const laneSurvivors = [...input.recordedPaths, ...input.recorded.filter((r) => r.outcome !== "removed").map((r) => r.path)].map(canonical);
  const decided = new Map<string, ReceiptEntry["outcome"]>();
  for (const entry of ordered) {
    // Undecided entries are no deeper, so only a decided, not-removed entry can lie inside this one.
    const survivors = [...laneSurvivors, ...ordered.filter((e) => e !== entry && !["removed", "absent"].includes(decided.get(e.path) ?? "")).map((e) => e.path)];
    const result = await ledgerOutcome(entry, runRoot, input, survivors);
    decided.set(entry.path, result.outcome);
    results.push(result);
  }
  const known = new Set<string>([...entries.map((e) => e.path), ...lane]);
  const repos = new Set<string>();
  for (const entry of entries) if (entry.commonDir) repos.add(entry.commonDir);
  const root = await input.git(input.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (root.code === 0 && root.stdout.trim()) repos.add(canonical(root.stdout.trim()));
  results.push(...await discovered(repos, known, input.git));
  const count = (outcome: ReceiptEntry["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  const receipt: Receipt = {
    v: 1,
    at: (input.now ?? new Date()).toISOString(),
    runDir: runRoot,
    ledger: join(runRoot, LEDGER_FILE),
    counts: { removed: count("removed"), kept: count("kept"), absent: count("absent") },
    entries: results,
    warnings,
  };
  return { receipt, file: writeReceipt(runRoot, receipt) };
}
