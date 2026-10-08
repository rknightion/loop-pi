// Close-time teardown through the extension's public surface (the scratch_register tool and the
// loop-closeout event) against real temporary git repositories with a real origin. Only clean,
// landed, registered worktrees and registered disposable directories go; everything else stays and
// is listed with its reason in <run dir>/teardown.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import laneWorktrees from "./index.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const identity = (repo: string) => {
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
};

/** A clone of a bare origin with one pushed commit; origin/HEAD names its default branch. */
function cloned(base: string, name: string): string {
  const origin = join(base, `${name}-origin.git`);
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, `${name}-seed`);
  git(base, "init", "-q", "-b", "main", seed);
  identity(seed);
  writeFileSync(join(seed, "README"), `${name}\n`);
  git(seed, "add", "README");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", origin, "main");
  const repo = join(base, name);
  git(base, "clone", "-q", origin, repo);
  identity(repo);
  return repo;
}

function harness(cwd: string) {
  const runDir = fresh("td-run-");
  writeFileSync(join(runDir, "loop-pi-proto"), "2\n");
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  const handlers = new Map<string, (e: any, c: any) => any>();
  const tools = new Map<string, any>();
  const bus = new Map<string, ((d: any) => void)[]>();
  const api = {
    on: (n: string, h: any) => handlers.set(n, h),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: () => undefined,
    events: {
      on: (n: string, h: any) => {
        bus.set(n, [...(bus.get(n) ?? []), h]);
        return () => undefined;
      },
      emit: (n: string, d: any) => (bus.get(n) ?? []).forEach((h) => h(d)),
    },
  };
  laneWorktrees(api as any);
  const ctx = {
    cwd,
    ui: { notify: () => undefined },
    sessionManager: { getSessionId: () => "s", getSessionFile: () => "/sessions/s.jsonl", getBranch: () => [] },
  };
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  return {
    runDir,
    register: (params: Record<string, unknown>) => {
      const tool = tools.get("scratch_register");
      assert.ok(tool, "the root has a scratch_register tool");
      return tool.execute("call", params, undefined, undefined, ctx);
    },
    async closeout() {
      const lines: string[] = [];
      const pending: Promise<unknown>[] = [];
      api.events.emit("loop-closeout", { lines, pending });
      await Promise.all(pending);
      return lines;
    },
    receipt: () => JSON.parse(readFileSync(join(runDir, "teardown.json"), "utf8")),
    restore() {
      if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
      else process.env.LOOP_PI_RUN_DIR = previous;
    },
  };
}

/** Every git invocation while `fn` runs, through a PATH shim in front of the real git. */
async function recordingGit<T>(fn: () => Promise<T>): Promise<{ value: T; calls: string[] }> {
  const shim = fresh("td-shim-");
  const log = join(shim, "calls.log");
  const real = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${shim}:${path}`;
  try {
    const value = await fn();
    return { value, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
  } finally {
    process.env.PATH = path;
  }
}

const entry = (receipt: any, path: string) => receipt.entries.find((e: any) => e.path === path);

test("closeout removes only clean landed registered worktrees and disposable dirs; everything else stays and is listed", async () => {
  const base = fresh("td-base-");
  const a = cloned(base, "a");
  const b = cloned(base, "b"); // The root's own repository (session cwd) is a different repo.
  const scratch = join(base, "scratch");
  mkdirSync(scratch);
  const wt = (repo: string, path: string) => git(repo, "worktree", "add", "-q", "--detach", path, "origin/main");

  // Same-named loop dirs in two repositories: A's is registered, B's is not.
  const clean = join(base, "a-side", "worktrees-loop27", "X");
  const other = join(base, "b-side", "worktrees-loop27", "X");
  mkdirSync(join(base, "a-side", "worktrees-loop27"), { recursive: true });
  mkdirSync(join(base, "b-side", "worktrees-loop27"), { recursive: true });
  wt(a, clean);
  wt(b, other);
  // Ignored build output does not make a worktree dirty (git worktree remove takes it too).
  writeFileSync(join(a, ".git", "info", "exclude"), "node_modules/\n");
  mkdirSync(join(clean, "node_modules"));
  writeFileSync(join(clean, "node_modules", "dep.js"), "x");

  const dirty = join(scratch, "dirty-loop27");
  wt(a, dirty);
  writeFileSync(join(dirty, "notes.txt"), "work in progress");
  const unlanded = join(scratch, "unlanded-loop27");
  wt(a, unlanded);
  writeFileSync(join(unlanded, "feature.txt"), "f");
  git(unlanded, "add", "feature.txt");
  git(unlanded, "commit", "-qm", "unpushed");
  const kept = join(scratch, "kept-loop27");
  wt(a, kept);
  const unregistered = join(scratch, "unregistered-loop27");
  wt(a, unregistered);
  // Registered as A's worktree, then replaced by a same-named worktree of B.
  const swapped = join(scratch, "swap-loop27");
  wt(a, swapped);

  const cache = join(scratch, "cache-loop27");
  mkdirSync(join(cache, "nested"), { recursive: true });
  writeFileSync(join(cache, "nested", "blob"), "cached");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "must survive");
  symlinkSync(outside, join(cache, "nested", "link")); // Never followed by the removal.
  const gate = join(scratch, "gate-loop27");
  mkdirSync(gate);
  const grew = join(scratch, "grew-loop27");
  mkdirSync(grew);

  const h = harness(b);
  try {
    await h.register({ path: clean, kind: "worktree" });
    await h.register({ path: dirty, kind: "worktree" });
    await h.register({ path: unlanded, kind: "worktree" });
    await h.register({ path: kept, kind: "gate", keep: true });
    await h.register({ path: swapped, kind: "worktree" });
    await h.register({ path: cache, kind: "cache", disposable: true });
    await h.register({ path: gate, kind: "gate" });
    await h.register({ path: grew, kind: "cache", disposable: true });

    git(a, "worktree", "remove", swapped);
    wt(b, swapped);
    wt(b, join(grew, "inner")); // A worktree appeared inside a disposable dir after registration.

    const { value: lines, calls } = await recordingGit(() => h.closeout());

    assert.equal(existsSync(clean), false, "a clean landed registered worktree is removed");
    assert.doesNotMatch(git(a, "worktree", "list"), /worktrees-loop27/);
    assert.equal(existsSync(cache), false, "a registered disposable dir is removed");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "must survive", "a link inside a disposable dir is not followed");
    for (const path of [dirty, unlanded, kept, unregistered, swapped, other, gate, grew, join(grew, "inner")]) {
      assert.equal(existsSync(path), true, `${path} survives`);
    }
    assert.equal(readFileSync(join(dirty, "notes.txt"), "utf8"), "work in progress");
    assert.equal(git(unlanded, "log", "-1", "--format=%s"), "unpushed");
    assert.equal(git(swapped, "rev-parse", "--path-format=absolute", "--git-common-dir"), realpathSync(join(b, ".git")));

    const removes = calls.filter((c) => c.includes("worktree remove"));
    assert.ok(removes.length >= 1, "removal goes through git worktree remove");
    for (const call of calls) assert.doesNotMatch(call, /(^|\s)(--force|-f)(\s|$)/, `no forced git call: ${call}`);

    const receipt = h.receipt();
    assert.equal(receipt.v, 1);
    const expect = (path: string, outcome: string, reason: RegExp, source = "ledger") => {
      const e = entry(receipt, path);
      assert.ok(e, `${path} is listed in teardown.json`);
      assert.equal(e.outcome, outcome, path);
      assert.equal(e.source, source, path);
      assert.match(e.reason, reason, path);
    };
    expect(clean, "removed", /^clean and landed on refs\/remotes\/origin\/main; removed with git worktree remove$/);
    expect(cache, "removed", /^registered disposable directory removed$/);
    expect(dirty, "kept", /^dirty: uncommitted changes or untracked files$/);
    expect(unlanded, "kept", /^unlanded: HEAD [0-9a-f]{12} is not on refs\/remotes\/origin\/main$/);
    expect(kept, "kept", /^keep flag set at registration$/);
    expect(swapped, "kept", /^(the path is not the directory registered \(replaced, moved or now a link\)|belongs to a different repository \(.*\) than the one registered)$/);
    expect(gate, "kept", /^not marked disposable at registration$/);
    expect(grew, "kept", /^holds Git data at inner\/\.git$/);
    expect(unregistered, "kept", /^unregistered: not in this run's ledger; left for a human decision$/, "discovered");
    expect(other, "kept", /^unregistered: not in this run's ledger; left for a human decision$/, "discovered");
    assert.deepEqual(receipt.counts, { removed: 2, kept: receipt.entries.length - 2, absent: 0 });
    assert.equal(lines.length, 1, "teardown extends the sweep's single closeout line");
    assert.match(lines[0], /^lane-worktrees: removed 0 worktree\(s\).*; teardown removed 2, kept \d+, absent 0 \(receipt .*teardown\.json\)$/);
  } finally {
    h.restore();
  }
});

test("registration refuses paths teardown could never safely own", async () => {
  const base = fresh("td-refuse-");
  const a = cloned(base, "a");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const refused = async (params: Record<string, unknown>, reason: RegExp) => {
      await assert.rejects(() => h.register(params), reason, JSON.stringify(params));
    };
    await refused({ path: a, kind: "worktree" }, /main working tree/);
    await refused({ path: a, kind: "cache", disposable: true }, /\.git entry/);
    await refused({ path: join(a, "missing"), kind: "cache" }, /does not exist/);
    await refused({ path: "/", kind: "cache", disposable: true }, /filesystem root|protected location/);
    await refused({ path: base, kind: "cache", disposable: true }, /protected location/); // Contains the session cwd.
    mkdirSync(join(h.runDir, "gate"));
    await refused({ path: join(h.runDir, "gate"), kind: "gate", disposable: true }, /run directory/);
    mkdirSync(join(a, "src"));
    writeFileSync(join(a, "src", "main.ts"), "x");
    git(a, "add", "src/main.ts");
    await refused({ path: join(a, "src"), kind: "cache", disposable: true }, /tracked/);
    assert.equal(existsSync(join(h.runDir, "scratch-ledger.jsonl")), false, "nothing refused reaches the ledger");
  } finally {
    h.restore();
  }
});

test("a keep-flagged or non-disposable registered dir inside a disposable registered parent keeps both", async () => {
  const base = fresh("td-nest-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const parent = join(base, "cache");
    const child = join(parent, "evidence");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "proof.log"), "only copy");
    await h.register({ path: child, kind: "gate", keep: true });
    await h.register({ path: parent, kind: "cache", disposable: true });
    const other = join(base, "other");
    const listed = join(other, "listed");
    mkdirSync(listed, { recursive: true });
    await h.register({ path: listed, kind: "gate" }); // Not disposable: listed only.
    await h.register({ path: other, kind: "cache", disposable: true });
    const done = join(base, "done");
    mkdirSync(join(done, "inner"), { recursive: true });
    await h.register({ path: join(done, "inner"), kind: "cache", disposable: true });
    await h.register({ path: done, kind: "cache", disposable: true });
    await h.closeout();
    assert.equal(readFileSync(join(child, "proof.log"), "utf8"), "only copy", "the keep-flagged child survives");
    assert.equal(existsSync(listed), true, "the non-disposable child survives");
    assert.equal(existsSync(done), false, "a parent whose registered children were all removed goes too");
    const receipt = h.receipt();
    assert.equal(entry(receipt, child).outcome, "kept");
    assert.equal(entry(receipt, parent).outcome, "kept");
    assert.equal(entry(receipt, parent).reason, `holds a registered path that is not removed: ${child}`);
    assert.equal(entry(receipt, other).reason, `holds a registered path that is not removed: ${listed}`);
    assert.equal(entry(receipt, join(done, "inner")).outcome, "removed");
    assert.equal(entry(receipt, done).outcome, "removed");
  } finally {
    h.restore();
  }
});

test("a case-variant spelling of a protected path is never registered or removed", async (t) => {
  const base = fresh("td-case-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const evidence = join(h.runDir, "evidence");
    mkdirSync(evidence);
    writeFileSync(join(evidence, "gate.log"), "evidence");
    const variant = evidence.toUpperCase();
    if (variant === evidence || !existsSync(variant)) {
      t.skip("case-sensitive filesystem: no case-variant spelling resolves");
      return;
    }
    await assert.rejects(() => h.register({ path: variant, kind: "gate", disposable: true }), /inside the loop run directory/);
    const sessionVariant = join(session, "..").toUpperCase();
    await assert.rejects(() => h.register({ path: sessionVariant, kind: "cache", disposable: true }), /protected location/);
    // A ledger line written behind the tool's back with the variant spelling is kept at teardown.
    const s = lstatSync(evidence);
    appendFileSync(join(h.runDir, "scratch-ledger.jsonl"), `${JSON.stringify({ v: 1, at: "2026-10-08T00:00:00.000Z", path: variant, kind: "gate", type: "dir", keep: false, disposable: true, dev: s.dev, ino: s.ino })}\n`);
    await h.closeout();
    assert.equal(readFileSync(join(evidence, "gate.log"), "utf8"), "evidence");
    assert.equal(entry(h.receipt(), variant).outcome, "kept");
  } finally {
    h.restore();
  }
});

test("a clean landed worktree holding ignored content outside node_modules is kept and lists it", async () => {
  const base = fresh("td-ign-");
  const a = cloned(base, "a");
  writeFileSync(join(a, ".git", "info", "exclude"), "*.log\nnode_modules/\n");
  const wt = join(base, "wt");
  git(a, "worktree", "add", "-q", "--detach", wt, "origin/main");
  writeFileSync(join(wt, "gate.log"), "only copy of evidence");
  mkdirSync(join(wt, "node_modules"));
  writeFileSync(join(wt, "node_modules", "dep.js"), "x");
  const h = harness(a);
  try {
    await h.register({ path: wt, kind: "worktree" });
    await h.closeout();
    assert.equal(readFileSync(join(wt, "gate.log"), "utf8"), "only copy of evidence");
    const e = entry(h.receipt(), wt);
    assert.equal(e.outcome, "kept");
    assert.equal(e.reason, "ignored content present");
    assert.deepEqual(e.ignored, ["gate.log"]);
  } finally {
    h.restore();
  }
});
