import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { freezeOpsGrants, parseOpsLine, validateOps } from "./ops-grants.ts";
import { parseLaunch } from "./launch-detect.ts";

const VALID = {
  v: 1,
  ops: [{ surface: "deploy:site", kind: "deploy", allow: ["^just deploy( |$)"], secret_paths: ["kv/ci/site/token"] }],
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("parseOpsLine", () => {
  const hex = "a".repeat(64);
  test("no line is none", () => {
    assert.deepEqual(parseOpsLine("You are the root.\nWrite codex/report-x-loop1.md"), { kind: "none" });
  });
  test("a well-formed line yields path and lowercase digest", () => {
    assert.deepEqual(parseOpsLine(`x\nOps grants: /r/codex/ops-x-loop1.json sha256=${hex.toUpperCase()}\n`), {
      kind: "line",
      path: "/r/codex/ops-x-loop1.json",
      sha256: hex,
    });
  });
  test("a relative path, a short digest and a second line are invalid", () => {
    assert.equal(parseOpsLine(`Ops grants: codex/ops.json sha256=${hex}`).kind, "invalid");
    assert.equal(parseOpsLine("Ops grants: /r/ops.json sha256=abc").kind, "invalid");
    assert.equal(
      parseOpsLine(`Ops grants: /r/a.json sha256=${hex}\nOps grants: /r/b.json sha256=${hex}`).kind,
      "invalid",
    );
  });
});

describe("validateOps", () => {
  test("accepts the S6 shape", () => {
    const checked = validateOps(VALID);
    assert.equal(checked.ok, true);
  });
  test("rejects each shape error", () => {
    const entry = VALID.ops[0];
    const bad: unknown[] = [
      null,
      [],
      { v: 2, ops: [] },
      { v: 1 },
      { v: 1, ops: [{ ...entry, kind: "nuke" }] },
      { v: 1, ops: [{ ...entry, surface: "" }] },
      { v: 1, ops: [{ ...entry, allow: ["("] }] },
      { v: 1, ops: [{ ...entry, allow: "^x" }] },
      { v: 1, ops: [{ ...entry, secret_paths: undefined }] },
      { v: 1, ops: ["deploy"] },
    ];
    for (const value of bad) assert.equal(validateOps(value).ok, false, JSON.stringify(value));
  });
});

describe("freezeOpsGrants", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-ops-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("freezes a file whose digest matches", () => {
    const text = JSON.stringify(VALID);
    const path = join(tmp, "ops.json");
    writeFileSync(path, text);
    const frozen = freezeOpsGrants(parseOpsLine(`Ops grants: ${path} sha256=${sha(text)}`));
    assert.deepEqual(frozen, { ops: VALID, opsPath: path, rejected: null });
  });

  test("a digest mismatch, a missing file and an invalid file all freeze null with a reason", () => {
    const path = join(tmp, "ops.json");
    writeFileSync(path, JSON.stringify(VALID));
    const mismatch = freezeOpsGrants(parseOpsLine(`Ops grants: ${path} sha256=${"0".repeat(64)}`));
    assert.equal(mismatch.ops, null);
    assert.match(mismatch.rejected ?? "", /sha256/);

    const missing = freezeOpsGrants(parseOpsLine(`Ops grants: ${join(tmp, "nope.json")} sha256=${"0".repeat(64)}`));
    assert.equal(missing.ops, null);
    assert.match(missing.rejected ?? "", /cannot be read/);

    const invalid = join(tmp, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ v: 1, ops: [{ surface: "x", kind: "nuke", allow: [], secret_paths: [] }] }));
    const frozenInvalid = freezeOpsGrants(
      parseOpsLine(`Ops grants: ${invalid} sha256=${sha(JSON.stringify({ v: 1, ops: [{ surface: "x", kind: "nuke", allow: [], secret_paths: [] }] }))}`),
    );
    assert.equal(frozenInvalid.ops, null);
    assert.match(frozenInvalid.rejected ?? "", /kind/);
  });

  test("no line freezes nothing and rejects nothing", () => {
    assert.deepEqual(freezeOpsGrants({ kind: "none" }), { ops: null, opsPath: null, rejected: null });
  });
});

describe("parseLaunch carries the Ops grants line", () => {
  const hex = "b".repeat(64);
  test("from a pasted launch message", () => {
    const text = `You are the root. Read the goal and write /r/codex/report-x-loop2.md as the terminal action.\nOps grants: /r/codex/ops-x-loop2.json sha256=${hex}`;
    const launch = parseLaunch(text, "/r", "2026-10-01T00:00:00Z");
    assert.deepEqual(launch?.opsLine, { kind: "line", path: "/r/codex/ops-x-loop2.json", sha256: hex });
  });
  test("from the body of a launch file", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-ops-launch-"));
    try {
      const body = `You are the root. Write /r/codex/report-x-loop2.md.\nOps grants: /r/ops.json sha256=${hex}\n`;
      const launch = parseLaunch(`${dir}/codex/launch-x-loop2.txt`, "/r", "2026-10-01T00:00:00Z", () => body);
      assert.equal(launch?.opsLine.kind, "line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a launch without the line has none", () => {
    assert.deepEqual(
      parseLaunch("You are the root. Write /r/codex/report-x-loop2.md.", "/r", "2026-10-01T00:00:00Z")?.opsLine,
      { kind: "none" },
    );
  });
});
