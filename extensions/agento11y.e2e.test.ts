// The Agent Observability extension (@grafana/agento11y-pi, exact pin) on the pinned pi and
// pi-subagents: a real root RPC session and real native background lanes (a senior and the scout
// it launches) load it, the root by flag and the lanes through the agent-file `extensions:`
// allowlist, and export to an in-process sink. Nothing leaves the machine: every inherited
// AGENTO11Y_*, SIGIL_* and OTEL_* variable is dropped and XDG_CONFIG_HOME points at a fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  CLI_PATH, FAUX_EXTENSION, PI_SUBAGENTS_PACKAGE_DIR, ROOT_EXTENSION, cleanupAllAfterExit, expectDetachedRuns, freshDir, startPiRpc,
  waitForCondition, writeFauxScript,
} from "./loop-guard/rpc-test-helpers.ts";
import { hermeticPiEnv } from "./test-support/hermetic-env.ts";
import { adoptNopushLauncher } from "./test-support/lane-agents.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = readFileSync(join(ROOT, "bin/loop-pi-install"), "utf8");
const EXTENSION = join(ROOT, "node_modules/@grafana/agento11y-pi/dist/index.js");
/** The export bounds the shipped launcher sets (bin/loop-pi-install). */
const BOUND_MS = Number(/^DEFAULT_TELEMETRY_EXPORT_TIMEOUT_MS = (\d+)$/m.exec(INSTALLER)?.[1]);
const MAX_RETRIES = /^TELEMETRY_MAX_RETRIES = (\d+)$/m.exec(INSTALLER)?.[1];
const MARK = "CONTENTMARK";
after(() => cleanupAllAfterExit());

/** Every inherited telemetry variable removed (a spawn drops undefined values), plus the fixture's. */
function isolatedEnv(xdg: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) if (/^(AGENTO11Y|SIGIL|OTEL)_/.test(key)) env[key] = undefined;
  return {
    ...env, XDG_CONFIG_HOME: xdg, OTEL_EXPORTER_OTLP_TIMEOUT: String(BOUND_MS),
    AGENTO11Y_EXPORT_TIMEOUT_MS: String(BOUND_MS), AGENTO11Y_MAX_RETRIES: String(MAX_RETRIES), ...extra,
  };
}

interface Received { path: string; auth: string | undefined; raw: string; body: any; at: number }

async function sink(answer: boolean): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* kept raw */ }
    received.push({ path: req.url ?? "", auth: req.headers.authorization, raw, body, at: Date.now() });
    if (!answer) return;
    res.writeHead(200, { "content-type": "application/json" });
    // The generation export answers per generation; OTLP/HTTP accepts an empty object.
    res.end(JSON.stringify(Array.isArray(body?.generations)
      ? { results: body.generations.map((g: any) => ({ generationId: g.id, accepted: true })) } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function configHome(fixture: string, port: number, tenant: string, token: string): string {
  const xdg = join(fixture, "xdg");
  mkdirSync(join(xdg, "agento11y"), { recursive: true });
  writeFileSync(join(xdg, "agento11y/config.env"), [
    `AGENTO11Y_ENDPOINT=http://127.0.0.1:${port}`, `AGENTO11Y_AUTH_TENANT_ID=${tenant}`, `AGENTO11Y_AUTH_TOKEN=${token}`,
    `AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}/otlp`, "AGENTO11Y_CONTENT_CAPTURE_MODE=full", "",
  ].join("\n"), { mode: 0o600 });
  return xdg;
}

const generations = (received: Received[]) => received.filter((r) => r.path === "/api/v1/generations:export")
  .flatMap((r) => (r.body?.generations ?? []).map((g: any) => ({ at: r.at, conversation: g.conversation_id as string, raw: JSON.stringify(g) })));

test("the shipped launcher bounds and allowlist entry are what this test loads", () => {
  assert.match(INSTALLER, /^TELEMETRY_PACKAGE = "@grafana\/agento11y-pi"$/m);
  assert.match(INSTALLER, /^TELEMETRY_EXTENSION = f"node_modules\/\{TELEMETRY_PACKAGE\}\/dist\/index\.js"$/m);
  assert.ok(BOUND_MS >= 500 && BOUND_MS <= 2400 && MAX_RETRIES === "1");
  const allowlist = /^extensions: (.*)$/m.exec(readFileSync(join(ROOT, "home/agents/scout.md"), "utf8"))![1];
  assert.equal(allowlist.replaceAll("{{PREFIX}}", ROOT), EXTENSION);
});

test("root, lane and nested lane each export their own generations through the allowlist seam", { timeout: 180_000 }, async () => {
  const { server, port, received } = await sink(true);
  const fixture = freshDir("agento11y-e2e-");
  const home = join(fixture, "home");
  const cwd = join(fixture, "repo");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(join(home, "extensions", "subagent"), { recursive: true });
  mkdirSync(cwd);
  const tenant = "4242";
  const token = `fixture-${Math.random().toString(36).slice(2)}`;
  const xdg = configHome(fixture, port, tenant, token);
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    packages: [PI_SUBAGENTS_PACKAGE_DIR], subagents: { agentExcludeDirs: ["~/.agents"] }, retry: { enabled: false },
    loopPi: { modelFamily: { provider: "faux", pattern: "^faux-1$", name: "faux" }, rootRoute: { provider: "faux", model: "faux-1", thinking: "off" } },
  }));
  const config = JSON.parse(readFileSync(join(ROOT, "home/extensions/subagent/config.json"), "utf8").replaceAll("{{HOME}}", home).replaceAll("{{PREFIX}}", ROOT));
  writeFileSync(join(home, "extensions/subagent/config.json"), JSON.stringify(config));
  const envDump = join(fixture, "lane-env.json");
  for (const agent of ["senior", "scout"]) writeFileSync(join(home, "agents", `${agent}.md`), [
    "---", `name: ${agent}`, "description: Telemetry fixture", `tools: ${agent === "senior" ? "bash, subagent" : "bash"}`,
    ...(agent === "senior" ? ["allowedAgents: scout"] : []), `extensions: ${EXTENSION}`, `subagentOnlyExtensions: ${FAUX_EXTENSION}`,
    "model: faux/faux-1", "async: true", "timeoutMs: 60000", "---", "Synthetic fixture only.",
  ].join("\n"));
  // Lanes launch the way the installed home does: under nopush, which the root guard pins.
  adoptNopushLauncher(home);
  const script = writeFauxScript([
    { match: "ROOT_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "senior", task: `SENIOR_GO ${MARK}-senior`, async: true } }] },
    { match: "SENIOR_GO", once: true, toolCalls: [{ name: "subagent", args: { agent: "scout", task: `SCOUT_GO ${MARK}-scout`, async: true } }] },
    { match: "SCOUT_GO", once: true, toolCalls: [{ name: "bash", args: { command: `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' '${envDump}'` } }] },
    { match: ".*", text: "fixture reply" },
  ]);
  const subagentTempRoot = freshDir("agento11y-e2e-sub-");
  expectDetachedRuns(subagentTempRoot, 1);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, ROOT_EXTENSION, EXTENSION], sessionArgs: [], agentDir: home, subagentTempRoot, cwd,
    fauxScriptPath: script, env: isolatedEnv(xdg),
  });
  let terminal = 0;
  try {
    session.send({ type: "prompt", message: `ROOT_GO ${MARK}-root` });
    // The senior's run is terminal once its nested scout has returned to it and it has settled.
    terminal = await waitForCondition(() => {
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
    await session.waitFor((e) => e.type === "message_end" && (e.message as any)?.customType === "subagent-notify", 30_000);
    await session.waitFor((e) => e.type === "agent_end", 30_000);
    await session.close();
    await waitForCondition(() => (generations(received).some((g) => g.raw.includes(`${MARK}-root`)) ? true : undefined), 15_000, 50);
  } catch (error) {
    throw new Error(`${error}\nstderr:\n${session.stderr.join("")}`);
  } finally {
    await session.close();
    await close(server);
  }

  const auth = `Basic ${Buffer.from(`${tenant}:${token}`).toString("base64")}`;
  assert.ok(received.length > 0 && received.every((r) => r.auth === auth), "every export carries the configured credential");
  assert.ok(received.some((r) => r.path === "/otlp/v1/traces"), "OTLP traces reach the sink");
  const all = generations(received);
  const byMarker = (marker: string) => new Set(all.filter((g) => g.raw.includes(marker)).map((g) => g.conversation));
  // A parent's tool call carries its child's brief, so each child's own conversation is the one
  // its marker reaches that is not an ancestor's.
  const root = byMarker(`${MARK}-root`);
  const senior = new Set([...byMarker(`${MARK}-senior`)].filter((id) => !root.has(id)));
  const scout = new Set([...byMarker(`${MARK}-scout`)].filter((id) => !root.has(id) && !senior.has(id)));
  // Content capture follows the config file (full here): each brief's text is in its own generation.
  assert.deepEqual([root.size, senior.size, scout.size], [1, 1, 1], `conversations per session: ${JSON.stringify([...root, ...senior, ...scout])}`);
  // Lanes flush during their own session_shutdown, before the runner exits.
  const laneGenerations = all.filter((g) => senior.has(g.conversation) || scout.has(g.conversation));
  assert.ok(laneGenerations.length > 0 && laneGenerations.every((g) => g.at <= terminal), "lane generations arrived before the lane run was terminal");
  // The extension loads the config file into the process environment; a lane's tool inherits it.
  const laneEnv = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
  assert.equal(laneEnv.AGENTO11Y_ENDPOINT, `http://127.0.0.1:${port}`);
  assert.equal(laneEnv.XDG_CONFIG_HOME, xdg);
});

test("a one-shot session exits within the launcher's bound when the collector never answers", { timeout: 60_000 }, async () => {
  const { server, port, received } = await sink(false);
  const fixture = freshDir("agento11y-bound-");
  const home = join(fixture, "home");
  mkdirSync(home);
  const xdg = configHome(fixture, port, "1", `fixture-${Math.random().toString(36).slice(2)}`);
  const script = writeFauxScript([{ match: ".*", text: "fixture reply" }]);
  try {
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI_PATH, "--no-session", "--provider", "faux", "--model", "faux-1",
        "--extension", FAUX_EXTENSION, "--extension", EXTENSION, "-p", "hello"], {
        cwd: fixture, stdio: ["ignore", "ignore", "ignore"],
        env: hermeticPiEnv({ ...isolatedEnv(xdg), PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0", LOOP_PI_FAUX_SCRIPT: script }),
      });
      child.on("exit", (exitCode) => resolve(exitCode));
    });
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    assert.ok(received.some((r) => r.path === "/api/v1/generations:export"), "the session did try to export");
    // Startup plus one bounded flush; with the vendor defaults this takes about 40 s.
    // Exit flush: from the session's export (its turn is done) to process exit, inside
    // pi-subagents' 5 s child shutdown bound. With the vendor defaults this takes about 40 s.
    const flushMs = started + elapsed - Math.min(...received.map((r) => r.at));
    assert.ok(flushMs < 5000, `exit flush took ${flushMs} ms (whole run ${elapsed} ms)`);
  } finally {
    await close(server);
  }
});
