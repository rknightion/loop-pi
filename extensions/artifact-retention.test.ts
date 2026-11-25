// pi-subagents prunes a session's artifacts (including outputs/<run id>/, where a lane's saved
// output lives) once nothing has touched them for artifactConfig.cleanupDays days, 7 by default. A
// root resumed after that loses the "Full output" file a notify named; the returns/ copy in the run
// dir is the only durable one. The home therefore keeps artifacts longer than the default.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupOldArtifacts } from "../node_modules/pi-subagents/src/shared/artifacts.js";

const PACKAGE = new URL("../node_modules/pi-subagents/", import.meta.url);
const template = readFileSync(new URL("../home/extensions/subagent/config.json", import.meta.url), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "loop-pi-artifact-retention-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;

function configuredCleanupDays(): number | undefined {
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), template.replaceAll("{{HOME}}", agentDir));
  // The pinned package's own loader, in a child process so its agent dir comes from this env only.
  const loaded = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { loadConfig } from ${JSON.stringify(new URL("src/extension/config.js", PACKAGE).href)};` +
    " process.stdout.write(JSON.stringify(loadConfig()))"],
  { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 15_000 });
  return JSON.parse(loaded).artifactConfig?.cleanupDays;
}

/** An artifacts dir holding a lane's saved output last written `ageDays` ago. */
function artifactsWithSavedOutput(name: string, ageDays: number): string {
  const dir = join(scratch, name);
  const run = join(dir, "outputs", "run-1");
  mkdirSync(run, { recursive: true });
  const saved = join(run, "worker.md");
  writeFileSync(saved, "full lane output");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  for (const path of [saved, run, join(dir, "outputs")]) utimesSync(path, when, when);
  return saved;
}

test("pi-subagents' default retention removes a saved lane output after a week", () => {
  const saved = artifactsWithSavedOutput("default", 10);
  cleanupOldArtifacts(join(scratch, "default"), 7);
  assert.equal(existsSync(saved), false);
});

test("the home keeps a saved lane output for longer than the default week, and the pinned loader reads it", () => {
  const days = configuredCleanupDays();
  assert.ok(typeof days === "number" && days > 10, `artifactConfig.cleanupDays must exceed 10 days: ${days}`);
  const saved = artifactsWithSavedOutput("home", 10);
  cleanupOldArtifacts(join(scratch, "home"), days);
  assert.equal(existsSync(saved), true);
  const stale = artifactsWithSavedOutput("stale", days + 1);
  cleanupOldArtifacts(join(scratch, "stale"), days);
  assert.equal(existsSync(stale), false, "retention is still bounded");
});
