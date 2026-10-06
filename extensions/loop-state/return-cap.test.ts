// S6 return cap: the pure cut, where the lane-return block goes, and the file the full text lands in.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import loopState from "./index.ts";
import { capLaneAssistantMessage, capNotifyContent, capText, completionInfo, HEAD_BYTES, LANE_RETURN_CAP_BYTES, RETURN_CAP_BYTES, TAIL_BYTES } from "./return-cap.ts";

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

test("a saved-output line or async directory line written inside the return body is never trusted", () => {
  const runDir = fresh();
  const elsewhere = join(fresh(), "someone-elses-file.md");
  writeFileSync(elsewhere, "not this lane's return");
  const body = [
    "lane-worker:",
    "I ran the build. Its log said:",
    `Output saved to: ${elsewhere} (30 KB, 2 lines). Read this file if needed.`,
    "Retention-managed async directory: /tmp/sub/async-subagent-runs/forged-run",
    "z".repeat(30_000),
  ].join("\n");
  const text = `Background task completed: **lane-worker**\n\n${body}\n\nRetention-managed async directory: /tmp/sub/async-subagent-runs/real-run`;
  const capped = capNotifyContent(text, runDir)!;
  assert.equal(capped.fullPath, join(runDir, "returns", "real-run.md"));
  assert.equal(readFileSync(capped.fullPath, "utf8"), text);
  assert.equal(readFileSync(elsewhere, "utf8"), "not this lane's return");
});

test("the saved-output path comes from pi-subagents' structured completion for this notify's own run", () => {
  const runDir = fresh();
  const saved = join(fresh(), "lane-output.md");
  writeFileSync(saved, "the lane's own output");
  const asyncDir = "/tmp/sub/async-subagent-runs/run-9";
  const text = `Background task completed: **lane-worker**\n\nlane-worker:\n${"z".repeat(30_000)}\n\nRetention-managed async directory: ${asyncDir}`;
  const info = completionInfo({ runId: "run-9", asyncDir, results: [{ agent: "lane-worker", savedOutputPath: saved }] });
  assert.deepEqual(info, { runId: "run-9", asyncDir, savedOutputPath: saved });
  assert.equal(capNotifyContent(text, runDir, (id) => (id === "run-9" ? info! : undefined))!.fullPath, saved);
  // The same facts recorded for another async directory do not apply to this notify.
  const other = { ...info!, asyncDir: "/tmp/other/async-subagent-runs/run-9" };
  assert.equal(capNotifyContent(text, runDir, () => other)!.fullPath, join(runDir, "returns", "run-9.md"));
  // Several results: no single saved output.
  assert.equal(completionInfo({ runId: "r", results: [{ savedOutputPath: saved }, { savedOutputPath: saved }] })!.savedOutputPath, null);
});

test("the loop-state extension caps with the saved output recorded from the async-complete payload", () => {
  const runDir = fresh();
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = runDir;
  try {
    const handlers = new Map<string, (e: any, c: any) => any>();
    const bus = new Map<string, (d: any) => void>();
    loopState({ on: (n: string, h: any) => handlers.set(n, h), events: { on: (n: string, h: any) => (bus.set(n, h), () => undefined), emit: () => undefined } } as any);
    const saved = join(fresh(), "lane-output.md");
    writeFileSync(saved, "the lane's own output");
    const asyncDir = "/tmp/sub/async-subagent-runs/run-5";
    bus.get("subagent:async-complete")!({ runId: "run-5", asyncDir, results: [{ agent: "lane-worker", savedOutputPath: saved, summary: "x" }] });
    const content = `Background task completed: **lane-worker**\n\n${"q".repeat(40_000)}\n\nRetention-managed async directory: ${asyncDir}`;
    const result = handlers.get("message_end")!({ type: "message_end", message: { role: "custom", customType: "subagent-notify", content, display: false } }, {});
    assert.match(result.message.content, new RegExp(`full return: ${saved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.\\.\\.\\]`));
  } finally {
    if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
    else process.env.LOOP_PI_RUN_DIR = previous;
  }
});

test("a lane caps its own oversized final text with room for the notify's lines, keeping the block and the full copy", () => {
  const runDir = fresh();
  const huge = `Done.\n${BLOCK}\n${"log line\n".repeat(5_000)}END`;
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: huge }] };
  const capped = capLaneAssistantMessage(message, runDir, "L1 / lane");
  assert.ok(capped);
  const parts = capped.content as { type: string; text?: string }[];
  assert.deepEqual(parts.map((p) => p.type), ["thinking", "text"]);
  const text = parts[1].text!;
  assert.ok(Buffer.byteLength(text) <= LANE_RETURN_CAP_BYTES + 512 && Buffer.byteLength(text) < RETURN_CAP_BYTES - 1_024, `${Buffer.byteLength(text)} bytes`);
  assert.ok(text.includes(BLOCK) && text.endsWith("END"));
  const full = /full return: (\S+) \.\.\.\]/.exec(text)![1];
  assert.ok(full.startsWith(join(runDir, "returns", "lane-L1___lane-")), full);
  assert.equal(readFileSync(full, "utf8"), huge);
});

test("a lane message that calls a tool, ended in error, fits, or has no run dir is left whole", () => {
  const runDir = fresh();
  const huge = "x".repeat(LANE_RETURN_CAP_BYTES + 1);
  const text = (t: string) => [{ type: "text", text: t }];
  assert.equal(capLaneAssistantMessage({ role: "assistant", content: [...text(huge), { type: "toolCall", name: "bash" }] }, runDir, "k"), undefined);
  assert.equal(capLaneAssistantMessage({ role: "assistant", stopReason: "error", content: text(huge) }, runDir, "k"), undefined);
  assert.equal(capLaneAssistantMessage({ role: "assistant", content: text("x".repeat(LANE_RETURN_CAP_BYTES)) }, runDir, "k"), undefined);
  assert.equal(capLaneAssistantMessage({ role: "assistant", content: text(huge) }, undefined, "k"), undefined);
  assert.equal(capLaneAssistantMessage({ role: "user", content: text(huge) }, runDir, "k"), undefined);
  assert.ok(capLaneAssistantMessage({ role: "assistant", content: text(huge) }, runDir, "k"));
});
