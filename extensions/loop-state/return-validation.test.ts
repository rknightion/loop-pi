// Exercise the live completion listener and real state CLI, not just the pure parser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { laneReturnError } from "./return-validation.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import loopState from "./index.ts";
import { parseLaneReturn } from "./core.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("live v3 returns validate patch evidence and complete exit without restricting honest return forms", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "return-validation-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const bin = fileURLToPath(new URL("../../bin/loop-state", import.meta.url));
  const log = join(dir, "state-fixture.jsonl");
  const patch = join(dir, "candidate.patch");
  writeFileSync(patch, "fixture patch\n");
  mkdirSync(join(dir, "bin"));
  symlinkSync(bin, join(dir, "bin", "loop-state"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, any>();
  const bus = new Map<string, any[]>();
  const notes: string[] = [];
  const entries: any[] = [];
  const ctx = { cwd: dir, ui: { notify: (s: string) => notes.push(s) }, sessionManager: {
    getBranch: () => entries, getSessionId: () => "fixture-session", getSessionFile: () => "/fixture/session.jsonl",
  } };
  loopState({
    on: (name: string, fn: any) => handlers.set(name, fn),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: () => undefined,
    events: {
      on: (name: string, fn: any) => { bus.set(name, [...(bus.get(name) ?? []), fn]); return () => undefined; },
      emit: (name: string, data: unknown) => { for (const fn of bus.get(name) ?? []) fn(data); },
    },
  } as any);
  bus.set("loop-continuation:query-launch", [(d: any) => d.reply({ reportPath: join(dir, "closeout-fixture.md") })]);
  const rows = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  try {
    handlers.get("session_start")({}, ctx);
    const cases = [
      { name: "missing", extra: { patch: join(dir, "missing.patch") }, status: "failed", diagnostic: /patch.*(read|ENOENT)/i },
      { name: "directory", extra: { patch: dir }, status: "failed", diagnostic: /patch.*regular/i },
      { name: "hash", extra: { patch_sha256: "b".repeat(64) }, status: "failed", diagnostic: /patch_sha256.*mismatch/i },
      { name: "missing-hash", extra: { patch_sha256: null }, status: "failed", diagnostic: /patch_sha256/i },
      { name: "exit", extra: { exit: 7, landed: true, sha: "c".repeat(40) }, status: "failed", diagnostic: /exit.*7/i },
      ...["7", "0", true, false, { code: 7 }, [7], 1.5].map(exit => ({
        name: `malformed-exit-${JSON.stringify(exit)}`, extra: { exit, landed: true, sha: "d".repeat(40) }, status: "failed", diagnostic: /exit.*integer/i,
      })),
      { name: "valid", extra: {}, status: "complete" },
      { name: "omitted-exit", extra: { exit: undefined }, status: "complete" },
      { name: "legacy", extra: { v: undefined, exit: "7", patch: "/missing/legacy.patch" }, status: "complete" },
      { name: "v2", extra: { v: 2, exit: "7", patch: "/missing/v2.patch" }, status: "complete" },
      { name: "partial", extra: { status: "partial", exit: 1 }, status: "partial" },
      { name: "blocked", extra: { status: "blocked", patch: null, patch_sha256: null, exit: null }, status: "blocked" },
      { name: "reviewer", extra: { patch: null, patch_sha256: null, exit: null }, status: "complete" },
      { name: "scout", extra: { patch: null, patch_sha256: null, exit: 0 }, status: "complete" },
      { name: "senior", extra: { patch: undefined, patch_sha256: undefined, sha: "a".repeat(40) }, status: "complete" },
    ];
    for (const [i, c] of cases.entries()) {
      await t.test(c.name, async () => {
      const run = `fixture-${i}`;
      handlers.get("tool_call")({ toolCallId: run, toolName: "subagent", input: { agent: "worker", task: "Lane: L1 · Task: T1 · Tier: routine" } }, ctx);
      handlers.get("tool_result")({ toolCallId: run, toolName: "subagent", input: {}, content: [{ type: "text", text: `Async: worker [${run}]` }], details: { mode: "single", runId: run } }, ctx);
      const block = { v: 3, lane: "L1", status: "complete", check: "fixture", exit: 0,
        patch, patch_sha256: digest("fixture patch\n"), ...c.extra };
      const text = "```lane-return\n" + JSON.stringify(block) + "\n```";
      assert.deepEqual(parseLaneReturn(text), JSON.parse(JSON.stringify(block)), "parser stays pure and compatible");
      const before = notes.length;
      for (const fn of bus.get("subagent:async-complete") ?? []) fn({ runId: run, sessionId: "/fixture/session.jsonl", success: true, results: [{ summary: text }] });
      const deadline = Date.now() + 5000;
      while (!rows().some(r => r.ev === "return" && r.run === run)) {
        assert.ok(Date.now() < deadline, `return recorded: ${c.name}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const row = rows().find(r => r.ev === "return" && r.run === run);
      assert.equal(row.status, c.status, c.name);
      if (c.diagnostic) assert.match(notes.slice(before).join("\n"), c.diagnostic, c.name);
      if (c.name === "senior") assert.equal(row.sha, "a".repeat(40));
      if ("landed" in c.extra && c.extra.landed) {
        assert.equal(row.landed, true, "rejected evidence must not re-admit potentially landed work");
        assert.equal(row.sha, c.extra.sha);
      }
      });
    }
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v3 scalar preflight rejects nonfinite exits before artifact I/O", () => {
  for (const exit of [NaN, Infinity, -Infinity]) {
    assert.match(laneReturnError({ v: 3, status: "partial", exit, patch: "/missing/fixture.patch" }, "/") ?? "", /exit.*finite integer/i);
  }
});

test("patch close failure becomes a rejection diagnostic, not an escaping exception", () => {
  const dir = mkdtempSync(join(tmpdir(), "return-close-"));
  const patch = join(dir, "candidate.patch");
  writeFileSync(patch, "fixture patch\n");
  const originalClose = fs.closeSync;
  let closed = 0;
  try {
    // Fault at the filesystem boundary, after releasing the real descriptor. No production seam
    // is added for this rare cleanup failure; restore builtin bindings before other tests run.
    fs.closeSync = (fd) => { originalClose(fd); closed++; throw new Error("injected close EIO"); };
    syncBuiltinESMExports();
    assert.match(laneReturnError({ v: 3, status: "complete", exit: 0, patch,
      patch_sha256: digest("fixture patch\n") }, dir) ?? "", /patch.*close.*injected close EIO/i);
    assert.equal(closed, 1);
  } finally {
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
