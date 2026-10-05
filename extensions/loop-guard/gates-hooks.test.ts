import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import rootExtension from "./root.ts";
import laneExtension from "./lane.ts";

for (const [role, extension, tools] of [
  ["root", rootExtension, ["bash", "watch_process", "watch_start"]],
  ["lane", laneExtension, ["bash", "watch_process"]],
] as const) {
  test(`${role}: all shell tools enforce gates and hooks see the actual declared command`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "gate-hooks-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      mkdirSync(join(directory, ".git"));
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, "LOOP.md"), "## Mutexes\n- gate: heavy | printf hidden\n");
      writeFileSync(join(directory, "scripts/backlog-guard.py"),
        'import json, sys\np = json.load(sys.stdin)\nif p["toolInput"]["command"] == "printf hidden":\n print(json.dumps({"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"declared command seen"}}))\n');
      const handlers = new Map<string, Function[]>();
      const pi = {
        on(event: string, handler: Function) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        events: { on() {}, emit() {} },
      };
      extension(pi as any);
      const ctx = { cwd: directory, ui: { notify() {} } };
      const call = handlers.get("tool_call")![0];
      for (const toolName of tools) {
        const naked = await call({ toolName, input: { command: "printf hidden" } }, ctx);
        assert.equal(naked?.block, true, toolName);
        assert.match(naked.reason, /loop-gate-lock heavy/);
        const wrapped = await call({ toolName, input: { command: "loop-gate-lock heavy" } }, ctx);
        assert.equal(wrapped?.block, true, toolName);
        assert.equal(wrapped.reason, "declared command seen", toolName);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
