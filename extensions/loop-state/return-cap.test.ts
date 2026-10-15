// S6 return cap: the pure cut, where the lane-return block goes, and the file the full text lands in.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import loopState from "./index.ts";
import { parseLaneReturn, returnEvent } from "./core.ts";
import { parseLaneReturn as parseDispatcherLaneReturn } from "../dispatcher/brief.ts";
import { capLaneAssistantMessage, capNotifyContent, capNotifyMessage, capText, completionInfo, HEAD_BYTES, LANE_RETURN_CAP_BYTES, RETURN_CAP_BYTES, TAIL_BYTES } from "./return-cap.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "return-cap-"));
  dirs.push(d);
  return d;
};

const BLOCK = '```lane-return\n{"v":2,"lane":"L1","status":"complete","sha":null,"landed":false}\n```';

// Invoke the pinned package's real preview producer: do not reproduce its slice/line-end logic.
const nativeOutput = await import(new URL("../../node_modules/pi-subagents/src/runs/shared/single-output.js", import.meta.url).href);
const agentDir = new URL("../../home/agents/", import.meta.url);
const serializedBudget = (policy: string) => {
  const match = /serialized fenced block at most ([\d,]+) UTF-16 code units/.exec(policy);
  return match ? Number(match[1].replaceAll(",", "")) : null;
};
const fenced = (data: Record<string, unknown>, tag = "lane-return") => `\`\`\`${tag}\n${JSON.stringify(data)}\n\`\`\`\n`;
const returnData = (status: string, tail: string) => ({
  v: 2, lane: "L-preview", status, sha: null, landed: false, base: "a".repeat(40),
  check: 'env LABEL="é😀" npm test && printf "\\n"', exit: status === "partial" ? null : 1,
  tail, ci: null, coderabbit: { ran: false, major: 0, unreviewed: 0 },
  questions: ["Review remains pending; full evidence: /runs/evidence/output.md"],
});
const oldAllowedReturn = (status: string) => fenced(returnData(status, Array.from({ length: 40 }, (_, i) => `${i}: ${"é😀\\\"".repeat(24)}`).join("\n")));
const maximalReturn = (status: string, budget: number | null) => {
  if (budget === null) return oldAllowedReturn(status); // The old policy allowed this 40-line tail.
  const data = returnData(status, 'last failure: é😀\\"\n');
  const remaining = budget - fenced(data).length;
  assert.ok(remaining >= 0, "required fixed fields must fit without abbreviating the exact check");
  data.tail += "x".repeat(remaining);
  const block = fenced(data);
  assert.equal(block.length, budget, "budget counts serialized escapes, fences and final newline");
  assert.ok(Buffer.byteLength(block) > block.length, "UTF-8 bytes differ from native UTF-16 units");
  assert.ok([...block].length < block.length, "astral characters count as two native units");
  return block;
};
const nativePreview = (output: string, mode: "artifact" | "saved" | "summary") => {
  const fullPath = join(fresh(), "output.md");
  writeFileSync(fullPath, output);
  const input = mode === "saved" ? `${output}\n\n${nativeOutput.formatSavedOutputReference(fullPath, output).message}` : output;
  const preview = mode === "summary"
    ? nativeOutput.capSummaryOutputs(`lane-worker:\n${input}`, [{ agent: "lane-worker", output: input, artifactPaths: { outputPath: fullPath } }])
    : nativeOutput.capInlineOutput(input, mode === "saved" ? { savedPath: fullPath } : { artifactPath: fullPath });
  assert.ok(preview.includes("…"), "exercise actual truncation, not a short-output bypass");
  assert.ok(preview.includes(fullPath), "native preview retains its full-output reference");
  assert.equal(readFileSync(fullPath, "utf8"), output, "full copy is unchanged");
  return preview;
};

test("pinned native preview exposes the old allowed 40-line v2 return cut mid-block", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../../node_modules/pi-subagents/package.json", import.meta.url), "utf8")).version, "0.77.0");
  const block = oldAllowedReturn("partial");
  assert.equal(JSON.parse(block.split("\n")[1]).tail.split("\n").length, 40);
  assert.equal(parseLaneReturn(block)!.status, "partial");
  assert.equal(parseDispatcherLaneReturn(block).parsed, true);
  const preview = nativePreview(block, "artifact");
  assert.ok(preview.startsWith("```lane-return\n"));
  assert.ok(!preview.includes("\n```"), "the native preview loses the closing fence");
  assert.equal(parseLaneReturn(preview), null);
  assert.equal(parseDispatcherLaneReturn(preview).parsed, false);
});

for (const status of ["failed", "partial"]) {
  test(`maximal producer-allowed ${status} return survives the pinned native preview for both consumers`, () => {
    const policy = readFileSync(new URL("worker.md", agentDir), "utf8");
    const budget = serializedBudget(policy);
    const block = maximalReturn(status, budget);
    for (const mode of ["artifact", "saved", "summary"] as const) {
      // No newline until well past the preview; also test frequent line ends after the fence.
      for (const prose of ["z".repeat(4_000), "report line\n".repeat(400)]) {
        const preview = nativePreview(block + prose, mode);
        assert.ok(preview.includes(block), "the entire serialized block, closing fence and newline must survive");
        assert.deepEqual(parseLaneReturn(preview), parseLaneReturn(block));
        assert.deepEqual(parseDispatcherLaneReturn(preview), parseDispatcherLaneReturn(block));
        assert.deepEqual(returnEvent("L-preview", "run-preview", parseLaneReturn(preview)), returnEvent("L-preview", "run-preview", parseLaneReturn(block)));
      }
    }
    assert.notEqual(budget, null, "the real producer policy must define the tested serialized budget");
  });
}

test("every pi producer shares the serialized preview budget; triage stays a distinct block", () => {
  const reference = serializedBudget(readFileSync(new URL("worker.md", agentDir), "utf8"));
  assert.notEqual(reference, null);
  for (const name of readdirSync(agentDir).filter((name) => name.endsWith(".md"))) {
    const policy = readFileSync(new URL(name, agentDir), "utf8");
    assert.equal(serializedBudget(policy), reference, name);
    assert.match(policy, /including fences,\s*newlines and JSON escapes/, name);
    if (name === "triager.md") {
      assert.match(policy, /```triage\n/);
      const data = { v: 1, lane: "L-preview", decision: "park", reason: 'é😀\\"', brief: null, needs: "defect", split: null };
      data.reason += "x".repeat(reference! - fenced(data, "triage").length);
      const block = fenced(data, "triage");
      assert.equal(block.length, reference);
      assert.ok(nativePreview(block + "z".repeat(4_000), "artifact").includes(block));
      assert.equal(parseLaneReturn(block), null, "triage must not become a lane-return");
    } else {
      assert.match(policy, /```lane-return\n/);
      assert.match(policy, /never abbreviate the exact check/);
    }
  }
});

for (const boundary of ["root", "lane"]) {
  test(`${boundary} cap preserves the dispatcher outcome when an annotated trailing fence is core-only`, () => {
    const block = (status: string, exit: number) => `\`\`\`lane-return\n${JSON.stringify({ v: 2, lane: "L1", status, exit, sha: null, landed: false })}\n\`\`\``;
    const annotated = '```lane-return note\n{"v":2,"lane":"L1","status":"unknown","exit":null,"landed":false}\n```';
    const text = `${block("complete", 0)}\n${"a".repeat(12_000)}\n${block("failed", 1)}\n${"a".repeat(12_000)}\n${annotated}\n${"a".repeat(10_000)}`;
    const dir = fresh();
    const before = parseDispatcherLaneReturn(text);
    assert.equal(before.status, "failed");
    assert.equal(before.exit, 1);
    const output = boundary === "root"
      ? capNotifyContent(text, dir)?.text ?? text
      : capLaneAssistantMessage({ role: "assistant", content: [{ type: "text", text }] }, dir, "L1")?.content[0].text ?? text;
    assert.deepEqual(parseLaneReturn(output), parseLaneReturn(text));
    assert.deepEqual(parseDispatcherLaneReturn(output), before, "a cap must not promote an older dispatcher success");
    const files = readdirSync(join(dir, "returns"));
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(dir, "returns", files[0]), "utf8"), text);
  });
}

test("a text within the cap is left alone", () => {
  assert.equal(capText("x".repeat(RETURN_CAP_BYTES), "/f"), null);
});

test("an oversized text keeps head, marker, tail without duplicating a block wholly in the head", () => {
  const text = `${BLOCK}\n${"a".repeat(50_000)}\nTAIL`;
  const capped = capText(text, "/runs/r/returns/x.md")!;
  const lines = capped.split("\n");
  const marker = lines.findIndex((l) => l.startsWith("[... "));
  assert.equal(lines[marker], `[... ${Buffer.byteLength(text) - HEAD_BYTES - TAIL_BYTES} bytes omitted; full return: /runs/r/returns/x.md ...]`);
  assert.ok(capped.startsWith(BLOCK));
  assert.equal(capped.split("```lane-return").length - 1, 1, "a block wholly in the head is not duplicated");
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

// Synthetic content, native 0.77.0 shape: notify.js sendCompletion emits
// details.runs via notifyRunDetails (which removes previews, not run identity).
test("native structured notify identity wins over missing or misleading directory text", () => {
  const runDir = fresh();
  const saved = join(fresh(), "output.md");
  writeFileSync(saved, "synthetic saved output");
  const info = { runId: "native-run", asyncDir: "/tmp/sub/native-run", savedOutputPath: saved };
  for (const suffix of ["", "\nRetention-managed async directory: /tmp/sub/other-run"]) {
    const message = {
      role: "custom", customType: "subagent-notify", display: false,
      content: `Background task completed: **lane-worker**\n\n${BLOCK}\n${"q".repeat(40_000)}${suffix}`,
      details: { runs: [{ runId: "native-run", status: "completed", source: "async", agent: "lane-worker" }] },
    };
    const queried: string[] = [];
    const capped = capNotifyMessage(message, runDir, (id) => (queried.push(id), info))!;
    assert.deepEqual(queried, ["native-run"]);
    assert.ok(capped.content.includes(`full return: ${saved}`));
    assert.ok(Buffer.byteLength(capped.content) <= RETURN_CAP_BYTES);
    assert.deepEqual(parseLaneReturn(capped.content), parseLaneReturn(message.content));
    assert.equal(capped.details, message.details);
  }
  const message = { role: "custom", customType: "subagent-notify", content: "z".repeat(40_000), details: { runs: [{ runId: "native-run" }] } };
  const capped = capNotifyMessage(message, runDir)!;
  assert.ok(capped.content.includes(join(runDir, "returns", "native-run.md")));
  assert.equal(readFileSync(join(runDir, "returns", "native-run.md"), "utf8"), message.content);
  const wrong = capNotifyMessage(message, runDir, () => ({ ...info, runId: "other-run" }))!;
  assert.ok(!wrong.content.includes(`full return: ${saved}`), "a mismatched completion is not this run");
});

test("structured batches and malformed identities retain the entire notify without guessing a run", () => {
  const content = `${BLOCK}\n${"z".repeat(40_000)}\nRetention-managed async directory: /tmp/sub/other-run`;
  for (const runs of [[], [{ runId: "one" }, { runId: "two" }], [{ runId: "one" }, { runId: "one" }], null, "bad", [null], [{}], [{ runId: 4 }], [{ runId: "../escape" }], [{ runId: "x".repeat(257) }]]) {
    const runDir = fresh();
    const capped = capNotifyMessage({ role: "custom", customType: "subagent-notify", content, details: { runs } }, runDir, () => { throw new Error("must not guess"); })!;
    const files = readdirSync(join(runDir, "returns"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^notify-[a-f0-9]{16}\.md$/);
    assert.equal(readFileSync(join(runDir, "returns", files[0]), "utf8"), content);
    assert.ok(Buffer.byteLength(capped.content) <= RETURN_CAP_BYTES);
  }
  for (const details of [undefined, {}, { runs: undefined }]) {
    const runDir = fresh();
    const capped = capNotifyMessage({ role: "custom", customType: "subagent-notify", content, details }, runDir)!;
    assert.ok(capped.content.includes(join(runDir, "returns", "other-run.md")), "absent structured runs keep the legacy fallback");
  }
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
  assert.ok(Buffer.byteLength(text) <= LANE_RETURN_CAP_BYTES, `${Buffer.byteLength(text)} bytes`);
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

test("a block that straddles the head cut is not split: the head stops before it and the block parses", () => {
  const block = `\`\`\`lane-return\n{"v":2,"lane":"L1","status":"complete","sha":null,"landed":false,"pad":"${"p".repeat(400)}"}\n\`\`\``;
  const text = `${"a".repeat(HEAD_BYTES - 100)}\n${block}\n${"log line\n".repeat(3_000)}END`;
  for (const capped of [capText(text, "/full.md"), capLaneAssistantMessage({ role: "assistant", content: [{ type: "text", text }] }, fresh(), "k")?.content]) {
    const out = typeof capped === "string" ? capped : (capped as { text: string }[])[0].text;
    assert.ok(out, "capped");
    assert.deepEqual(parseLaneReturn(out), parseLaneReturn(text));
    assert.equal(out.split("```lane-return").length - 1, 1, "exactly one opener");
  }
});

for (const [label, earlier] of [
  ["body", `\`\`\`lane-return\n${"p".repeat(800)}\n\`\`\``],
  ["header", `\`\`\`lane-return ${"h".repeat(800)}\n{}\n\`\`\``],
]) {
  test(`an earlier opener crossing the head cut in its ${label} is removed before the protected last block`, () => {
    const text = `${"a".repeat(HEAD_BYTES - 100)}${earlier}\n${"z".repeat(20_000)}\n${BLOCK}\n${"t".repeat(10_000)}`;
    const out = capText(text, "/full.md")!;
    assert.deepEqual(parseLaneReturn(out), parseLaneReturn(text));
    assert.equal(out.split("```lane-return").length - 1, 1);
  });
}

for (const bytes of [4_096, 12_288]) {
  test(`lane-sized caps budget a ${bytes}-byte multibyte protected block, marker and separators`, () => {
    const prefix = '```lane-return\n{"v":2,"lane":"L1","status":"complete","pad":"';
    const suffix = '"}\n```';
    const block = prefix + "é".repeat(Math.floor((bytes - Buffer.byteLength(prefix + suffix)) / 2)) + suffix;
    const text = `${"é".repeat(10_000)}\n${block}\n${"é".repeat(10_000)}`;
    const out = capLaneAssistantMessage({ role: "assistant", content: [{ type: "text", text }] }, fresh(), "budget")!.content[0].text;
    assert.ok(Buffer.byteLength(out) <= LANE_RETURN_CAP_BYTES, `${Buffer.byteLength(out)} bytes`);
    assert.ok(!out.includes("�"));
    assert.deepEqual(parseLaneReturn(out), parseLaneReturn(text));
    assert.equal(out.split("```lane-return").length - 1, 1);
  });
}

test("a protected block too large for the budget deterministically leaves text whole", () => {
  const block = `\`\`\`lane-return\n{"v":2,"lane":"L1","status":"complete","pad":"${"p".repeat(LANE_RETURN_CAP_BYTES)}"}\n\`\`\``;
  const text = `${"a".repeat(20_000)}\n${block}\n${"t".repeat(20_000)}`;
  assert.equal(capText(text, "/full.md", LANE_RETURN_CAP_BYTES), null);
  assert.equal(capLaneAssistantMessage({ role: "assistant", content: [{ type: "text", text }] }, fresh(), "oversize"), undefined);
});

test("a marker too large for the budget deterministically leaves text whole", () => {
  assert.equal(capText("x".repeat(20_000), "/" + "p".repeat(LANE_RETURN_CAP_BYTES), LANE_RETURN_CAP_BYTES), null);
});

test("a small custom budget without a block still accounts for a multibyte marker", () => {
  const out = capText("é".repeat(20_000), "/é", 128, { head: 100, tail: 100 })!;
  assert.ok(Buffer.byteLength(out) <= 128);
  assert.ok(!out.includes("�"));
  assert.ok(out.includes("full return: /é"));
});

// Exercise both public message boundaries, not a substitute parser. A trailing unusable fence
// must never turn the latest failed/exit 1 return into the old complete/exit 0 in the kept head.
for (const [label, trailing] of [
  ["malformed JSON", "```lane-return\n{broken\n```"],
  ["array", "```lane-return\n[]\n```"],
  ["null", "```lane-return\nnull\n```"],
  ["primitive", "```lane-return\n42\n```"],
  ["unsupported version", '```lane-return\n{"v":4,"status":"complete","exit":0}\n```'], // v3 (lane.md) is supported
  ["unclosed fence", "```lane-return\n{broken"],
]) {
  for (const boundary of ["root", "lane"]) {
    test(`${boundary} preserves the latest failed return before a trailing ${label} and keeps the full copy`, () => {
      const complete = '```lane-return\n{"v":2,"lane":"L1","status":"complete","exit":0,"landed":false}\n```';
      const failed = '```lane-return\n{"v":2,"lane":"L1","status":"failed","exit":1,"landed":false}\n```';
      const text = `${complete}\n${"a".repeat(12_000)}\n${failed}\n${"b".repeat(12_000)}\n${trailing}\n${"c".repeat(10_000)}`;
      const expected = parseLaneReturn(text);
      assert.equal(expected!.status, "failed");
      assert.equal(expected!.exit, 1);

      const dir = fresh();
      const message = { role: "assistant", content: [{ type: "text", text }] };
      const capped = boundary === "root" ? capNotifyContent(text, dir)?.text : capLaneAssistantMessage(message, dir, "L1")?.content[0].text;
      const out = capped ?? text;
      assert.deepEqual(parseLaneReturn(out), expected, `${boundary} must not promote stale success`);
      assert.deepEqual(returnEvent("L1", "r", parseLaneReturn(out)), returnEvent("L1", "r", expected));
      const files = readdirSync(join(dir, "returns"));
      assert.equal(files.length, 1);
      assert.equal(readFileSync(join(dir, "returns", files[0]), "utf8"), text);
      if (label === "unclosed fence") {
        assert.ok(capped, "a safe cut with an unclosed trailing fence still caps");
        assert.ok(Buffer.byteLength(out) <= (boundary === "root" ? RETURN_CAP_BYTES : LANE_RETURN_CAP_BYTES));
      } else {
        assert.equal(capped, undefined, "an unsafe cut deterministically leaves the original whole");
      }
    });
  }
}

test("malformed fences do not prevent a supported cut whose consumer outcome stays null", () => {
  const text = `${"a".repeat(20_000)}\n\`\`\`lane-return\n{broken\n\`\`\`\n${"b".repeat(20_000)}`;
  const out = capText(text, "/full.md")!;
  assert.ok(out);
  assert.equal(parseLaneReturn(text), null);
  assert.equal(parseLaneReturn(out), null);
  assert.ok(Buffer.byteLength(out) <= RETURN_CAP_BYTES);
});

test("a lane caps only the last non-empty text part, which is the output pi-subagents returns", () => {
  const runDir = fresh();
  const last = `${BLOCK}\n${"z".repeat(LANE_RETURN_CAP_BYTES)}`;
  const content = [{ type: "text", text: "early note" }, { type: "thinking", thinking: "t" }, { type: "text", text: last, textSignature: "sig" }, { type: "text", text: " " }];
  const capped = capLaneAssistantMessage({ role: "assistant", content }, runDir, "k")!.content as { type: string; text?: string; textSignature?: string }[];
  assert.deepEqual(capped.map((p) => p.type), ["text", "thinking", "text", "text"]);
  assert.equal(capped[0].text, "early note");
  assert.equal(capped[2].textSignature, undefined, "the signature of altered text is dropped");
  assert.ok(capped[2].text!.includes(BLOCK) && Buffer.byteLength(capped[2].text!) <= LANE_RETURN_CAP_BYTES);
  assert.equal(capLaneAssistantMessage({ role: "assistant", content: [{ type: "text", text: last }, { type: "text", text: "short final" }] }, runDir, "k"), undefined);
});
