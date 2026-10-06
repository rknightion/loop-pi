// Git writes an absolute gitdir pointer by default. Keep its original bytes in extension state,
// not the public working tree, and verify both its canonical target and HEAD around conversion.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export async function relativeGitdir(path: string, head: () => Promise<string>): Promise<string> {
  const file = join(path, ".git");
  const original = readFileSync(file, "utf8");
  const match = /^gitdir: (.+)\r?\n?$/.exec(original);
  if (!match) throw new Error("retained worktree has no gitdir pointer");
  const target = realpathSync(resolve(path, match[1]));
  const before = await head();
  if (!before) throw new Error("retained worktree HEAD could not be verified");
  const pointer = relative(realpathSync(path), target);
  const temp = `${file}.loop-tmp`;
  try {
    writeFileSync(temp, `gitdir: ${pointer}\n`, { flag: "wx" });
    renameSync(temp, file);
    const written = readFileSync(file, "utf8").trim().slice("gitdir: ".length);
    if (realpathSync(resolve(path, written)) !== target || (await head()) !== before) {
      throw new Error("relative gitdir conversion changed target or HEAD");
    }
  } catch (error) {
    // Restore the exact preimage on a failed verification, never leave an unverified pointer.
    writeFileSync(file, original);
    throw error;
  }
  return original;
}
