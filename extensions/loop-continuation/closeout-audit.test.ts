import assert from "node:assert/strict";
import { test } from "node:test";

import { closeoutArgs } from "./closeout-audit.ts";

const SHA = "a".repeat(64);

test("the closeout audit is handed the charter frozen at arm and its digest", () => {
  assert.deepEqual(closeoutArgs("/run", { path: "/repo/codex/charter-x-loop1.md", sha256: SHA }), [
    "closeout", "--run-dir", "/run", "--push-log", "/run/push-log.jsonl",
    "--charter", "/repo/codex/charter-x-loop1.md", "--charter-sha256", SHA,
  ]);
});

test("a root armed without a frozen charter runs the audit without release authority", () => {
  const plain = ["closeout", "--run-dir", "/run", "--push-log", "/run/push-log.jsonl"];
  assert.deepEqual(closeoutArgs("/run"), plain);
  assert.deepEqual(closeoutArgs("/run", null), plain);
  assert.deepEqual(closeoutArgs("/run", { path: "", sha256: SHA }), plain);
});
