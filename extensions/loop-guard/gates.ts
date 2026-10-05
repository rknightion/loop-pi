// Explicit heavy-gate grammar shared with bin/loop-gate-lock; ordinary mutex prose is advisory.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GateDeclaration { name: string; command: string }
export interface GateDeclarations {
  gates: GateDeclaration[];
  error?: string;
  /** Runtime approval binds canonical execution cwd and the exact LOOP.md bytes. */
  cwd?: string;
  sha256?: string;
}

export function parseGateDeclarations(text: string): GateDeclarations {
  const gates: GateDeclaration[] = [];
  let active = false;
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^#{1,2}(?:\s|$)/.test(trimmed)) {
      active = trimmed === "## Mutexes";
      continue;
    }
    if (!active || !/^-\s+gate:/.test(trimmed)) continue;
    const declaration = /^-\s+gate:\s*([^|]+)\|(.*)$/.exec(trimmed);
    if (!declaration) return { gates: [], error: "malformed explicit gate declaration in LOOP.md" };
    const name = declaration[1].trim();
    const command = declaration[2].trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !command || command.includes("\0")) {
      return { gates: [], error: "invalid gate name or empty command in LOOP.md" };
    }
    if (gates.some((g) => g.name === name || g.command === command)) {
      return { gates: [], error: "duplicate gate name or command in LOOP.md" };
    }
    gates.push({ name, command });
  }
  return { gates };
}

/** Walk to this worktree's root, never another checkout via the common git dir. */
export function loadGateDeclarations(cwd: string): GateDeclarations {
  let executionCwd: string;
  try { executionCwd = realpathSync(cwd); }
  catch { return { gates: [], error: "cannot resolve gate execution cwd" }; }
  let directory = executionCwd;
  for (;;) {
    if (existsSync(join(directory, ".git"))) {
      try {
        const path = join(directory, "LOOP.md");
        if (!existsSync(path)) return { gates: [] };
        const bytes = readFileSync(path);
        return { ...parseGateDeclarations(bytes.toString("utf8")), cwd: executionCwd,
          sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch {
        return { gates: [], error: "cannot read LOOP.md gate declarations" };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return { gates: [] };
    directory = parent;
  }
}
