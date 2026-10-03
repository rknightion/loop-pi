// lane.ts with an ops identity (S6): allow patterns, secret paths, credential creation, the
// single-flight surface lock, and the loop control files every lane is refused.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import laneExtension from "./lane.ts";
import { acquireOpsLock } from "./ops-lock.ts";
import { HOOK_TEMPLATES_DIR } from "../test-support/hook-templates.ts";

type Handler = (event: any, ctx: any) => any;

let agentDir: string;
let lockDir: string;

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "loop-guard-lane-ops-test-"));
  lockDir = join(agentDir, "ops-locks");
  await cp(HOOK_TEMPLATES_DIR, join(agentDir, "scripts"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.LOOP_PI_OPS_LOCK_DIR = lockDir;
});

after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.LOOP_PI_OPS_LOCK_DIR;
  delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  await rm(agentDir, { recursive: true, force: true });
});

const RELEASE = {
  surface: "release:svc",
  kind: "release",
  // The second pattern has no `$`: the guard anchors both ends itself.
  allow: ["^gh release (create|edit) v[0-9]+\\.[0-9]+\\.[0-9]+( --draft=false)?$", "^gh release delete v0\\.9\\.0"],
};
const SECRET = {
  surface: "secret:svc-token",
  kind: "secret-write",
  allow: ["^vault kv put( -mount=kv)? [^ ]+ value=-$", "^gh secret set [A-Z_]+ --body -$", "^vault token create( .*)?$"],
  secret_paths: ["kv/ci/svc/token", "SVC_TOKEN"],
};
const CREDENTIAL = { surface: "cred:svc", kind: "credential-create", allow: ["^vault token create -policy=svc$"] };

/** Load lane.ts under `binding` (the env the root's binding becomes) and return its handlers. */
function lane(binding: unknown) {
  if (binding === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify(binding);
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  };
  laneExtension(api as any);
  const toolCall = handlers.get("tool_call")![0];
  const ctx = { cwd: agentDir, ui: { notify: () => {} } };
  return {
    bash: (command: string) => toolCall({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command } }, ctx),
    tool: (toolName: string, input: Record<string, unknown>) => toolCall({ type: "tool_call", toolCallId: "1", toolName, input }, ctx),
    shutdown: async () => {
      for (const h of handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown" }, ctx);
    },
  };
}

const opsBinding = (entry: Record<string, unknown>, agent = "ops") => ({ "loop-pi.guard/1": { agent, surface: entry.surface, entry } });

/** An ops lane on `entry`'s surface, retried briefly until the surface lock is no longer held. */
async function laneWhenFree(entry: Record<string, unknown>) {
  let l = lane(opsBinding(entry));
  for (let i = 0; i < 40 && (await l.bash("ls"))?.block; i++) {
    await l.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    l = lane(opsBinding(entry));
  }
  return l;
}

async function assertVerdict(l: ReturnType<typeof lane>, command: string, blocked: boolean, reason?: RegExp) {
  const result = await l.bash(command);
  assert.equal(result?.block ?? false, blocked, `${command}: ${result?.reason ?? "allowed"}`);
  if (reason) assert.match(result?.reason ?? "", reason, command);
}

test("ops lane: a forbidden command passes only on a full allow match", async () => {
  // A surface of its own, so a lock still being dropped by another test cannot block this one.
  const l = lane(opsBinding({ ...RELEASE, surface: "release:svc-allow" }));
  try {
    await assertVerdict(l, "gh release create v1.2.3", false);
    await assertVerdict(l, "gh release edit v1.2.3 --draft=false", false);
    await assertVerdict(l, "gh release create v1.2.3 --target other", true, /does not fully match/);
    await assertVerdict(l, "GH_REPO=other/repo gh release create v1.2.3", true, /does not fully match/);
    await assertVerdict(l, "gh release delete v1.2.3", true, /does not fully match/);
    await assertVerdict(l, "gh release delete v0.9.0", false);
    await assertVerdict(l, "gh release delete v0.9.0 --cleanup-tag", true, /does not fully match/);
    await assertVerdict(l, "gh workflow run deploy.yml", true, /does not fully match/);
    await assertVerdict(l, "echo ok && gh release create v1.2.3", false);
    await assertVerdict(l, "gh release create 'v1.2.3 --draft=false'", true, /does not fully match/);
  } finally {
    await l.shutdown();
  }
});

test("ops lane: every other rule stays (force push, push grant, git add -A, background, control files)", async () => {
  const l = lane(opsBinding({ ...RELEASE, surface: "release:svc-rules", allow: ["^git push origin main$", "^.*$"] }));
  try {
    await assertVerdict(l, "git push --force origin main", true, /force-push/);
    await assertVerdict(l, "git push origin main", true, /push-granted/);
    await assertVerdict(l, "git add -A", true);
    await assertVerdict(l, "sleep 100 &", true);
    await assertVerdict(l, "echo x > codex/state-c-loop1.jsonl", true, /belong to the root/);
    await assertVerdict(l, "python3 -c \"import os; os.system('gh release delete v1')\"", true, /fallback/);
  } finally {
    await l.shutdown();
  }
});

test("ops lane: a secret write passes only to an exact secret_paths member", async () => {
  const l = lane(opsBinding(SECRET));
  try {
    await assertVerdict(l, "vault kv put kv/ci/svc/token value=-", false);
    await assertVerdict(l, "vault kv put -mount=kv ci/svc/token value=-", false);
    await assertVerdict(l, "gh secret set SVC_TOKEN --body -", false);
    await assertVerdict(l, "vault kv put kv/ci/other/token value=-", true, /not in secret_paths/);
    await assertVerdict(l, "vault kv put kv/ci/svc/token/extra value=-", true, /not in secret_paths/);
    await assertVerdict(l, "gh secret set OTHER_TOKEN --body -", true, /not in secret_paths/);
    await assertVerdict(l, "vault token create -policy=svc", true, /not credential-create/);
  } finally {
    await l.shutdown();
  }
});

test("ops lane: credential creation passes only for kind credential-create", async () => {
  const granted = lane(opsBinding(CREDENTIAL));
  try {
    await assertVerdict(granted, "vault token create -policy=svc", false);
    await assertVerdict(granted, "vault token create -policy=admin", true, /does not fully match/);
  } finally {
    await granted.shutdown();
  }
  const plain = lane(undefined);
  await assertVerdict(plain, "vault token create -policy=svc", true, /credential creation, blocked for lanes/);
  await assertVerdict(plain, "aws --region eu-west-2 iam create-access-key --user-name ci", true, /credential creation/);
});

test("a binding forged for a non-ops agent grants nothing", async () => {
  const l = lane(opsBinding(RELEASE, "lane-worker"));
  try {
    await assertVerdict(l, "gh release create v1.2.3", true, /blocked for lanes/);
  } finally {
    await l.shutdown();
  }
});

test("ops lane: a held surface lock blocks every command; the lock is released at shutdown", { timeout: 30_000 }, async () => {
  const other = await acquireOpsLock(RELEASE.surface, { dir: lockDir });
  assert.equal(other.state, "held");
  const blocked = lane(opsBinding(RELEASE));
  try {
    await assertVerdict(blocked, "gh release create v1.2.3", true, /single-flight.*another ops lane/);
    await assertVerdict(blocked, "ls", true, /single-flight/);
  } finally {
    await blocked.shutdown();
    other.release();
  }
  // A released holder exits asynchronously; wait until the same surface is free again.
  const first = await laneWhenFree(RELEASE);
  await assertVerdict(first, "ls", false);
  await first.shutdown();
  const next = await laneWhenFree(RELEASE);
  await assertVerdict(next, "gh release create v1.2.3", false);
  await next.shutdown();
});

test("every lane: edit and write into codex/ops-*, codex/state-*, codex/goal-* are refused exactly", async () => {
  const l = lane(undefined);
  await mkdir(join(agentDir, "codex"), { recursive: true });
  await symlink(join(agentDir, "codex", "ops-c-loop1.json"), join(agentDir, "innocent.json"));
  for (const [toolName, path] of [
    ["write", "codex/ops-c-loop1.json"],
    ["edit", `${agentDir}/codex/state-c-loop1.jsonl`],
    ["write", "./x/../codex/goal-c-loop1.md"],
    ["write", "@codex/GOAL-c-loop1.md"],
    ["write", "innocent.json"],
  ]) {
    const result = await l.tool(toolName, { path, content: "x", edits: [] });
    assert.equal(result?.block, true, `${toolName} ${path}`);
    assert.match(result?.reason ?? "", /belong to the root/);
  }
  const fine = await l.tool("write", { path: "codex/report-c-loop1.md", content: "x" });
  assert.equal(fine?.block ?? false, false, fine?.reason);
});

test("every lane: bash writes into loop control files are refused, reads are not", async () => {
  const l = lane(undefined);
  for (const command of [
    "echo '{}' > codex/ops-c-loop1.json",
    "printf x >> codex/state-c-loop1.jsonl",
    "jq . a.json 2>&1 >| codex/goal-c-loop1.md",
    "cat a | tee -a codex/state-c-loop1.jsonl",
    "cp /tmp/x codex/ops-c-loop1.json",
    "mv codex/ops-c-loop1.json /tmp/x",
    "rm -rf codex",
    "rm codex/*.json",
    "sed -i s/a/b/ codex/goal-c-loop1.md",
    "bash -c 'echo x > codex/ops-c-loop1.json'",
    "loop-state append codex/state-c-loop1.jsonl land task=T-1",
  ]) {
    await assertVerdict(l, command, true, /belong to the root/);
  }
  for (const command of ["cat codex/ops-c-loop1.json", "loop-state digest codex/state-c-loop1.jsonl", "echo x > codex/report-c-loop1.md"]) {
    await assertVerdict(l, command, false);
  }
});
