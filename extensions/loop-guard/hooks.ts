// Adapter that runs the shared Codex-template PreToolUse hook scripts
// (backlog-guard.py, staging-guard.py) against a pi tool call.
//
// SEAMS.md: "Shared hook scripts: <agentDir>/scripts/backlog-guard.py and
// staging-guard.py, run as `python3 <script>` with a Codex-format JSON payload
// on stdin ... a deny is exit 0 with `hookSpecificOutput.permissionDecision ==
// "deny"` on stdout." These scripts fail open by design (a crash or unexpected
// input never blocks); the adapter itself failing or timing out is a different
// condition, and C4 item 1 says that "blocks the call for lanes" (root allows
// it through, per the same "root allows with a logged warning" posture as an
// unparseable command).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The guard scripts loop-guard knows how to run, in the order it runs them. */
export const KNOWN_HOOK_SCRIPTS = ["backlog-guard.py", "staging-guard.py"] as const;

export interface HookScriptResult {
  /** True when the script itself returned a permissionDecision: "deny". */
  denied: boolean;
  reason?: string;
  /** Set when the adapter could not get a verdict from the script at all
   *  (spawn error, non-zero/non-two exit with no parseable deny, or timeout). */
  adapterFailure?: string;
}

export function hookScriptPaths(agentDir: string): { backlogGuard: string; stagingGuard: string } {
  return {
    backlogGuard: join(agentDir, "scripts", "backlog-guard.py"),
    stagingGuard: join(agentDir, "scripts", "staging-guard.py"),
  };
}

/** Guard scripts the home's settings.json requires (`loopPi.requiredHookScripts`, default none).
 *  An absent file or key requires nothing. A file that is not valid JSON, or a key that is not an
 *  array of strings, fails closed: every known guard is required, so a broken config never quietly
 *  switches a guard off. */
export function requiredHookScripts(agentDir: string): string[] {
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return [];
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const value = settings?.loopPi?.requiredHookScripts;
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    // fall through to fail closed
  }
  return [...KNOWN_HOOK_SCRIPTS];
}

/** The scripts to run for one tool call: each named script that exists in `<agentDir>/scripts/`, plus
 *  each required one even when absent (running an absent script is an adapter failure). */
export function hookScriptsToRun(agentDir: string, names: readonly string[]): string[] {
  const required = new Set(requiredHookScripts(agentDir));
  return names
    .map((name) => ({ name, path: join(agentDir, "scripts", name) }))
    .filter(({ name, path }) => required.has(name) || existsSync(path))
    .map(({ path }) => path);
}

export interface RunHookOptions {
  script: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  timeoutMs?: number;
}

/** Run one shared hook script with a Codex-format PreToolUse payload on stdin. */
export function runHookScript(options: RunHookOptions): Promise<HookScriptResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const payload = JSON.stringify({
    hookEventName: "PreToolUse",
    toolName: options.toolName,
    toolInput: options.toolInput,
    cwd: options.cwd,
  });

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("python3", [options.script], {
        cwd: options.cwd,
        env: { ...process.env, PWD: options.cwd, CODEX_PROJECT_DIR: options.cwd },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ denied: false, adapterFailure: `spawn error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: HookScriptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ denied: false, adapterFailure: `timeout after ${timeoutMs}ms running ${options.script}` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ denied: false, adapterFailure: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      try {
        const trimmed = stdout.trim();
        if (trimmed) {
          const parsed = JSON.parse(trimmed);
          const decision = parsed?.hookSpecificOutput?.permissionDecision;
          if (decision === "deny") {
            finish({ denied: true, reason: parsed?.hookSpecificOutput?.permissionDecisionReason });
            return;
          }
        }
      } catch {
        // Fall through: unparseable stdout is only an adapter failure if the
        // exit code also looks wrong; a script that exits 0 with no output is
        // the normal "allow" case for a Codex-shaped payload.
      }
      if (code !== 0) {
        finish({ denied: false, adapterFailure: `exit ${code}: ${stderr.trim() || "(no stderr)"}` });
        return;
      }
      finish({ denied: false });
    });

    // A script that exits or closes stdin before reading the whole payload makes this write fail
    // with EPIPE. Unhandled, that stream error would crash the session; the close handler above
    // still reports the script's exit, so a failing guard keeps blocking.
    child.stdin?.on("error", () => {});
    child.stdin?.write(payload);
    child.stdin?.end();
  });
}

export interface HookRunSummary {
  denied: boolean;
  reason?: string;
  /** Every adapter failure across the scripts that were run, in order. */
  adapterFailures: string[];
}

/** Run every applicable hook script for one tool call and summarise the result. */
export async function runHookScripts(
  scripts: string[],
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<HookRunSummary> {
  const adapterFailures: string[] = [];
  for (const script of scripts) {
    const result = await runHookScript({ script, toolName, toolInput, cwd });
    if (result.adapterFailure) adapterFailures.push(`${script}: ${result.adapterFailure}`);
    if (result.denied) {
      return { denied: true, reason: result.reason, adapterFailures };
    }
  }
  return { denied: false, adapterFailures };
}
