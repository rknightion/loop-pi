import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAge, formatStatus, nextDeadline } from "./status.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

test("formatAge is seconds, minutes, then hours and minutes", () => {
  assert.equal(formatAge(45_000), "45s");
  assert.equal(formatAge(7 * 60_000 + 59_000), "7m");
  assert.equal(formatAge(2 * 3_600_000 + 5 * 60_000), "2h05m");
  assert.equal(formatAge(-5_000), "0s");
});

test("nextDeadline is the earliest valid time across timers and watchers", () => {
  const timers = [{ at: "2026-10-08T14:00:00Z" }, { at: "garbage" }];
  const watchers = [{ deadline: "2026-10-08T13:00:00Z" }, {}];
  assert.equal(nextDeadline(timers, watchers), Date.parse("2026-10-08T13:00:00Z"));
  assert.equal(nextDeadline([], []), null);
  assert.equal(nextDeadline(null, null), null);
});

test("an idle root with no loop-wait reply says so rather than showing zero", () => {
  const text = formatStatus({ lanes: 0, timers: null, watchers: null, nudges: null, maxNudges: 3, heartbeatAt: null, now: NOW });
  assert.equal(text, "loop: 0 lanes · timers ? · watchers ? · nudge 0/3 · hb -");
});

test("a busy root shows lanes, counts, the next deadline, the nudge chain and heartbeat age", () => {
  const text = formatStatus({
    lanes: 1,
    timers: [{ at: new Date(NOW + 600_000).toISOString() }],
    watchers: [],
    nudges: 2,
    maxNudges: 3,
    heartbeatAt: NOW - 185_000,
    now: NOW,
  });
  assert.match(text, /^loop: 1 lane · 1 timer · 0 watchers · next \d\d:\d\d · nudge 2\/3 · hb 3m ago$/);
});

test("a known slot cap shows as lanes over cap; an unknown or invalid cap keeps the bare count", () => {
  const base = { timers: [], watchers: [], nudges: 0, maxNudges: 3, heartbeatAt: null, now: NOW };
  assert.match(formatStatus({ ...base, lanes: 1, laneCap: 4 }), /^loop: 1\/4 lanes · /);
  assert.match(formatStatus({ ...base, lanes: 0, laneCap: 1 }), /^loop: 0\/1 lanes · /);
  assert.match(formatStatus({ ...base, lanes: 1, laneCap: null }), /^loop: 1 lane · /);
  assert.match(formatStatus({ ...base, lanes: 1 }), /^loop: 1 lane · /);
  assert.match(formatStatus({ ...base, lanes: 1, laneCap: 0 }), /^loop: 1 lane · /);
});
