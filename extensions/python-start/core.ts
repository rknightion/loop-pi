// Where an extension finds Python 3.15 to start a script on. Same order as the bin/ tools' python-floor
// block (AGENTS.md, Python): python3.15 on PATH, then Homebrew's, then a 3.15 uv already has. Never
// the system python3, which on a host with an older one would run the script on the wrong version.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const HOMEBREW_PYTHON = ["/opt/homebrew/bin/python3.15", "/home/linuxbrew/.linuxbrew/bin/python3.15"] as const;

export interface FindPythonDeps {
  path?: string;
  homebrew?: readonly string[];
  /** Runs uv's resolve-only query from /; null when uv is absent or finds nothing. */
  uvFind?: (path: string) => string | null;
  executable?: (file: string) => boolean;
  exists?: (file: string) => boolean;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** uv only resolves a path: from /, with --directory (UV_WORKING_DIR cannot override it), the virtual
 *  environment variables emptied and no project or config, so nothing in the caller's directory steers
 *  it. It never runs the script and never downloads. */
function uvResolve(path: string): string | null {
  for (const dir of path.split(":")) {
    if (!dir.startsWith("/")) continue;
    const uv = join(dir, "uv");
    if (!isExecutableFile(uv)) continue;
    try {
      const out = execFileSync(uv, ["--directory", "/", "python", "find", "--no-project", "--no-config", "--no-python-downloads", "3.15"], {
        cwd: "/",
        env: { ...process.env, VIRTUAL_ENV: "", CONDA_PREFIX: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return out.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The absolute path of a Python 3.15, or null. Only absolute PATH entries count: a "." or empty
 *  element would run a file from the current repository. A virtual environment's python is refused. */
export function findPython315(deps: FindPythonDeps = {}): string | null {
  const path = deps.path ?? process.env.PATH ?? "";
  const executable = deps.executable ?? isExecutableFile;
  const exists = deps.exists ?? existsSync;
  for (const dir of path.split(":")) {
    if (dir.startsWith("/") && executable(join(dir, "python3.15"))) return join(dir, "python3.15");
  }
  for (const candidate of deps.homebrew ?? HOMEBREW_PYTHON) {
    if (executable(candidate)) return candidate;
  }
  const found = (deps.uvFind ?? uvResolve)(path);
  if (found && found.startsWith("/") && !found.includes("/.venv/") && executable(found)) {
    const prefix = found.replace(/\/bin\/[^/]*$/, "");
    if (!exists(join(prefix, "pyvenv.cfg"))) return found;
  }
  return null;
}

/** A resolver that asks `find` once per `key` and reuses the answer, a miss included, so a host where
 *  only uv has a 3.15 pays for its synchronous subprocess once per process, not on every hook or
 *  checkpoint. The key defaults to PATH, so a changed PATH looks again. */
export function cachedResolver(find: () => string | null, key: () => string = () => process.env.PATH ?? ""): () => string | null {
  let seen: string | undefined;
  let value: string | null = null;
  return () => {
    const now = key();
    if (seen !== now) {
      value = find();
      seen = now;
    }
    return value;
  };
}

/** findPython315 for the running process, resolved on first use. */
export const python315 = cachedResolver(() => findPython315());
