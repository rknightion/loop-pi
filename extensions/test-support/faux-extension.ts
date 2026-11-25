// Test-only pi extension: registers a scripted "faux" provider so RPC and print-mode
// sessions (root and children) run without a live model. Never shipped by loop-pi-install
// (test-support/ is excluded from builds).
//
// LOOP_PI_FAUX_SCRIPT names a JSON file: {"rules": [Rule, ...]}. For each model call the
// first rule whose `match` regex matches the latest user, custom or tool-result text wins.
// A rule with `once: true` is used at most once per process. Rule shape:
//   {"match": "regex", "once"?: bool, "text"?: "reply", "thinking"?: "...",
//    "toolCalls"?: [{"name": "bash", "args": {...}}], "stopReason"?: "stop" | "toolUse" | "error",
//    "errorMessage"?: "...", "delayMs"?: number, "hang"?: bool,
//    "waitForSession"?: {"dir": "...", "contains": "..."}}
// `waitForSession` holds the reply until a `.jsonl` file under `dir` contains `contains` (a readiness
// barrier on something another process really wrote), polling for at most 60 seconds, then replies anyway
// so a missing signal fails the test's own assertions instead of hanging it.
// `stopReason: "length"` scripts an output-budget stop. `hang: true` never answers: the request
// stays open until it is aborted, like a model that keeps streaming reasoning.
// With no matching rule the reply is the text "FAUX: no rule matched".
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Rule = {
  match: string;
  once?: boolean;
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: "stop" | "toolUse" | "error" | "length";
  errorMessage?: string;
  delayMs?: number;
  hang?: boolean;
  waitForSession?: { dir: string; contains: string };
};

function sessionContains(dir: string, needle: string): boolean {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) {
        if (sessionContains(path, needle)) return true;
      } else if (name.endsWith(".jsonl") && readFileSync(path, "utf8").includes(needle)) return true;
    } catch {
      // A file replaced mid-scan: the next poll sees it.
    }
  }
  return false;
}

function latestText(context: any): string {
  const messages: any[] = context?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((block: any) => (block.type === "text" ? block.text : "")).join("\n");
    }
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const scriptPath = process.env.LOOP_PI_FAUX_SCRIPT;
  if (!scriptPath) return;
  const requestLog = process.env.LOOP_PI_FAUX_REQUEST_LOG;
  const rules: Rule[] = JSON.parse(readFileSync(scriptPath, "utf8")).rules;
  const used = new Set<number>();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true, contextWindow: 272000, maxTokens: 128000 }] });
  faux.setResponses(
    Array.from({ length: 10_000 }, () => async (context: any, options: any) => {
      const text = latestText(context);
      // What the provider receives, after every `context` and `context_with_system` handler.
      if (requestLog) appendFileSync(requestLog, JSON.stringify(context?.messages ?? []) + "\n");
      const index = rules.findIndex((rule, i) => !(rule.once && used.has(i)) && new RegExp(rule.match, "s").test(text));
      if (index < 0) return fauxAssistantMessage("FAUX: no rule matched");
      used.add(index);
      const rule = rules[index];
      if (rule.waitForSession) {
        const { dir, contains } = rule.waitForSession;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !sessionContains(dir, contains)) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
      if (rule.hang) {
        const signal: AbortSignal | undefined = options?.signal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      const blocks: any[] = [];
      if (rule.thinking) blocks.push(fauxThinking(rule.thinking));
      if (rule.text) blocks.push(fauxText(rule.text));
      for (const call of rule.toolCalls ?? []) blocks.push(fauxToolCall(call.name, call.args as Parameters<typeof fauxToolCall>[1]));
      const stopReason = rule.stopReason ?? (rule.toolCalls?.length ? "toolUse" : "stop");
      return fauxAssistantMessage(blocks.length ? blocks : "", { stopReason, errorMessage: rule.errorMessage });
    }),
  );
  pi.registerProvider(faux.provider as any);
}
