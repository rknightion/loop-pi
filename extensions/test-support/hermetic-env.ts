// Environment for a pi process a test spawns. Not itself a test file.
//
// A test run inside a loop lane inherits that lane's pi-subagents markers (PI_SUBAGENT_CHILD=1,
// PI_SUBAGENT_PARENT_SESSION, PI_SUBAGENT_RUNNER_CONFIG, ...). Passed through, they make the
// spawned test pi believe it is itself a subagent child, so pi-subagents withholds the `subagent`
// tool and any root-side test fails with "Tool subagent not found". Loop-pi deliberately gives
// children no nested spawning; the test pi is a fresh root, so drop every inherited marker.
const INHERITED_SUBAGENT_ENV = /^PI_SUBAGENTS?_/;

export function hermeticPiEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_SUBAGENT_ENV.test(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}
