import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ROOT_MODEL_TIME_NOTICE_MIN_WALL_MS, ROOT_MODEL_TIME_NOTICE_SHARE, formatModelTime, rootModelTime, wakeNotice, type ModelTime,
} from "./modeltime.ts";

const T0 = Date.parse("2026-10-08T09:00:00Z");
const MIN = 60_000;

/** An assistant message entry as call-timing persists it, spanning [start, end] minutes after T0. */
const request = (startMin: number, endMin: number, extra: object = {}) => ({
  type: "message",
  message: { role: "assistant", loopPiProgress: { state: "ended", startedAt: T0 + startMin * MIN, endedAt: T0 + endMin * MIN, ...extra } },
});
const known = (t: ModelTime) => {
  assert.equal(t.state, "known");
  return t as Extract<ModelTime, { state: "known" }>;
};

test("the share is the sum of the root's own request durations over wall time since the launch", () => {
  const entries = [request(0, 60), { type: "message", message: { role: "user" } }, request(100, 130), { type: "custom", customType: "x" }];
  const t = known(rootModelTime(entries, T0, T0 + 190 * MIN));
  assert.equal(t.modelMs, 90 * MIN);
  assert.equal(t.wallMs, 190 * MIN);
  assert.equal(t.requests, 2);
  assert.ok(Math.abs(t.share - 90 / 190) < 1e-9);
  assert.equal(formatModelTime(t), "root model time 47% of 3h10m");
});

test("a request that began before the launch counts only from the launch, and none counts past now", () => {
  const entries = [request(-30, 10), request(50, 80)];
  const t = known(rootModelTime(entries, T0, T0 + 60 * MIN));
  assert.equal(t.modelMs, 10 * MIN + 10 * MIN);
  assert.equal(t.requests, 2);
});

test("the share is never above one, even for overlapping records", () => {
  const t = known(rootModelTime([request(0, 50), request(0, 50)], T0, T0 + 60 * MIN));
  assert.equal(t.share, 1);
});

test("a session with no assistant message has nothing to show; one with only untimed messages is unknown", () => {
  assert.deepEqual(rootModelTime([], T0, T0 + MIN), { state: "none" });
  assert.equal(formatModelTime({ state: "none" }), null);
  const untimed = [{ type: "message", message: { role: "assistant" } }];
  assert.deepEqual(rootModelTime(untimed, T0, T0 + MIN), { state: "unknown" });
  assert.equal(formatModelTime({ state: "unknown" }), "root model time ?");
});

test("unreadable or malformed state is unknown, never a number", () => {
  assert.deepEqual(rootModelTime(undefined, T0, T0 + MIN), { state: "unknown" });
  assert.deepEqual(rootModelTime("garbage", T0, T0 + MIN), { state: "unknown" });
  assert.deepEqual(rootModelTime([request(0, 1)], null, T0 + MIN), { state: "unknown" });
  assert.deepEqual(rootModelTime([request(0, 1)], T0, T0), { state: "unknown" });
  assert.deepEqual(rootModelTime([request(0, 1)], T0, Number.NaN), { state: "unknown" });
  for (const bad of [{ state: "abandoned" }, { startedAt: "x" }, { endedAt: null }, { startedAt: T0 + 5 * MIN, endedAt: T0 }]) {
    assert.deepEqual(rootModelTime([request(0, 1, bad)], T0, T0 + MIN), { state: "unknown" }, JSON.stringify(bad));
  }
  const withNulls = [null, 7, { type: "message" }, { type: "message", message: null }, request(0, 30)];
  assert.equal(known(rootModelTime(withNulls, T0, T0 + 60 * MIN)).modelMs, 30 * MIN);
});

test("the figure is a pure function of the persisted entries, so a reload gives the same answer", () => {
  const persisted = JSON.parse(JSON.stringify([request(0, 20), request(40, 70)]));
  const before = known(rootModelTime([request(0, 20), request(40, 70)], T0, T0 + 100 * MIN));
  const after = known(rootModelTime(persisted, T0, T0 + 100 * MIN));
  assert.deepEqual(after, before);
});

test("the wake notice needs a share strictly above the threshold and enough wall time", () => {
  assert.equal(ROOT_MODEL_TIME_NOTICE_SHARE, 0.6);
  assert.equal(ROOT_MODEL_TIME_NOTICE_MIN_WALL_MS, 30 * MIN);
  const at = (modelMin: number, wallMin: number) => wakeNotice(known(rootModelTime([request(0, modelMin)], T0, T0 + wallMin * MIN)));
  assert.match(at(62, 100) ?? "", /^Root model time is above 60% of wall time \(62% of 1h40m\): combine reviews and keep ledgers to one-line appends\.$/);
  assert.equal(at(60, 100), null, "exactly at the threshold is not above it");
  assert.equal(at(50, 100), null);
  assert.equal(at(29, 29.5), null, "under thirty minutes of wall time");
  assert.ok(at(29.5, 30), "thirty minutes of wall time is enough");
  assert.equal(wakeNotice({ state: "unknown" }), null);
  assert.equal(wakeNotice({ state: "none" }), null);
});

test("the notice is one line", () => {
  const notice = wakeNotice(known(rootModelTime([request(0, 90)], T0, T0 + 100 * MIN)));
  assert.ok(notice && !notice.includes("\n"));
});
