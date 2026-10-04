// The closeout audit loop-continuation runs itself at `/loop-closeout` (protocol marker present):
//   loop-pi-audit closeout --run-dir <run dir> [--grants <frozen copy> --grants-sha256 <held digest>]
//     --push-log <run dir>/push-log.jsonl
// The result goes to the root as a `loop-closeout-audit` message. A non-zero exit is never clean.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOSEOUT_MESSAGE_TYPE = "loop-closeout-audit";
export const CLOSEOUT_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_BYTES = 8_192;

export function closeoutArgs(runDir: string, grants: { path: string | null; sha256: string | null }): string[] {
  const args = ["closeout", "--run-dir", runDir];
  if (grants.path && grants.sha256) args.push("--grants", grants.path, "--grants-sha256", grants.sha256);
  args.push("--push-log", join(runDir, "push-log.jsonl"));
  return args;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<agentDir>/bin/loop-pi-audit`, else the build's own `bin/loop-pi-audit`, else PATH. */
export function auditBinary(agentDir: string): string {
  const home = join(agentDir, "bin", "loop-pi-audit");
  if (executable(home)) return home;
  const build = fileURLToPath(new URL("../../bin/loop-pi-audit", import.meta.url));
  if (executable(build)) return build;
  return "loop-pi-audit";
}

export interface AuditResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCloseoutAudit(bin: string, args: string[], cwd: string, timeoutMs = CLOSEOUT_TIMEOUT_MS): Promise<AuditResult> {
  return new Promise((done) => {
    try {
      execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        done({ code, stdout: String(stdout ?? ""), stderr: error && code === null ? `${error.message}\n${String(stderr ?? "")}` : String(stderr ?? "") });
      });
    } catch (error) {
      done({ code: null, stdout: "", stderr: String(error) });
    }
  });
}

function tail(text: string): string {
  const buf = Buffer.from(text.trim(), "utf8");
  if (buf.length <= OUTPUT_TAIL_BYTES) return buf.toString("utf8");
  return `[... ${buf.length - OUTPUT_TAIL_BYTES} bytes omitted ...]\n${buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8")}`;
}

/** The message the root reads after `/loop-closeout`. */
export function closeoutMessage(argv: string[], result: AuditResult, lines: readonly string[]): string {
  const verdict =
    result.code === 0
      ? "clean"
      : "NOT clean: a non-zero result is never clean; list every ungranted change in the report";
  const parts = [`loop-closeout: \`${argv.join(" ")}\` exited ${result.code ?? "without a code"} (${verdict}).`];
  if (result.stdout.trim()) parts.push(`stdout:\n${tail(result.stdout)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${tail(result.stderr)}`);
  for (const line of lines) if (line.trim()) parts.push(line.trim());
  return parts.join("\n\n");
}
