// The home's custom `subagent` tool description (home/subagent-tool-description.md), rendered by the
// installed pi-subagents exactly as a loop home renders it. pi-subagents 0.77.0's compact text
// advertises `{workflow:"parallel",...}`; loop-guard refuses every `workflow`, so the loop-pi header
// must say so before the model reads the package's line.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildSubagentToolDescription } from "../../node_modules/pi-subagents/src/extension/tool-description.js";
import { evaluateSubagentCall } from "./rules.ts";

const made: string[] = [];
after(() => { while (made.length) rmSync(made.pop()!, { recursive: true, force: true }); });

test("the rendered custom description refuses workflow, parallel included, and asks for one async {agent, task} call per lane", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "loop-pi-tooldesc-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "loop-pi-tooldesc-cwd-"));
  made.push(agentDir, cwd);
  copyFileSync(new URL("../../home/subagent-tool-description.md", import.meta.url), join(agentDir, "subagent-tool-description.md"));
  const warnings: string[] = [];
  const rendered: string = buildSubagentToolDescription({ toolDescriptionMode: "custom" }, { agentDir, cwd, warn: (m: string) => warnings.push(m) });
  assert.deepEqual(warnings, []);
  const packageAt = rendered.indexOf('Independent parallel children: {workflow:"parallel"');
  assert.ok(packageAt > 0, "the package's compact text, which offers workflow:\"parallel\", is rendered below the header");
  const header = rendered.slice(0, packageAt);
  assert.match(header, /workflow:\s*"parallel"/, "the header names the parallel workflow");
  assert.match(header, /refuse/i);
  assert.match(header, /async `subagent` call with \{agent, task\}, one call per lane/);
  // The header's claim holds: the guard refuses the shape the package advertises.
  assert.equal(evaluateSubagentCall({ workflow: "parallel", args: { tasks: [{ agent: "worker", task: "x" }] } }).block, true);
});
