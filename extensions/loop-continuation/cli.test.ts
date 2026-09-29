// End-to-end proof on the faux provider (pi/extensions/SEAMS.md "Test harness"): a root that
// stops with plain text after an armed launch gets exactly one nudge turn, then releases on a
// current PAUSED: line. No live model, no network; every temp dir is under os.tmpdir() and
// cleaned up; the spawned pi process's stdin is closed so it never waits on a TTY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = join(HERE, "..", "..");
const CLI = join(PI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const FAUX_EXTENSION = join(PI_ROOT, "extensions", "test-support", "faux-extension.ts");
const LOOP_CONTINUATION_EXTENSION = HERE;

interface Rpc {
  proc: ReturnType<typeof spawn>;
  events: unknown[];
  waitFor(predicate: (event: any) => boolean, timeoutMs?: number): Promise<any>;
  send(command: Record<string, unknown>): void;
  close(): Promise<number | null>;
}

function startRpc(cwd: string, faux_script: string, home: string): Rpc {
  const proc = spawn(
    process.execPath,
    [
      CLI,
      "--mode",
      "rpc",
      "--no-session",
      "--extension",
      FAUX_EXTENSION,
      "--extension",
      LOOP_CONTINUATION_EXTENSION,
      "--provider",
      "faux",
      "--model",
      "faux-1",
    ],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: home,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        LOOP_PI_FAUX_SCRIPT: faux_script,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const events: unknown[] = [];
  const waiters: { predicate: (event: any) => boolean; resolve: (event: any) => void }[] = [];
  let buffer = "";
  let stderr = "";
  proc.stderr!.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  proc.stdout!.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(record);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(record)) {
          const [w] = waiters.splice(i, 1);
          w.resolve(record);
        }
      }
    }
  });

  function waitFor(predicate: (event: any) => boolean, timeoutMs = 20000): Promise<any> {
    const already = events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timed out waiting for event; stderr so far:\n${stderr}`));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  function send(command: Record<string, unknown>) {
    proc.stdin!.write(JSON.stringify(command) + "\n");
  }

  function close(): Promise<number | null> {
    return new Promise((resolve) => {
      proc.once("exit", (code) => resolve(code));
      try {
        proc.stdin!.end();
      } catch {
        // already closed
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 5000).unref();
    });
  }

  return { proc, events, waitFor, send, close };
}

test("an armed root that stops with plain text gets exactly one nudge, then releases on PAUSED:", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "loop-continuation-cli-"));
  const cwd = join(tmp, "cwd");
  const home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  const fauxScript = join(tmp, "faux-script.json");
  writeFileSync(
    fauxScript,
    JSON.stringify({
      rules: [
        {
          match: "You are the root",
          once: true,
          text: "Looked around, nothing left to say right now.",
          stopReason: "stop",
        },
        {
          match: "TURN ENDINGS",
          text: "Nothing more to do here.\nPAUSED: waiting on the owner",
          stopReason: "stop",
        },
      ],
    }),
  );

  const rpc = startRpc(cwd, fauxScript, home);
  try {
    rpc.send({
      id: "launch",
      type: "prompt",
      message: "You are the root. Report at codex/report-x-loop1.md when finished.",
    });

    const promptResponse = await rpc.waitFor((e) => e.type === "response" && e.command === "prompt");
    assert.equal(promptResponse.success, true);

    await rpc.waitFor((e) => e.type === "agent_settled");

    // The nudge is committed as a boundary draft (agent_before_settle's returned `entries`), which
    // surfaces as `entry_appended` with the custom_message's own shape, not a `message_start`
    // (that event is only emitted for a custom message delivered live via pi.sendMessage while
    // idle, e.g. a real subagent-notify/loop-watch/loop-wake push).
    const nudgeEntries = rpc.events.filter(
      (e: any) => e.type === "entry_appended" && e.entry?.type === "custom_message" && e.entry?.customType === "loop-continuation",
    );
    assert.equal(nudgeEntries.length, 1, "expected exactly one loop-continuation nudge turn");

    const agentSettledCount = rpc.events.filter((e: any) => e.type === "agent_settled").length;
    assert.equal(agentSettledCount, 1, "expected the session to settle exactly once (no third turn)");

    const assistantTexts = rpc.events
      .filter((e: any) => e.type === "message_end" && e.message?.role === "assistant")
      .map((e: any) => {
        const content = e.message.content;
        if (typeof content === "string") return content;
        return (content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      });
    assert.equal(assistantTexts.length, 2, "expected two assistant turns: the stall, then the paused reply");
    assert.match(assistantTexts[1], /PAUSED: waiting on the owner/);
  } finally {
    await rpc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
