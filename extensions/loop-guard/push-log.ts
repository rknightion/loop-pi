// Push log writer (SEAMS S1): one line per remote branch a successful `git push` updated, appended
// to `<run dir>/push-log.jsonl` by the root (at `tool_execution_end`) and by every lane (the lane
// guard's post-exec hook). Land evidence for the audit comes from here, not from root-written events.
//
// Before the push runs (the guard's `tool_call`), `planPushes` reads each named remote branch with
// `git ls-remote`; after a successful run, `recordPushes` reads them again and writes a line for every
// branch whose value changed: `old` (null when the branch did not exist) and `new`. A failed command,
// a remote that cannot be read, or a branch that did not move writes nothing. Best effort: commands
// the parser cannot read and pushes inside other tools are not logged.

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { basename, parseCommand, resolveGitArguments, stripWrappers } from "./rules.ts";

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
}

export interface PlannedPush {
  repo: string;
  cwd: string;
  remote: string;
  refs: PushRefs;
  before: Map<string, string>;
}

export interface PushLogMeta {
  runDir: string;
  actor: "root" | "lane";
  agent: string | null;
  lane: string | null;
}

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

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

/** Every `git push` in a command, with the directory it runs in. A `cd <dir>` earlier in the same
 *  command moves later pushes. Dry runs are skipped. */
export function pushTargets(command: string, cwd: string): PushTarget[] {
  const parsed = parseCommand(command, "root");
  if (!parsed) return [];
  const targets: PushTarget[] = [];
  let dir = cwd;
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
    if (head !== "git") continue;
    const resolved = resolveGitArguments(stripped);
    if (resolved.shellCommand !== undefined || resolved.unparseable || resolved.args[0] !== "push") continue;
    const target: PushTarget = { cwd: gitCwd(stripped, dir), refspecs: [], all: false };
    const positional: string[] = [];
    let dryRun = false;
    const args = resolved.args.slice(1);
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
    if (dryRun) continue;
    if (target.remote === undefined) target.remote = positional.shift();
    else if (positional.length) target.remote = positional.shift();
    target.refspecs = positional;
    targets.push(target);
  }
  return targets;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      execFile("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        done(err ? undefined : String(stdout).trim()),
      );
    } catch {
      done(undefined);
    }
  });
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

async function planOne(target: PushTarget): Promise<PlannedPush | undefined> {
  const repo = await git(target.cwd, ["rev-parse", "--show-toplevel"]);
  if (!repo) return undefined;
  const current = await git(target.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let remote = target.remote;
  if (remote === undefined && current) {
    for (const key of [`branch.${current}.pushRemote`, "remote.pushDefault", `branch.${current}.remote`]) {
      remote = await git(target.cwd, ["config", "--get", key]);
      if (remote) break;
    }
  }
  remote = remote || "origin";
  let refs: PushRefs;
  if (target.all) refs = "all";
  else if (target.refspecs.length === 0) {
    if (!current) return undefined;
    const pushRef = await git(target.cwd, ["rev-parse", "--symbolic-full-name", "@{push}"]);
    const prefix = `refs/remotes/${remote}/`;
    refs = [pushRef?.startsWith(prefix) ? `refs/heads/${pushRef.slice(prefix.length)}` : `refs/heads/${current}`];
  } else {
    refs = [...new Set(target.refspecs.map((spec) => destinationRef(spec, current)).filter((r): r is string => r !== undefined))];
    if (refs.length === 0) return undefined;
  }
  const before = await lsRemote(target.cwd, remote, refs);
  if (!before) return undefined;
  return { repo, cwd: target.cwd, remote, refs, before };
}

/** Read the remote branches every push in `command` will update. Run before the command executes. */
export async function planPushes(command: string, cwd: string): Promise<PlannedPush[]> {
  if (!/\bpush\b/.test(command)) return [];
  const planned: PlannedPush[] = [];
  for (const target of pushTargets(command, cwd)) {
    const one = await planOne(target);
    if (one) planned.push(one);
  }
  return planned;
}

const isoSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** After a successful command: append a line for every planned branch whose remote value moved. */
export async function recordPushes(plans: PlannedPush[], meta: PushLogMeta): Promise<number> {
  const lines: string[] = [];
  for (const plan of plans) {
    const after = await lsRemote(plan.cwd, plan.remote, plan.refs);
    if (!after) continue;
    const refs = plan.refs === "all" ? [...after.keys()] : plan.refs;
    for (const ref of refs) {
      const next = after.get(ref);
      if (!next) continue;
      const old = plan.before.get(ref) ?? null;
      if (old === next) continue;
      lines.push(
        JSON.stringify({
          v: 1,
          ts: isoSeconds(),
          actor: meta.actor,
          agent: meta.agent,
          lane: meta.lane,
          repo: plan.repo,
          remote: plan.remote,
          ref,
          old,
          new: next,
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
