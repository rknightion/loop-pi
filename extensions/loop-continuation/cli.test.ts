// End-to-end proof on the faux provider (pi/extensions/SEAMS.md "Test harness"): a root that
// stops with plain text after an armed launch gets exactly one nudge turn, then releases on a
// current PAUSED: line. No live model, no network; every temp dir is under os.tmpdir() and
// cleaned up; the spawned pi process's stdin is closed so it never waits on a TTY.

import { after, test } from "node:test";
import { cleanupFixtures, loopFixture } from "./test-fixture.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = join(HERE, "..", "..");
const CLI = join(PI_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const FAUX_EXTENSION = join(PI_ROOT, "extensions", "test-support", "faux-extension.ts");
const LOOP_CONTINUATION_EXTENSION = HERE;

after(cleanupFixtures);

test("three ignored nudges release the root and write a home/cwd-attributed incident", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "loop-continuation-incident-cli-"));
  const f = loopFixture();
  const cwd = f.repo;
  const home = f.agentDir;
  const script = join(tmp, "faux-script.json");
  writeFileSync(script, JSON.stringify({ rules: [
    { match: "You are the root", once: true, text: "Still working.", stopReason: "stop" },
    { match: "TURN ENDINGS", text: "Still working.", stopReason: "stop" },
  ] }));
  const rpc = startRpc(cwd, script, home, f.runDir);
  try {
    rpc.send({ id: "launch", type: "prompt", message: f.launch });
    await rpc.waitFor((e) => e.type === "agent_settled");
    const nudges = rpc.events.filter((e: any) => e.type === "entry_appended" && e.entry?.customType === "loop-continuation");
    assert.equal(nudges.length, 3);
    const files = readdirSync(join(home, "incidents"));
    assert.equal(files.length, 1);
    const payload = JSON.parse(readFileSync(join(home, "incidents", files[0]), "utf8"));
    assert.equal(payload.class, "loop-continuation-chain-exhausted");
    assert.equal(payload.home, home);
    assert.equal(payload.cwd, realpathSync(cwd));
    assert.ok(payload.session && payload.session !== "unknown");
    assert.equal(payload.v, 1);
    assert.ok(Number.isFinite(Date.parse(payload.at)));
  } finally {
    await rpc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

interface Rpc {
  proc: ReturnType<typeof spawn>;
  events: unknown[];
  waitFor(predicate: (event: any) => boolean, timeoutMs?: number): Promise<any>;
  send(command: Record<string, unknown>): void;
  close(): Promise<number | null>;
}

function startRpc(cwd: string, faux_script: string, home: string, runDir: string): Rpc {
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
        LOOP_PI_RUN_DIR: runDir,
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
  const f = loopFixture();

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

  const rpc = startRpc(f.repo, fauxScript, f.agentDir, f.runDir);
  try {
    rpc.send({
      id: "launch",
      type: "prompt",
      message: f.launch,
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

test("S3: a refused arm returns handled from input, so no model turn runs, and the reason reaches the user", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "loop-continuation-refused-cli-"));
  const f = loopFixture();
  const script = join(tmp, "faux-script.json");
  writeFileSync(script, JSON.stringify({ rules: [{ match: ".*", text: "A MODEL TURN RAN", stopReason: "stop" }] }));
  // A run dir that does not exist: the launcher never made one.
  const rpc = startRpc(f.repo, script, f.agentDir, join(tmp, "no-run-dir"));
  try {
    rpc.send({ id: "launch", type: "prompt", message: f.launch });
    const response = await rpc.waitFor((e) => e.type === "response" && e.id === "launch");
    assert.equal(response.success, true);
    const notice = await rpc.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /did not arm this root/.test(String(e.message)));
    assert.equal(notice.notifyType, "error");
    assert.match(String(notice.message), /does not exist/);
    // Give a turn every chance to start before asserting none did.
    rpc.send({ id: "state", type: "get_state" });
    await rpc.waitFor((e) => e.type === "response" && e.id === "state");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(rpc.events.filter((e: any) => e.type === "message_end" && e.message?.role === "assistant").length, 0, "no model turn ran");
    assert.equal(rpc.events.filter((e: any) => e.type === "agent_start").length, 0);
    const incidents = readdirSync(join(f.agentDir, "incidents", "root"));
    assert.equal(incidents.length, 1);
    assert.match(incidents[0], /-arm-refused\.json$/);
  } finally {
    await rpc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
