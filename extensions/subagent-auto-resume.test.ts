// pi-subagents 0.82.0 relaunches an interrupted background workflow by itself when its session is
// reopened (`autoResume`, default on). That relaunch goes through the executor, not a model
// `subagent` call, so loop-guard never sees it. loop-guard already refuses every workflow; the home
// also turns auto-resume off so no relaunch can bypass the guard.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const PACKAGE = new URL("../node_modules/pi-subagents/", import.meta.url);
const template = readFileSync(new URL("../home/extensions/subagent/config.json", import.meta.url), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "loop-pi-auto-resume-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the home turns pi-subagents workflow auto-resume off, and the pinned loader reads it", () => {
  const config = JSON.parse(template);
  assert.equal(config.autoResume, false);
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), template.replaceAll("{{HOME}}", agentDir));
  // The pinned package's own loader, in a child process so its agent dir comes from this env only.
  const loaded = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { loadConfig } from ${JSON.stringify(new URL("src/extension/config.js", PACKAGE).href)};` +
    " process.stdout.write(JSON.stringify(loadConfig()))"],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 15_000 });
  assert.equal(JSON.parse(loaded).autoResume, false, "the loader validates and keeps the key");
});

test("the pinned pi-subagents gates workflow auto-resume on config.autoResume in source and bundle", () => {
  const gate = /if \(recovering && ctx\.hasUI && config\.autoResume !== false\)/;
  assert.match(readFileSync(new URL("src/extension/index.js", PACKAGE), "utf8"), gate);
  const bundle = new URL("bundle/", PACKAGE);
  const chunks = readdirSync(bundle).filter((name) => name.endsWith(".js")).map((name) => readFileSync(new URL(name, bundle), "utf8"));
  assert.ok(chunks.some((text) => /config\.autoResume !== false/.test(text)), "the loaded bundle carries the same gate");
});
