// Test-only: lay out the five roster agents in a scratch home, each naming `launcher: nopush` like
// the shipped home/agents/*.md, so the root guard can pin them (loop-guard/launcher-pin.ts). Not
// itself a test file.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LANE_AGENT_NAMES = ["worker", "senior", "senior-escalation", "reviewer", "scout"] as const;

export function writeLaneAgents(agentDir: string): void {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  for (const name of LANE_AGENT_NAMES) {
    writeFileSync(join(agentDir, "agents", `${name}.md`), [
      "---", `name: ${name}`, "description: Root guard fixture", "tools: read", "extensions: []", "launcher: nopush",
      "---", "", "Root guard fixture.",
    ].join("\n"));
  }
}

const NOPUSH_WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "loop-pi-nopush");

/** Make a scratch home launch its lanes the way the installed home does: the user subagent config
 *  maps `runnerLaunchers.nopush` to the shipped wrapper, and every agent file that names no launcher
 *  gets `launcher: nopush`. The root guard pins every lane launch to that launcher, so a home whose
 *  agents name none has every root launch refused. Call it after the agent files are written. */
export function adoptNopushLauncher(agentDir: string): void {
  const configDir = join(agentDir, "extensions", "subagent");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  config.runnerLaunchers = { nopush: [NOPUSH_WRAPPER] };
  writeFileSync(configPath, JSON.stringify(config));
  const agents = join(agentDir, "agents");
  if (!existsSync(agents)) return;
  for (const name of readdirSync(agents)) {
    if (!name.endsWith(".md")) continue;
    const path = join(agents, name);
    const text = readFileSync(path, "utf8");
    const end = text.indexOf("\n---", 3);
    if (!text.startsWith("---\n") || end < 0 || /^launcher:/m.test(text.slice(0, end))) continue;
    writeFileSync(path, `${text.slice(0, end)}\nlauncher: nopush${text.slice(end)}`);
  }
}
