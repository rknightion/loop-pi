// The `loop-pi-runtime` session entry: which home variant and which service tier this session
// ran with, written at session_start by both the root and the lane entry so a transcript carries
// its own runtime facts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_ENTRY_TYPE = "loop-pi-runtime";

export interface RuntimeEntry {
  v: 1;
  variant: string;
  models: Record<string, { service_tier: string }>;
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/** `variant` from the home receipt the installer writes, else "unknown". */
function readVariant(agentDir: string): string {
  const receipt = readJson(join(agentDir, ".loop-pi-managed.json")) as { variant?: unknown } | null;
  return typeof receipt?.variant === "string" && receipt.variant ? receipt.variant : "unknown";
}

/** `service_tier` per model id from models.json modelOverrides samplingParams, else "default". */
export function readRuntimeEntry(agentDir: string, currentModelId?: string): RuntimeEntry {
  const models: RuntimeEntry["models"] = {};
  const file = readJson(join(agentDir, "models.json")) as { providers?: Record<string, { modelOverrides?: unknown }> } | null;
  for (const provider of Object.values(file?.providers ?? {})) {
    const overrides = provider?.modelOverrides;
    if (typeof overrides !== "object" || overrides === null) continue;
    for (const [id, override] of Object.entries(overrides as Record<string, unknown>)) {
      const tier = (override as { samplingParams?: { service_tier?: unknown } } | null)?.samplingParams?.service_tier;
      models[id] = { service_tier: typeof tier === "string" && tier ? tier : "default" };
    }
  }
  if (currentModelId && !(currentModelId in models)) models[currentModelId] = { service_tier: "default" };
  return { v: 1, variant: readVariant(agentDir), models };
}

export function registerRuntimeEntry(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      pi.appendEntry(RUNTIME_ENTRY_TYPE, readRuntimeEntry(getAgentDir(), ctx.model?.id));
    } catch {
      // Recording runtime facts must never trap the session.
    }
  });
}
