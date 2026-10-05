// Ops grant class: the root's launch check, the lane binding parse and the surface lock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateOpsLaunch, knownInterpreterNetwork, opsSurfaceLines, parseLaneBinding, validateOpsEntry, type OpsEntry } from "./ops.ts";
import laneExtension from "./lane.ts";
import { acquireOpsLock, opsLockPath } from "./ops-lock.ts";
import { bindLaneIdentity } from "./push-grant.ts";
import { opsSubject, parseCommand, secretWriteTarget } from "./rules.ts";

// All URLs below are synthetic; handlers are called directly and no shell payload executes.
const NETWORK_CODE = [
  'import urllib.request; req = urllib.request.Request("https://other.example.com/health"); print(urllib.request.urlopen(req).read())',
  'from urllib.request import Request, urlopen; print(urlopen(Request("https://other.example.com/health")).read())',
  'from urllib import request as r; r.urlopen("https://other.example.com/health")',
  'from urllib import (request as r); r.urlopen("https://other.example.com/health")',
  'from urllib import (\n parse,\n request as r,\n)\nr.urlopen("https://other.example.com/health")',
  'from http import (client as h); h.HTTPSConnection("other.example.com")',
  'import requests; print(requests.get("https://other.example.com/health").status_code)',
  'import requests as r; session = r.Session(); session.get("https://other.example.com/health")',
  'import requests.api as r; r.get("https://other.example.com/health")',
  'if True: import requests as r; r.get("https://other.example.com/health")',
  `value = 1 # user's comment\nimport requests as r\nr.get('https://other.example.com/health')`,
  'if True: from urllib.request import urlopen as u; u("https://other.example.com/health")',
  'import httpx as h; h.get("https://other.example.com/health")',
  'import aiohttp; client = aiohttp.ClientSession()',
  'import http.client; conn = http.client.HTTPSConnection("other.example.com")',
  'from http import client as h; h.HTTPSConnection("other.example.com")',
  'import socket as s; s.create_connection(("other.example.com", 443))',
];

for (const code of NETWORK_CODE) {
  test(`network classifier: ${code}`, () => assert.equal(knownInterpreterNetwork(code), true));
}

test("network classifier: local JSON, URL parsing, printed code and comments are not network clients", () => {
  for (const code of [
    'import json; print(json.loads("{}"))',
    'from urllib.parse import urlparse; print(urlparse("https://service.example.com/health"))',
    'from urllib import (parse as request); print(request.urlparse("https://service.example.com/health"))',
    'print("requests.get(endpoint)")',
    'print("require(\\\"https\\\")")',
    '# import requests\nimport json',
    'import json; print(json.loads("{}")) # ; import requests',
    'import json; print(json.loads(\'{"value":"# ; import requests"}\'))',
    'import json; print(json.loads(\'{"code": "; import requests"}\'))',
  ]) assert.equal(knownInterpreterNetwork(code), false, code);
});

test("ops network forms: real bash/watch_process handlers refuse clients, preserve helpers and honour explicit forms", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-network-handler-"));
  const keys = ["PI_CODING_AGENT_DIR", "LOOP_PI_OPS_LOCK_DIR", "PI_SUBAGENT_EXTENSION_BINDINGS", "LOOP_PI_RUN_DIR", "LOOP_PI_REPO"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.LOOP_PI_OPS_LOCK_DIR = join(dir, "locks");
  delete process.env.LOOP_PI_RUN_DIR;
  delete process.env.LOOP_PI_REPO;
  const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const python = (code: string) => opsSubject(["python3", "-c", code]);
  const explicit = python(NETWORK_CODE[0]);
  const stdin = `python3 - <<'PY'\n${NETWORK_CODE[0]}\nPY`;
  const wrapped = `env MODE=probe bash -c ${JSON.stringify(explicit)}`;
  const grantedGroup = `( ${explicit} )`;
  const alias = (name: string) => opsSubject(["git", "-c", `alias.${name}=!${explicit}`, name]);
  const grantedAlias = alias("readback");
  const expansionCode = 'import requests; requests.get("https://service.example.com/$PART")';
  const literalExpansion = python(expansionCode);
  const shellExpansion = `python3 -c "${expansionCode.replace(/"/g, '\\"')}"`;
  const ungrantedGroups = [
    `(${explicit})`,
    `{ ${explicit}; }`,
    `( ( ${explicit} ) )`,
    `{\n${explicit}\n}`,
    `( ${explicit} ) > result.json`,
  ];
  const normal = [
    "curl -fsS https://service.example.com/health",
    "ssh service.example.com uptime",
    python('import json; print(json.loads("{}"))'),
    python('from urllib.parse import urlparse; print(urlparse("https://service.example.com/health"))'),
    python('print("requests.get(endpoint)")'),
    "git status --short", "cat result.json", "ls -l result.json",
    `cat <<'PY'\n${NETWORK_CODE[0]}\nPY`,
    "python3 -m json.tool result.json",
    `( ${python('import json; print(json.loads("{}"))')} )`,
    `{ ${python('import json; print(json.loads("{}"))')}; }`,
  ];
  const blocked = [
    ...NETWORK_CODE.map(python),
    `env MODE=probe /usr/bin/python3 -c '${NETWORK_CODE[0]}'`,
    `bash -c ${JSON.stringify(python(NETWORK_CODE[0]))}`,
    stdin,
    `cat <<'PY' | python3 -\n${NETWORK_CODE[0]}\nPY`,
    `python3 <<< '${NETWORK_CODE[0]}'`,
    'python3 -m requests https://other.example.com/health',
    'node -e \'fetch("https://other.example.com/health")\'',
    'node -e \'const https = require("https"); https.get("https://other.example.com/health")\'',
    'node --input-type=module -e \'import axios from "axios"; axios.get("https://other.example.com/health")\'',
    'ruby -e \'require "net/http"; Net::HTTP.get(URI("https://other.example.com/health"))\'',
    'perl -e \'use HTTP::Tiny; HTTP::Tiny->new->get("https://other.example.com/health")\'',
  ];
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const load = (allow: string[], suffix: string) => {
    const entry = { surface: `probe:synthetic-${suffix}`, kind: "probe", allow };
    process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "loop-pi.guard/1": { agent: "ops-probe", surface: entry.surface, entry } });
    handlers.clear();
    laneExtension({ on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {};
    } } as any);
  };
  const ctx = { cwd: dir, ui: { notify() {} } };
  const shutdown = async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
  };
  const verdict = async (toolName: string, command: string, expected: boolean) => {
    const input = { command };
    const result = await handlers.get("tool_call")![0]({ type: "tool_call", toolCallId: "synthetic", toolName, input }, ctx);
    assert.equal(result?.block ?? false, expected, `${toolName}: ${command}: ${result?.reason ?? "allowed"}`);
    if (expected) assert.match(result.reason, /known interpreter network command/);
  };
  try {
    load(normal.slice(0, 2).map(escapePattern), "literal");
    for (const toolName of ["bash", "watch_process"]) {
      for (const command of normal) await verdict(toolName, command, false);
      for (const command of blocked) await verdict(toolName, command, true);
    }
    await shutdown();
    const subject = opsSubject(parseCommand(explicit)!.segments[0]);
    load([escapePattern(subject), escapePattern(stdin), escapePattern(wrapped), escapePattern(grantedGroup), escapePattern(grantedAlias), escapePattern(literalExpansion)], "explicit");
    for (const toolName of ["bash", "watch_process"]) {
      await verdict(toolName, literalExpansion, false);
      await verdict(toolName, shellExpansion, true);
      await verdict(toolName, python('import json; print(json.loads("{}")) # ; import requests'), false);
      await verdict(toolName, explicit, false);
      await verdict(toolName, stdin, false);
      await verdict(toolName, python(NETWORK_CODE[3]), true);
      await verdict(toolName, `${explicit} extra`, true);
      await verdict(toolName, `env MODE=other ${explicit}`, true);
      await verdict(toolName, `bash -c ${JSON.stringify(explicit)}`, true);
      await verdict(toolName, `env MODE=other bash -c ${JSON.stringify(explicit)}`, true);
      await verdict(toolName, `echo local; ${explicit}`, true);
      await verdict(toolName, wrapped, false);
      for (const group of ungrantedGroups) await verdict(toolName, group, true);
      await verdict(toolName, grantedGroup, false);
      await verdict(toolName, alias("other"), true);
      await verdict(toolName, `env MODE=other ${grantedAlias}`, true);
      await verdict(toolName, grantedAlias, false);
    }
    await shutdown();
    // Declaration discovery uses a worktree marker; no Git process or gate payload executes.
    load([escapePattern(shellExpansion)], "explicit-expansion");
    for (const toolName of ["bash", "watch_process"]) {
      await verdict(toolName, shellExpansion, false);
      await verdict(toolName, shellExpansion.replace("$PART", "$OTHER"), true);
    }
    await shutdown();
    await writeFile(join(dir, ".git"), "");
    await writeFile(join(dir, "LOOP.md"), `## Mutexes\n- gate: interpreter-probe | ${explicit}\n`);
    load([escapePattern(subject)], "gate-direct");
    for (const toolName of ["bash", "watch_process"]) await verdict(toolName, "loop-gate-lock interpreter-probe", true);
    await shutdown();
    load([escapePattern("loop-gate-lock interpreter-probe")], "gate-wrapper");
    for (const toolName of ["bash", "watch_process"]) await verdict(toolName, "loop-gate-lock interpreter-probe", false);
    await shutdown();
    load([".*"], "unparseable");
    await verdict("bash", "python3 -c 'import requests; requests.get(endpoint)", true);
  } finally {
    await shutdown();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  }
});

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
    name: "allow pattern that does not compile",
    input: { agent: "ops", task: brief("deploy:svc-worker") },
    ops: { v: 1, ops: [{ ...DEPLOY, allow: ["just deploy ("] }] },
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
  { name: "entry with a pattern that does not compile", binding: { "loop-pi.guard/1": { agent: "ops", surface: DEPLOY.surface, entry: { ...DEPLOY, allow: ["(.*"] } } } },
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

// ---------------------------------------------------------------------------
// SEAMS S8: no separate `^` requirement (full match stays), agent `ops-probe` bound only to
// kind `probe`, and the optional `runDir` binding field.
// ---------------------------------------------------------------------------

const PROBE: OpsEntry = { surface: "probe:svc-health", kind: "probe", allow: ["curl -fsS https://svc\\.example\\.com/health"] };
const OPS_WITH_PROBE = { v: 1, ops: [DEPLOY, RELEASE, PROBE] };

test("ops entry: an allow pattern without a leading ^ is valid and launches", () => {
  const unanchored = { ...DEPLOY, allow: ["just deploy( .*)?"] };
  assert.ok(validateOpsEntry(unanchored));
  const decision = evaluateOpsLaunch({ agent: "ops", task: brief("deploy:svc-worker") }, { v: 1, ops: [unanchored] }, never);
  assert.equal(decision.block, false, decision.block ? decision.reason : "");
  assert.deepEqual(parseLaneBinding(JSON.stringify({ "loop-pi.guard/1": { agent: "ops", surface: DEPLOY.surface, entry: unanchored } })).ops, {
    surface: DEPLOY.surface,
    entry: unanchored,
  });
});

test("ops launch refusal text no longer asks for patterns anchored with ^", () => {
  const decision = evaluateOpsLaunch({ agent: "ops", task: brief("deploy:svc-worker") }, { v: 1, ops: [{ ...DEPLOY, allow: ["("] }] }, never);
  assert.equal(decision.block, true);
  assert.doesNotMatch(decision.block ? decision.reason : "", /anchored/);
});

test("ops-probe launch: a probe surface binds its full entry", () => {
  const decision = evaluateOpsLaunch({ agent: "ops-probe", task: brief("probe:svc-health") }, OPS_WITH_PROBE, never);
  assert.equal(decision.block, false, decision.block ? decision.reason : "");
  assert.deepEqual(decision.block === false && decision.entry, PROBE);
  const input: Record<string, unknown> = { agent: "ops-probe", task: "x", extensionBindings: { "spoof/1": {} } };
  bindLaneIdentity(input, "ops-probe", PROBE);
  assert.deepEqual(input.extensionBindings, { "loop-pi.guard/1": { agent: "ops-probe", surface: PROBE.surface, entry: PROBE } });
  const lane = parseLaneBinding(JSON.stringify(input.extensionBindings));
  assert.equal(lane.agent, "ops-probe");
  assert.deepEqual(lane.ops, { surface: PROBE.surface, entry: PROBE });
});

test("ops-probe launch: a deploy, release or secret-write surface is refused", () => {
  for (const surface of ["deploy:svc-worker", "release:svc"]) {
    const decision = evaluateOpsLaunch({ agent: "ops-probe", task: brief(surface) }, OPS_WITH_PROBE, never);
    assert.equal(decision.block, true, surface);
    assert.match(decision.block ? decision.reason : "", /ops-probe.*probe/);
  }
});

test("ops may still bind a probe surface", () => {
  const decision = evaluateOpsLaunch({ agent: "ops", task: brief("probe:svc-health") }, OPS_WITH_PROBE, never);
  assert.deepEqual(decision.block === false && decision.entry, PROBE);
});

test("ops-probe launch: single flight, launched alone, and refused with no frozen ops", () => {
  const active = evaluateOpsLaunch({ agent: "ops-probe", task: brief("probe:svc-health") }, OPS_WITH_PROBE, (s) => s === PROBE.surface);
  assert.match(active.block ? active.reason : "", /already active/);
  const parallel = evaluateOpsLaunch({ tasks: [{ agent: "ops-probe", task: brief("probe:svc-health") }] }, OPS_WITH_PROBE, never);
  assert.match(parallel.block ? parallel.reason : "", /may only be launched alone/);
  const none = evaluateOpsLaunch({ agent: "ops-probe", task: brief("probe:svc-health") }, null, never);
  assert.match(none.block ? none.reason : "", /no ops grants are frozen/);
  const noLine = evaluateOpsLaunch({ agent: "ops-probe", task: brief() }, OPS_WITH_PROBE, never);
  assert.match(noLine.block ? noLine.reason : "", /exactly one `Ops surface/);
});

test("ops-probe binding: refuses a non-probe entry and a missing entry; a forged non-probe binding grants nothing", () => {
  assert.throws(() => bindLaneIdentity({}, "ops-probe", DEPLOY), /probe/);
  assert.throws(() => bindLaneIdentity({}, "ops-probe"), /requires its ops entry/);
  const forged = parseLaneBinding(JSON.stringify({ "loop-pi.guard/1": { agent: "ops-probe", surface: DEPLOY.surface, entry: DEPLOY } }));
  assert.equal(forged.agent, "ops-probe");
  assert.equal(forged.ops, undefined);
});

test("binding runDir: optional, carried when given, ignored when not an absolute path", () => {
  const input: Record<string, unknown> = { agent: "lane-worker-push", task: "x" };
  bindLaneIdentity(input, "lane-worker-push", undefined, { runDir: "/runs/loop-a" });
  assert.deepEqual(input.extensionBindings, { "loop-pi.guard/1": { agent: "lane-worker-push", runDir: "/runs/loop-a" } });
  assert.equal(parseLaneBinding(JSON.stringify(input.extensionBindings)).runDir, "/runs/loop-a");
  const ops: Record<string, unknown> = { agent: "ops", task: "x" };
  bindLaneIdentity(ops, "ops", DEPLOY, { runDir: "/runs/loop-a" });
  assert.deepEqual(ops.extensionBindings, { "loop-pi.guard/1": { agent: "ops", surface: DEPLOY.surface, entry: DEPLOY, runDir: "/runs/loop-a" } });
  const parsed = parseLaneBinding(JSON.stringify(ops.extensionBindings));
  assert.equal(parsed.runDir, "/runs/loop-a");
  assert.deepEqual(parsed.ops, { surface: DEPLOY.surface, entry: DEPLOY });
  const bare: Record<string, unknown> = {};
  bindLaneIdentity(bare, "mapper", undefined, {});
  assert.deepEqual(bare.extensionBindings, { "loop-pi.guard/1": { agent: "mapper" } }, "no runDir key without a run dir");
  assert.equal(parseLaneBinding(JSON.stringify({ "loop-pi.guard/1": { agent: "mapper", runDir: "relative/run" } })).runDir, undefined);
  assert.equal(parseLaneBinding(JSON.stringify({ "loop-pi.guard/1": { agent: "mapper", runDir: 7 } })).runDir, undefined);
});
