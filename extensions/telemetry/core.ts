// Metadata-only OpenTelemetry export for pi sessions (root and lanes). SEAMS.md "Telemetry".
//
// Off unless the home's own settings.json carries a `loopPi.telemetry` block whose `configFile`
// names a readable env-style file with an OTLP endpoint. The file is read here, in process, and the
// credential goes only into the exporter's header object: nothing is written to process.env, so no
// tool subprocess or child lane tool environment ever sees it. Project settings are never read.
//
// What is exported is metadata only and does not depend on any capture switch: span and log
// attributes carry ids, model and provider names, token counts, tool names, finish reasons and
// error types. Prompt, reply, tool argument, tool result, error text, file path and cwd are never
// read into an attribute. No metrics are exported.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";

export type Role = "root" | "lane";

export const DEFAULT_CONFIG_FILE = join("~", ".config", "agento11y", "config.env");
export const DEFAULT_EXPORT_TIMEOUT_MS = 2000;
/** Below pi-subagents' 5 s bound on a child's `session_shutdown` handlers. */
export const MAX_EXPORT_TIMEOUT_MS = 4000;
const SCOPE = "loop-pi.telemetry";
const PLAIN = /^[A-Za-z0-9._-]{1,64}$/;

export interface TelemetrySettings {
  configFile: string;
  context?: string;
  exportTimeoutMs: number;
}

/** `loopPi.telemetry` from the home's settings.json; undefined (telemetry off) when absent or off. */
export function readTelemetrySettings(settingsPath = join(getAgentDir(), "settings.json")): TelemetrySettings | undefined {
  let block: unknown;
  try {
    block = JSON.parse(readFileSync(settingsPath, "utf8"))?.loopPi?.telemetry;
  } catch {
    return undefined;
  }
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const raw = block as Record<string, unknown>;
  if (raw.enabled === false) return undefined;
  const configFile = typeof raw.configFile === "string" && raw.configFile.trim() ? raw.configFile.trim() : DEFAULT_CONFIG_FILE;
  const context = typeof raw.context === "string" && PLAIN.test(raw.context) ? raw.context : undefined;
  const timeout = Number(raw.exportTimeoutMs);
  const exportTimeoutMs = Number.isFinite(timeout) && timeout > 0
    ? Math.min(Math.max(Math.floor(timeout), 100), MAX_EXPORT_TIMEOUT_MS) : DEFAULT_EXPORT_TIMEOUT_MS;
  return { configFile: expandHome(configFile), context, exportTimeoutMs };
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  return path.startsWith("~/") && process.env.HOME ? join(process.env.HOME, path.slice(2)) : path;
}

/** `KEY=value` lines; `#` comments, an optional `export ` prefix and matching quotes are accepted. */
export function parseConfigEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

export interface ExportTarget {
  tracesUrl: string;
  logsUrl: string;
  /** Only ever handed to the exporters; never logged, exported or placed in process.env. */
  headers: Record<string, string>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where and how to export, from the config file's values; undefined means telemetry stays off. */
export function exportTarget(values: Map<string, string>): ExportTarget | undefined {
  const endpoint = values.get("AGENTO11Y_OTEL_EXPORTER_OTLP_ENDPOINT")?.trim();
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  // A credential never travels in cleartext off this machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const tenant = values.get("AGENTO11Y_AUTH_TENANT_ID")?.trim() ?? "";
  const token = (values.get("AGENTO11Y_OTEL_AUTH_TOKEN") || values.get("AGENTO11Y_AUTH_TOKEN") || "").trim();
  if (Boolean(tenant) !== Boolean(token)) return undefined;
  const base = url.toString().replace(/\/+$/, "");
  const headers: Record<string, string> = tenant
    ? { Authorization: `Basic ${Buffer.from(`${tenant}:${token}`).toString("base64")}` } : {};
  return { tracesUrl: `${base}/v1/traces`, logsUrl: `${base}/v1/logs`, headers };
}

export interface Exporters {
  spans: SpanExporter;
  logs: LogRecordExporter;
}

interface Pipeline {
  tracer: Tracer;
  logger: Logger;
  flush(timeoutMs: number): Promise<void>;
}

/** One pipeline per process and configuration: a background runner hosts several child sessions. */
const PIPELINES = Symbol.for("loop-pi.telemetry.pipelines.v1");
function pipelines(): Map<string, Pipeline> {
  const root = globalThis as unknown as Record<symbol, Map<string, Pipeline> | undefined>;
  return (root[PIPELINES] ??= new Map());
}

export interface TelemetryOptions {
  settingsPath?: string;
  /** Tests: replace the OTLP exporters. */
  exporters?: (target: ExportTarget, timeoutMs: number) => Exporters;
}

function otlpExporters(target: ExportTarget, timeoutMs: number): Exporters {
  return {
    spans: new OTLPTraceExporter({ url: target.tracesUrl, headers: { ...target.headers }, timeoutMillis: timeoutMs }),
    logs: new OTLPLogExporter({ url: target.logsUrl, headers: { ...target.headers }, timeoutMillis: timeoutMs }),
  };
}

function pipeline(settings: TelemetrySettings, target: ExportTarget, options: TelemetryOptions): Pipeline {
  const key = JSON.stringify([target.tracesUrl, target.logsUrl, target.headers, settings.context ?? "", settings.exportTimeoutMs, Boolean(options.exporters)]);
  const existing = pipelines().get(key);
  if (existing && !options.exporters) return existing;
  const resource = resourceFromAttributes({
    "service.name": "pi",
    "service.version": VERSION,
    "host.name": hostname(),
    ...(settings.context ? { "loop_pi.context": settings.context } : {}),
  });
  const exporters = (options.exporters ?? otlpExporters)(target, settings.exportTimeoutMs);
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: exporters.spans, scheduledDelayMillis: 2000, exportTimeoutMillis: settings.exportTimeoutMs })],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: exporters.logs, scheduledDelayMillis: 2000, exportTimeoutMillis: settings.exportTimeoutMs })],
  });
  const created: Pipeline = {
    tracer: tracerProvider.getTracer(SCOPE, VERSION),
    logger: loggerProvider.getLogger(SCOPE, VERSION),
    async flush(timeoutMs: number) {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
      try {
        await Promise.race([
          Promise.allSettled([tracerProvider.forceFlush({ timeoutMillis: timeoutMs }), loggerProvider.forceFlush()]),
          bound,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  if (!options.exporters) pipelines().set(key, created);
  return created;
}

/** The lane's agent name from the root guard's identity binding, when it is a plain name. */
export function laneAgentName(raw = process.env.PI_SUBAGENT_EXTENSION_BINDINGS): string | undefined {
  try {
    const agent = (JSON.parse(raw ?? "") as Record<string, { agent?: unknown } | undefined>)?.["loop-pi.guard/1"]?.agent;
    return typeof agent === "string" && PLAIN.test(agent) ? agent : undefined;
  } catch {
    return undefined;
  }
}

function plain(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:/@+-]{1,128}$/.test(value) ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Install the session hooks. Every handler swallows its own errors: telemetry never affects a session. */
export function installTelemetry(pi: ExtensionAPI, role: Role, options: TelemetryOptions = {}): void {
  let active: Pipeline | undefined;
  let timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS;
  let ids: Attributes = {};
  let agentName = role === "root" ? "loop-pi-root" : "loop-pi-lane";
  let agent: { span: Span; context: Context } | undefined;
  let chat: Span | undefined;
  let chatSent = false;
  const tools = new Map<string, Span>();
  let turns = 0;
  let requests = 0;

  const guard = <A extends unknown[]>(fn: (...args: A) => void | Promise<void>) => async (...args: A) => {
    try {
      await fn(...args);
    } catch {
      // Telemetry is best effort: a failure here must never reach the session.
    }
  };

  const modelAttributes = (ctx: ExtensionContext): Attributes => {
    const provider = plain(ctx.model?.provider);
    const model = plain(ctx.model?.id);
    return { ...(provider ? { "gen_ai.provider.name": provider } : {}), ...(model ? { "gen_ai.request.model": model } : {}) };
  };

  const emit = (eventName: string, attributes: Attributes, severity = SeverityNumber.INFO) => {
    active?.logger.emit({
      eventName, body: eventName, severityNumber: severity, severityText: severity === SeverityNumber.INFO ? "INFO" : "WARN",
      attributes: { "event.name": eventName, ...ids, "loop_pi.role": role, "gen_ai.agent.name": agentName, ...attributes },
      ...(agent ? { context: agent.context } : {}),
    });
  };

  const endChat = (attributes: Attributes, errorType?: string) => {
    if (!chat) return;
    chat.setAttributes(attributes);
    if (errorType) {
      chat.setAttribute("error.type", errorType);
      chat.setStatus({ code: SpanStatusCode.ERROR });
    }
    chat.end();
    chat = undefined;
  };

  const endTools = (errorType: string) => {
    for (const span of tools.values()) {
      span.setAttribute("error.type", errorType);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    tools.clear();
  };

  const endAgent = (errorType?: string) => {
    endChat({}, errorType ?? "agent_ended");
    endTools(errorType ?? "agent_ended");
    if (!agent) return;
    agent.span.setAttributes({ "loop_pi.turn.count": turns, "loop_pi.request.count": requests });
    if (errorType) {
      agent.span.setAttribute("error.type", errorType);
      agent.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    agent.span.end();
    agent = undefined;
  };

  pi.on("session_start", guard((event, ctx) => {
    endAgent("session_replaced");
    const settings = readTelemetrySettings(options.settingsPath);
    let target: ExportTarget | undefined;
    if (settings) {
      try {
        target = exportTarget(parseConfigEnv(readFileSync(settings.configFile, "utf8")));
      } catch {
        target = undefined;
      }
    }
    active = settings && target ? pipeline(settings, target, options) : undefined;
    if (!active || !settings) return;
    timeoutMs = settings.exportTimeoutMs;
    const sessionId = plain(ctx.sessionManager.getSessionId());
    ids = sessionId ? { "gen_ai.conversation.id": sessionId, "session.id": sessionId } : {};
    agentName = (role === "lane" ? laneAgentName() : undefined) ?? (role === "root" ? "loop-pi-root" : "loop-pi-lane");
    emit("pi.session.start", { "pi.session.start_reason": event.reason });
  }));

  pi.on("agent_start", guard((_event, ctx) => {
    if (!active) return;
    endAgent("superseded");
    turns = 0;
    requests = 0;
    const span = active.tracer.startSpan(`invoke_agent ${agentName}`, {
      kind: SpanKind.INTERNAL,
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": agentName, "loop_pi.role": role, ...ids, ...modelAttributes(ctx) },
    }, ROOT_CONTEXT);
    agent = { span, context: trace.setSpan(ROOT_CONTEXT, span) };
  }));

  const startChat = (ctx: ExtensionContext) => {
    if (!active) return;
    requests += 1;
    const model = modelAttributes(ctx);
    chat = active.tracer.startSpan(`chat ${model["gen_ai.request.model"] ?? "unknown"}`, {
      kind: SpanKind.CLIENT,
      attributes: { "gen_ai.operation.name": "chat", ...ids, ...model },
    }, agent?.context ?? ROOT_CONTEXT);
    chatSent = false;
  };

  // A model call opens at the turn (providers without a wire payload never fire
  // `before_provider_request`) and closes at the assistant message. A second request with no
  // assistant message in between (a retry) closes the first as superseded and opens its own.
  pi.on("turn_start", guard((_event, ctx) => {
    if (!active) return;
    turns += 1;
    endChat({}, "superseded");
    startChat(ctx);
  }));

  pi.on("before_provider_request", guard((_event, ctx) => {
    if (!active) return;
    if (chat && !chatSent) {
      chatSent = true;
      return;
    }
    endChat({}, "superseded");
    startChat(ctx);
    chatSent = true;
  }));

  pi.on("message_end", guard((event) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (!active || message?.role !== "assistant" || !chat) return;
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    const cacheRead = count(usage.cacheRead);
    const cacheWrite = count(usage.cacheWrite);
    const stop = plain(message.stopReason) ?? "unknown";
    const responseModel = plain(message.responseModel) ?? plain(message.model);
    const attributes: Attributes = {
      "gen_ai.usage.input_tokens": count(usage.input) + cacheRead + cacheWrite,
      "gen_ai.usage.output_tokens": count(usage.output),
      "gen_ai.usage.cache_read.input_tokens": cacheRead,
      "gen_ai.usage.cache_creation.input_tokens": cacheWrite,
      "gen_ai.response.finish_reasons": [stop],
      ...(responseModel ? { "gen_ai.response.model": responseModel } : {}),
    };
    endChat(attributes, stop === "error" ? "provider_error" : stop === "aborted" ? "aborted" : undefined);
  }));

  pi.on("tool_execution_start", guard((event) => {
    if (!active) return;
    const name = plain(event.toolName) ?? "unknown";
    const callId = plain(event.toolCallId);
    tools.get(event.toolCallId)?.end();
    tools.set(event.toolCallId, active.tracer.startSpan(`execute_tool ${name}`, {
      kind: SpanKind.INTERNAL,
      attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, ...(callId ? { "gen_ai.tool.call.id": callId } : {}), ...ids },
    }, agent?.context ?? ROOT_CONTEXT));
  }));

  pi.on("tool_execution_end", guard((event) => {
    const span = tools.get(event.toolCallId);
    if (!span) return;
    tools.delete(event.toolCallId);
    if (event.isError) {
      span.setAttribute("error.type", "tool_error");
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  }));

  pi.on("agent_end", guard(() => {
    if (active) endAgent();
  }));

  pi.on("session_shutdown", guard(async (event) => {
    if (!active) return;
    endAgent("session_shutdown");
    emit("pi.session.end", { "pi.session.end_reason": event.reason });
    const flushing = active;
    active = undefined;
    // Bounded: an unreachable collector costs at most the export timeout at exit.
    await flushing.flush(timeoutMs);
  }));
}
