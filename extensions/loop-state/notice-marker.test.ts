import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LOOP_PI_NOTICE_TYPES, markNotice, markNotices } from "./notice-marker.ts";

const EXTENSIONS = fileURLToPath(new URL("..", import.meta.url));
const MARK = '<loop_pi_notice type="loop-wake" origin="automated message from the loop-pi harness, not typed by the user">';

test("a loop-pi notice is wrapped in the request, string or parts, and nothing else is", () => {
  assert.equal(markNotice({ role: "custom", customType: "loop-wake", content: "timer fired" }).content, `${MARK}\ntimer fired\n</loop_pi_notice>`);
  const parts = markNotice({ role: "custom", customType: "loop-wake", content: [{ type: "text", text: "x" }] }).content as { text: string }[];
  assert.deepEqual(parts.map((p) => p.text), [`${MARK}\n`, "x", "\n</loop_pi_notice>"]);
  for (const other of [
    { role: "custom", customType: "subagent-notify", content: "lane done" },
    { role: "user", content: "owner text" },
    { role: "custom", customType: "loop-pi-runtime", content: "state" },
  ]) assert.equal(markNotice(other), other);
  assert.equal(markNotices([{ role: "user", content: "x" }]), undefined);
  const message = { role: "custom", customType: "loop-continuation", content: "nudge" };
  assert.deepEqual(markNotices([message]), [markNotice(message)]);
  assert.equal(message.content, "nudge", "the stored message is not changed");
});

test("every custom message type loop-pi sends to the model is marked", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "test-support" && name !== "fixtures") walk(path); }
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(EXTENSIONS);
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const constants = new Map([...source.matchAll(/\bconst\s+([\w$]+)\s*=\s*["'](loop-[a-z-]+)["']/g)].map((m) => [m[1], m[2]]));
  const sent = new Set<string>();
  // Messages: sendMessage calls, nudge drafts (custom_message entries) and before_agent_start messages.
  for (const m of source.matchAll(/customType:\s*(?:["']([a-z-]+)["']|([\w$]+))/g)) {
    const type = m[1] ?? constants.get(m[2]);
    if (type?.startsWith("loop-")) sent.add(type);
  }
  // Session entries are state, never sent to the model.
  for (const m of source.matchAll(/appendEntry\(\s*(?:"([a-z-]+)"|([A-Z_]+))/g)) sent.delete(m[1] ?? constants.get(m[2]) ?? "");
  for (const type of ["loop-continuation-state", "loop-pi-runtime", "loop-state-return-recovery"]) sent.delete(type);
  assert.deepEqual([...sent].sort(), [...LOOP_PI_NOTICE_TYPES].sort());
});

test("the loop-state context hook marks loop-pi notices after its own rewrites", async () => {
  const { default: loopState } = await import("./index.ts");
  const handlers = new Map<string, (e: any, c: any) => any>();
  loopState({ on: (n: string, h: any) => handlers.set(n, h), events: { on: () => () => undefined, emit: () => undefined } } as any);
  const owner = { role: "user", content: "owner text" };
  const wake = { role: "custom", customType: "loop-wake", content: "timer fired" };
  const result = handlers.get("context_with_system")!({ type: "context_with_system", messages: [owner, wake] }, {});
  assert.deepEqual(result?.messages, [owner, { ...wake, content: `${MARK}\ntimer fired\n</loop_pi_notice>` }]);
});
