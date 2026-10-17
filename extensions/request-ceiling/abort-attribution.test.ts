// The ceiling must not announce a harness abort when the owner already aborted the run
// (SEAMS.md "Run-dir files and return caps", pi-subagents hold). Unit-level: a fake pi, no process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installRequestCeiling } from "./index.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  const sequence: string[] = [];
  const ctx: { model: unknown; signal?: AbortSignal; abort(): void } = {
    model: { id: "fixture", provider: "fixture", api: "openai-responses" },
    abort() { sequence.push("abort"); },
  };
  const pi = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: { on() {}, emit(name: string) { sequence.push(name); } },
    sendMessage() {},
  };
  installRequestCeiling(pi as never, { inactivityMs: 50, absoluteMs: 1000, maxFollowUps: 1 } as never);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.map((fn) => fn(event, ctx)).at(-1);
  return { ctx, fire, sequence };
}

test("the ceiling timer announces its abort when the run is live", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness();
  h.fire("turn_start");
  t.mock.timers.tick(50);
  assert.deepEqual(h.sequence, ["loop-recovery:request-timeout", "abort"]);
  h.fire("session_shutdown");
});

test("the ceiling timer announces no harness abort when the owner already aborted the run", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = harness();
  h.fire("turn_start");
  h.ctx.signal = AbortSignal.abort();
  t.mock.timers.tick(50);
  assert.deepEqual(h.sequence, ["abort"], "no loop-recovery:request-timeout; the idempotent abort still runs");
  h.fire("session_shutdown");
});
