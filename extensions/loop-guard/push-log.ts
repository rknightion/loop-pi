// Push log writer (SEAMS S1): one line per remote branch a successful `git push` or `gh pr merge`
// moved, appended to `<run dir>/push-log.jsonl` by the root (at `tool_execution_end`) and by every
// lane (the lane guard's post-exec hook). Land evidence for the audit comes from here, not from
// root-written events.
//
// Before the command runs (the guard's `tool_call`), `planPushes` reads each named remote branch
// with `git ls-remote` (`old`) and the local commit each refspec's source names. After a successful
// run, `recordPushes` reads the remote again and writes a line only when the branch now equals the
// commit this push sent (`new`): the source as resolved before the command, or (when no later step
// of the same command can pull foreign commits into it) as resolved after it, so a commit made
// earlier in the same command counts. A branch that another writer moved after the push, a no-op
// push, a failed command or a remote that cannot be read writes nothing; a foreign push is never
// absorbed into the logged range.
//
// `gh pr merge` (root, and lanes under an ops release surface) logs the same schema: `old` is the
// remote base branch before the merge, `new` the PR's merge commit, written only when the PR is
// MERGED and the remote base branch equals that commit afterwards.
//
// `repo` is the main checkout (the parent of the common git dir), so a push from a linked worktree
// matches the audit's repository path. Only a push spelled as its own shell command is logged: one
// inside an interpreter's code or stdin script (`python3 - <<EOF ... subprocess.run(['git','push'])`),
// a git alias's shell body or text the parser cannot read is not. `unloggedPushRefusal` lets the lane
// guard refuse those before they run, so a push the log cannot see never lands from a lane. A push
// from a script file, a task runner or an obfuscated spelling is not detected and is not logged;
// the closeout audit then reports the move UNGRANTED (fails closed).

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename as pathBasename, dirname, join, resolve } from "node:path";
import { basename, isInterpreterHead, parseCommand, resolveGitArguments, stripWrappers, textRunsPush } from "./rules.ts";

export const PUSH_LOG = "push-log.jsonl";
const GIT_TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;

/** The branches one push updates: named refs, or every branch (`--all`, `--branches`). */
type PushRefs = string[] | "all";

interface PushTarget {
  cwd: string;
  remote?: string;
  refspecs: string[];
  all: boolean;
  /** False when a later step of the same command can bring other commits into the local source. */
  afterSafe: boolean;
}

interface MergeTarget {
  cwd: string;
  selector?: string;
  repo?: string;
}

export interface PlannedGitPush {
  kind: "push";
  repo: string;
  cwd: string;
  remote: string;
  refs: PushRefs;
  before: Map<string, string>;
  /** The source each destination ref is pushed from (a ref name or revision; for "all", the ref). */
  sources: Map<string, string>;
  /** Each destination ref's source commit, resolved before the command ran. */
  localBefore: Map<string, string>;
  afterSafe: boolean;
}

export interface PlannedPrMerge {
  kind: "merge";
  repo: string;
  cwd: string;
  remote: string;
  /** `--repo` as given to `gh`, passed on to `gh pr view`. */
  ghRepo?: string;
  number: number;
  baseRef: string;
  old: string | null;
}

export type PlannedPush = PlannedGitPush | PlannedPrMerge;

export interface PushLogMeta {
  runDir: string;
  actor: "root" | "lane";
  agent: string | null;
  lane: string | null;
}

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
/** git subcommands that can move a local branch to commits fetched from elsewhere. */
const INTEGRATING_GIT = new Set(["pull", "fetch", "merge", "rebase", "reset", "update-ref", "checkout", "switch", "cherry-pick", "am", "remote"]);
/** `gh pr merge` options that take a value. */
const GH_MERGE_VALUE_OPTIONS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"]);

function expandHome(word: string): string {
  if (word === "~") return homedir();
  if (word.startsWith("~/")) return join(homedir(), word.slice(2));
  return word;
}

/** The repository directory a `git` invocation runs in: `cwd` moved by each `-C <dir>`. */
function gitCwd(tokens: string[], cwd: string): string {
  let dir = cwd;
  for (let i = 1; i < tokens.length && tokens[i].startsWith("-"); i++) {
    if (tokens[i] === "-C" && tokens[i + 1] !== undefined) dir = resolve(dir, expandHome(tokens[++i]));
    else if (["-c", "--git-dir", "--work-tree", "--namespace"].includes(tokens[i])) i++;
  }
  return dir;
}

function parsePush(args: string[], cwd: string): PushTarget | undefined {
  const target: PushTarget = { cwd, refspecs: [], all: false, afterSafe: true };
  const positional: string[] = [];
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      positional.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (t === "--all" || t === "--branches") target.all = true;
    else if (t === "--dry-run" || (/^-[a-zA-Z]+$/.test(t) && t.includes("n"))) dryRun = true;
    if (name === "--repo") target.remote = eq >= 0 ? t.slice(eq + 1) : args[i + 1];
    if (PUSH_VALUE_OPTIONS.has(name) && eq < 0) i++;
  }
  if (dryRun) return undefined;
  if (target.remote === undefined) target.remote = positional.shift();
  else if (positional.length) target.remote = positional.shift();
  target.refspecs = positional;
  return target;
}

/** `gh [-R repo] pr merge [<number|url|branch>] [flags]`, or undefined for any other gh command. */
function parsePrMerge(args: string[], cwd: string): MergeTarget | undefined {
  const words: string[] = [];
  let repo: string | undefined;
  let valueNext = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-R" || t === "--repo") {
      repo = args[++i];
      continue;
    }
    if (t.startsWith("--repo=")) {
      repo = t.slice("--repo=".length);
      continue;
    }
    if (t.startsWith("-R") && t.length > 2) {
      repo = t.slice(2);
      continue;
    }
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (words.length >= 2 && GH_MERGE_VALUE_OPTIONS.has(t)) {
      valueNext = true;
      continue;
    }
    words.push(t);
  }
  if (words[0] !== "pr" || words[1] !== "merge") return undefined;
  const selector = words.slice(2).find((w) => !w.startsWith("-"));
  return { cwd, selector, repo };
}

/** Every `git push` and `gh pr merge` in a command, with the directory it runs in. A `cd <dir>`
 *  earlier in the same command moves later ones. Dry runs are skipped. */
function commandTargets(command: string, cwd: string): { pushes: PushTarget[]; merges: MergeTarget[] } {
  const parsed = parseCommand(command, "root");
  const pushes: PushTarget[] = [];
  const merges: MergeTarget[] = [];
  if (!parsed) return { pushes, merges };
  let dir = cwd;
  const integrates = () => {
    for (const t of pushes) t.afterSafe = false;
  };
  for (const segment of parsed.segments) {
    const stripped = stripWrappers(segment);
    if (stripped.length === 0) continue;
    const head = basename(stripped[0]);
    if (head === "cd") {
      const arg = stripped[1];
      if (arg === undefined) dir = homedir();
      else if (!arg.startsWith("-")) dir = resolve(dir, expandHome(arg));
      continue;
    }
    if (head === "gh") {
      const merge = parsePrMerge(stripped.slice(1), dir);
      if (merge) {
        // A merge's local pull (`--delete-branch`) can move the local base branch.
        integrates();
        merges.push(merge);
      } else if (stripped[1] === "pr" && stripped[2] === "checkout") integrates();
      else if (stripped[1] === "repo" && stripped[2] === "sync") integrates();
      continue;
    }
    if (head !== "git") continue;
    const resolved = resolveGitArguments(stripped);
    if (resolved.shellCommand !== undefined || resolved.unparseable) continue;
    if (INTEGRATING_GIT.has(resolved.args[0])) integrates();
    if (resolved.args[0] !== "push") continue;
    const target = parsePush(resolved.args.slice(1), gitCwd(stripped, dir));
    if (target) pushes.push(target);
  }
  return { pushes, merges };
}

/** True when `command` runs a `git push` or `gh pr merge` that `commandTargets` cannot attribute:
 *  spelled inside an interpreter's inline code or stdin script, inside a git alias's shell body, or
 *  anywhere in a command the parser cannot read. Read with the same parse as `commandTargets`. */
export function hiddenPush(command: string): boolean {
  const parsed = parseCommand(command, "root");
  if (!parsed) return textRunsPush(command);
  for (const segment of parsed.segments) {
    const stripped = stripWrappers(segment);
    if (stripped.length === 0) continue;
    const head = basename(stripped[0]);
    if (head === "git") {
      const resolved = resolveGitArguments(stripped);
      if (resolved.shellCommand !== undefined && textRunsPush(resolved.shellCommand)) return true;
      if (resolved.unparseable && textRunsPush(resolved.aliasText ?? stripped.join(" "))) return true;
    }
    if (isInterpreterHead(head) && stripped.slice(1).some((arg) => textRunsPush(arg))) return true;
  }
  return parsed.interpreterScripts.some((script) => textRunsPush(script));
}

/** The lane guard's refusal for a push the push log would not record, or undefined. Under protocol
 *  2 the closeout audit grants a default-branch move only through the log, so such a push would land
 *  UNGRANTED. `bash` logs literal pushes, so only hidden ones are refused there; `watch_process`
 *  logs none, so every push through it is refused. */
export function unloggedPushRefusal(command: string, tool: "bash" | "watch_process"): string | undefined {
  if (tool === "watch_process") {
    const { pushes, merges } = commandTargets(command, process.cwd());
    if (pushes.length || merges.length || hiddenPush(command)) {
      return (
        "loop-guard: a git push or gh pr merge through watch_process is not recorded in the push log, so the " +
        "closeout audit would mark the move UNGRANTED. Run it as its own bash command instead."
      );
    }
    return undefined;
  }
  if (!/\b(?:push|merge)\b/.test(command) || !hiddenPush(command)) return undefined;
  return (
    "loop-guard: this command runs git push (or gh pr merge) inside a script, interpreter or alias, where the " +
    "push log cannot see it, so the closeout audit would mark the move UNGRANTED. Do any other work first, then " +
    "run the push as its own literal bash command, for example `git push origin main`. If the text only " +
    "mentions git push as data, make the edit with the edit or write tool instead."
  );
}

/** Every `git push` in a command, with the directory it runs in. */
export function pushTargets(command: string, cwd: string): PushTarget[] {
  return commandTargets(command, cwd).pushes;
}

function run(file: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv };
      execFile(file, args, { cwd, env, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        done(err ? undefined : String(stdout).trim()),
      );
    } catch {
      done(undefined);
    }
  });
}

const git = (cwd: string, args: string[]) => run("git", cwd, args);
const gh = (cwd: string, args: string[]) => run("gh", cwd, args, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });

/** The main checkout of the repository at `cwd` (the parent of the common git dir, so a linked
 *  worktree resolves to its main checkout), else the worktree's own toplevel. */
async function mainCheckout(cwd: string): Promise<string | undefined> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common && pathBasename(common) === ".git") return dirname(common);
  return (await git(cwd, ["rev-parse", "--show-toplevel"])) || undefined;
}

/** The commit `rev` names in the repository at `cwd`, or undefined. */
async function commitOf(cwd: string, rev: string): Promise<string | undefined> {
  const sha = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return sha && SHA.test(sha) ? sha : undefined;
}

/** The remote branch a refspec updates, or undefined (tags, notes, deletions, unknown HEAD). */
function destinationRef(spec: string, current: string | undefined): string | undefined {
  const s = spec.replace(/^\+/, "");
  const colon = s.indexOf(":");
  const src = colon >= 0 ? s.slice(0, colon) : s;
  let dst = colon >= 0 ? s.slice(colon + 1) : "";
  if (colon >= 0 && src === "") return undefined;
  if (dst === "") {
    if (src === "HEAD" || src === "@") return current ? `refs/heads/${current}` : undefined;
    dst = src;
  }
  if (dst === "HEAD" || dst === "@") return current ? `refs/heads/${current}` : undefined;
  if (dst.startsWith("refs/heads/")) return dst;
  if (dst.startsWith("refs/")) return undefined;
  return `refs/heads/${dst}`;
}

/** The local source a refspec pushes (`HEAD` for `@`). */
function sourceOf(spec: string): string {
  const s = spec.replace(/^\+/, "");
  const colon = s.indexOf(":");
  const src = colon >= 0 ? s.slice(0, colon) : s;
  return src === "@" ? "HEAD" : src;
}

/** The remote's branches: the named refs, or every branch for "all". Undefined when unreadable. */
async function lsRemote(cwd: string, remote: string, refs: PushRefs): Promise<Map<string, string> | undefined> {
  const named = refs === "all" ? undefined : new Set(refs);
  if (named && named.size === 0) return new Map();
  const out = await git(cwd, ["ls-remote", refs === "all" ? "--heads" : "--refs", remote, ...(named ? [...named] : [])]);
  if (out === undefined) return undefined;
  const values = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !SHA.test(sha)) continue;
    if (named ? named.has(ref) : ref.startsWith("refs/heads/")) values.set(ref, sha);
  }
  return values;
}

/** The remote a branch pushes to by default: pushRemote, pushDefault, its upstream remote, origin. */
async function defaultRemote(cwd: string, current: string | undefined): Promise<string> {
  if (current) {
    for (const key of [`branch.${current}.pushRemote`, "remote.pushDefault", `branch.${current}.remote`]) {
      const remote = await git(cwd, ["config", "--get", key]);
      if (remote) return remote;
    }
  }
  return "origin";
}

async function planPush(target: PushTarget): Promise<PlannedGitPush | undefined> {
  const repo = await mainCheckout(target.cwd);
  if (!repo) return undefined;
  const current = await git(target.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = target.remote ?? (await defaultRemote(target.cwd, current || undefined));
  let refs: PushRefs;
  const sources = new Map<string, string>();
  const localBefore = new Map<string, string>();
  if (target.all) {
    refs = "all";
    const out = await git(target.cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]);
    for (const line of (out ?? "").split("\n")) {
      const [sha, ref] = line.split(" ");
      if (sha && ref && SHA.test(sha)) localBefore.set(ref, sha);
    }
  } else if (target.refspecs.length === 0) {
    if (!current) return undefined;
    const pushRef = await git(target.cwd, ["rev-parse", "--symbolic-full-name", "@{push}"]);
    const prefix = `refs/remotes/${remote}/`;
    const ref = pushRef?.startsWith(prefix) ? `refs/heads/${pushRef.slice(prefix.length)}` : `refs/heads/${current}`;
    refs = [ref];
    sources.set(ref, `refs/heads/${current}`);
  } else {
    for (const spec of target.refspecs) {
      const ref = destinationRef(spec, current || undefined);
      if (ref !== undefined) sources.set(ref, sourceOf(spec));
    }
    refs = [...sources.keys()];
    if (refs.length === 0) return undefined;
  }
  for (const [ref, source] of sources) {
    const sha = await commitOf(target.cwd, source);
    if (sha) localBefore.set(ref, sha);
  }
  const before = await lsRemote(target.cwd, remote, refs);
  if (!before) return undefined;
  return { kind: "push", repo, cwd: target.cwd, remote, refs, before, sources, localBefore, afterSafe: target.afterSafe };
}

/** `owner/repo` from a pull request URL or a `--repo` value (`[host/]owner/repo`). */
function ownerRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let path = value;
  try {
    path = new URL(value).pathname;
  } catch {
    // Not a URL: `[host/]owner/repo`.
  }
  const parts = path.split("/").filter(Boolean);
  const pull = parts.indexOf("pull");
  const pair = pull >= 2 ? parts.slice(pull - 2, pull) : parts.slice(-2);
  return pair.length === 2 ? pair.join("/").replace(/\.git$/, "").toLowerCase() : undefined;
}

/** The git remote whose URL names `owner/repo`; without `--repo`, the default remote otherwise. */
async function remoteFor(cwd: string, slug: string | undefined, explicitRepo: boolean): Promise<string | undefined> {
  if (slug) {
    const out = (await git(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"])) ?? "";
    for (const line of out.split("\n")) {
      const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
      if (!m) continue;
      const url = m[2].replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
      if (url.endsWith(`/${slug}`) || url.endsWith(`:${slug}`)) return m[1];
    }
  }
  if (explicitRepo) return undefined;
  const current = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return defaultRemote(cwd, current || undefined);
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const ghRepoArgs = (repo: string | undefined) => (repo ? ["--repo", repo] : []);

async function planMerge(target: MergeTarget): Promise<PlannedPrMerge | undefined> {
  const repo = await mainCheckout(target.cwd);
  if (!repo) return undefined;
  const view = parseJson(
    await gh(target.cwd, ["pr", "view", ...(target.selector ? [target.selector] : []), ...ghRepoArgs(target.repo), "--json", "number,baseRefName,url"]),
  );
  const number = view?.number;
  const base = view?.baseRefName;
  if (typeof number !== "number" || typeof base !== "string" || !base) return undefined;
  const remote = await remoteFor(target.cwd, ownerRepo(target.repo) ?? ownerRepo(typeof view?.url === "string" ? view.url : undefined), target.repo !== undefined);
  if (!remote) return undefined;
  const baseRef = `refs/heads/${base}`;
  const before = await lsRemote(target.cwd, remote, [baseRef]);
  if (!before) return undefined;
  return { kind: "merge", repo, cwd: target.cwd, remote, ghRepo: target.repo, number, baseRef, old: before.get(baseRef) ?? null };
}

/** Read the remote branches every push and PR merge in `command` will update. Run before the
 *  command executes. */
export async function planPushes(command: string, cwd: string): Promise<PlannedPush[]> {
  if (!/\b(?:push|merge)\b/.test(command)) return [];
  const { pushes, merges } = commandTargets(command, cwd);
  const planned: PlannedPush[] = [];
  for (const target of pushes) {
    const one = await planPush(target);
    if (one) planned.push(one);
  }
  for (const target of merges) {
    const one = await planMerge(target);
    if (one) planned.push(one);
  }
  return planned;
}

const isoSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

interface Moved {
  ref: string;
  old: string | null;
  new: string;
}

async function pushMoves(plan: PlannedGitPush): Promise<Moved[]> {
  const after = await lsRemote(plan.cwd, plan.remote, plan.refs);
  if (!after) return [];
  const moves: Moved[] = [];
  const refs = plan.refs === "all" ? [...after.keys()] : plan.refs;
  for (const ref of refs) {
    const next = after.get(ref);
    if (!next) continue;
    const old = plan.before.get(ref) ?? null;
    if (old === next) continue;
    // Only the commit this push sent: never a value another writer pushed since.
    const sent = new Set<string>();
    const before = plan.localBefore.get(ref);
    if (before) sent.add(before);
    if (plan.afterSafe) {
      const now = await commitOf(plan.cwd, plan.sources.get(ref) ?? ref);
      if (now) sent.add(now);
    }
    if (sent.has(next)) moves.push({ ref, old, new: next });
  }
  return moves;
}

async function mergeMoves(plan: PlannedPrMerge): Promise<Moved[]> {
  const view = parseJson(await gh(plan.cwd, ["pr", "view", String(plan.number), ...ghRepoArgs(plan.ghRepo), "--json", "mergeCommit,baseRefName,state"]));
  if (view?.state !== "MERGED" || `refs/heads/${String(view.baseRefName)}` !== plan.baseRef) return [];
  const oid = (view.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
  if (typeof oid !== "string" || !SHA.test(oid) || oid === plan.old) return [];
  const after = await lsRemote(plan.cwd, plan.remote, [plan.baseRef]);
  if (after?.get(plan.baseRef) !== oid) return [];
  return [{ ref: plan.baseRef, old: plan.old, new: oid }];
}

/** After a successful command: append a line for every planned branch this command moved. */
export async function recordPushes(plans: PlannedPush[], meta: PushLogMeta): Promise<number> {
  const lines: string[] = [];
  for (const plan of plans) {
    const moves = plan.kind === "merge" ? await mergeMoves(plan) : await pushMoves(plan);
    for (const move of moves) {
      lines.push(
        JSON.stringify({
          v: 1,
          ts: isoSeconds(),
          actor: meta.actor,
          agent: meta.agent,
          lane: meta.lane,
          repo: plan.repo,
          remote: plan.remote,
          ref: move.ref,
          old: move.old,
          new: move.new,
        }),
      );
    }
  }
  if (lines.length) appendFileSync(join(meta.runDir, PUSH_LOG), `${lines.join("\n")}\n`);
  return lines.length;
}

/** The lane id from a brief's `Lane: <id>` header, or null. pi-subagents hands a child its task
 *  as `Task: <brief>`, so the header may follow that prefix. */
export function laneIdFromBrief(text: string): string | null {
  const m = /^[ \t]*(?:Task:[ \t]*)?Lane:[ \t]*([^\s·]+)/m.exec(text);
  return m ? m[1] : null;
}
