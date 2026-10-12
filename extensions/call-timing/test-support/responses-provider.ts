// Offline fixture, never installed: an `openai-responses` provider pointed at a local scripted SSE
// server, so pi's own OpenAI client, SSE parser, raw stream hook and Responses normalization run
// unchanged. The key is a placeholder the local server ignores.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("progress-fixture", {
    baseUrl: process.env.LOOP_PI_PROGRESS_BASE_URL!,
    apiKey: "fixture-placeholder",
    api: "openai-responses",
    models: [{
      id: "fixture", name: "fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    }],
  });
}
