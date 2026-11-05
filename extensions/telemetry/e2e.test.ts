// Compatibility smoke on the pinned pi and pi-subagents: a real root RPC session and real native
// background lanes (a senior and the scout it launches) export through the agent-file allowlist
// to an in-process OTLP receiver. Capture switches are set in the invoking environment; the
// receiver must still see metadata only, and each lane must export before its runner exits.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, cleanupAllAfterExit, expectDetachedRuns, freshDir, startPiRpc, waitForCondition,
} from "../loop-guard/rpc-test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
after(() => cleanupAllAfterExit());

const MARK = "CONTENTMARK";

interface Received { path: string; auth: string | undefined; body: any; raw: string; at: number }

type KV = { key: string; value: Record<string, unknown> };
function attrs(list: KV[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of list ?? []) out[key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.arrayValue ?? value;
  return out;
}

function logRecords(received: Received[]) {
  return received.filter((r) => r.path.endsWith("/v1/logs")).flatMap((r) => r.body.resourceLogs.flatMap((rl: any) =>
    rl.scopeLogs.flatMap((sl: any) => sl.logRecords.map((record: any) => ({ at: r.at, name: record.eventName, resource: attrs(rl.resource.attributes), attributes: attrs(record.attributes) })))));
}

function spans(received: Received[]) {
  return received.filter((r) => r.path.endsWith("/v1/traces")).flatMap((r) => r.body.resourceSpans.flatMap((rs: any) =>
    rs.scopeSpans.flatMap((ss: any) => ss.spans.map((span: any) => ({ name: span.name, resource: attrs(rs.resource.attributes), attributes: attrs(span.attributes) })))));
}

test("root, lane and nested lane export metadata-only GenAI telemetry through the allowlist seam", { timeout: 180_000 }, async () => {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { /* recorded raw */ }
    received.push({ path: req.url ?? "", auth: req.headers.authorization, body, raw, at: Date.now() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fixture = freshDir("telemetry-e2e-");
  const home = join(fixture, "home");
  const cwd = join(fixture, "repo");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
  mkdirSync(cwd);
  const credential = `fixture-${Math.random().toString(36).slice(2)}`;
  const configFile = join(fixture, "config.env");
  writeFileSync(configFile, [
    `AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}/otlp`, "AGENTO11Y_AUTH_TENANT_ID=4242",
    `AGENTO11Y_AUTH_TOKEN=${credential}`, "AGENTO11Y_CONTENT_CAPTURE_MODE=full", "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] }, retry: { enabled: false },
    loopPi: {
      modelFamily: { provider: "faux", pattern: "^faux-1$", name: "faux" },
      rootRoute: { provider: "faux", model: "faux-1", thinking: "off" },
      telemetry: { configFile, context: "fixture", exportTimeoutMs: 1500 },
    },
  }));
  const config = JSON.parse(readFileSync(join(ROOT, "home/extensions/subagent/config.json"), "utf8").replaceAll("{{HOME}}", home).replaceAll("{{PREFIX}}", ROOT));
  writeFileSync(join(home, "extensions/subagent/config.json"), JSON.stringify(config));
  // The shipped agents' `extensions:` allowlist line, rendered for this checkout.
  const allowlist = /^extensions: (.*)$/m.exec(readFileSync(join(ROOT, "home/agents/scout.md"), "utf8"))![1].replaceAll("{{PREFIX}}", ROOT);
  assert.equal(allowlist, join(ROOT, "extensions/telemetry/lane.ts"));
  const envDump = join(fixture, "lane-env.json");
  for (const agent of ["senior", "scout"]) writeFileSync(join(home, "agents", `${agent}.md`), [
    "---", `name: ${agent}`, "description: Telemetry fixture", `tools: ${agent === "senior" ? "bash, subagent" : "bash"}`,
    ...(agent === "senior" ? ["allowedAgents: scout"] : []), `extensions: ${allowlist}`, `subagentOnlyExtensions: ${FAUX_EXTENSION}`,
    "model: faux/faux-1", "async: true", "timeoutMs: 60000", "---", "Synthetic fixture only.",
  ].join("\n"));
  const script = join(fixture, "faux.json");
  writeFileSync(script, JSON.stringify({ rules: [
    { match: "ROOT_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "senior", task: `SENIOR_GO ${MARK} brief`, async: true } }] },
    { match: "SENIOR_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "scout", task: `SCOUT_GO ${MARK} brief`, async: true } }] },
    { match: "SCOUT_GO", once: true, toolCalls: [{ name: "bash", args: { command: `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' '${envDump}'; echo ${MARK}-result /${MARK}/path` } }] },
    { match: ".*", text: `${MARK} reply` },
  ] }));

  const subagentTempRoot = freshDir("telemetry-e2e-sub-");
  expectDetachedRuns(subagentTempRoot, 1);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, join(HERE, "root.ts")], sessionArgs: [], agentDir: home, subagentTempRoot, cwd,
    fauxScriptPath: script,
    env: {
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true", OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "1", PI_OTEL_CAPTURE_CONTENT: "true", AGENTO11Y_CONTENT_CAPTURE_MODE: "full",
    },
  });
  try {
    session.send({ type: "prompt", message: `ROOT_GO ${MARK} prompt` });
    // The senior's own run completes once its nested scout has returned to it.
    const terminal = await waitForCondition(() => {
      const runsDir = join(subagentTempRoot, "async-subagent-runs");
      let run: string | undefined;
      try { run = readdirSync(runsDir).find((name) => !name.startsWith(".")); } catch { return; }
      if (!run) return;
      try {
        const status = JSON.parse(readFileSync(join(runsDir, run, "status.json"), "utf8"));
        assert.notEqual(status.state, "failed", `lane failed: ${status.error}`);
        return status.state === "complete" && status.processTerminal?.state === "observed" ? Date.now() : undefined;
      } catch (error) { if (error instanceof assert.AssertionError) throw error; return; }
    }, 120_000, 100);
    // Each lane flushed during its own session_shutdown, before its runner exited.
    const laneEnds = logRecords(received).filter((r) => r.name === "pi.session.end" && r.attributes["loop_pi.role"] === "lane");
    // A direct lane is named by the root guard's identity binding; a nested lane has none.
    assert.deepEqual(laneEnds.map((r) => r.attributes["gen_ai.agent.name"]).sort(), ["loop-pi-lane", "senior"]);
    assert.ok(laneEnds.every((r) => r.at <= terminal), "lane telemetry arrived before the lane run was terminal");
    await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify", 30_000);
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    await session.close();
    await waitForCondition(() => logRecords(received).some((r) => r.name === "pi.session.end" && r.attributes["loop_pi.role"] === "root") || undefined, 10_000, 50);
  } catch (error) {
    throw new Error(`${error}\nstderr:\n${session.stderr.join("")}`);
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual([...new Set(received.map((r) => r.path))].sort(), ["/otlp/v1/logs", "/otlp/v1/traces"], "spans and logs only, no metrics");
  const expectedAuth = `Basic ${Buffer.from(`4242:${credential}`).toString("base64")}`;
  assert.ok(received.every((r) => r.auth === expectedAuth), "every export carries the configured header");
  const everything = received.map((r) => r.raw).join("\n");
  assert.equal(everything.includes(MARK), false, "no prompt, brief, reply, tool argument, tool result or path is exported");
  assert.equal(everything.includes(credential), false);
  assert.equal(everything.includes(cwd), false);

  // The credential never reaches a lane's tool environment.
  const laneEnv = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
  assert.equal(Object.values(laneEnv).some((value) => value.includes(credential)), false);

  const logs = logRecords(received);
  const allSpans = spans(received);
  const sessions = new Map<string, Set<string>>();
  for (const item of [...logs, ...allSpans]) {
    const id = item.attributes["session.id"] as string;
    assert.equal(item.attributes["gen_ai.conversation.id"], id);
    assert.equal(item.resource["service.name"], "pi");
    assert.equal(item.resource["loop_pi.context"], "fixture");
    assert.equal(typeof item.resource["host.name"], "string");
    if ("name" in item && typeof item.name === "string" && item.name.startsWith("pi.session")) {
      const role = `${item.attributes["loop_pi.role"]}:${item.attributes["gen_ai.agent.name"]}`;
      sessions.set(role, (sessions.get(role) ?? new Set()).add(id));
    }
    for (const key of Object.keys(item.attributes)) assert.doesNotMatch(key, /cwd|path|file|prompt|content|message|argument|result|instruction/i, key);
  }
  assert.deepEqual([...sessions.keys()].sort(), ["lane:loop-pi-lane", "lane:senior", "root:loop-pi-root"]);
  const ids = [...sessions.values()].flatMap((set) => [...set]);
  assert.equal(new Set(ids).size, 3, "each session reports its own native id");
  const names = allSpans.map((span) => span.name);
  for (const name of ["invoke_agent loop-pi-root", "invoke_agent senior", "invoke_agent loop-pi-lane", "execute_tool subagent", "execute_tool bash", "chat faux-1"]) {
    assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  }
  const scoutTool = allSpans.find((span) => span.name === "execute_tool bash")!;
  assert.equal(scoutTool.attributes["gen_ai.tool.name"], "bash");
});
