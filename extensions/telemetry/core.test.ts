// Telemetry configuration, the content guard and the exit bound, against in-memory exporters.
// Hook-level: every handler is driven directly with content-bearing events (SEAMS.md "Telemetry").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace";
import {
  DEFAULT_EXPORT_TIMEOUT_MS, MAX_EXPORT_TIMEOUT_MS, exportTarget, installTelemetry, laneAgentName, parseConfigEnv,
  readTelemetrySettings, type Exporters,
} from "./core.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-pi-telemetry-"));
  dirs.push(dir);
  return dir;
}

/** A credential-shaped value built at run time, never written into the source. */
const credential = () => `fixture-${Math.random().toString(36).slice(2)}`;

test("the config file parser accepts comments, export prefixes and matching quotes", () => {
  const values = parseConfigEnv([
    "# comment", "export AGENTO11Y_AUTH_TENANT_ID=42", "AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT='https://otlp.example.com/otlp'",
    'AGENTO11Y_AUTH_TOKEN="abc def"', "lower=ignored", "  AGENTO11Y_CONTENT_CAPTURE_MODE = full  ", "",
  ].join("\n"));
  assert.equal(values.get("AGENTO11Y_AUTH_TENANT_ID"), "42");
  assert.equal(values.get("AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT"), "https://otlp.example.com/otlp");
  assert.equal(values.get("AGENTO11Y_AUTH_TOKEN"), "abc def");
  assert.equal(values.get("AGENTO11Y_CONTENT_CAPTURE_MODE"), "full");
  assert.equal(values.has("lower"), false);
});

test("the export target needs an endpoint, keeps credentials off cleartext links and builds Basic auth", () => {
  const token = credential();
  const values = (extra: Record<string, string>) => new Map(Object.entries(extra));
  assert.equal(exportTarget(values({})), undefined);
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })), undefined);
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.example.com/otlp" })), undefined);
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "https://u:p@otlp.example.com/otlp" })), undefined);
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com/otlp?x=1" })), undefined);
  // Half a credential is a misconfiguration, not an anonymous exporter.
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com", AGENTO11Y_AUTH_TENANT_ID: "1" })), undefined);
  assert.equal(exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com", AGENTO11Y_AUTH_TOKEN: token })), undefined);
  const local = exportTarget(values({ AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" }));
  assert.deepEqual(local, { tracesUrl: "http://127.0.0.1:4318/v1/traces", logsUrl: "http://127.0.0.1:4318/v1/logs", headers: {} });
  const remote = exportTarget(values({
    AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com/otlp/", AGENTO11Y_AUTH_TENANT_ID: "42",
    AGENTO11Y_AUTH_TOKEN: "general", AGENTO11Y_OTEL_AUTH_TOKEN: token,
  }));
  assert.equal(remote?.tracesUrl, "https://otlp.example.com/otlp/v1/traces");
  assert.equal(remote?.logsUrl, "https://otlp.example.com/otlp/v1/logs");
  // The OTLP-specific token wins over the general one.
  assert.deepEqual(remote?.headers, { Authorization: `Basic ${Buffer.from(`42:${token}`).toString("base64")}` });
});

test("settings: absent or disabled is off; the file, context and timeout are validated", () => {
  const dir = scratch();
  const path = join(dir, "settings.json");
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  assert.equal(readTelemetrySettings(join(dir, "missing.json")), undefined);
  write({ loopPi: {} });
  assert.equal(readTelemetrySettings(path), undefined);
  write({ loopPi: { telemetry: { enabled: false, configFile: "/x" } } });
  assert.equal(readTelemetrySettings(path), undefined);
  write({ loopPi: { telemetry: {} } });
  const defaults = readTelemetrySettings(path);
  assert.equal(defaults?.configFile, join(process.env.HOME ?? "~", ".config/agento11y/config.env"));
  assert.equal(defaults?.exportTimeoutMs, DEFAULT_EXPORT_TIMEOUT_MS);
  assert.equal(defaults?.context, undefined);
  write({ loopPi: { telemetry: { configFile: "/etc/x.env", context: "personal", exportTimeoutMs: 999999 } } });
  assert.deepEqual(readTelemetrySettings(path), { configFile: "/etc/x.env", context: "personal", exportTimeoutMs: MAX_EXPORT_TIMEOUT_MS });
  write({ loopPi: { telemetry: { context: "not a plain name", exportTimeoutMs: 5 } } });
  assert.deepEqual([readTelemetrySettings(path)?.context, readTelemetrySettings(path)?.exportTimeoutMs], [undefined, 100]);
});

test("a lane names its agent from the root guard's identity binding only", () => {
  assert.equal(laneAgentName(JSON.stringify({ "loop-pi.guard/1": { agent: "worker", runDir: "/r" } })), "worker");
  assert.equal(laneAgentName(JSON.stringify({ "loop-pi.guard/1": { agent: "../../x y" } })), undefined);
  assert.equal(laneAgentName("not json"), undefined);
  assert.equal(laneAgentName(undefined), undefined);
});

// --- hook-level harness ---------------------------------------------------------------------

type Handler = (event: any, ctx: any) => unknown;
function fakePi(): { pi: ExtensionAPI; fire(name: string, event: any, ctx?: any): Promise<void> } {
  const handlers = new Map<string, Handler[]>();
  const pi = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  return {
    pi: pi as unknown as ExtensionAPI,
    async fire(name, event, ctx = context) {
      for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
    },
  };
}

const MARK = "CONTENTMARK";
const context = {
  cwd: `/private/${MARK}-cwd`, hasUI: false,
  model: { provider: "openai", id: "gpt-6.1-sol" },
  sessionManager: { getSessionId: () => "0199-session-id", getSessionFile: () => `/private/${MARK}-session.jsonl` },
};

function configured(token: string, extra: Record<string, unknown> = {}): string {
  const dir = scratch();
  const config = join(dir, "config.env");
  writeFileSync(config, `AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com/otlp\nAGENTO11Y_AUTH_TENANT_ID=7\nAGENTO11Y_AUTH_TOKEN=${token}\nAGENTO11Y_CONTENT_CAPTURE_MODE=full\n`, { mode: 0o600 });
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ loopPi: { telemetry: { configFile: config, context: "work", ...extra } } }));
  return settings;
}

async function contentBearingSession(fire: (name: string, event: any) => Promise<void>): Promise<void> {
  await fire("session_start", { reason: "startup" });
  await fire("before_agent_start", { messageType: "user", prompt: `${MARK} prompt`, systemPrompt: `${MARK} system`, systemPromptOptions: {} });
  await fire("agent_start", {});
  await fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
  await fire("context", { messages: [{ role: "user", content: `${MARK} context` }] });
  await fire("before_provider_request", { payload: { input: `${MARK} payload` } });
  await fire("message_end", { message: {
    role: "assistant", provider: "openai", model: "gpt-6.1-sol", stopReason: "toolUse",
    content: [{ type: "text", text: `${MARK} reply` }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: `cat /${MARK}` } }],
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.1 } },
  } });
  await fire("tool_execution_start", { toolCallId: "call_1", toolName: "bash", args: { command: `cat /${MARK}`, path: `/${MARK}` } });
  await fire("tool_execution_end", { toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: `${MARK} result` }] }, isError: true });
  await fire("before_provider_request", { payload: {} });
  await fire("message_end", { message: {
    role: "assistant", provider: "openai", model: "gpt-6.1-sol", stopReason: "error", errorMessage: `${MARK} provider error at /${MARK}`,
    content: [], usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
  } });
  await fire("agent_end", { messages: [] });
  await fire("session_shutdown", { reason: "quit" });
}

const CAPTURE_ENV = {
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true", OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1",
  OTEL_LOG_TOOL_CONTENT: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1", PI_OTEL_CAPTURE_CONTENT: "true",
  AGENTO11Y_CONTENT_CAPTURE_MODE: "full", SIGIL_CONTENT_CAPTURE_MODE: "full",
};

test("content guard: capture switches set everywhere still export metadata only, with session ids", async () => {
  const saved = Object.fromEntries(Object.keys(CAPTURE_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, CAPTURE_ENV);
  const envBefore = JSON.stringify(process.env);
  const token = credential();
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  try {
    const { pi, fire } = fakePi();
    installTelemetry(pi, "root", { settingsPath: configured(token), exporters: () => ({ spans, logs }) });
    await contentBearingSession(fire);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
  assert.equal(JSON.stringify({ ...process.env, ...CAPTURE_ENV }), JSON.stringify({ ...JSON.parse(envBefore), ...CAPTURE_ENV }), "the extension writes nothing into process.env");

  const finished = spans.getFinishedSpans();
  const records = logs.getFinishedLogRecords();
  assert.deepEqual(finished.map((span) => span.name).sort(), ["chat gpt-6.1-sol", "chat gpt-6.1-sol", "execute_tool bash", "invoke_agent loop-pi-root"]);
  assert.deepEqual(records.map((record) => record.eventName), ["pi.session.start", "pi.session.end"]);
  const exported = JSON.stringify({
    spans: finished.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, resource: span.resource.attributes })),
    logs: records.map((record) => ({ body: record.body, attributes: record.attributes, resource: record.resource.attributes })),
  });
  assert.equal(exported.includes(MARK), false, "no prompt, reply, tool argument, tool result, error text, path or cwd");
  assert.equal(exported.includes(token), false);
  for (const key of [...finished.flatMap((span) => Object.keys(span.attributes)), ...records.flatMap((record) => Object.keys(record.attributes))]) {
    assert.doesNotMatch(key, /cwd|path|file|prompt|content|message|argument|result|instruction/i, key);
  }
  for (const item of [...finished.map((span) => span.attributes), ...records.map((record) => record.attributes)]) {
    assert.equal(item["gen_ai.conversation.id"], "0199-session-id");
    assert.equal(item["session.id"], "0199-session-id");
  }
  const resource = finished[0].resource.attributes;
  assert.equal(resource["service.name"], "pi");
  assert.equal(resource["loop_pi.context"], "work");
  assert.equal(typeof resource["host.name"], "string");
  const [first, second] = finished.filter((span) => span.name.startsWith("chat "));
  assert.equal(first.attributes["gen_ai.usage.input_tokens"], 15);
  assert.equal(first.attributes["gen_ai.usage.output_tokens"], 5);
  assert.equal(first.attributes["gen_ai.usage.cache_read.input_tokens"], 3);
  assert.deepEqual(first.attributes["gen_ai.response.finish_reasons"], ["toolUse"]);
  assert.equal(second.attributes["error.type"], "provider_error");
  const tool = finished.find((span) => span.name === "execute_tool bash")!;
  assert.deepEqual([tool.attributes["gen_ai.tool.name"], tool.attributes["gen_ai.tool.call.id"], tool.attributes["error.type"]], ["bash", "call_1", "tool_error"]);
  const agent = finished.find((span) => span.name.startsWith("invoke_agent"))!;
  assert.equal(tool.parentSpanContext?.spanId, agent.spanContext().spanId);
  assert.equal(first.parentSpanContext?.spanId, agent.spanContext().spanId);
});

test("missing, unreadable or incomplete configuration leaves the session untouched and exports nothing", async () => {
  const dir = scratch();
  let built = 0;
  const exporters = (): Exporters => { built += 1; return { spans: new InMemorySpanExporter(), logs: new InMemoryLogRecordExporter() }; };
  const settings = (value: unknown) => { const path = join(dir, `s${built}-${Math.random()}.json`); writeFileSync(path, JSON.stringify(value)); return path; };
  const incomplete = join(dir, "incomplete.env");
  writeFileSync(incomplete, "AGENTO11Y_AUTH_TENANT_ID=1\n");
  for (const settingsPath of [
    join(dir, "no-settings.json"),
    settings({ loopPi: { telemetry: { configFile: join(dir, "absent.env") } } }),
    settings({ loopPi: { telemetry: { configFile: dir } } }),
    settings({ loopPi: { telemetry: { configFile: incomplete } } }),
  ]) {
    const { pi, fire } = fakePi();
    installTelemetry(pi, "root", { settingsPath, exporters });
    await contentBearingSession(fire);
  }
  assert.equal(built, 0);
});

test("the exit flush is bounded when the collector never answers", async () => {
  const hanging: SpanExporter = { export: () => {}, shutdown: async () => {} };
  const logs = new InMemoryLogRecordExporter();
  const { pi, fire } = fakePi();
  installTelemetry(pi, "lane", { settingsPath: configured(credential(), { exportTimeoutMs: 300 }), exporters: () => ({ spans: hanging, logs }) });
  await fire("session_start", { reason: "startup" });
  await fire("agent_start", {});
  await fire("agent_end", { messages: [] });
  const started = Date.now();
  await fire("session_shutdown", { reason: "quit" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `session_shutdown took ${elapsed} ms`);
  assert.deepEqual(logs.getFinishedLogRecords().map((record) => [record.eventName, record.attributes["gen_ai.agent.name"]]),
    [["pi.session.start", "loop-pi-lane"], ["pi.session.end", "loop-pi-lane"]]);
});
