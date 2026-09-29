// loop-pi runs one model family only: by default the gpt-6 family (gpt-6-sol, gpt-6-luna,
// gpt-6-astra) on the `openai` provider, or whatever settings.json `loopPi.modelFamily` names. Loaded by both loop-guard entries, so the
// root and every lane refuse a model outside the family three ways: a `subagent` call carrying a
// model (or run-deadline) override is blocked by subagentOverrideBlock in each entry's tool_call
// handler, selecting another model switches straight back, and a request for one is sent under a
// model name the provider rejects, so no call on a wrong model ever completes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Registered only by extensions/test-support (never installed), so tests can run the guard offline.
const TEST_PROVIDER = "faux";

type ModelRef = { provider: string; id: string };

/** The allowed family and the route to fall back to, from the home's settings.json `loopPi` block:
 *  `modelFamily: {provider, pattern, name, members}` and `rootRoute: {provider, model, thinking}`.
 *  Every field defaults to the gpt-6 family on the `openai` provider. */
export interface ModelFamilyConfig {
  provider: string;
  pattern: RegExp;
  name: string;
  members: string[];
  fallback: ModelRef;
}

const DEFAULT_FAMILY = {
  provider: "openai",
  pattern: "^gpt-6(-[a-z0-9]+)+$",
  name: "gpt-6",
  members: ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"],
};
const DEFAULT_ROOT_ROUTE = { provider: "openai", model: "gpt-6-sol" };

const text = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback);

export function modelFamilyConfig(settings: unknown): ModelFamilyConfig {
  const loopPi = (settings as { loopPi?: Record<string, any> } | undefined)?.loopPi ?? {};
  const family = loopPi.modelFamily ?? {};
  const route = loopPi.rootRoute ?? {};
  let pattern: RegExp;
  try {
    pattern = new RegExp(text(family.pattern, DEFAULT_FAMILY.pattern));
  } catch {
    return modelFamilyConfig({});
  }
  const members = Array.isArray(family.members) && family.members.every((m: unknown) => typeof m === "string")
    ? family.members
    : DEFAULT_FAMILY.members;
  return {
    provider: text(family.provider, DEFAULT_FAMILY.provider),
    pattern,
    name: text(family.name, DEFAULT_FAMILY.name),
    members,
    fallback: { provider: text(route.provider, DEFAULT_ROOT_ROUTE.provider), id: text(route.model, DEFAULT_ROOT_ROUTE.model) },
  };
}

/** The config for a home: its settings.json, or the defaults when that is absent or unreadable. */
export function loadModelFamilyConfig(agentDir: string): ModelFamilyConfig {
  try {
    return modelFamilyConfig(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
  } catch {
    return modelFamilyConfig({});
  }
}

// Set from the home's settings when an entry installs the guard; the defaults until then.
let active = modelFamilyConfig({});

export function isAllowedModel(provider: string, id: string, config: ModelFamilyConfig = active): boolean {
  return provider === TEST_PROVIDER || (provider === config.provider && config.pattern.test(id));
}

/** Every `model` override anywhere in a `subagent` call's input. Agent files pin the gpt-6 route,
 *  so any override is refused, whatever its value or type. */
export function subagentModelOverrides(input: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "model" && inner !== undefined && inner !== null) {
          found.push(typeof inner === "string" ? inner : JSON.stringify(inner));
        } else walk(inner);
      }
    }
  };
  walk(input);
  return found;
}

/** The payload to send instead when the active model is outside the family, else undefined. */
export function refusedPayload(model: ModelRef | undefined, payload: unknown, config: ModelFamilyConfig = active): unknown {
  if (!model || isAllowedModel(model.provider, model.id, config)) return undefined;
  if (!payload || typeof payload !== "object" || typeof (payload as { model?: unknown }).model !== "string") return undefined;
  return { ...(payload as object), model: `loop-pi-refused:${model.id}` };
}

async function enforceActiveModel(pi: ExtensionAPI, ctx: ExtensionContext, previous?: ModelRef): Promise<void> {
  const current = ctx.model;
  if (!current || isAllowedModel(current.provider, current.id)) return;
  const back = previous && isAllowedModel(previous.provider, previous.id) ? previous : active.fallback;
  const target = ctx.modelRegistry.find(back.provider, back.id);
  const switched = target ? await pi.setModel(target) : false;
  ctx.ui.notify(
    `loop-pi runs the ${active.name} family only; refused ${current.provider}/${current.id}` +
      (switched ? `, switched to ${back.provider}/${back.id}.` : ". Requests on it will be rejected."),
    "error",
  );
}

export function installModelFamily(pi: ExtensionAPI): void {
  active = loadModelFamilyConfig(getAgentDir());
  pi.on("session_start", (_event, ctx) => enforceActiveModel(pi, ctx));
  pi.on("model_select", (event, ctx) => enforceActiveModel(pi, ctx, event.previousModel));
  pi.on("before_provider_request", (event, ctx) => refusedPayload(ctx.model, event.payload));
}

const DEADLINE_KEYS = new Set(["timeoutMs", "maxRuntimeMs"]);

/** Run-deadline overrides at the call or task level. A host `acceptance` gate's own timeout is not one. */
function deadlineOverrides(input: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (DEADLINE_KEYS.has(key) && inner !== undefined && inner !== null) found.push(`${key}=${JSON.stringify(inner)}`);
        else if (key !== "acceptance") walk(inner);
      }
    }
  };
  walk(input);
  return found;
}

/** The block verdict for a `subagent` call carrying a model or run-deadline override, else undefined.
 *  Agent files pin both; a shortened deadline leaves a lane minutes of work after the checkpoint steer. */
export function subagentOverrideBlock(
  input: unknown,
  config: ModelFamilyConfig = active,
): { block: true; reason: string } | undefined {
  const models = subagentModelOverrides(input);
  if (models.length > 0) {
    return {
      block: true,
      reason:
        `loop-guard: pass no model override to subagent; agent files pin the ${config.name} family route ` +
        `(${config.members.join(", ")}). Refused: ${models.join(", ")}`,
    };
  }
  const deadlines = deadlineOverrides(input);
  if (deadlines.length > 0) {
    return {
      block: true,
      reason:
        "loop-guard: pass no run deadline override to subagent (timeoutMs/maxRuntimeMs); each agent file pins " +
        `its run deadline and the checkpoint steer comes 10 minutes before it. Refused: ${deadlines.join(", ")}`,
    };
  }
  return undefined;
}
