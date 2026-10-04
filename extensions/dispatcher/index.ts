// loop-pi dispatcher (SEAMS.md S7): a pi session that runs a loop without an LLM root.
//
// Started in print mode with the S1 launch message (or a launch file path) as the prompt. The
// `input` handler runs the whole loop and returns `handled`, so the prompt never reaches a model and
// the process lives exactly as long as the loop. pi-subagents still asks for a turn on each
// completion (triggerTurn); the session's model is this extension's in-process `loop-dispatch/idle`
// provider, which answers with an empty stop and never makes a network request.
//
// Lanes go through pi-subagents' RPC `spawn` after loop-guard's subagent rule and identity binding.
// The lane guards are registered as required child extensions, fail closed. Every S2 event,
// including dispatch and return, is written here with `by: dispatcher`; the loop-state extension is
// not loaded in a dispatcher session.
// Before `loopPi.onClose` it commits the backlog Done edits with `git commit -- backlog`, unpushed.

import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { composedGate as findComposedGate, dispatcherEligible, effectiveTier, guardedExtra, parseGoal, parseLoopMd, type TaskSpec } from "./goal.ts";
import { guardSpawn } from "./guard.ts";
import { parseLaunch } from "./launch.ts";
import { Dispatcher, type CloseReason, type Ports } from "./scheduler.ts";

export const IDLE_PROVIDER = "loop-dispatch";
export const IDLE_MODEL = "idle";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const MINUTE = 60_000;

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { cwd: string; input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<Exec> {
  return new Promise((done) => {
    try {
      const child = execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: opts.env }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        done({ code, stdout: String(stdout), stderr: error && code === -1 ? `${error.message}\n${stderr}` : String(stderr) });
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    } catch (error) {
      done({ code: -1, stdout: "", stderr: String(error) });
    }
  });
}

/** `loopPi.onClose` from the home settings: argv arrays with `{log}` and `{report}` placeholders. */
export function onCloseCommands(settings: unknown, log: string, report: string): string[][] {
  const list = (settings as { loopPi?: { onClose?: unknown } })?.loopPi?.onClose;
  if (!Array.isArray(list)) return [];
  return list
    .filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string"))
    .map((argv) => argv.map((a) => a.replaceAll("{log}", log).replaceAll("{report}", report)));
}

/** The final message of a finished run, from the async-complete payload. */
export function completionText(data: any): string {
  const first = Array.isArray(data?.results) ? data.results[0] : undefined;
  if (typeof first?.output === "string" && first.output) return first.output;
  const path = first?.artifactPaths?.outputPath;
  if (typeof path === "string" && existsSync(path)) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // fall through to the summary
    }
  }
  return typeof data?.summary === "string" ? data.summary : "";
}

/** The Envelope table has no objective column: use the backlog task's title, else name the task. The title
 * also fills the brief header when the Envelope cell gave none. */
async function objectiveFor(task: TaskSpec, repo: string): Promise<string> {
  const r = await run("backlog", ["task", task.id, "--plain"], { cwd: repo, timeoutMs: MINUTE });
  const title = r.code === 0 ? backlogTitle(r.stdout) : undefined;
  if (title && !task.title) task.title = title;
  return title ? `Complete backlog task ${task.id}: ${title}` : `Complete task ${task.id}.`;
}

/** The title line of `backlog task <id> --plain`: `Task <ID> - <title>`. */
export function backlogTitle(plain: string): string | undefined {
  const m = /^Task\s+\S+\s+-\s+(.+)$/m.exec(plain);
  return m?.[1].trim() || undefined;
}

export default function (pi: ExtensionAPI) {
  const idle = fauxProvider({ provider: IDLE_PROVIDER, models: [{ id: IDLE_MODEL, contextWindow: 1_000_000, maxTokens: 16 }] });
  const reply = async () => {
    idle.appendResponses([reply]);
    return fauxAssistantMessage("");
  };
  idle.setResponses([reply]);
  pi.registerProvider(idle.provider as any);

  let childRegistration: { dispose(): void } | undefined;
  let childRegistrationError: string | undefined;
  let started = false;
  let active: Dispatcher | undefined;

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const extensions = [{ id: "loop-guard-lane", path: fileURLToPath(new URL("../loop-guard/lane.ts", import.meta.url)) }];
    const loopWaitLane = fileURLToPath(new URL("../loop-wait/lane.ts", import.meta.url));
    if (existsSync(loopWaitLane)) extensions.push({ id: "loop-wait-lane", path: loopWaitLane });
    try {
      childRegistration = registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions, requireForAllRunners: true });
    } catch (error) {
      childRegistrationError = error instanceof Error ? error.message : String(error);
    }
  });
  pi.on("session_shutdown", () => {
    childRegistration?.dispose();
    childRegistration = undefined;
  });

  pi.events.on("subagent:async-complete", (data: any) => {
    if (active && typeof data?.runId === "string") active.complete(data.runId, completionText(data));
  });

  const rpc = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<{ success: boolean; data?: any; error?: { message?: string } }>((resolve) => {
      const requestId = randomUUID();
      let off: (() => void) | undefined;
      const timer = setTimeout(() => {
        off?.();
        resolve({ success: false, error: { message: `no pi-subagents reply to ${method} within ${timeoutMs} ms` } });
      }, timeoutMs);
      off = pi.events.on(`${RPC_REPLY}${requestId}`, (r: any) => {
        clearTimeout(timer);
        off?.();
        resolve(r);
      }) as unknown as () => void;
      pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, ...(params === undefined ? {} : { params }) });
    });

  const queryLaunchOps = () =>
    new Promise<unknown>((resolve) => {
      let answered = false;
      pi.events.emit("loop-continuation:query-launch", {
        reply: (r: { ops?: unknown }) => {
          answered = true;
          resolve(r?.ops ?? null);
        },
      });
      if (!answered) setTimeout(() => resolve(null), 50);
    });

  async function runLoop(text: string): Promise<{ code: number; message: string }> {
    const refuse = (message: string) => ({ code: 2, message: `loop-pi-dispatch refused: ${message}` });
    if (childRegistrationError) return refuse(`required child extensions could not be registered (${childRegistrationError})`);
    const launch = parseLaunch(text, (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
    if ("error" in launch) return refuse(launch.error);
    if (launch.opsLine || (await queryLaunchOps()) !== null) return refuse("the launch grants ops; an ops loop needs an LLM root");
    const runDir = process.env.LOOP_PI_RUN_DIR;
    if (!runDir || !existsSync(runDir)) return refuse("LOOP_PI_RUN_DIR is not set; start it through the loop-pi-dispatch launcher");
    if (existsSync(launch.log) && statSync(launch.log).size > 0) return refuse(`${launch.log} already holds events; a dispatcher does not resume a loop`);
    let goalText: string;
    try {
      goalText = readFileSync(launch.goal, "utf8");
    } catch {
      return refuse(`cannot read ${launch.goal}`);
    }
    const loopPath = join(launch.repo, "LOOP.md");
    const loop = parseLoopMd(existsSync(loopPath) ? readFileSync(loopPath, "utf8") : "");
    const goal = parseGoal(goalText);
    const lsFiles = await run("git", ["ls-files", "-z"], { cwd: launch.repo, timeoutMs: MINUTE });
    if (lsFiles.code !== 0) return refuse(`git ls-files failed in ${launch.repo}`);
    const files = lsFiles.stdout.split("\0").filter(Boolean);
    const verdict = dispatcherEligible(goal, loop, files);
    if (!verdict.eligible) return refuse(`the goal is not dispatcher-eligible:\n- ${verdict.reasons.join("\n- ")}`);
    const cap = Number.parseInt(goal.run.concurrency ?? "", 10);
    if (!(cap >= 1)) return refuse("## Run has no `concurrency: <n>`");
    const composedGate = findComposedGate(goal, loop);
    if (!composedGate) return refuse("no composed gate: LOOP.md has no `gate:` and the tasks do not share one");
    const ping = await rpc("ping", undefined, 10_000);
    if (!ping.success) return refuse(`pi-subagents RPC is not available (${ping.error?.message ?? "no reply"})`);

    const repo = launch.repo;
    const loopState = existsSync(join(getAgentDir(), "bin", "loop-state")) ? join(getAgentDir(), "bin", "loop-state") : "loop-state";
    const audit = fileURLToPath(new URL("../../bin/loop-pi-audit", import.meta.url));
    const git = (args: string[], timeoutMs = 2 * MINUTE) => run("git", args, { cwd: repo, timeoutMs });
    let branch: string | undefined;
    const defaultBranch = async () => {
      if (branch) return branch;
      const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      branch = head.code === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, "") : (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      return branch;
    };
    const say = (message: string) => process.stderr.write(`${message}\n`);

    const ports: Ports = {
      async append(event) {
        const r = await run(loopState, ["append", launch.log, "--by", "dispatcher"], { cwd: repo, input: JSON.stringify(event), timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`loop-state refused ${String(event.ev)}: ${(r.stderr || r.stdout).trim()}`);
      },
      async spawn(agent, brief) {
        if (childRegistrationError) return { error: "required child extensions are not registered (fail closed)" };
        const params: Record<string, unknown> = { agent, task: brief };
        const refused = guardSpawn(params, agent);
        if (refused) return { error: refused };
        const r = await rpc("spawn", params, 2 * MINUTE);
        const runId = r.data?.details?.runId ?? r.data?.details?.asyncId;
        if (!r.success || typeof runId !== "string") return { error: r.error?.message ?? "pi-subagents returned no run id" };
        return { runId };
      },
      async remoteSha() {
        const b = await defaultBranch();
        await git(["fetch", "--quiet", "origin", b]);
        const r = await git(["rev-parse", `origin/${b}`]);
        if (r.code !== 0) throw new Error(`cannot resolve origin/${b}: ${r.stderr.trim()}`);
        return r.stdout.trim();
      },
      async isAncestor(sha, tip) {
        return (await git(["merge-base", "--is-ancestor", sha, tip])).code === 0;
      },
      async backlogDone(task) {
        const r = await run("backlog", ["task", "edit", task, "-s", "Done"], { cwd: repo, timeoutMs: MINUTE });
        return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim() };
      },
      async closeout() {
        const grants = join(runDir, "dispatch-grants.json");
        writeFileSync(grants, `${JSON.stringify({ [realpathSync(repo)]: [`refs/heads/${await defaultBranch()}`] })}\n`);
        const r = await run(audit, ["closeout", "--grants", grants], { cwd: repo, timeoutMs: 15 * MINUTE });
        say(r.stdout.trim());
        return { ok: r.code === 0, detail: (r.stderr || r.stdout).trim() };
      },
      async commitBacklog(tasks) {
        const status = await git(["status", "--porcelain", "--", "backlog"]);
        if (status.code !== 0) return { ok: false, detail: status.stderr.trim() };
        if (!status.stdout.trim()) return { ok: true, detail: "nothing to commit under backlog/" };
        const add = await git(["add", "--", "backlog"]);
        if (add.code !== 0) return { ok: false, detail: add.stderr.trim() };
        const commit = await git(["commit", "--quiet", "-m", `backlog: mark ${tasks.join(", ")} Done`, "--", "backlog"]);
        return { ok: commit.code === 0, detail: (commit.stderr || commit.stdout).trim() };
      },
      async onClose() {
        let settings: unknown = {};
        try {
          settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
        } catch {
          // no settings: nothing to run
        }
        for (const argv of onCloseCommands(settings, launch.log, launch.report)) {
          const r = await run(argv[0], argv.slice(1), { cwd: repo, timeoutMs: 15 * MINUTE });
          if (r.code !== 0) say(`loop-pi-dispatch: onClose ${argv[0]} exited ${r.code}: ${r.stderr.trim().slice(-2000)}`);
        }
      },
      log: say,
    };

    for (const t of goal.tasks) t.objective = await objectiveFor(t, repo);
    const tiers = Object.fromEntries(goal.tasks.map((t) => [t.id, effectiveTier(t, loop, files)]));
    const dispatcher = new Dispatcher(
      {
        tasks: goal.tasks,
        tiers,
        runTier: goal.run.tier || loop.keys.tier || "routine",
        cap,
        composedGate,
        guardedExtra: guardedExtra(loop),
        files,
        goalSha256: createHash("sha256").update(goalText).digest("hex"),
        rootModel: `${IDLE_PROVIDER}/${IDLE_MODEL}`,
      },
      ports,
    );
    active = dispatcher;
    const keepAlive = setInterval(() => {}, MINUTE);
    let reason: CloseReason;
    try {
      reason = await dispatcher.start();
    } finally {
      clearInterval(keepAlive);
      active = undefined;
    }
    const states = Object.entries(dispatcher.snapshot()).map(([id, s]) => `${id}=${s.status}`).join(" ");
    return { code: reason === "nothing-admissible" ? 0 : 1, message: `loop-pi-dispatch: closed ${reason}; ${states}` };
  }

  pi.on("input", async (event) => {
    if (started) return { action: "handled" as const };
    started = true;
    const result = await runLoop(event.text);
    process.stderr.write(`${result.message}\n`);
    if (result.code !== 0) process.exitCode = result.code;
    return { action: "handled" as const };
  });
}
