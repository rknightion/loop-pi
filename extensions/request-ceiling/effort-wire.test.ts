// pi-ai 1.3.0 marks the GPT-6 family `supportsMidConvoEffort` and exempts only Sign in with ChatGPT at
// api.openai.com. Behind codex-lb (a ChatGPT-subscription proxy) every request then carries
// `reasoning.effort: "medium"` plus a `configuration_update` input item, which codex-lb answers at
// medium effort, and which request-ceiling's portableRequest rejects, so managed recovery is denied.
// The rob/agents pi-overlay turns the flag off at provider level. This drives the pinned pi CLI with a
// models.json of the overlay's shape against a capture server and checks the request body on the wire.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hermeticPiEnv } from "../test-support/hermetic-env.ts";
import { CLI_PATH } from "../loop-wait/test-helpers.ts";
import { portableRequest } from "./recovery.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function captureFirstRequest(compat: Record<string, unknown> | undefined): Promise<any> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "capture only", type: "invalid_request_error", code: "capture" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agentDir = mkdtempSync(join(tmpdir(), "effort-wire-"));
  dirs.push(agentDir);
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", ...(compat ? { compat } : {}),
    // The overlay's per-model compat merges over the provider's; it must not reset the effort flag.
    modelOverrides: { "gpt-6.1-sol": { contextWindow: 872000, maxTokens: 80000, compat: { supportsAdditionalTools: false, supportsToolSearch: false } } } } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  try {
    const child = spawn(process.execPath, [CLI_PATH, "-p", "--no-session", "--no-tools", "--no-extensions", "--no-context-files", "--no-skills",
      "--provider", "openai", "--model", "gpt-6.1-sol", "--thinking", "high", "Reply OK."], {
      cwd: agentDir,
      env: hermeticPiEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    assert.ok(bodies.length > 0, `pi sent no request: ${stderr}`);
    return bodies[0];
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const updates = (body: any) => (body.input as any[]).filter((item) => item?.type === "configuration_update");

test("bare pi 1.3.0 behind a proxy sends effort medium and a configuration_update item (the hazard)", { timeout: 60_000 }, async () => {
  const body = await captureFirstRequest(undefined);
  assert.equal(body.reasoning?.effort, "medium");
  assert.deepEqual(updates(body).map((item) => item.reasoning?.effort), ["high"]);
  assert.equal(portableRequest(body), false, "request-ceiling cannot replay a request carrying configuration_update");
});

test("the overlay's provider compat sends the requested effort and a portable request", { timeout: 60_000 }, async () => {
  const body = await captureFirstRequest({ supportsMidConvoEffort: false });
  assert.equal(body.reasoning?.effort, "high");
  assert.deepEqual(updates(body), []);
  assert.equal(portableRequest(body), true);
});
