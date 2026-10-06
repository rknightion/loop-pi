// Test-only explicit root closeout; fixtures are never installed in a runtime home.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "test_release",
    label: "Release retained test worktrees",
    description: "Explicit root closeout for the worktree regression.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      const pending: Promise<unknown>[] = [];
      pi.events.emit("loop-closeout", { lines, pending });
      await Promise.all(pending);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { lines } };
    },
  });
}
