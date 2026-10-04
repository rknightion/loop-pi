// Test support for loop-continuation (not a test file; `test-` files are excluded from builds).
// `loopFixture` builds a loop that passes the S3 arm checks: a git repository with codex/goal-*.md,
// a run dir, and an agent home whose bin/loop-state is this checkout's. `fakePi` loads index.ts
// against a fake ExtensionAPI.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOOP_STATE_BIN = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));
const made: string[] = [];

export function fresh(prefix = "loop-cont-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function cleanupFixtures(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
}

export function goalText(opts: { host?: string; tier?: string; rootModel?: string | null } = {}): string {
  return [
    "# Goal: x loop3",
    "## Run",
    `tier: ${opts.tier ?? "guarded"}`,
    "root: llm - fixture",
    ...(opts.rootModel === null ? [] : [`root-model: ${opts.rootModel ?? "provider/model-a"}`]),
    "concurrency: 2",
    ...(opts.host ? [`host: ${opts.host}`] : []),
    "## Envelope",
    "| task | acceptance check | owned files | gate | landing | agent | tier |",
    "|---|---|---|---|---|---|---|",
    "| T-1 (first task) | a passes | a/** | just check | lands-after-green | lane-worker-push | routine |",
    "| `T-2` | b passes | b/** | just check | returns candidate | lane-worker | guarded |",
    "## Authority",
    "push agents: lane-worker-push",
    "",
  ].join("\n");
}

export interface LoopFixture {
  repo: string;
  goal: string;
  report: string;
  log: string;
  runDir: string;
  agentDir: string;
  launch: string;
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function initRepo(repo: string): void {
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "codex/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-qm", "init");
}

export function loopFixture(opts: { host?: string; tier?: string; rootModel?: string | null; agentDir?: string } = {}): LoopFixture {
  const repo = fresh("loop-cont-repo-");
  initRepo(repo);
  mkdirSync(join(repo, "codex"));
  const goal = join(repo, "codex", "goal-x-loop3.md");
  writeFileSync(goal, goalText(opts));
  const report = join(repo, "codex", "report-x-loop3.md");
  const log = join(repo, "codex", "state-x-loop3.jsonl");
  const runDir = fresh("loop-cont-run-");
  const agentDir = opts.agentDir ?? fresh("loop-cont-home-");
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  try {
    symlinkSync(LOOP_STATE_BIN, join(agentDir, "bin", "loop-state"));
  } catch {
    // already linked
  }
  const launch = `You are the root. Read ${goal} in full. Write ${report} as the terminal action.`;
  return { repo, goal, report, log, runDir, agentDir, launch };
}

type Handler = (event: any, ctx: any) => any;

export interface FakePi {
  handlers: Map<string, Handler>;
  bus: Map<string, ((data: any) => void)[]>;
  entries: { customType: string; data: any }[];
  sent: { message: any; options: any }[];
  notes: { message: string; type?: string }[];
  ctx(branch?: unknown[]): any;
  input(text: string): Promise<any>;
  emit(channel: string, data: any): void;
  query(): any;
  restore(): void;
}

/** Load index.ts against a fake ExtensionAPI with `PI_CODING_AGENT_DIR` and `LOOP_PI_RUN_DIR` set. */
export async function fakePi(opts: { agentDir: string; cwd: string; runDir?: string | null; sessionId?: string }): Promise<FakePi> {
  const previous = { home: process.env.PI_CODING_AGENT_DIR, run: process.env.LOOP_PI_RUN_DIR };
  process.env.PI_CODING_AGENT_DIR = opts.agentDir;
  if (opts.runDir) process.env.LOOP_PI_RUN_DIR = opts.runDir;
  else delete process.env.LOOP_PI_RUN_DIR;
  const handlers = new Map<string, Handler>();
  const bus = new Map<string, ((data: any) => void)[]>();
  const entries: { customType: string; data: any }[] = [];
  const sent: { message: any; options: any }[] = [];
  const notes: { message: string; type?: string }[] = [];
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        bus.set(name, [...(bus.get(name) ?? []), handler]);
        return () => undefined;
      },
      emit: (name: string, data: unknown) => (bus.get(name) ?? []).forEach((h) => h(data)),
    },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const module = await import("./index.ts");
  module.default(api as never);
  const sessionId = opts.sessionId ?? "sess-1";
  const ctx = (branch: unknown[] = []) => ({
    cwd: opts.cwd,
    ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/sessions/${sessionId}.jsonl`, getBranch: () => branch },
  });
  handlers.get("session_start")!({ type: "session_start" }, ctx());
  return {
    handlers,
    bus,
    entries,
    sent,
    notes,
    ctx,
    input: async (text: string) => handlers.get("input")!({ type: "input", text, source: "rpc" }, ctx()),
    emit: (channel, data) => api.events.emit(channel, data),
    query: () => {
      let answer: any;
      api.events.emit("loop-continuation:query-launch", { reply: (r: unknown) => (answer = r) });
      return answer;
    },
    restore: () => {
      if (previous.home === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous.home;
      if (previous.run === undefined) delete process.env.LOOP_PI_RUN_DIR;
      else process.env.LOOP_PI_RUN_DIR = previous.run;
    },
  };
}
