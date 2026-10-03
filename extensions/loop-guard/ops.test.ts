// Ops grant class: the root's launch check, the lane binding parse and the surface lock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateOpsLaunch, opsSurfaceLines, parseLaneBinding, validateOpsEntry, type OpsEntry } from "./ops.ts";
import { acquireOpsLock, opsLockPath } from "./ops-lock.ts";
import { bindLaneIdentity } from "./push-grant.ts";
import { opsSubject, secretWriteTarget } from "./rules.ts";

const DEPLOY: OpsEntry = { surface: "deploy:svc-worker", kind: "deploy", allow: ["^just deploy( .*)?$"] };
const RELEASE: OpsEntry = { surface: "release:svc", kind: "release", allow: ["^gh release create v[0-9.]+$"] };
const OPS = { v: 1, ops: [DEPLOY, RELEASE] };
const never = () => false;

function brief(surface?: string): string {
  const lines = ["Lane: L1 · Task: T-1 · Tier: guarded", "Objective: deploy the worker"];
  if (surface !== undefined) lines.push(`Ops surface: ${surface}`);
  lines.push("Gate: just deploy");
  return lines.join("\n");
}

test("ops launch: a frozen surface binds its full entry", () => {
  const decision = evaluateOpsLaunch({ agent: "ops", task: brief("deploy:svc-worker") }, OPS, never);
  assert.equal(decision.block, false);
  assert.deepEqual(decision.block === false && decision.entry, DEPLOY);
});

test("ops launch: the bare ops array is accepted as the frozen value", () => {
  const decision = evaluateOpsLaunch({ agent: "ops", task: brief("release:svc") }, [DEPLOY, RELEASE], never);
  assert.deepEqual(decision.block === false && decision.entry, RELEASE);
});

const OPS_REFUSALS: { name: string; input: Record<string, unknown>; ops: unknown; active?: string; reason: RegExp }[] = [
  { name: "ops null", input: { agent: "ops", task: brief("deploy:svc-worker") }, ops: null, reason: /no ops grants are frozen/ },
  { name: "ops undefined (no reply)", input: { agent: "ops", task: brief("deploy:svc-worker") }, ops: undefined, reason: /no ops grants are frozen/ },
  { name: "surface not in ops", input: { agent: "ops", task: brief("deploy:other") }, ops: OPS, reason: /not in the frozen ops/ },
  { name: "no surface line", input: { agent: "ops", task: brief() }, ops: OPS, reason: /exactly one `Ops surface/ },
  {
    name: "two surface lines",
    input: { agent: "ops", task: `${brief("deploy:svc-worker")}\nOps surface: release:svc` },
    ops: OPS,
    reason: /exactly one `Ops surface/,
  },
  { name: "empty surface id", input: { agent: "ops", task: brief("") }, ops: OPS, reason: /not a valid ops surface id/ },
  { name: "path-like surface id", input: { agent: "ops", task: brief("../../x") }, ops: OPS, reason: /not a valid ops surface id/ },
  { name: "surface already active", input: { agent: "ops", task: brief("deploy:svc-worker") }, ops: OPS, active: "deploy:svc-worker", reason: /already active/ },
  {
    name: "duplicate surface in ops",
    input: { agent: "ops", task: brief("deploy:svc-worker") },
    ops: { v: 1, ops: [DEPLOY, DEPLOY] },
    reason: /more than once/,
  },
  {
    name: "unanchored allow pattern",
    input: { agent: "ops", task: brief("deploy:svc-worker") },
    ops: { v: 1, ops: [{ ...DEPLOY, allow: ["just deploy"] }] },
    reason: /malformed/,
  },
  {
    name: "unknown kind",
    input: { agent: "ops", task: brief("deploy:svc-worker") },
    ops: { v: 1, ops: [{ ...DEPLOY, kind: "anything" }] },
    reason: /malformed/,
  },
  { name: "ops file of the wrong version", input: { agent: "ops", task: brief("deploy:svc-worker") }, ops: { v: 2, ops: [DEPLOY] }, reason: /no ops grants are frozen/ },
  { name: "Ops surface on a non-ops agent", input: { agent: "lane-worker", task: brief("deploy:svc-worker") }, ops: OPS, reason: /only valid in a brief for agent `ops`/ },
  {
    name: "ops inside a parallel tasks launch",
    input: { tasks: [{ agent: "ops", task: brief("deploy:svc-worker") }] },
    ops: OPS,
    reason: /may only be launched alone/,
  },
  {
    name: "Ops surface inside a chain step for another agent",
    input: { chain: [{ agent: "mapper", task: brief("deploy:svc-worker") }] },
    ops: OPS,
    reason: /only valid in a brief for agent `ops`/,
  },
];

for (const c of OPS_REFUSALS) {
  test(`ops launch refused: ${c.name}`, () => {
    const decision = evaluateOpsLaunch(c.input, c.ops, (s) => s === c.active);
    assert.equal(decision.block, true);
    assert.match(decision.block ? decision.reason : "", c.reason);
  });
}

test("ops launch: other agents without a surface line pass with no entry", () => {
  const decision = evaluateOpsLaunch({ agent: "lane-worker", task: "Objective: Ops surface is mentioned inline only" }, null, never);
  assert.deepEqual(decision, { block: false });
});

test("opsSurfaceLines reads only whole lines", () => {
  assert.deepEqual(opsSurfaceLines("a\n  Ops surface: x:y  \nsee the Ops surface: line"), ["x:y"]);
});

test("validateOpsEntry: secret_paths must be strings", () => {
  assert.equal(validateOpsEntry({ ...DEPLOY, secret_paths: [1] }), null);
  assert.ok(validateOpsEntry({ ...DEPLOY, secret_paths: ["kv/a"] }));
});

test("bindLaneIdentity: no ops entry keeps the agent-only binding", () => {
  const input: Record<string, unknown> = { agent: "lane-worker-push", task: "x", extensionBindings: { "spoof/1": { a: 1 } } };
  bindLaneIdentity(input, "lane-worker-push");
  assert.deepEqual(input.extensionBindings, { "loop-pi.guard/1": { agent: "lane-worker-push" } });
});

test("bindLaneIdentity: an ops entry binds agent, surface and the full entry", () => {
  const input: Record<string, unknown> = { agent: "ops", task: "x" };
  bindLaneIdentity(input, "ops", DEPLOY);
  assert.deepEqual(input.extensionBindings, {
    "loop-pi.guard/1": { agent: "ops", surface: "deploy:svc-worker", entry: DEPLOY },
  });
  assert.deepEqual(parseLaneBinding(JSON.stringify(input.extensionBindings ?? null)).ops, { surface: DEPLOY.surface, entry: DEPLOY });
});

test("bindLaneIdentity: refuses an ops entry on another agent and ops without an entry", () => {
  assert.throws(() => bindLaneIdentity({}, "lane-worker", DEPLOY), /only agent ops/);
  assert.throws(() => bindLaneIdentity({}, "ops"), /requires its ops entry/);
});

const BINDING_REFUSALS: { name: string; binding: unknown }[] = [
  { name: "forged by a non-ops agent", binding: { "loop-pi.guard/1": { agent: "lane-worker", surface: DEPLOY.surface, entry: DEPLOY } } },
  { name: "surface differs from the entry", binding: { "loop-pi.guard/1": { agent: "ops", surface: "release:svc", entry: DEPLOY } } },
  { name: "entry missing", binding: { "loop-pi.guard/1": { agent: "ops", surface: DEPLOY.surface } } },
  { name: "entry with an unanchored pattern", binding: { "loop-pi.guard/1": { agent: "ops", surface: DEPLOY.surface, entry: { ...DEPLOY, allow: [".*"] } } } },
  { name: "another namespace", binding: { "loop-pi.ops/1": { agent: "ops", surface: DEPLOY.surface, entry: DEPLOY } } },
];

for (const c of BINDING_REFUSALS) {
  test(`lane binding grants no ops: ${c.name}`, () => {
    assert.equal(parseLaneBinding(JSON.stringify(c.binding)).ops, undefined);
  });
}

test("lane binding: malformed JSON binds nothing", () => {
  assert.deepEqual(parseLaneBinding("{not json"), {});
  assert.deepEqual(parseLaneBinding(undefined), {});
});

test("surface lock: a second holder is busy until the first releases", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-ops-lock-"));
  try {
    const first = await acquireOpsLock("deploy:svc-worker", { dir });
    assert.equal(first.state, "held", first.reason ?? "");
    assert.equal(first.isHeld(), true);
    assert.equal(first.path, opsLockPath("deploy:svc-worker", dir));

    const second = await acquireOpsLock("deploy:svc-worker", { dir });
    assert.equal(second.state, "busy");
    assert.equal(second.isHeld(), false);
    assert.match(second.reason ?? "", /another ops lane/);

    const other = await acquireOpsLock("release:svc", { dir });
    assert.equal(other.state, "held", "a different surface is not blocked");
    other.release();

    first.release();
    assert.equal(first.isHeld(), false);
    let third = await acquireOpsLock("deploy:svc-worker", { dir });
    for (let i = 0; i < 50 && third.state === "busy"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      third = await acquireOpsLock("deploy:svc-worker", { dir });
    }
    assert.equal(third.state, "held");
    third.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("surface lock: a holder that cannot start is an error, never held", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-ops-lock-"));
  try {
    const lock = await acquireOpsLock("deploy:svc-worker", { dir, python: join(dir, "no-such-python") });
    assert.equal(lock.state, "error");
    assert.equal(lock.isHeld(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("surface lock: the holder drops the lock when its parent process is killed", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-guard-ops-lock-"));
  const lockModule = new URL("./ops-lock.ts", import.meta.url).href;
  const parent = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { acquireOpsLock } = await import(${JSON.stringify(lockModule)});
       const lock = await acquireOpsLock("deploy:svc-worker", { dir: ${JSON.stringify(dir)} });
       console.log(lock.state);
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const state = await new Promise<string>((resolve) => parent.stdout!.once("data", (d) => resolve(String(d).trim())));
    assert.equal(state, "held");
    assert.equal((await acquireOpsLock("deploy:svc-worker", { dir })).state, "busy");
    parent.kill("SIGKILL");
    let lock = await acquireOpsLock("deploy:svc-worker", { dir });
    for (let i = 0; i < 60 && lock.state === "busy"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      lock = await acquireOpsLock("deploy:svc-worker", { dir });
    }
    assert.equal(lock.state, "held", "a dead lane must not leave its surface locked");
    lock.release();
  } finally {
    parent.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

const SECRET_TARGETS: [string, string | null][] = [
  ["vault write kv/ci/a value=x", "kv/ci/a"],
  ["vault write -force kv/ci/a", "kv/ci/a"],
  ["vault kv put -mount=secret ci/a value=x", "secret/ci/a"],
  ["bao kv put --mount=kv/ /ci/a value=-", "kv/ci/a"],
  ["bao secret put kv/ci/a value=x", "kv/ci/a"],
  ["vault write -mount=kv ci/a", null],
  ["vault kv put -format json kv/ci/a", null],
  ["vault kv put kv/ci/a -mount=other value=x", null],
  ["vault kv put kv/ci/a value=-", "kv/ci/a"],
  ["gh secret set TOKEN --body -", "TOKEN"],
  ["gh secret set -R o/r -e prod TOKEN", "TOKEN"],
  ["gh secret set --repo=o/r TOKEN", "TOKEN"],
  ["gh secret set -f .env", null],
  ["gh secret set A B", null],
  ["gh secret set --unknown x TOKEN", null],
  ["op item create --vault CI --title svc-token password=x", "CI/svc-token"],
  ["op item create --title svc-token", null],
  ["op item edit svc-token --vault=CI password=y", "CI/svc-token"],
  ["op item edit --vault CI", null],
  ["aws secretsmanager put-secret-value --secret-id ci/a --secret-string x", "ci/a"],
  ["aws --region eu-west-2 secretsmanager create-secret --name=ci/b", "ci/b"],
  ["aws secretsmanager update-secret --secret-id ci/a --secret-id ci/b", null],
  ["aws secretsmanager put-secret-value --cli-input-json file://x.json", null],
];

for (const [command, target] of SECRET_TARGETS) {
  test(`secretWriteTarget: ${command} -> ${target}`, () => {
    assert.equal(secretWriteTarget(command.split(" ")), target);
  });
}

test("opsSubject quotes any word holding whitespace or shell syntax", () => {
  assert.equal(opsSubject(["gh", "release", "create", "v1 --draft", "a;b"]), "gh release create 'v1 --draft' 'a;b'");
});
