import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const { dependencies } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const versionPatterns = {
  "@earendil-works/pi-coding-agent": /(?:@earendil-works\/pi-coding-agent|\bpi)`?\s+(\d+\.\d+(?:\.\d+)?)/g,
  "pi-subagents": /\bpi-subagents\s+(\d+\.\d+(?:\.\d+)?)/g,
};

for (const file of ["README.md", "extensions/SEAMS.md"]) {
  test(`${file} states the exact pinned runtime versions`, () => {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const [name, pattern] of Object.entries(versionPatterns)) {
      const versions = [...text.matchAll(pattern)].map((match) => match[1]);
      assert.ok(versions.length > 0, `${file} must state ${name}'s pinned version`);
      for (const version of versions) {
        assert.equal(version, dependencies[name], `${file}: stale ${name} version ${version}`);
      }
    }
  });
}
