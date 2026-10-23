// The loop-status extension loaded against a fake ExtensionAPI: the root model-time segment on the
// status line and the one-line notice added to a wake. Entries are the session's persisted
// assistant messages as call-timing leaves them (`loopPiProgress`); a "reload" is a fresh
// extension instance over the same entries.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PARENT_WAKE_TEXT } from "../loop-continuation/state.ts";
import loopStatus from "./index.ts";
import { MODEL_TIME_NOTICE_TYPE } from "./modeltime.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => NOW - minutesAgo * MIN;

const request = (startAgo: number, endAgo: number) => ({
  type: "message",
  message: { role: "assistant", loopPiProgress: { state: "ended", startedAt: at(startAgo), endedAt: at(endAgo) } },
});

interface Options {
  entries?: unknown[] | (() => never);
  /** Minutes before NOW the session header was written. */
  sessionAgo?: number;
  /** Minutes before NOW the launch prompt was seen; absent: no launch is armed. */
  launchAgo?: number;
}

async function load(opts: Options) {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const listeners = new Map<string, ((data: any) => void)[]>();
  const statuses: (string | undefined)[] = [];
  const realNow = Date.now;
  Date.now = () => NOW;
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on: (name: string, handler: (data: any) => void) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
      emit: (name: string, data: any) => {
        if (name === "loop-continuation:query-launch") {
          data.reply(opts.launchAgo === undefined
            ? { reportPath: null }
            : { reportPath: "/nonexistent/codex/closeout-demo-loop1.md", launchedAt: new Date(at(opts.launchAgo)).toISOString() });
        }
      },
    },
    registerCommand: () => {},
    sendMessage: () => {},
  };
  const ctx = {
    hasUI: true,
    cwd: "/nonexistent",
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
    sessionManager: {
      getSessionFile: () => "/nonexistent/session.jsonl",
      getSessionId: () => "session",
      getHeader: () => ({ timestamp: new Date(at(opts.sessionAgo ?? 0)).toISOString() }),
      getEntries: () => {
        if (typeof opts.entries === "function") return opts.entries();
        return opts.entries ?? [];
      },
    },
  };
  loopStatus(pi as never);
  const fire = (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = handler(event, ctx) ?? result;
    return result;
  };
  fire("session_start", { type: "session_start" });
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  return { fire, statuses, restore: () => { Date.now = realNow; } };
}

const customWake = (customType: string) => ({ type: "before_agent_start", messageType: "custom", message: { customType, content: "x" } });
const userWake = { type: "before_agent_start", messageType: "user", prompt: PARENT_WAKE_TEXT };

/** Over 60% of the 190 minutes since launch: 120 minutes in the model. */
const BUSY = [request(190, 130), request(100, 40)];

test("the status line shows the share of wall time since the launch, and a reload shows the same", async () => {
  const entries = BUSY;
  const first = await load({ entries, launchAgo: 190, sessionAgo: 300 });
  const reloaded = await load({ entries: JSON.parse(JSON.stringify(entries)), launchAgo: 190, sessionAgo: 300 });
  try {
    for (const run of [first, reloaded]) assert.match(run.statuses.at(-1) ?? "", /· root model time 63% of 3h10m · nudge 0\/3 ·/);
  } finally {
    first.restore();
    reloaded.restore();
  }
});

test("with no launch the wall time runs from the session start", async () => {
  const run = await load({ entries: [request(60, 30)], sessionAgo: 120 });
  try {
    assert.match(run.statuses.at(-1) ?? "", /· root model time 25% of 2h00m · /);
  } finally {
    run.restore();
  }
});

test("unreadable session state shows an unknown share and adds no notice", async () => {
  const run = await load({ entries: () => { throw new Error("stale session"); }, launchAgo: 190 });
  try {
    assert.match(run.statuses.at(-1) ?? "", /· root model time \? · /);
    assert.equal(run.fire("before_agent_start", customWake("loop-wake")), undefined);
  } finally {
    run.restore();
  }
});

test("a timer, watch or lane-return wake over the threshold gets exactly one notice line", async () => {
  for (const wake of [customWake("loop-wake"), customWake("loop-watch"), customWake("subagent-notify"), customWake("subagent_control_notice"), userWake]) {
    const run = await load({ entries: BUSY, launchAgo: 190 });
    try {
      if (wake === userWake) run.fire("input", { type: "input", source: "extension", text: PARENT_WAKE_TEXT });
      const result = run.fire("before_agent_start", wake);
      assert.equal(result?.message?.customType, MODEL_TIME_NOTICE_TYPE, JSON.stringify(wake));
      assert.match(result.message.content, /^Root model time is above 60% of wall time \(63% of 3h10m\): combine reviews and keep ledgers to one-line appends\.$/);
      assert.equal(Object.keys(result).length, 1, "one message and nothing else");
    } finally {
      run.restore();
    }
  }
});

test("the notice repeats only on a higher band or ten wakes later, and never before a launch is armed", async () => {
  const run = await load({ entries: BUSY, launchAgo: 190 });
  const unarmed = await load({ entries: BUSY, sessionAgo: 190 });
  try {
    const sent = Array.from({ length: 11 }, () => run.fire("before_agent_start", customWake("loop-wake")) !== undefined);
    assert.deepEqual(sent, [true, false, false, false, false, false, false, false, false, false, true]);
    assert.equal(unarmed.fire("before_agent_start", customWake("loop-wake")), undefined);
  } finally {
    run.restore();
    unarmed.restore();
  }
});

test("no notice at or below the threshold, under thirty minutes of wall time, or when the share is unknown", async () => {
  const below = await load({ entries: [request(190, 130)], launchAgo: 190 });
  const young = await load({ entries: [request(25, 5)], launchAgo: 25 });
  const none = await load({ entries: [], launchAgo: 190 });
  const untimed = await load({ entries: [{ type: "message", message: { role: "assistant" } }], launchAgo: 190 });
  try {
    for (const run of [below, young, none, untimed]) assert.equal(run.fire("before_agent_start", customWake("loop-wake")), undefined);
  } finally {
    for (const run of [below, young, none, untimed]) run.restore();
  }
});

test("only a wake gets a notice: not an operator prompt, not a typed copy of the wake text, not another custom message", async () => {
  const run = await load({ entries: BUSY, launchAgo: 190 });
  try {
    assert.equal(run.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "carry on" }), undefined);
    // Same text, but it arrived from the operator, not as an extension-sourced wake.
    run.fire("input", { type: "input", source: "interactive", text: PARENT_WAKE_TEXT });
    assert.equal(run.fire("before_agent_start", userWake), undefined);
    assert.equal(run.fire("before_agent_start", customWake("loop-continuation")), undefined);
    assert.equal(run.fire("before_agent_start", customWake("loop-closeout-audit")), undefined);
  } finally {
    run.restore();
  }
});

test("a wake input that never started a run does not leak into the next prompt", async () => {
  const run = await load({ entries: BUSY, launchAgo: 190 });
  try {
    run.fire("input", { type: "input", source: "extension", text: PARENT_WAKE_TEXT });
    run.fire("agent_settled", { type: "agent_settled" });
    assert.equal(run.fire("before_agent_start", userWake), undefined);
  } finally {
    run.restore();
  }
});
