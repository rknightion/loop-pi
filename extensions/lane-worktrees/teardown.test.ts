// Close-time teardown through the extension's public surface (the scratch_register tool and the
// loop-closeout event) against real temporary git repositories with a real origin. Only clean,
// landed, registered worktrees and registered disposable directories go; everything else stays and
// is listed with its reason in <run dir>/teardown.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    await h.register({ path: cache, kind: "cache", disposable: true });
    await h.register({ path: gate, kind: "gate" });
    await h.register({ path: grew, kind: "cache", disposable: true });

    wt(b, join(grew, "inner")); // A worktree appeared inside a disposable dir after registration.

    const { value: lines, calls } = await recordingGit(() => h.closeout());

    assert.equal(existsSync(clean), false, "a clean landed registered worktree is removed");
    assert.doesNotMatch(git(a, "worktree", "list"), /worktrees-loop27/);
    assert.equal(existsSync(cache), false, "a registered disposable dir is removed");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "must survive", "a link inside a disposable dir is not followed");
    for (const path of [dirty, unlanded, kept, unregistered, other, gate, grew, join(grew, "inner")]) {
      assert.equal(existsSync(path), true, `${path} survives`);
    }
    assert.equal(readFileSync(join(dirty, "notes.txt"), "utf8"), "work in progress");
    assert.equal(git(unlanded, "log", "-1", "--format=%s"), "unpushed");

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

test("closeout fails closed when a registered worktree was deleted and replaced by another repository", { timeout: 30_000 }, async () => {
  const base = fresh("td-deleted-replacement-");
  const a = cloned(base, "a");
  const b = cloned(base, "b");
  const swapped = join(base, "swapped");
  const replacement = join(base, "replacement");
  const clean = join(base, "clean");
  const cache = join(base, "cache");
  git(a, "worktree", "add", "-q", "--detach", swapped, "origin/main");
  git(a, "worktree", "add", "-q", "--detach", clean, "origin/main");
  mkdirSync(cache);
  writeFileSync(join(cache, "sentinel"), "must survive");
  const h = harness(b);
  try {
    await h.register({ path: swapped, kind: "worktree" });
    await h.register({ path: clean, kind: "worktree" });
    await h.register({ path: cache, kind: "cache", disposable: true });
    const registered = lstatSync(swapped);
    // Create the foreign object before deleting the registered one, preventing inode reuse
    // from accidentally making this an identity match instead of a replacement fixture.
    git(b, "worktree", "add", "-q", "--detach", replacement, "origin/main");
    git(a, "worktree", "remove", swapped);
    git(b, "worktree", "move", replacement, swapped);
    assert.notEqual(lstatSync(swapped).ino, registered.ino);
    const paths = [swapped, clean, cache];
    const before = paths.map((path) => lstatSync(path).ino);
    const ledger = readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8");

    const { value: lines, calls } = await recordingGit(() => h.closeout());

    assert.match(lines[0], /teardown failed, nothing further removed: .*registered directory location unresolved.*no teardown\.json written/);
    assert.equal(existsSync(join(h.runDir, "teardown.json")), false, "unknown original identity cannot yield a success receipt");
    assert.deepEqual(paths.map((path) => lstatSync(path).ino), before, "replacement and unrelated removable objects survive unchanged");
    assert.equal(readFileSync(join(cache, "sentinel"), "utf8"), "must survive");
    assert.equal(git(swapped, "rev-parse", "--path-format=absolute", "--git-common-dir"), realpathSync(join(b, ".git")));
    assert.equal(calls.some((call) => call.includes("worktree remove")), false, "failure precedes unrelated worktree removal");
    assert.equal(readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8"), ledger);
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

test("a kept directory moved into a disposable registered parent keeps both and lists only surviving paths", async () => {
  const base = fresh("td-moved-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const original = join(base, "evidence");
    const parent = join(base, "cache");
    const moved = join(parent, "nested", "evidence");
    mkdirSync(original);
    mkdirSync(join(parent, "nested"), { recursive: true });
    writeFileSync(join(original, "proof.log"), "only copy");
    await h.register({ path: original, kind: "gate", keep: true });
    await h.register({ path: parent, kind: "cache", disposable: true });
    renameSync(original, moved);

    await h.closeout();

    assert.equal(existsSync(parent), true, "the disposable parent survives");
    assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy", "the moved kept directory survives");
    assert.equal(existsSync(original), false, "the registered spelling is no longer a surviving path");
    const receipt = h.receipt();
    assert.deepEqual(receipt.counts, { removed: 0, kept: 2, absent: 0 });
    assert.deepEqual(receipt.entries.sort((a: any, b: any) => a.path.localeCompare(b.path)), [
      { path: parent, source: "ledger", kind: "cache", outcome: "kept", reason: `holds a registered path that is not removed: ${moved}` },
      { path: moved, source: "ledger", kind: "gate", outcome: "kept", reason: `keep flag set at registration; moved from ${original}` },
    ].sort((a, b) => a.path.localeCompare(b.path)), "receipt lists exactly the surviving paths and why each was kept");
    assert.deepEqual(receipt.warnings, []);
  } finally {
    h.restore();
  }
});

for (const inside of [true, false]) {
  test(`duplicate filesystem identities fail closed before relocation (inside search=${inside})`, { timeout: 30_000 }, async () => {
    const base = fresh("td-duplicate-identity-");
    const session = join(base, "session");
    const original = join(base, "evidence");
    const parent = join(base, "cache");
    const disposable = join(base, "disposable");
    const moved = join(inside ? parent : base, "moved");
    for (const path of [session, original, parent, disposable]) mkdirSync(path);
    writeFileSync(join(original, "proof.log"), "only copy");
    writeFileSync(join(disposable, "sentinel"), "must survive");
    const h = harness(session);
    try {
      await h.register({ path: original, kind: "gate", keep: true });
      await h.register({ path: parent, kind: "cache", disposable: true });
      await h.register({ path: disposable, kind: "cache", disposable: true });
      renameSync(original, moved);
      // Two legitimate registrations across a move can name one object with conflicting intent.
      await h.register({ path: moved, kind: "cache", disposable: true });
      const ledgerPath = join(h.runDir, "scratch-ledger.jsonl");
      const ledger = readFileSync(ledgerPath, "utf8");
      const entries = ledger.trim().split("\n").map((line) => JSON.parse(line));
      assert.notEqual(entries[0].path, entries[3].path);
      assert.deepEqual([entries[0].dev, entries[0].ino], [entries[3].dev, entries[3].ino]);
      const paths = [parent, moved, disposable];
      const before = paths.map((path) => [lstatSync(path).dev, lstatSync(path).ino]);
      const names = readdirSync(base);
      const receiptPath = join(h.runDir, "teardown.json");
      if (!inside) writeFileSync(receiptPath, "prior receipt\n");

      const lines = await h.closeout();

      assert.match(lines[0], /teardown failed, nothing further removed: .*multiple paths for filesystem identity.*no teardown\.json written/, "duplicate identity is rejected even before an unresolved relocation can fail");
      assert.deepEqual(paths.map((path) => [lstatSync(path).dev, lstatSync(path).ino]), before);
      assert.deepEqual(readdirSync(base), names, "no scratch directory was moved aside");
      assert.equal(existsSync(original), false);
      assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy");
      assert.equal(readFileSync(join(disposable, "sentinel"), "utf8"), "must survive");
      assert.equal(readFileSync(ledgerPath, "utf8"), ledger);
      if (inside) assert.equal(existsSync(receiptPath), false, "no ambiguous receipt is created");
      else assert.equal(readFileSync(receiptPath, "utf8"), "prior receipt\n", "no old receipt is overwritten");
    } finally {
      h.restore();
    }
  });
}

test("exhausted relocation discovery fails before scratch mutation or a misleading receipt", { timeout: 60_000 }, async () => {
  const base = fresh("td-budget-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const original = join(base, "evidence");
    const parent = join(base, "cache");
    const disposable = join(base, "disposable");
    mkdirSync(original);
    mkdirSync(parent);
    mkdirSync(disposable);
    writeFileSync(join(original, "proof.log"), "only copy");
    writeFileSync(join(disposable, "sentinel"), "must not be removed");
    await h.register({ path: original, kind: "gate", keep: true });
    await h.register({ path: parent, kind: "cache", disposable: true });
    await h.register({ path: disposable, kind: "cache", disposable: true });
    // The depth-first search pushes these siblings in readdir order, visiting the first last.
    // Place the kept object beyond its real 10000-directory limit, not a mocked/test-only budget.
    for (let i = 0; i < 10_001; i++) mkdirSync(join(parent, `slot-${String(i).padStart(5, "0")}`));
    const moved = join(parent, readdirSync(parent)[0], "evidence");
    renameSync(original, moved);
    const ledger = readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8");
    const before = readdirSync(base);

    const lines = await h.closeout();

    assert.match(lines[0], /teardown failed, nothing further removed: .*relocation discovery directory budget exhausted.*no teardown\.json written/, "unknown location must not be reported as kept at the missing original path");
    assert.equal(existsSync(join(h.runDir, "teardown.json")), false, "no successful receipt is written");
    assert.equal(existsSync(original), false);
    assert.equal(existsSync(parent), true);
    assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy");
    assert.equal(readFileSync(join(disposable, "sentinel"), "utf8"), "must not be removed", "failure precedes even unrelated disposable deletion");
    assert.deepEqual(readdirSync(base), before, "nothing was renamed aside");
    assert.equal(readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8"), ledger);
  } finally {
    h.restore();
  }
});

test("a kept registration moved outside every disposable root is reported absent and never touched", async () => {
  const base = fresh("td-unresolved-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const original = join(base, "evidence");
    const moved = join(base, "outside-search");
    const disposable = join(base, "disposable");
    mkdirSync(original);
    mkdirSync(disposable);
    writeFileSync(join(original, "proof.log"), "only copy");
    writeFileSync(join(disposable, "sentinel"), "must not be removed");
    await h.register({ path: original, kind: "gate", keep: true });
    await h.register({ path: disposable, kind: "cache", disposable: true });
    renameSync(original, moved);
    await h.closeout();
    const entries = h.receipt().entries;
    assert.equal(entries.find((e: { path: string }) => e.path === original)?.outcome, "absent");
    assert.equal(entries.find((e: { path: string }) => e.path === disposable)?.outcome, "removed");
    assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy");
  } finally {
    h.restore();
  }
});

test("a second closeout reports what the first removed as absent and still tears down later registrations", async () => {
  const base = fresh("td-repeat-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const first = join(base, "first-cache");
    const later = join(base, "later-cache");
    const kept = join(base, "evidence");
    mkdirSync(first);
    mkdirSync(kept);
    writeFileSync(join(kept, "proof.log"), "only copy");
    await h.register({ path: first, kind: "cache", disposable: true });
    await h.register({ path: kept, kind: "gate", keep: true });
    await h.closeout();
    assert.equal(existsSync(first), false);
    mkdirSync(later);
    await h.register({ path: later, kind: "cache", disposable: true });
    await h.closeout();
    const entries = h.receipt().entries;
    assert.equal(entries.find((e: { path: string }) => e.path === first)?.outcome, "absent");
    assert.equal(entries.find((e: { path: string }) => e.path === later)?.outcome, "removed");
    assert.equal(entries.find((e: { path: string }) => e.path === kept)?.outcome, "kept");
    assert.equal(readFileSync(join(kept, "proof.log"), "utf8"), "only copy");
  } finally {
    h.restore();
  }
});

for (const keep of [false, true]) {
  test(`an unresolved registered identity fails closed despite an old-path replacement (keep=${keep})`, { timeout: 30_000 }, async () => {
    const base = fresh("td-unresolved-replacement-");
    const session = join(base, "session");
    mkdirSync(session);
    const h = harness(session);
    try {
      const original = join(base, "evidence");
      const parent = join(base, "cache");
      const moved = join(parent, ".git", "evidence");
      const disposable = join(base, "disposable");
      mkdirSync(original);
      mkdirSync(parent);
      mkdirSync(disposable);
      writeFileSync(join(original, "proof.log"), "only copy");
      writeFileSync(join(disposable, "sentinel"), "must not be removed");
      await h.register({ path: original, kind: "gate", keep });
      await h.register({ path: parent, kind: "cache", disposable: true });
      await h.register({ path: disposable, kind: "cache", disposable: true });
      const registeredId = lstatSync(original).ino;
      // Discovery deliberately does not enter Git data. The replacement must not stand in for
      // the still-existing registered identity whose actual location cannot be established.
      mkdirSync(join(parent, ".git"));
      renameSync(original, moved);
      mkdirSync(original);
      writeFileSync(join(original, "foreign.log"), "replacement must survive");
      assert.equal(lstatSync(moved).ino, registeredId);
      assert.notEqual(lstatSync(original).ino, registeredId, "old spelling is a distinct replacement");
      const paths = [original, parent, moved, disposable];
      const beforeIds = paths.map((path) => lstatSync(path).ino);
      const beforeNames = readdirSync(base);
      const ledger = readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8");
      const receiptPath = join(h.runDir, "teardown.json");
      // Both a fresh closeout and a retry with an older receipt must fail without writing success.
      if (keep) writeFileSync(receiptPath, "prior receipt\n");

      const lines = await h.closeout();

      assert.match(lines[0], /teardown failed, nothing further removed: .*registered directory location unresolved.*no teardown\.json written/);
      if (keep) assert.equal(readFileSync(receiptPath, "utf8"), "prior receipt\n", "existing receipt is not overwritten");
      else assert.equal(existsSync(receiptPath), false, "no new successful receipt is written");
      assert.deepEqual(paths.map((path) => lstatSync(path).ino), beforeIds, "all registered objects and the foreign replacement survive unchanged");
      assert.deepEqual(readdirSync(base), beforeNames, "no scratch path was renamed aside");
      assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy");
      assert.equal(readFileSync(join(original, "foreign.log"), "utf8"), "replacement must survive");
      assert.equal(readFileSync(join(disposable, "sentinel"), "utf8"), "must not be removed", "failure precedes unrelated scratch deletion");
      assert.equal(readFileSync(join(h.runDir, "scratch-ledger.jsonl"), "utf8"), ledger);
    } finally {
      h.restore();
    }
  });
}

test("resolved relocation reports the registered identity, not a foreign old-path replacement", { timeout: 30_000 }, async () => {
  const base = fresh("td-resolved-replacement-");
  const session = join(base, "session");
  mkdirSync(session);
  const h = harness(session);
  try {
    const original = join(base, "evidence");
    const parent = join(base, "cache");
    const moved = join(parent, "evidence");
    mkdirSync(original);
    mkdirSync(parent);
    writeFileSync(join(original, "proof.log"), "only copy");
    await h.register({ path: original, kind: "gate", keep: true });
    await h.register({ path: parent, kind: "cache", disposable: true });
    renameSync(original, moved);
    mkdirSync(original);
    writeFileSync(join(original, "foreign.log"), "replacement must survive");
    const replacementId = lstatSync(original).ino;
    assert.notEqual(replacementId, lstatSync(moved).ino);

    await h.closeout();

    assert.equal(lstatSync(original).ino, replacementId, "foreign replacement is never deleted");
    assert.equal(readFileSync(join(original, "foreign.log"), "utf8"), "replacement must survive");
    assert.equal(readFileSync(join(moved, "proof.log"), "utf8"), "only copy");
    assert.equal(existsSync(parent), true);
    const receipt = h.receipt();
    assert.deepEqual(receipt.counts, { removed: 0, kept: 2, absent: 0 });
    assert.deepEqual(receipt.entries.sort((a: any, b: any) => a.path.localeCompare(b.path)), [
      { path: parent, source: "ledger", kind: "cache", outcome: "kept", reason: `holds a registered path that is not removed: ${moved}` },
      { path: moved, source: "ledger", kind: "gate", outcome: "kept", reason: `keep flag set at registration; moved from ${original}` },
    ].sort((a, b) => a.path.localeCompare(b.path)), "only actual surviving registered identities receive ledger outcomes");
    assert.deepEqual(receipt.warnings, []);
  } finally {
    h.restore();
  }
});

test("a registered kept worktree moved into a disposable parent is not rediscovered as unregistered", async () => {
  const base = fresh("td-moved-wt-");
  const repo = cloned(base, "a");
  const original = join(base, "worktree");
  const parent = join(base, "cache");
  const moved = join(parent, "worktree");
  mkdirSync(parent);
  git(repo, "worktree", "add", "-q", "--detach", original, "origin/main");
  const h = harness(repo);
  try {
    await h.register({ path: original, kind: "worktree", keep: true });
    await h.register({ path: parent, kind: "cache", disposable: true });
    git(repo, "worktree", "move", original, moved);
    await h.closeout();
    assert.equal(existsSync(parent), true);
    assert.equal(readFileSync(join(moved, "README"), "utf8"), "a\n");
    const receipt = h.receipt();
    assert.deepEqual(receipt.counts, { removed: 0, kept: 2, absent: 0 });
    assert.deepEqual(receipt.entries.sort((a: any, b: any) => a.path.localeCompare(b.path)), [
      { path: parent, source: "ledger", kind: "cache", outcome: "kept", reason: `holds a registered path that is not removed: ${moved}` },
      { path: moved, source: "ledger", kind: "worktree", outcome: "kept", reason: `keep flag set at registration; moved from ${original}` },
    ].sort((a, b) => a.path.localeCompare(b.path)));
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

test("a case-variant ledger spelling never collapses distinct directory identities", async () => {
  const base = fresh("td-case-identity-");
  const session = join(base, "session");
  const occupied = join(base, "cache");
  const variant = join(base, "CACHE");
  const registered = join(base, "evidence");
  mkdirSync(session);
  mkdirSync(occupied);
  if (!existsSync(variant)) mkdirSync(variant); // Distinct casing is also possible on a sensitive FS.
  mkdirSync(registered);
  writeFileSync(join(variant, "sentinel"), "foreign object");
  const h = harness(session);
  try {
    const original = lstatSync(registered);
    const foreign = lstatSync(variant);
    assert.notEqual(foreign.ino, original.ino, "variant names a different actual object");
    appendFileSync(join(h.runDir, "scratch-ledger.jsonl"), `${JSON.stringify({ v: 1, at: "2026-10-08T00:00:00.000Z", path: variant, kind: "gate", type: "dir", keep: true, disposable: false, dev: original.dev, ino: original.ino })}\n`);
    await h.register({ path: occupied, kind: "cache", disposable: true });

    const lines = await h.closeout();

    assert.match(lines[0], /teardown failed, nothing further removed: .*registered directory location unresolved.*no teardown\.json written/);
    assert.equal(existsSync(join(h.runDir, "teardown.json")), false);
    assert.equal(lstatSync(variant).ino, foreign.ino);
    assert.equal(lstatSync(registered).ino, original.ino);
    assert.equal(readFileSync(join(variant, "sentinel"), "utf8"), "foreign object");
    assert.equal(existsSync(occupied), true, "casing never licenses unrelated deletion");
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
