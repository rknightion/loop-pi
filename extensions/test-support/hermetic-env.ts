// Environment for a pi process a test spawns. Not itself a test file.
//
// A test run inside a loop lane inherits that lane's pi-subagents markers (PI_SUBAGENT_CHILD=1,
// PI_SUBAGENT_PARENT_SESSION, PI_SUBAGENT_RUNNER_CONFIG, ...). Passed through, they make the
// spawned test pi believe it is itself a subagent child, so pi-subagents withholds the `subagent`
// tool and any root-side test fails with "Tool subagent not found". Loop-pi deliberately gives
// children no nested spawning; the test pi is a fresh root, so drop every inherited marker.
const INHERITED_SUBAGENT_ENV = /^PI_SUBAGENTS?_/;
const INHERITED_GIT_CONFIG = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;

// Disposable fixture subprocesses own their Git configuration. Inherited command-scope
// config can override even a repository-local insteadOf or local SSH pack transport.
// Filter only the copied child environment, never the test runner or its lane fence.
// Explicit overrides are applied afterwards so tests can deliberately install controls.
export function hermeticFixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_GIT_CONFIG.test(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}

export function hermeticPiEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = hermeticFixtureEnv();
  for (const key of Object.keys(env)) {
    if (INHERITED_SUBAGENT_ENV.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}
