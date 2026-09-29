// Test-only pi extension: registers a scripted "faux" provider so RPC and print-mode
// sessions (root and children) run without a live model. Never shipped by loop-pi-install
// (test-support/ is excluded from builds).
//
// LOOP_PI_FAUX_SCRIPT names a JSON file: {"rules": [Rule, ...]}. For each model call the
// first rule whose `match` regex matches the latest user, custom or tool-result text wins.
// A rule with `once: true` is used at most once per process. Rule shape:
//   {"match": "regex", "once"?: bool, "text"?: "reply", "thinking"?: "...",
//    "toolCalls"?: [{"name": "bash", "args": {...}}], "stopReason"?: "stop" | "toolUse" | "error",
//    "errorMessage"?: "...", "delayMs"?: number}
// With no matching rule the reply is the text "FAUX: no rule matched".
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Rule = {
  match: string;
  once?: boolean;
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: "stop" | "toolUse" | "error";
  errorMessage?: string;
  delayMs?: number;
};

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
  const rules: Rule[] = JSON.parse(readFileSync(scriptPath, "utf8")).rules;
  const used = new Set<number>();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true, contextWindow: 272000, maxTokens: 128000 }] });
  faux.setResponses(
    Array.from({ length: 10_000 }, () => async (context: any) => {
      const text = latestText(context);
      const index = rules.findIndex((rule, i) => !(rule.once && used.has(i)) && new RegExp(rule.match, "s").test(text));
      if (index < 0) return fauxAssistantMessage("FAUX: no rule matched");
      used.add(index);
      const rule = rules[index];
      if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
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
