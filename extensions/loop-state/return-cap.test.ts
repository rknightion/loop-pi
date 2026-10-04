// S6 return cap: the pure cut, where the lane-return block goes, and the file the full text lands in.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import loopState from "./index.ts";
import { capNotifyContent, capText, HEAD_BYTES, RETURN_CAP_BYTES, TAIL_BYTES } from "./return-cap.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "return-cap-"));
  dirs.push(d);
  return d;
};

const BLOCK = '```lane-return\n{"v":2,"lane":"L1","status":"complete","sha":null,"landed":false}\n```';

test("a text within the cap is left alone", () => {
  assert.equal(capText("x".repeat(RETURN_CAP_BYTES), "/f"), null);
});

test("an oversized text keeps head, marker, tail; a block outside the tail is appended once after the marker", () => {
  const text = `${BLOCK}\n${"a".repeat(50_000)}\nTAIL`;
  const capped = capText(text, "/runs/r/returns/x.md")!;
  const lines = capped.split("\n");
  const marker = lines.findIndex((l) => l.startsWith("[... "));
  assert.equal(lines[marker], `[... ${Buffer.byteLength(text) - HEAD_BYTES - TAIL_BYTES} bytes omitted; full return: /runs/r/returns/x.md ...]`);
  assert.equal(lines.slice(marker + 1, marker + 4).join("\n"), BLOCK);
  assert.ok(capped.endsWith("\nTAIL"));
  assert.ok(Buffer.byteLength(capped) <= RETURN_CAP_BYTES);
});

test("a block wholly inside the kept tail is not repeated", () => {
  const text = `${"a".repeat(50_000)}\n${BLOCK}`;
  const capped = capText(text, "/f")!;
  assert.equal(capped.split("```lane-return").length - 1, 1);
  assert.ok(capped.endsWith(BLOCK));
});

test("a block that straddles the tail boundary is appended whole", () => {
  const tailStart = 50_000 + BLOCK.length - TAIL_BYTES;
  const text = `${"a".repeat(50_000)}${BLOCK}${"b".repeat(TAIL_BYTES - BLOCK.length + 10)}`;
  assert.ok(tailStart > 0);
  const capped = capText(text, "/f")!;
  assert.ok(capped.includes(`...]\n${BLOCK}\n`));
});

test("the cut never splits a multi-byte character", () => {
  // Odd offsets are character boundaries, so both the 6,144-byte head and the 8,192-byte tail cut mid-character.
  const text = `a${"é".repeat(20_000)}b`;
  const capped = capText(text, "/f")!;
  assert.ok(!capped.includes("�"));
  const [head, , tail] = capped.split("\n");
  assert.ok(Buffer.byteLength(head) <= HEAD_BYTES && Buffer.byteLength(tail) <= TAIL_BYTES);
});

test("the full text goes to returns/<run id>.md, or the saved output file pi-subagents reported", () => {
  const runDir = fresh();
  const asyncDir = "/tmp/sub/async-subagent-runs/0123abcd-run";
  const text = `Background task completed: **lane-worker**\n\n${"z".repeat(30_000)}\nRetention-managed async directory: ${asyncDir}`;
  const capped = capNotifyContent(text, runDir)!;
  assert.equal(capped.fullPath, join(runDir, "returns", "0123abcd-run.md"));
  assert.equal(readFileSync(capped.fullPath, "utf8"), text);

  const saved = join(fresh(), "out.md");
  writeFileSync(saved, "the lane's own output");
  const withSaved = `Output saved to: ${saved} (30 KB, 2 lines). Read this file if needed.\n${"z".repeat(30_000)}`;
  const capped2 = capNotifyContent(withSaved, runDir)!;
  assert.equal(capped2.fullPath, saved);
  assert.match(capped2.text, new RegExp(`full return: ${saved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.\\.\\.\\]`));
});

test("without a run dir the message is left whole rather than lose its full text", () => {
  assert.equal(capNotifyContent("y".repeat(40_000), undefined), null);
  assert.equal(capNotifyContent("y".repeat(40_000), join(fresh(), "absent")), null);
});

test("the context hook caps an oversized notify already in the session, and leaves other messages alone", () => {
  const runDir = fresh();
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  try {
    const handlers = new Map<string, (e: any, c: any) => any>();
    loopState({ on: (n: string, h: any) => handlers.set(n, h), events: { on: () => () => undefined, emit: () => undefined } } as any);
    const big = { role: "custom", customType: "subagent-notify", content: `${BLOCK}\n${"q".repeat(40_000)}`, display: false };
    const user = { role: "user", content: "u".repeat(40_000) };
    const small = { role: "custom", customType: "subagent-notify", content: "short", display: false };
    const result = handlers.get("context")!({ type: "context", messages: [user, big, small] }, {});
    assert.equal(result.messages[0], user);
    assert.equal(result.messages[2], small);
    assert.ok(Buffer.byteLength(result.messages[1].content) <= RETURN_CAP_BYTES);
    assert.ok(result.messages[1].content.includes(BLOCK));
    assert.equal(handlers.get("context")!({ type: "context", messages: [user, small] }, {}), undefined);
  } finally {
    if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previous;
  }
});
