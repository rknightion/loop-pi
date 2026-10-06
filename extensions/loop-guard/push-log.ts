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
// push or a remote that cannot be read writes nothing. Root git pushes additionally require the
// specific invocation's successful porcelain update, with exact old/new SHAs; a later shell
// failure does not discard it. A skipped/rejected/up-to-date root push cannot absorb a foreign
// same-source publication. Unconfirmed root git forms fail closed; lanes retain their successful
// enclosing-call check.
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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename as pathBasename, dirname, join, resolve } from "node:path";
import { basename, isInterpreterHead, parseCommand, resolveGitArguments, stripWrappers, textRunsPush } from "./rules.ts";

export const PUSH_LOG = "push-log.jsonl";
const GIT_TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;

/** The branches one push updates: named refs, or every branch (`--all`, `--branches`). */
type PushRefs = string[] | "all";

interface PushInvocation {
  cwd: string;
  args: string[];
  porcelainArgs: string[];
  /** Only supported -C options, reused for execution-time context reads. */
  contextArgs: string[];
}

interface PushContext {
  endpoint: string;
  commonDir: string;
  config: string;
  environment: string;
}

interface PushTarget {
  invocation?: PushInvocation;
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
  /** Exact single fetch/push endpoint, repository and effective config, held privately. */
  context?: PushContext;
  refs: PushRefs;
  before: Map<string, string>;
  /** The source each destination ref is pushed from (a ref name or revision; for "all", the ref). */
  sources: Map<string, string>;
  /** Each destination ref's source commit, resolved before the command ran. */
  localBefore: Map<string, string>;
  afterSafe: boolean;
  /** A literal git invocation we can observe without reconstructing shell control flow. */
  invocation?: PushInvocation;
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
    if (target) {
      // Only intercept the literal executable and subcommand. Aliases, absolute executables and
      // wrappers that bypass shell functions remain unconfirmed on errored calls (fail closed).
      let subcommand = 1;
      let safeContext = true;
      while (stripped[subcommand]?.startsWith("-")) {
        const option = stripped[subcommand++];
        // -C is resolved by the planner. Other invocation overrides can change the repository,
        // endpoint or configuration independently of that plan, so root attribution fails closed.
        if (option !== "-C") safeContext = false;
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option)) subcommand++;
      }
      if (safeContext && stripped[0] === "git" && stripped[subcommand] === "push") {
        try {
          target.invocation = {
            cwd: realpathSync(dir), args: stripped.slice(1), contextArgs: stripped.slice(1, subcommand),
            porcelainArgs: ["-c", "core.abbrev=40", ...stripped.slice(1, subcommand + 1), "--porcelain", ...stripped.slice(subcommand + 1)],
          };
        } catch {
          // A directory unavailable at planning time cannot supply execution evidence.
        }
      }
      pushes.push(target);
    }
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
    // These executors run command/code arguments, not an attributable shell segment. Do not
    // unwrap them into push targets: find/parallel may execute more than once or in another cwd.
    if (head === "git") {
      const args = resolveGitArguments(stripped).args;
      if (args[0] === "rebase" && args.some((arg, i) =>
        ((arg === "-x" || arg === "--exec") && textRunsPush(args[i + 1] ?? "")) ||
        (arg.startsWith("--exec=") && textRunsPush(arg.slice(7))) ||
        (arg.startsWith("-x") && arg.length > 2 && textRunsPush(arg.slice(2))),
      )) return true;
    }
    const executor =
      (head === "find" && stripped.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) ||
      (head === "uv" && stripped.includes("run")) ||
      ["deno", "awk", "gawk", "mawk", "watch", "parallel"].includes(head);
    if (executor && textRunsPush(stripped.slice(1).join(" "))) return true;
    // Deno's native process API separates the executable from its argv with an options
    // object, unlike subprocess.run(['git', 'push']). Recognise literal Command/args pairs.
    if (head === "deno") {
      const code = stripped.slice(1).join(" ");
      const native = /\bDeno\.Command\s*\(\s*(['"])([^'"]+)\1\s*,\s*\{[^}]*?\bargs\s*:\s*\[([^\]]*)\]/g;
      for (const match of code.matchAll(native)) {
        if (textRunsPush(`${match[2]} ${match[3]}`)) return true;
      }
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
  if (!hiddenPush(command)) return undefined;
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

function run(file: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}, raw = false): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv };
      execFile(file, args, { cwd, env, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        done(err ? undefined : raw ? String(stdout) : String(stdout).trim()),
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

// These inherited variables can change Git's repository/config/SSH transport independently of
// its argv. Capture them exactly and privately, never in a receipt or forwarded tool output.
const ENVIRONMENT_CAPTURE = 'JSON.stringify(Object.entries(process.env).filter(([key]) => /^(GIT_|SSH_)/.test(key) || ["HOME", "XDG_CONFIG_HOME"].includes(key)).sort(([a], [b]) => a.localeCompare(b)))';
const gitEnvironment = () => JSON.stringify(Object.entries(process.env).filter(([key]) =>
  /^(GIT_|SSH_)/.test(key) || ["HOME", "XDG_CONFIG_HOME"].includes(key),
).sort(([a], [b]) => a.localeCompare(b)));

/** Multiple endpoints (even identical ones) or an unnamed transport cannot supply authority. */
function singleEndpoint(value: string | undefined): string | undefined {
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

async function pushContext(cwd: string, remote: string): Promise<PushContext | undefined> {
  const [fetch, push, commonDir, config] = await Promise.all([
    run("git", cwd, ["remote", "get-url", "--all", remote], {}, true),
    run("git", cwd, ["remote", "get-url", "--push", "--all", remote], {}, true),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(cwd, ["config", "--null", "--list"]),
  ]);
  const endpoint = singleEndpoint(fetch?.replace(/\n$/, ""));
  if (!endpoint || singleEndpoint(push?.replace(/\n$/, "")) !== endpoint || !commonDir || config === undefined) return undefined;
  return { endpoint, commonDir, config, environment: gitEnvironment() };
}

/** When an audit baseline exists, use its endpoint, not a temporarily reconfigured remote.
 * Linked-worktree snapshot keys resolve to the same main checkout. Missing/conflicting identity
 * in that baseline fails closed; no snapshot or receipt is rewritten. */
async function matchesAuditEndpoint(runDir: string | undefined, repo: string, remote: string, endpoint: string): Promise<boolean> {
  if (!runDir) return true;
  const path = join(runDir, "audit-before.json");
  if (!existsSync(path)) return true;
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    if (!snapshot?.repos || typeof snapshot.repos !== "object" || Array.isArray(snapshot.repos)) return false;
    let found = false;
    for (const [key, value] of Object.entries(snapshot.repos)) {
      if (await mainCheckout(key) !== repo) continue;
      const entry = (value as { remotes?: Record<string, { available?: unknown; url?: unknown }> })?.remotes?.[remote];
      if (entry?.available !== true || typeof entry.url !== "string" || singleEndpoint(entry.url) !== endpoint) return false;
      found = true;
    }
    return found;
  } catch {
    return false;
  }
}

async function planPush(target: PushTarget, runDir?: string): Promise<PlannedGitPush | undefined> {
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
  let context = target.invocation ? await pushContext(target.cwd, remote) : undefined;
  if (context && !await matchesAuditEndpoint(runDir, repo, remote, context.endpoint)) context = undefined;
  return { kind: "push", repo, cwd: target.cwd, remote, context, refs, before, sources, localBefore, afterSafe: target.afterSafe, invocation: target.invocation };
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
export async function planPushes(command: string, cwd: string, runDir?: string): Promise<PlannedPush[]> {
  const { pushes, merges } = commandTargets(command, cwd);
  const planned: PlannedPush[] = [];
  for (const target of pushes) {
    const one = await planPush(target, runDir);
    if (one) planned.push(one);
  }
  for (const target of merges) {
    const one = await planMerge(target);
    if (one) planned.push(one);
  }
  return planned;
}

/** Root-private execution evidence, not shell output supplied by the model or a remote read.
 *  The wrapper saves git's porcelain stdout only after that exact invocation exits successfully.
 *  Its per-call directory is removed at completion or session shutdown. This is the existing
 *  honest-mistake fence, not an OS boundary against adversarial same-account file writes. */
export interface PushExecutionEvidence {
  command: string;
  outputs: Map<PlannedGitPush, string>;
  dispose(): void;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function capturePushExecutions(command: string, plans: PlannedPush[]): PushExecutionEvidence {
  const dir = mkdtempSync(join(tmpdir(), "loop-push-execution-"));
  const outputs = new Map<PlannedGitPush, string>();
  const invocations = new Map<string, string>();
  const branches: string[] = [];
  for (const plan of plans) {
    if (plan.kind !== "push" || !plan.invocation || !plan.context) continue;
    const { cwd, args, porcelainArgs, contextArgs } = plan.invocation;
    const key = JSON.stringify([cwd, args, plan.context]);
    let output = invocations.get(key);
    if (!output) {
      output = join(dir, `push-${invocations.size}`);
      invocations.set(key, output);
      const matches = [`[ "$#" -eq ${args.length} ]`, `[ "$(pwd -P)" = ${shellQuote(cwd)} ]`,
        ...args.map((arg, i) => `[ "\${${i + 1}}" = ${shellQuote(arg)} ]`)];
      const pending = shellQuote(`${output}.pending`);
      // Query through the same physical cwd, -C options and inherited environment as the actual
      // invocation, on both sides of it. Keep full endpoint usernames/config privately: Git's
      // anonymized display is never the authority. A failed context read cannot promote evidence.
      const queries = [
        ["remote", "get-url", "--all", plan.remote],
        ["remote", "get-url", "--push", "--all", plan.remote],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ["config", "--null", "--list"],
      ];
      const captureContext = (side: string) => [
        ...queries.slice(0, side === "before" ? 4 : 3).map((query, i) =>
          `command git ${[...contextArgs, ...query].map(shellQuote).join(" ")} > ${shellQuote(`${output}.${side}-${i}`)}`,
        ),
        `command ${shellQuote(process.execPath)} -e ${shellQuote(`process.stdout.write(${ENVIRONMENT_CAPTURE})`)} > ${shellQuote(`${output}.${side}-env`)}`,
      ].join(" && ");
      branches.push([
        `if ${matches.join(" && ")}; then`,
        "  local status context_ok=0",
        `  if ${captureContext("before")}; then context_ok=1; fi`,
        `  if command git ${porcelainArgs.map(shellQuote).join(" ")} > ${pending}; then status=0; else status=$?; fi`,
        `  command cat ${pending} || :`,
        // Up-to-date output is saved too, but cannot confirm a moved ref. Failed push output is
        // never promoted, even if another writer publishes the very same local source later.
        `  if [ "$status" -eq 0 ] && [ "$context_ok" -eq 1 ] && ${captureContext("after")}; then command mv ${pending} ${shellQuote(output)} || :; fi`,
        "  return \"$status\"",
        "fi",
      ].join("\n"));
    }
    outputs.set(plan, output);
  }
  return {
    command: branches.length ? `git() {\n${branches.join("\n")}\ncommand git "$@"\n}\n${command}` : command,
    outputs,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The successful invocation must report THIS ref's exact old/new update, not merely exit 0.
 *  In particular an up-to-date push after a foreign same-source publication proves no move.
 *  core.abbrev=40 above makes porcelain's update range full length; no prefix equality grants. */
function executionConfirms(plan: PlannedGitPush, move: Moved, evidence: PushExecutionEvidence): boolean {
  const path = evidence.outputs.get(plan);
  if (!path) return false;
  let output: string;
  try {
    output = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (!plan.context) return false;
  const { endpoint, commonDir, config, environment } = plan.context;
  try {
    for (const side of ["before", "after"]) {
      // --set-upstream legitimately writes branch config during a push; the exact pre-execution
      // config binds selection, while both sides must retain the endpoint/repository/environment.
      const expected = side === "before" ? [endpoint, endpoint, commonDir, config] : [endpoint, endpoint, commonDir];
      if (expected.some((value, i) => readFileSync(`${path}.${side}-${i}`, "utf8").replace(/\n$/, "") !== value)) return false;
      if (readFileSync(`${path}.${side}-env`, "utf8") !== environment) return false;
    }
  } catch {
    return false;
  }
  const lines = output.split("\n");
  const endpoints = lines.filter((line) => line.startsWith("To "));
  // Git removes SSH userinfo from porcelain's display. Only compare that presentation AFTER
  // full exact private endpoint/config equality above, so another SSH user cannot inherit it.
  const display = endpoint.replace(/^(ssh:\/\/)[^/@]+@/, "$1").replace(/^[^/@:]+@([^/:]+:)/, "$1");
  if (endpoints.length !== 1 || endpoints[0] !== `To ${display}`) return false;
  return lines.some((line) => {
    const [flag, refspec, summary] = line.split("\t");
    if (!refspec || refspec.slice(refspec.indexOf(":") + 1) !== move.ref) return false;
    if (move.old === null) return flag === "*" && summary === "[new branch]";
    if (flag !== " " && flag !== "+") return false;
    const range = /^([0-9a-f]{40})\.{2,3}([0-9a-f]{40})(?: |$)/.exec(summary ?? "");
    return range?.[1] === move.old && range?.[2] === move.new;
  });
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
    // Restrict to the planned source. Root execution evidence also distinguishes another
    // writer publishing this SAME source from a publication by the planned invocation.
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

/** Append verified remote moves. Root git plans require captured successful execution; the
 *  root excludes PR merge plans on failed calls. Lanes call only after an enclosing success. */
export async function recordPushes(plans: PlannedPush[], meta: PushLogMeta, evidence?: PushExecutionEvidence): Promise<number> {
  const lines: string[] = [];
  for (const plan of plans) {
    const moves = plan.kind === "merge" ? await mergeMoves(plan) : await pushMoves(plan);
    for (const move of moves) {
      if (evidence && plan.kind === "push" && !executionConfirms(plan, move, evidence)) continue;
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
