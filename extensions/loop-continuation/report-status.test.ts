// Ported subset of the closeout-counts and PAUSED/WAITING marker rules from
// the agent-workflows plugin's fanout_session.py (report_status/report_counts/final_marker),
// for the v3 closeout (frozen seam S2).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportCounts, reportStatus, finalMarker, waitingDeadline } from "./report-status.ts";
import type { LaunchInfo } from "./launch-detect.ts";

const CHARTER_SHA = "a".repeat(64);
const VALID_REPORT = [
  `# Closeout: repo loop3 · Charter: ${CHARTER_SHA}`,
  "",
  "## Landed",
  "- T-1 (first task), abc123",
  "## Parked",
  "## For ratification",
  "## Notes",
].join("\n");

describe("reportStatus", () => {
  let tmp: string;
  let reportPath: string;
  let launch: LaunchInfo;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-continuation-report-"));
    reportPath = join(tmp, "closeout-x-loop3.md");
    launch = { report: reportPath, loop: 3, launchTs: "2026-09-25T00:00:00Z" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("a well-formed closeout written after launch counts", () => {
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
    writeFileSync(reportPath, "not a header\n## Landed\n## Parked\n## For ratification\n## Notes");
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

  test("a closeout missing a required section does not count", () => {
    for (const section of ["## Landed", "## Parked", "## For ratification", "## Notes"]) {
      const missing = VALID_REPORT.split("\n").filter((l) => l !== section).join("\n");
      writeFileSync(reportPath, missing);
      const { counts, whyNot } = reportStatus(launch, tmp);
      assert.equal(counts, false, section);
      assert.equal(whyNot, `is missing sections: ${section}`);
    }
  });

  test("a report header and sections of another shape do not count as a closeout", () => {
    writeFileSync(reportPath, [`# Loop: repo loop3 · Goal: ${CHARTER_SHA}`, "## Outcome", "## Evidence", "## Pending", "## Questions",
      "## Stalls and deaths", "## Tokens and wakeups"].join("\n"));
    const { counts, whyNot } = reportStatus(launch, tmp);
    assert.equal(counts, false);
    assert.match(whyNot!, /# Closeout: <repo> loop<N> · Charter:/);
  });

  test("a heading with trailing text is not the section heading", () => {
    writeFileSync(reportPath, VALID_REPORT.replace("## Notes", "## Notes and more"));
    assert.equal(reportStatus(launch, tmp).whyNot, "is missing sections: ## Notes");
  });

  test("reportCounts is the boolean projection of reportStatus", () => {
    writeFileSync(reportPath, VALID_REPORT);
    assert.equal(reportCounts(launch, tmp), true);
  });

  test("no launch at all does not count", () => {
    assert.equal(reportCounts(null, tmp), false);
  });
});

describe("reportStatus: the landing ledger rule", () => {
  let tmp: string;
  let reportPath: string;
  let ledgerPath: string;
  let launch: LaunchInfo;
  const ev = (event: string, fields: Record<string, unknown> = {}, ts = "2026-09-25T10:00:00Z") =>
    JSON.stringify({ v: 1, ts, event, outcome: null, pr: 7, head: "a".repeat(40), issues: [], merge_sha: null, main: null, deploy: null, ...fields });
  const writeLedger = (...rows: string[]) => writeFileSync(ledgerPath, rows.join("\n") + "\n");
  const check = (outcome = "ok", ts = "2026-09-25T12:00:00Z") => ev("closeout-check", { outcome, pr: null, head: null }, ts);
  const merged = (pr = 7, ts = "2026-09-25T10:05:00Z") => ev("merged", { pr, merge_sha: "b".repeat(40) }, ts);
  const verified = (fields: Record<string, unknown> = {}, pr = 7, ts = "2026-09-25T10:10:00Z") =>
    ev("verified", { pr, main: "green", deploy: "n/a", ...fields }, ts);
  const ready = (pr = 7, ts = "2026-09-25T10:00:00Z") => ev("ready", { outcome: "go", pr }, ts);
  const writeCharter = (...lines: string[]) => writeFileSync(join(tmp, "charter-x-loop3.md"), ["aim: synthetic", ...lines].join("\n") + "\n");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-continuation-ledger-"));
    reportPath = join(tmp, "closeout-x-loop3.md");
    mkdirSync(join(tmp, "loop3"));
    ledgerPath = join(tmp, "loop3", "landings.jsonl");
    launch = { report: reportPath, loop: 3, launchTs: "2026-09-25T00:00:00Z" };
    writeFileSync(reportPath, VALID_REPORT);
    writeCharter("protocol: v4");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const status = () => reportStatus(launch, tmp);

  test("every landing verified and an ok check newer than the last merge counts", () => {
    writeLedger(ready(), merged(), verified(), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("no ledger events and an ok check counts", () => {
    writeLedger(check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("a landing left at ready does not count", () => {
    writeLedger(ready(), check());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /pull request 7 at ready/);
  });

  test("a landing left at merged does not count", () => {
    writeLedger(ready(), merged(), check());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /pull request 7 merged and not verified/);
  });

  test("a landing is judged by its last event, so a refused ready that is later verified counts", () => {
    writeLedger(ready(7), ready(8, "2026-09-25T10:01:00Z"), ev("refused", { outcome: "held", pr: 8 }, "2026-09-25T10:02:00Z"),
      merged(7), verified(), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("a verified event with main unread does not count, and with the deploy unread does not count", () => {
    writeLedger(ready(), merged(), verified({ main: "unread" }), check());
    assert.match(status().whyNot!, /pull request 7 verified with main unread/);
    writeLedger(ready(), merged(), verified({ deploy: "unread" }), check());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /verified with the deploy unread/);
  });

  test("an unread verify that a later verify read counts", () => {
    writeLedger(ready(), merged(), verified({ main: "unread" }), verified({}, 7, "2026-09-25T10:20:00Z"), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("main recorded red or a deploy recorded failed does not block the closeout", () => {
    writeLedger(ready(), merged(), verified({ main: "red", deploy: "failed" }), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("an abandoned landing does not block the closeout", () => {
    writeLedger(ready(), ev("abandoned", { outcome: "abandoned" }, "2026-09-25T10:30:00Z"), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("a ledger with no closeout-check event does not count, with or without landings", () => {
    writeLedger(ready(), merged(), verified());
    assert.match(status().whyNot!, /no closeout-check/);
    writeFileSync(ledgerPath, "");
    assert.match(status().whyNot!, /no closeout-check/);
    rmSync(ledgerPath);
    assert.equal(status().counts, false);
  });

  test("a closeout-check older than the last merged event does not count", () => {
    writeLedger(check("ok", "2026-09-25T10:03:00Z"), ready(), merged(7, "2026-09-25T10:05:00Z"), verified());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /older than the last merge/);
  });

  test("a closeout-check that is not ok does not count", () => {
    writeLedger(ready(), merged(), verified(), check("missing"));
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /not ok/);
  });

  test("only the last closeout-check decides", () => {
    writeLedger(ready(), merged(), verified(), check("missing", "2026-09-25T11:00:00Z"), check("ok", "2026-09-25T12:00:00Z"));
    assert.equal(status().counts, true);
    writeLedger(ready(), merged(), verified(), check("ok", "2026-09-25T11:00:00Z"), check("missing", "2026-09-25T12:00:00Z"));
    assert.equal(status().counts, false);
  });

  test("a ledger that cannot be parsed does not count", () => {
    const rows: Array<[string, RegExp]> = [
      ["not json\n", /line 1 is not JSON/],
      [`${ready()}\n[1]\n`, /line 2 is not an object/],
      [`${JSON.stringify({ ts: "2026-09-25T10:00:00Z" })}\n`, /no known event/],
      [`${JSON.stringify({ event: "ready" })}\n`, /no known event and time/],
      [`${JSON.stringify({ event: "ready", ts: "yesterday" })}\n`, /no known event and time/],
      [`${JSON.stringify({ event: "shipped", ts: "2026-09-25T10:00:00Z" })}\n`, /no known event/],
      [`${ready()}\n${check()}\n{"event":`, /line 3 is not JSON/],
    ];
    for (const [text, why] of rows) {
      writeFileSync(ledgerPath, text);
      const { counts, whyNot } = status();
      assert.equal(counts, false, text);
      assert.match(whyNot!, why, text);
    }
  });

  test("a ledger path that is a directory cannot be read and does not count", () => {
    mkdirSync(ledgerPath);
    assert.match(status().whyNot!, /cannot be read/);
  });

  test("a direct-mode landing with no pull request is tracked by its head", () => {
    const sha = "c".repeat(40);
    writeLedger(ev("ready", { outcome: "go", pr: null, head: sha }), check());
    assert.match(status().whyNot!, new RegExp(`head ${sha} at ready`));
    writeLedger(ev("ready", { outcome: "go", pr: null, head: sha }), ev("merged", { pr: null, head: sha }, "2026-09-25T10:05:00Z"),
      ev("verified", { pr: null, head: sha, main: "green", deploy: "n/a" }, "2026-09-25T10:10:00Z"), check());
    assert.equal(status().counts, true);
  });

  test("the ledger rule applies only after the v3 rules pass", () => {
    writeLedger(ready(), merged(), verified(), check());
    writeFileSync(reportPath, "not a header\n");
    assert.match(status().whyNot!, /no valid header/);
  });

  test("a charter with no protocol line is judged by the v3 rule", () => {
    writeCharter("gate: just check");
    writeLedger(ready(), merged());
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("a charter that says protocol v3, or has no charter file at all, is judged by the v3 rule", () => {
    writeLedger(ready(), merged());
    writeCharter("protocol: v3");
    assert.equal(status().counts, true);
    rmSync(join(tmp, "charter-x-loop3.md"));
    assert.equal(status().counts, true);
  });

  test("loop-land: off turns the ledger rule off for a v4 charter", () => {
    writeCharter("protocol: v4", "loop-land: off");
    writeLedger("garbage");
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("another loop's charter is not this run's charter", () => {
    rmSync(join(tmp, "charter-x-loop3.md"));
    writeFileSync(join(tmp, "charter-x-loop13.md"), "protocol: v4\n");
    writeFileSync(join(tmp, "charter-x-loop30.md"), "protocol: v4\n");
    writeLedger(ready());
    assert.equal(status().counts, true);
  });

  const abandoned = (pr = 5, ts = "2026-09-25T10:30:00Z") => ev("abandoned", { outcome: "abandoned", pr }, ts);
  const unreadBoth = { main: "unread", deploy: "unread" };

  test("a merged landing whose verify read nothing still blocks after it is abandoned", () => {
    writeLedger(ready(5), merged(5), verified(unreadBoth, 5), abandoned(5), check("ok", "2026-09-25T12:00:00Z"));
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /pull request 5 verified with main unread/);
    assert.match(whyNot!, /loop-land verify/);
  });

  test("a merged landing with no later verified blocks after it is abandoned", () => {
    writeLedger(ready(5), merged(5), abandoned(5), check());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /pull request 5 merged and not verified/);
    assert.match(whyNot!, /loop-land verify/);
    assert.doesNotMatch(whyNot!, /loop-land abandon/);
  });

  test("a merged landing blocks whatever event follows: refused or error", () => {
    for (const after of [ev("refused", { outcome: "held", pr: 5 }, "2026-09-25T10:30:00Z"), ev("error", { outcome: "error", pr: 5 }, "2026-09-25T10:30:00Z")]) {
      writeLedger(ready(5), merged(5), after, check());
      assert.equal(status().counts, false, after);
    }
  });

  test("a verified-unread landing blocks after a refused or error event", () => {
    for (const after of [ev("refused", { pr: 5 }, "2026-09-25T10:30:00Z"), ev("error", { pr: 5 }, "2026-09-25T10:30:00Z")]) {
      writeLedger(ready(5), merged(5), verified({ deploy: "unread" }, 5), after, check());
      assert.match(status().whyNot!, /verified with the deploy unread/, after);
    }
  });

  test("the latest verified decides: a later read verify clears an unread one, a later unread one blocks", () => {
    writeLedger(ready(5), merged(5), verified(unreadBoth, 5), verified({}, 5, "2026-09-25T10:20:00Z"), abandoned(5), check());
    assert.deepEqual(status(), { counts: true, whyNot: null });
    writeLedger(ready(5), merged(5), verified({}, 5), verified(unreadBoth, 5, "2026-09-25T10:20:00Z"), check());
    assert.equal(status().counts, false);
  });

  test("a landing never merged blocks only while its last event is ready, and says to abandon it", () => {
    writeLedger(ready(5), check());
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /pull request 5 at ready/);
    assert.match(whyNot!, /loop-land abandon/);
    assert.doesNotMatch(whyNot!, /loop-land verify/);
    writeLedger(ready(5), abandoned(5), check());
    assert.equal(status().counts, true);
    writeLedger(ready(5), ev("refused", { outcome: "held", pr: 5 }, "2026-09-25T10:01:00Z"), check());
    assert.equal(status().counts, true);
  });

  test("an error event changes no landing's state", () => {
    const err = (pr: number, ts = "2026-09-25T10:30:00Z") => ev("error", { outcome: "error", pr }, ts);
    writeLedger(ready(5), err(5), check());
    assert.match(status().whyNot!, /pull request 5 at ready/);
    writeLedger(ready(5), abandoned(5), err(5), check());
    assert.equal(status().counts, true);
    writeLedger(ready(5), merged(5), verified({}, 5), err(5), check());
    assert.equal(status().counts, true);
    writeLedger(err(9), check());
    assert.equal(status().counts, true);
  });

  test("a closeout-check listed before the last merged event is stale on a tie, one listed after is not", () => {
    const t = "2026-09-25T12:00:00Z";
    writeLedger(ready(5, t), check("ok", t), merged(5, t), verified({}, 5, t));
    assert.match(status().whyNot!, /older than the last merge/);
    writeLedger(ready(5, t), merged(5, t), verified({}, 5, t), check("ok", t));
    assert.deepEqual(status(), { counts: true, whyNot: null });
  });

  test("a line nested too deeply to parse blocks as unparsable", () => {
    writeFileSync(ledgerPath, `${ready()}\n${"[".repeat(200000)}\n${check()}\n`);
    const { counts, whyNot } = status();
    assert.equal(counts, false);
    assert.match(whyNot!, /cannot be parsed/);
  });

  const charterAt = (name: string, text: string) => writeFileSync(join(tmp, name), text);
  const refuses = () => status().counts === false;

  test("charter keys are read only in the header, before the first level-two heading", () => {
    writeLedger(ready());
    charterAt("charter-x-loop3.md", "aim: synthetic\n\n## Notes\nprotocol: v4\n");
    assert.equal(status().counts, true, "a key under a heading is not the header");
    charterAt("charter-x-loop3.md", "# Title\nprotocol: v4\n## Notes\nloop-land: off\n");
    assert.equal(refuses(), true, "loop-land: off under a heading is not read");
  });

  test("a key must start at column 0 and a fenced key is ignored", () => {
    writeLedger(ready());
    charterAt("charter-x-loop3.md", "aim: synthetic\n  protocol: v4\n");
    assert.equal(status().counts, true, "an indented key is not a key");
    charterAt("charter-x-loop3.md", "aim: synthetic\n```\nprotocol: v4\n```\n");
    assert.equal(status().counts, true, "a key inside a fence is not read");
  });

  test("a four-backtick fence holding a three-backtick line does not hide a key after it, nor expose one inside", () => {
    writeLedger(ready());
    charterAt("charter-x-loop3.md", "aim: synthetic\n````\n```\nprotocol: v4\n```\n````\nloop-land: on\nprotocol: v4\n");
    assert.equal(refuses(), true, "the key after the closed outer fence is read");
    charterAt("charter-x-loop3.md", "aim: synthetic\n````\n```\nprotocol: v4\n```\n````\n");
    assert.equal(status().counts, true, "the key inside the outer fence stays hidden");
  });

  test("the first occurrence of a key wins and a quoted value is accepted", () => {
    writeLedger(ready());
    charterAt("charter-x-loop3.md", "protocol: v3\nprotocol: v4\n");
    assert.equal(status().counts, true);
    charterAt("charter-x-loop3.md", 'protocol: "v4"\n');
    assert.equal(refuses(), true);
    charterAt("charter-x-loop3.md", "protocol: 'v4'\nloop-land: 'off'\n");
    assert.equal(status().counts, true);
    charterAt("charter-x-loop3.md", "protocol: v4\nloop-land: on\nloop-land: off\n");
    assert.equal(refuses(), true, "the first loop-land line is the one read");
  });

  test("with several charters for a loop number the last by name wins, and an unreadable one means the v3 rule", () => {
    writeLedger(ready());
    charterAt("charter-a-loop3.md", "protocol: v4\n");
    charterAt("charter-x-loop3.md", "protocol: v3\n");
    assert.equal(status().counts, true, "the later name is v3");
    rmSync(join(tmp, "charter-x-loop3.md"));
    charterAt("charter-b-loop3.md", "protocol: v4\n");
    assert.equal(refuses(), true, "the last of the v4 charters");
    mkdirSync(join(tmp, "charter-z-loop3.md"));
    assert.equal(status().counts, true, "the last charter cannot be read, so v3");
  });

  test("a closeout whose name carries no loop number is judged by the v3 rule", () => {
    const named = join(tmp, "closeout-x.md");
    writeFileSync(named, VALID_REPORT);
    writeLedger(ready());
    assert.equal(reportStatus({ ...launch, report: named }, tmp).counts, true);
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

  test("a trailing period after the deadline still reads as WAITING", () => {
    assert.equal(finalMarker("Notes.\nWAITING: lane 3 CI until 2026-09-27T12:00:30Z."), "waiting");
  });

  test("a bolded WAITING line reads as WAITING", () => {
    assert.equal(finalMarker("**WAITING: lane 3 CI until 2026-09-27T12:00Z**"), "waiting");
  });

  test("a bulleted or quoted WAITING line reads as WAITING", () => {
    assert.equal(finalMarker("- WAITING: lane 3 CI until 2026-09-27T12:00Z"), "waiting");
    assert.equal(finalMarker("> `WAITING: lane 3 CI until 2026-09-27T12:00Z`"), "waiting");
  });

  test("a decorated PAUSED line reads as PAUSED", () => {
    assert.equal(finalMarker("**PAUSED: waiting on the owner.**"), "paused");
  });

  test("prose that merely mentions WAITING is not a marker", () => {
    assert.equal(finalMarker("I will end with WAITING: x until 2026-09-27T12:00Z soon."), null);
  });

  test("a deadline with trailing text other than decoration is not a marker", () => {
    assert.equal(finalMarker("WAITING: lane 3 CI until 2026-09-27T12:00Z please"), null);
  });
});

describe("waitingDeadline", () => {
  test("extracts the deadline from a current WAITING: line", () => {
    assert.equal(waitingDeadline("WAITING: lane 3 CI until 2026-09-27T12:00Z"), "2026-09-27T12:00Z");
  });

  test("extracts a deadline that carries seconds", () => {
    assert.equal(waitingDeadline("WAITING: lane 3 CI until 2026-09-27T12:00:30Z"), "2026-09-27T12:00:30Z");
  });

  test("extracts the deadline from a decorated WAITING: line", () => {
    assert.equal(waitingDeadline("**WAITING: lane 3 CI until 2026-09-27T12:00Z**."), "2026-09-27T12:00Z");
    assert.equal(waitingDeadline("- WAITING: lane 3 CI until 2026-09-27T12:00:30Z."), "2026-09-27T12:00:30Z");
  });

  test("null when the last line is not a WAITING: marker", () => {
    assert.equal(waitingDeadline("PAUSED: reason"), null);
  });
});
