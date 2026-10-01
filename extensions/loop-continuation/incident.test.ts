import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeIncident } from "./incident.ts";

test("chain incident records session, home and cwd for watchdog attribution", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-incident-"));
  const cwd = join(home, "project");
  writeIncident(home, "synthetic-session", cwd);
  const files = readdirSync(join(home, "incidents"));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith("synthetic-session-"));
  const payload = JSON.parse(readFileSync(join(home, "incidents", files[0]), "utf8"));
  assert.equal(payload.v, 1);
  assert.equal(payload.session, "synthetic-session");
  assert.equal(payload.class, "loop-continuation-chain-exhausted");
  assert.equal(payload.home, home);
  assert.equal(payload.cwd, cwd);
  assert.ok(Number.isFinite(Date.parse(payload.at)));
});

test("incident bookkeeping never traps the session on filesystem failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-incident-"));
  const file = join(dir, "not-a-directory");
  writeFileSync(file, "occupied");
  assert.doesNotThrow(() => writeIncident(file, "synthetic-session", dir));
});
