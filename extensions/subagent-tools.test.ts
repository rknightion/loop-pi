// pi-subagents 0.78.0 declares a `contact_supervisor` stub at the top level whenever `subagent` is
// registered (extension/index.js registerPinnedTool(pi, topLevelSupervisorTool())): it only returns an
// error there, and it costs tokens on every root request. A child registers the working tool itself
// (intercom/native-supervisor-channel.js registerNativeSupervisorClient), so the root can drop the stub
// with the launcher's `--exclude-tools` without touching children, which are separate pi processes
// started by pi-subagents with their own argument list. A child only gets the tool when the
// intercom bridge is active (child-launch.js creates the supervisor channel only then).
//
// This drives the pinned pi CLI with the launcher's exact exclusion list (read from bin/loop-pi-install,
// so the test follows the shipped flags) against a local Responses peer, and reads the `tools` array
// of the requests on the wire: once for the root, once for a real child process it launches.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { cleanupAll, freshDir, PI_SUBAGENTS_PACKAGE_DIR, startPiRpc, waitForCondition } from "./loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
after(cleanupAll);

/** The tool names the shipped root launcher excludes. */
function launcherExclusions(): string[] {
  const match = /--exclude-tools ([A-Za-z0-9_,]+)\s/.exec(readFileSync(join(ROOT, "bin/loop-pi-install"), "utf8"));
  assert.ok(match, "bin/loop-pi-install passes --exclude-tools to the root");
  return match[1].split(",");
}

interface Capture { root: string[]; child: string[] }

async function captureDeclaredTools(exclusions: string[], extraChildTools = "", bridge?: "always"): Promise<Capture> {
  const home = freshDir("subagent-tools-home-");
  const cwd = freshDir("subagent-tools-work-");
  const requests: { kind: "root" | "child"; tools: string[] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input: any[] = body.input ?? [];
    const kind = input.some((item) => item?.type === "function_call_output") ? "root"
      : JSON.stringify(input).includes("CHILD_PROOF") ? "child" : "root";
    requests.push({ kind, tools: (body.tools ?? []).map((tool: any) => tool.name) });
    const n = requests.length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ type: "response.created", response: { id: `resp_${n}`, status: "in_progress", output: [] } });
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
    let item: any;
    if (n === 1) {
      item = { id: "fc_child", type: "function_call", call_id: "call_child", name: "subagent",
        arguments: JSON.stringify({ agent: "probe", task: "CHILD_PROOF", async: true, worktree: false }) };
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
    } else {
      item = { id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] };
    }
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response: { id: `resp_${n}`, status: "completed", output: [item], usage } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  writeFileSync(join(home, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test", api: "openai-responses",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  } } }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] }, retry: { enabled: false },
  }));
  // The home's own pi-subagents config (eager activation, no intercom bridge), with its paths filled in.
  mkdirSync(join(home, "extensions/subagent"), { recursive: true });
  const config = JSON.parse(readFileSync(join(ROOT, "home/extensions/subagent/config.json"), "utf8")
    .replaceAll("{{HOME}}", home).replaceAll("{{PREFIX}}", ROOT));
  if (bridge) config.intercomBridge = { mode: bridge };
  writeFileSync(join(home, "extensions/subagent/config.json"), JSON.stringify(config));
  // A child with the shipped worker's tool allowlist, plus whatever a lane would add to it.
  const workerTools = /^tools: (.*)$/m.exec(readFileSync(join(ROOT, "home/agents/worker.md"), "utf8"))![1] + extraChildTools;
  mkdirSync(join(home, "agents"));
  writeFileSync(join(home, "agents/probe.md"), `---\nname: probe\ndescription: Declared-tools proof\ntools: ${workerTools}\nextensions: []\nmodel: fixture/fixture\n---\nComplete the proof.\n`);

  const session = startPiRpc({
    extensions: [], extraArgs: ["--provider", "fixture", "--model", "fixture", "--exclude-tools", exclusions.join(",")],
    sessionArgs: [], agentDir: home, subagentTempRoot: freshDir("subagent-tools-sub-"), cwd, fauxScriptPath: "",
  });
  try {
    session.send({ type: "prompt", id: "go", message: "GO" });
    await waitForCondition(() => (requests.some((r) => r.kind === "child") && requests.some((r) => r.kind === "root") ? true : undefined), 30_000);
    const root = requests.find((r) => r.kind === "root")!.tools;
    const child = requests.find((r) => r.kind === "child")!.tools;
    return { root, child };
  } catch (error) {
    throw new Error(`${error}\nrequests: ${JSON.stringify(requests)}\nstderr:\n${session.stderr.join("")}`);
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the launcher's root declares no contact_supervisor stub, while a child's working tool is kept", { timeout: 90_000 }, async () => {
  const exclusions = launcherExclusions();
  // intercomBridge "always" is what gives a child the tool (see the next test for the shipped "off").
  const { root, child } = await captureDeclaredTools(exclusions, "", "always");
  assert.ok(root.includes("subagent"), `the root can delegate: ${root.join(",")}`);
  for (const name of exclusions) assert.ok(!root.includes(name), `the root's request omits ${name}: ${root.join(",")}`);
  assert.ok(!root.includes("contact_supervisor"), `the root's request omits contact_supervisor: ${root.join(",")}`);
  assert.ok(root.includes("subagent_supervisor"), `the root keeps the tool it answers children with: ${root.join(",")}`);
  assert.ok(child.includes("contact_supervisor"), `the child's request still declares contact_supervisor: ${child.join(",")}`);
});

test("the exclusion changes no child's tools under the shipped config", { timeout: 90_000 }, async () => {
  // The shipped config has intercomBridge "off", which gives no child contact_supervisor, with or
  // without the root exclusion: the supervisor channel is only created when the bridge is active.
  const shipped = await captureDeclaredTools(launcherExclusions());
  const bare = await captureDeclaredTools(["subagents_enable"]);
  assert.deepEqual(shipped.child, bare.child);
  assert.ok(!shipped.child.includes("contact_supervisor"));
});

test("without the exclusion the root declares the stub (the hazard this fixes)", { timeout: 90_000 }, async () => {
  const { root } = await captureDeclaredTools(["subagents_enable"]);
  assert.ok(root.includes("contact_supervisor"), `pi-subagents 0.78.0 declares the stub at the top level: ${root.join(",")}`);
});
