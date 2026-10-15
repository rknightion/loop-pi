// Test support for loop-continuation (not a test file; `test-` files are excluded from builds).
// `loopFixture` builds a v3 loop that passes the arm checks: a git repository with
// codex/charter-*.md, a run dir, and an agent home whose bin/loop-state is this checkout's. `fakePi` loads index.ts
// against a fake ExtensionAPI.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Set charter header keys (`key: value` lines before its first `##`), replacing a key already there,
 *  e.g. `standing: <path> sha256=<hex>`. */
export function setCharterKeys(fixture: { charter: string }, ...lines: string[]): void {
  let text = readFileSync(fixture.charter, "utf8");
  for (const line of lines) {
    const key = line.slice(0, line.indexOf(":")).trim().toLowerCase();
    // Keys are plain words (`standing`, `lanes`): no regex escaping needed.
    const existing = new RegExp(`^${key}\\s*:.*$`, "mi");
    text = existing.test(text) ? text.replace(existing, () => line) : text.replace(/^## First wave/m, () => `${line}\n\n## First wave`);
  }
  writeFileSync(fixture.charter, text);
}

export function cleanupFixtures(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
}

/** A charter in the v3 template's shape (charter.md). */
export function charterText(opts: { host?: string; root?: string | null; lanes?: string | null } = {}): string {
  return [
    "# Charter: x loop3",
    "",
    "harness:    pi",
    ...(opts.root === null ? [] : [`root:       ${opts.root ?? "sol / medium"}`]),
    "aim:        exercise the fixture",
    "priorities: label:priority-high > status:\"To Do\"",
    "exclude:    label:needs-owner",
    ...(opts.lanes === null ? [] : [`lanes:      ${opts.lanes ?? "2"}`]),
    "gate:       just check",
    "gate-route: just check",
    "guarded-paths: none",
    "standing:   none",
    "authority:",
    "  - live: read the fixture database",
    ...(opts.host ? [`host:       ${opts.host}`] : []),
    "overnight:  keep building waves",
    "budget:     none",
    "",
    "## First wave",
    "",
    "| Task | Scope | Route | Note |",
    "|---|---|---|---|",
    "| T-1 (first task) | a/** | worker | |",
    "| `T-2` | b/** | senior (shared seam) | |",
    "",
    "## Decisions already made",
    "",
    "- none",
    "",
  ].join("\n");
}

export interface LoopFixture {
  repo: string;
  charter: string;
  /** The closeout path (the launch's `report`, S1). */
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

export function loopFixture(opts: { host?: string; root?: string | null; lanes?: string | null; agentDir?: string } = {}): LoopFixture {
  const repo = fresh("loop-cont-repo-");
  initRepo(repo);
  mkdirSync(join(repo, "codex"));
  const charter = join(repo, "codex", "charter-x-loop3.md");
  writeFileSync(charter, charterText(opts));
  const report = join(repo, "codex", "closeout-x-loop3.md");
  const log = join(repo, "codex", "state-x-loop3.jsonl");
  const runDir = fresh("loop-cont-run-");
  const agentDir = opts.agentDir ?? fresh("loop-cont-home-");
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  try {
    symlinkSync(LOOP_STATE_BIN, join(agentDir, "bin", "loop-state"));
  } catch {
    // already linked
  }
  const launch = `You are the root. Read ${charter} in full. Write ${report} as the terminal action.`;
  return { repo, charter, report, log, runDir, agentDir, launch };
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

/** A closeout that counts under S2 for the fixture's loop 3. */
export function closeoutBody(loop = 3): string {
  return [
    `# Closeout: x loop${loop} · Charter: ${"0".repeat(64)}`,
    "",
    "## Landed",
    "- none",
    "",
    "## Parked",
    "- none",
    "",
    "## For ratification",
    "- none",
    "",
    "## Notes",
    "- fixture",
    "",
  ].join("\n");
}
