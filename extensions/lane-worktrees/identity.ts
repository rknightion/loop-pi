// Allocation identity is evidence, never inferred from a shared common Git directory or a label.
// Fail closed on moved/replaced paths and symlinked parents. These are fresh honest-mistake checks,
// not an OS sandbox or atomic protection against a concurrent adversarial same-account rename.
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

interface ObjectId { dev: number; ino: number }
export interface AllocationIdentity {
  runRoot: string;
  path: string;
  commonDir: string;
  gitdir: string;
  token: string;
  rootId: ObjectId;
  parentId: ObjectId;
  pathId: ObjectId;
  pointerId: ObjectId;
  gitdirId: ObjectId;
}
export type GitProbe = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const MARKER = "loop-pi-allocation";

function object(path: string, kind: "file" | "directory"): ObjectId {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (kind === "file" ? !s.isFile() : !s.isDirectory())) throw new Error(`allocation ${kind} identity refused: ${path}`);
  return { dev: s.dev, ino: s.ino };
}
function same(a: ObjectId, b: ObjectId): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Anchor the canonical run root once; refuse a linked root and every link below that anchor. */
export function confinedRoot(runDir: string): string {
  object(runDir, "directory");
  return realpathSync(runDir);
}
export function confinedPath(runRoot: string, path: string, leafMayBeAbsent = false): void {
  object(runRoot, "directory");
  if (realpathSync(runRoot) !== runRoot) throw new Error("canonical run root changed");
  const rel = relative(runRoot, resolve(path));
  if (isAbsolute(rel) || rel.startsWith("..") || !rel) throw new Error("allocation escaped the canonical run root");
  const parts = rel.split("/");
  if (parts.length !== 2 || parts[0] !== "worktrees") throw new Error("allocation is not a direct child of the retained worktrees directory");
  object(join(runRoot, "worktrees"), "directory");
  try { object(path, "directory"); } catch (error) {
    if (!leafMayBeAbsent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Verify the recorded run cwd, not just the allocation root: never follow nested links. */
export function verifyRunCwd(path: string, cwd: unknown): boolean {
  if (typeof cwd !== "string" || isAbsolute(cwd)) return false;
  try {
    object(path, "directory");
    const root = realpathSync(path);
    if (root !== path) return false;
    const parts = cwd ? cwd.split("/") : [];
    if (parts.some((part) => !part || part === "." || part === "..")) return false;
    let component = path;
    for (const part of parts) {
      component = join(component, part);
      object(component, "directory");
    }
    return realpathSync(component) === component;
  } catch { return false; }
}

export function prepareParent(runDir: string): string {
  const root = confinedRoot(runDir);
  try { mkdirSync(join(root, "worktrees")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  object(join(root, "worktrees"), "directory");
  return root;
}

async function gitText(git: GitProbe, cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`allocation Git identity unavailable: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Capture and verify the actual Git registration, pointer, branch and filesystem objects. */
export async function allocationIdentity(runRoot: string, path: string, repo: string, branch: string, token: string, git: GitProbe): Promise<AllocationIdentity> {
  confinedPath(runRoot, path);
  const rootId = object(runRoot, "directory");
  const parentId = object(join(runRoot, "worktrees"), "directory");
  const pathId = object(path, "directory");
  const pointerId = object(join(path, ".git"), "file");
  const raw = readFileSync(join(path, ".git"), "utf8");
  const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(raw)?.[1];
  if (!pointer) throw new Error("allocation Git pointer is invalid");
  const gitdir = realpathSync(resolve(path, pointer));
  const gitdirId = object(gitdir, "directory");
  object(join(gitdir, "gitdir"), "file");
  if (realpathSync(resolve(gitdir, readFileSync(join(gitdir, "gitdir"), "utf8").trim())) !== realpathSync(join(path, ".git"))) throw new Error("allocation Git back-pointer changed");
  object(join(gitdir, MARKER), "file");
  if (readFileSync(join(gitdir, MARKER), "utf8") !== token) throw new Error("allocation registration token changed");
  const commonDir = realpathSync(await gitText(git, repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (dirname(gitdir) !== join(commonDir, "worktrees")) {
    throw new Error("allocation Git registration is outside its repository");
  }
  if (realpathSync(await gitText(git, path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== commonDir || realpathSync(await gitText(git, path, ["rev-parse", "--absolute-git-dir"])) !== gitdir || realpathSync(await gitText(git, path, ["rev-parse", "--show-toplevel"])) !== path || await gitText(git, path, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${branch}`) {
    throw new Error("allocation repository, branch, gitdir or path changed");
  }
  const registration = await gitText(git, repo, ["worktree", "list", "--porcelain", "-z"]);
  const records = registration.split("\0\0").map((r) => r.split("\0"));
  if (!records.some((r) => r.includes(`worktree ${path}`) && r.includes(`branch refs/heads/${branch}`))) throw new Error("allocation no longer has its exact Git worktree registration");
  confinedPath(runRoot, path);
  if (!same(rootId, object(runRoot, "directory")) || !same(parentId, object(join(runRoot, "worktrees"), "directory")) || !same(pathId, object(path, "directory")) || !same(pointerId, object(join(path, ".git"), "file")) || !same(gitdirId, object(gitdir, "directory"))) throw new Error("allocation changed during identity verification");
  return { runRoot, path, commonDir, gitdir, token, rootId, parentId, pathId, pointerId, gitdirId };
}

export async function verifyAllocation(identity: AllocationIdentity | undefined, runDir: string | undefined, path: string, repo: string, branch: string, git: GitProbe): Promise<boolean> {
  if (!identity || !runDir) return false;
  try {
    if (confinedRoot(runDir) !== identity.runRoot || path !== identity.path) return false;
    const current = await allocationIdentity(identity.runRoot, path, repo, branch, identity.token, git);
    return current.gitdir === identity.gitdir && current.commonDir === identity.commonDir && ["rootId", "parentId", "pathId", "pointerId", "gitdirId"].every((key) => same(current[key as "rootId"], identity[key as "rootId"]));
  } catch { return false; }
}

/** Called only immediately after our own successful allocation, never on an existing path. */
export function registerAllocation(runRoot: string, path: string, token: string): void {
  confinedPath(runRoot, path);
  object(join(path, ".git"), "file");
  const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(join(path, ".git"), "utf8"))?.[1];
  if (!pointer) throw new Error("new allocation Git pointer is invalid");
  const gitdir = realpathSync(resolve(path, pointer));
  object(gitdir, "directory");
  writeFileSync(join(gitdir, MARKER), token, { flag: "wx", mode: 0o600 });
}
