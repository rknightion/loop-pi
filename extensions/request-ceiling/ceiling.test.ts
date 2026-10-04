// Request ceiling: pure helpers, then end-to-end proofs on the faux provider over RPC
// (SEAMS.md "Test harness"). A request that never finishes is aborted at the wall-clock ceiling and
// the root continues on the incident follow-up; an empty output-budget stop becomes an incident,
// not a silent stop or a nudge; the follow-up chain is bounded.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FauxRule,
  FAUX_EXTENSION,
  type RpcEvent,
  cleanupAll,
  freshDir,
  startPiRpc,
  writeFauxScript,
} from "../loop-guard/rpc-test-helpers.ts";
import { DEFAULT_WALL_CLOCK_MS, EMPTY_LENGTH_ERROR, ceilingConfig, isEmptyLengthStop } from "./core.ts";
import { cleanupFixtures, loopFixture } from "../loop-continuation/test-fixture.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CEILING_EXTENSION = join(HERE, "index.ts");
const CONTINUATION_EXTENSION = join(HERE, "..", "loop-continuation", "index.ts");

after(cleanupAll);
after(cleanupFixtures);

test("an empty length stop is recognised; a truncated answer or tool call is not", () => {
  const base = { role: "assistant", stopReason: "length" };
  assert.equal(isEmptyLengthStop({ ...base, content: [{ type: "thinking", thinking: "..." }] }), true);
  assert.equal(isEmptyLengthStop({ ...base, content: [{ type: "text", text: "partial answer" }] }), false);
  assert.equal(isEmptyLengthStop({ ...base, content: [{ type: "toolCall", name: "bash", arguments: {} }] }), false);
  assert.equal(isEmptyLengthStop({ ...base, stopReason: "stop", content: [] }), false);
});

test("an invalid ceiling setting falls back to the default instead of disabling or zeroing it", () => {
  assert.equal(ceilingConfig({ loopPi: { requestCeiling: { wallClockMs: 0 } } }).wallClockMs, DEFAULT_WALL_CLOCK_MS);
  assert.equal(ceilingConfig({ loopPi: { requestCeiling: { wallClockMs: "900000" } } }).wallClockMs, DEFAULT_WALL_CLOCK_MS);
  assert.equal(ceilingConfig({ loopPi: { requestCeiling: { wallClockMs: 3e9 } } }).wallClockMs, DEFAULT_WALL_CLOCK_MS);
  assert.ok(DEFAULT_WALL_CLOCK_MS < 15 * 60 * 1000);
});

interface Run {
  home: string;
  events: RpcEvent[];
  close(): Promise<void>;
}

async function runRoot(rules: FauxRule[], ceiling: Record<string, number>, settledCount: number): Promise<Run> {
  const home = freshDir("request-ceiling-home-");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ loopPi: { requestCeiling: ceiling } }));
  // A launch loop-continuation arms (S3): a git repository holding the goal, and a run dir.
  const loop = loopFixture({ agentDir: home });
  const previous = process.env.LOOP_PI_RUN_DIR;
  process.env.LOOP_PI_RUN_DIR = loop.runDir;
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, CEILING_EXTENSION, CONTINUATION_EXTENSION],
    fauxScriptPath: writeFauxScript(rules),
    agentDir: home,
    subagentTempRoot: freshDir("request-ceiling-tmp-"),
    cwd: loop.repo,
  });
  if (previous === undefined) delete process.env.LOOP_PI_RUN_DIR;
  else process.env.LOOP_PI_RUN_DIR = previous;
  session.send({ id: "launch", type: "prompt", message: loop.launch });
  let seen = 0;
  await session.waitFor((e) => e.type === "agent_settled" && ++seen >= settledCount, 30_000);
  return { home, events: session.events, close: session.close };
}

const assistantEnds = (events: RpcEvent[]) =>
  events
    .filter((e) => e.type === "message_end" && (e.message as { role?: string })?.role === "assistant")
    .map((e) => e.message as { stopReason: string; errorMessage?: string; content: { type: string; text?: string }[] });

const incidentMessages = (events: RpcEvent[]) =>
  events.filter(
    (e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "loop-request-incident",
  );

const nudges = (events: RpcEvent[]) =>
  events.filter((e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "loop-continuation");

function requestIncidents(home: string): { class: string; attempt: number; elapsed_ms: number }[] {
  const dir = join(home, "incidents", "request");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

const textOf = (message: { content: { type: string; text?: string }[] }) =>
  message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

test("a request that never finishes is aborted at the ceiling and the root continues", async () => {
  const started = Date.now();
  const run = await runRoot(
    [
      { match: "You are the root", once: true, thinking: "deliberating", hang: true },
      { match: "wall-clock ceiling", text: "Recovered with a smaller step.\nPAUSED: test complete" },
    ],
    { wallClockMs: 1500, maxFollowUps: 2 },
    2,
  );
  try {
    const ends = assistantEnds(run.events);
    assert.equal(ends[0].stopReason, "aborted");
    assert.equal(incidentMessages(run.events).length, 1);
    assert.match(textOf(ends.at(-1)!), /Recovered with a smaller step/);
    assert.equal(nudges(run.events).length, 0, "an aborted request must not be answered with a TURN ENDINGS nudge");
    const incidents = requestIncidents(run.home);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].class, "loop-request-wall-clock-ceiling");
    // Node may fire a timer a millisecond before Date.now() says it is due.
    assert.ok(incidents[0].elapsed_ms >= 1450 && incidents[0].elapsed_ms < 10_000, `elapsed ${incidents[0].elapsed_ms}`);
    assert.ok(!existsSync(join(run.home, "incidents")) || readdirSync(join(run.home, "incidents")).every((n) => !n.endsWith(".json")),
      "request incidents stay out of the continuation-incident folder the watchdog validates");
    assert.ok(Date.now() - started < 30_000);
  } finally {
    await run.close();
  }
});

test("an empty output-budget stop becomes an incident follow-up, not a retry or a nudge", async () => {
  const run = await runRoot(
    [
      { match: "You are the root", once: true, thinking: "deliberating at length", stopReason: "length" },
      { match: "output budget", text: "Recovered.\nPAUSED: test complete" },
    ],
    { wallClockMs: 60_000, maxFollowUps: 2 },
    2,
  );
  try {
    const ends = assistantEnds(run.events);
    assert.equal(ends[0].stopReason, "error");
    assert.equal(ends[0].errorMessage, EMPTY_LENGTH_ERROR);
    assert.equal(run.events.filter((e) => e.type === "auto_retry_start").length, 0);
    assert.equal(nudges(run.events).length, 0);
    assert.equal(incidentMessages(run.events).length, 1);
    assert.match(textOf(ends.at(-1)!), /Recovered/);
    assert.deepEqual(requestIncidents(run.home).map((i) => i.class), ["loop-request-empty-length-stop"]);
  } finally {
    await run.close();
  }
});

test("follow-ups stop after maxFollowUps in a row and the exhaustion is recorded", async () => {
  const run = await runRoot([{ match: ".", hang: true }], { wallClockMs: 800, maxFollowUps: 1 }, 2);
  try {
    // Give a wrongly triggered third turn time to start before counting.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(assistantEnds(run.events).filter((m) => m.stopReason === "aborted").length, 2);
    assert.equal(incidentMessages(run.events).length, 2);
    assert.deepEqual(
      requestIncidents(run.home).map((i) => i.class),
      ["loop-request-wall-clock-ceiling", "loop-request-wall-clock-ceiling-exhausted"],
    );
  } finally {
    await run.close();
  }
});
