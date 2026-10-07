// Scripted stream fixture, never installed. Uses the real pi provider instrumentation path.
import { readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type Model, type Api, type TranscriptContext, type StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const fixture = fauxProvider({ provider: "timing-fixture", models: [{ id: "fixture", reasoning: true }] });
  const model = fixture.provider.getModels()[0];
  const stream = (_model: Model<Api>, _context: TranscriptContext, options?: StreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const script = JSON.parse(readFileSync(process.env.LOOP_PI_TIMING_SCRIPT!, "utf8"));
      const message = { ...fauxAssistantMessage(""), provider: model.provider, model: model.id, api: model.api, timestamp: Date.now() };
      await options?.onPayload?.({ fixture: true }, model);
      for (const headers of script.responses ?? []) await options?.onResponse?.({ status: 200, headers }, model);
      output.push({ type: "start", partial: message });
      const kind = script.kind ?? "text";
      if (kind === "text" || kind === "thinking") {
        message.content = kind === "text" ? [{ type: "text", text: "" }] : [{ type: "thinking", thinking: "" }];
        output.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: 0, partial: message });
        output.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: 0, delta: "", partial: message });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const first = Date.now();
        if (kind === "text") message.content = [{ type: "text", text: "first" }];
        else message.content = [{ type: "thinking", thinking: "first" }];
        output.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: 0, delta: "first", partial: message });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = Date.now();
        if (kind === "text") message.content = [{ type: "text", text: "firstsecond" }];
        else message.content = [{ type: "thinking", thinking: "firstsecond" }];
        output.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: 0, delta: "second", partial: message });
        output.push({ type: kind === "text" ? "text_end" : "thinking_end", contentIndex: 0, content: "firstsecond", partial: message });
        if (script.trace) writeFileSync(script.trace, JSON.stringify({ first, second }));
      }
      message.stopReason = "stop";
      output.push({ type: "done", reason: "stop", message });
      output.end();
    })();
    return output;
  };
  fixture.provider.streamSimple = stream;
  fixture.provider.stream = stream;
  pi.registerProvider(fixture.provider as any);
}
