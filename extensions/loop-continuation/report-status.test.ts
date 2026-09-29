// Ported subset of the report-counts and PAUSED/WAITING marker rules from
// the agent-workflows plugin's fanout_session.py
// (report_status/report_counts/final_marker), v2/strict mode only.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportCounts, reportStatus, finalMarker, waitingDeadline } from "./report-status.ts";
import type { LaunchInfo } from "./launch-detect.ts";

const GOAL_SHA = "a".repeat(64);
const VALID_REPORT = [
  `# Loop: repo loop3 · Goal: ${GOAL_SHA}`,
  "## Outcome",
  "## Evidence",
  "## Pending",
  "## Questions",
  "## Stalls and deaths",
  "## Tokens and wakeups",
].join("\n");

describe("reportStatus", () => {
  let tmp: string;
  let reportPath: string;
  let launch: LaunchInfo;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-continuation-report-"));
    reportPath = join(tmp, "report.md");
    launch = { report: reportPath, loop: 3, launchTs: "2026-09-25T00:00:00Z" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("a well-formed report written after launch counts", () => {
    writeFileSync(reportPath, VALID_REPORT);
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, true);
    assert.equal(whyNot, null);
  });

  test("a report that does not exist yet does not count", () => {
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.equal(whyNot, "does not exist yet");
  });

  test("a report that predates the launch does not count", () => {
    writeFileSync(reportPath, VALID_REPORT);
    const early = { ...launch, launchTs: "2099-01-01T00:00:00Z" };
    const { counts, whyNot } = reportStatus(early, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /predates the launch/);
  });

  test("a symlink does not count", () => {
    writeFileSync(join(tmp, "real.md"), VALID_REPORT);
    symlinkSync(join(tmp, "real.md"), reportPath);
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /symlink/);
  });

  test("a missing header does not count", () => {
    writeFileSync(reportPath, "not a header\n## Outcome\n## Evidence\n## Pending\n## Questions\n## Stalls and deaths\n## Tokens and wakeups");
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /no valid header/);
  });

  test("a header naming a different loop does not count", () => {
    const wrong = VALID_REPORT.replace("loop3", "loop9");
    writeFileSync(reportPath, wrong);
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /names loop 9, not loop 3/);
  });

  test("a report missing a required section does not count", () => {
    const missing = VALID_REPORT.split("\n").filter((l) => l !== "## Pending").join("\n");
    writeFileSync(reportPath, missing);
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /missing sections: ## Pending/);
  });

  test("reportCounts is the boolean projection of reportStatus", () => {
    writeFileSync(reportPath, VALID_REPORT);
    assert.equal(reportCounts(launch, tmp), true);
  });

  test("no launch at all does not count", () => {
    assert.equal(reportCounts(null, tmp), false);
  });
});

describe("finalMarker", () => {
  test("a current PAUSED: line is the paused marker", () => {
    assert.equal(finalMarker("Some notes.\nPAUSED: waiting on the owner"), "paused");
  });

  test("a current WAITING: … until <deadline> line is the waiting marker", () => {
    assert.equal(finalMarker("Notes.\nWAITING: lane 3 CI until 2026-09-27T12:00Z"), "waiting");
  });

  test("a WAITING: line with no deadline is not a marker", () => {
    assert.equal(finalMarker("WAITING: lane 3 CI"), null);
  });

  test("trailing blank lines do not hide the marker", () => {
    assert.equal(finalMarker("PAUSED: reason\n\n\n"), "paused");
  });

  test("plain prose with no marker line is null", () => {
    assert.equal(finalMarker("Just some closing remarks."), null);
  });

  test("no message at all is null", () => {
    assert.equal(finalMarker(null), null);
  });
});

describe("waitingDeadline", () => {
  test("extracts the deadline from a current WAITING: line", () => {
    assert.equal(waitingDeadline("WAITING: lane 3 CI until 2026-09-27T12:00Z"), "2026-09-27T12:00Z");
  });

  test("extracts a deadline that carries seconds", () => {
    assert.equal(waitingDeadline("WAITING: lane 3 CI until 2026-09-27T12:00:30Z"), "2026-09-27T12:00:30Z");
  });

  test("null when the last line is not a WAITING: marker", () => {
    assert.equal(waitingDeadline("PAUSED: reason"), null);
  });
});
