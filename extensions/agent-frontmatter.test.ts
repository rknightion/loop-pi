import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bundledModuleUrl } from "./loop-guard/rpc-test-helpers.ts";

// Execute the module from the package entry's reachable bundle, exactly as the runtime does.
const { parseFrontmatter, parseFrontmatterList } = await import(bundledModuleUrl("agents/frontmatter", ["parseFrontmatter", "parseFrontmatterList"]));
const writerTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "watch_process"];
const expectations: Record<string, { tools: string[]; allowedAgents?: string[] }> = {
  worker: { tools: writerTools },
  senior: { tools: [...writerTools, "subagent"], allowedAgents: ["scout", "worker", "reviewer"] },
  "senior-escalation": { tools: writerTools },
  reviewer: { tools: ["read", "grep", "find", "ls", "bash"] },
  scout: { tools: ["read", "grep", "find", "ls", "bash"] },
};
for (const [agent, expected] of Object.entries(expectations)) {
  test(`runtime frontmatter fence: ${agent}`, () => {
    let text = readFileSync(new URL(`../home/agents/${agent}.md`, import.meta.url), "utf8");
    if (process.env.LOOP_PI_FRONTMATTER_NEGATIVE === "1" && agent === "reviewer") {
      text = text.replace(/^tools:.*$/m, "tools:\n  - read\n  - grep\n  - find\n  - ls\n  - bash\n\n  - edit");
    }
    const { frontmatter: f } = parseFrontmatter(text);
    assert.deepEqual(parseFrontmatterList(f.tools), expected.tools);
    assert.deepEqual(parseFrontmatterList(f.allowedAgents), expected.allowedAgents);
    assert.equal(f.launcher, "nopush");
    assert.equal(f.async, "true");
    // The child extension allowlist: ambient extensions stay off, the telemetry extension loads.
    assert.deepEqual(parseFrontmatterList(f.extensions), ["{{HOME}}/vendor/agento11y-pi/dist/index.js"]);
  });
}
