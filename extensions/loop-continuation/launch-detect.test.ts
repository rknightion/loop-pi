// Ported subset of
// the agent-workflows plugin's test_loop_launch.py, restricted to
// the always-v2 (strict) shape this module implements (see launch-detect.ts's header comment for
// why the legacy branch and "Time budget" line are dropped).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunch } from "./launch-detect.ts";

const AFTER = "2026-09-25T00:00:00Z";

describe("parseLaunch: pasted marker launches", () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-continuation-"));
    repo = join(tmp, "repo");
    mkdirSync(join(repo, "codex"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("recognises 'You are the root' with a backtick-quoted relative report", () => {
    const text =
      "You are the root in this existing session.\nWrite `codex/report-2026-09-25-loop5.md` as the terminal action.\n";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.report, join(repo, "codex/report-2026-09-25-loop5.md"));
    assert.equal(result!.loop, 5);
  });

  test("recognises 'You are the campaign root' wording", () => {
    const text = "You are the campaign root. Write `codex/report-2026-09-25-loop5.md` now.";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.loop, 5);
  });

  test("resolves a ./codex/ relative report path", () => {
    const text = "You are the root. Write ./codex/report-2026-09-25-loop5.md as the terminal action.";
    const result = parseLaunch(text, repo, AFTER);
    assert.equal(result!.report, join(repo, "codex/report-2026-09-25-loop5.md"));
  });

  test("an absolute report path resolves independent of cwd", () => {
    const absReport = join(repo, "codex/report-2026-09-25-loop5.md");
    const text = `You are the root. Write ${absReport} as the terminal action.`;
    const result = parseLaunch(text, "/somewhere/else", AFTER);
    assert.equal(result!.report, absReport);
  });

  test("a marker quoted inside other operator text still arms", () => {
    const text =
      "Don't forget: earlier I said 'You are the root. Write codex/report-2026-09-25-loop5.md now.' " +
      "Keep going with lane 2 in the meantime.";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.loop, 5);
  });

  test("no marker text is not a launch", () => {
    const text = "Please write codex/report-2026-09-25-loop5.md when you are done.";
    assert.equal(parseLaunch(text, repo, AFTER), null);
  });
});

describe("parseLaunch: delimiters", () => {
  const repo = "/repo";

  test("a .backup suffix does not match the right delimiter", () => {
    const text = "You are the root. See codex/report-47.md.backup for context.";
    assert.equal(parseLaunch(text, repo, AFTER), null);
  });

  test("a trailing period then whitespace is a right delimiter", () => {
    const text = "You are the root. Write codex/report-2026-09-25-loop5.md. Then stop.";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.report, join(repo, "codex/report-2026-09-25-loop5.md"));
  });

  test("a trailing period at end of text is a right delimiter", () => {
    const text = "You are the root. Write codex/report-2026-09-25-loop5.md.";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.loop, 5);
  });

  test("a period followed by more text is not a right delimiter", () => {
    for (const text of [
      "You are the root. See codex/report-2026-09-25-loop5.md.backup for context.",
      "You are the root. See codex/report-47.md.backup for context.",
      'You are the root. See codex/report-2026-09-25-loop5.md.) for context.',
    ]) {
      assert.equal(parseLaunch(text, repo, AFTER), null, text);
    }
  });
});

describe("parseLaunch: multiplicity and dedup", () => {
  const repo = "/repo";

  test("two distinct report paths is not a launch", () => {
    const text =
      "You are the root. Write codex/report-2026-09-25-loop5.md or, if that's stale, " +
      "codex/report-2026-09-25-loop6.md instead.";
    assert.equal(parseLaunch(text, repo, AFTER), null);
  });

  test("a repeated identical token is still one distinct target", () => {
    const text =
      "You are the root. Write codex/report-2026-09-25-loop5.md. " +
      "Confirm: codex/report-2026-09-25-loop5.md is the terminal action.";
    assert.ok(parseLaunch(text, repo, AFTER));
  });

  test("an absolute and a relative spelling of the same report is one target", () => {
    const absReport = "/repo/codex/report-2026-09-25-loop5.md";
    const text =
      `You are the root. Write your report to:\n\n  ${absReport}\n\n` +
      "Then run:\n\n  wave-notify codex/report-2026-09-25-loop5.md\n";
    const result = parseLaunch(text, repo, AFTER);
    assert.ok(result);
    assert.equal(result!.report, absReport);
    assert.equal(result!.loop, 5);
  });

  test("an unknown cwd with a relative suffix of the absolute path is the same target", () => {
    const absReport = "/repo/codex/report-2026-09-25-loop5.md";
    const text = `You are the root. Write ${absReport} then notify codex/report-2026-09-25-loop5.md`;
    const result = parseLaunch(text, null, AFTER);
    assert.ok(result);
    assert.equal(result!.report, absReport);
  });

  test("an unknown cwd with a relative path that is not a suffix is a second target", () => {
    const other = "/other/codex/report-2026-09-25-loop5.md";
    const text = `You are the root. Write ${other} then notify codex/report-2026-09-26-loop5.md`;
    assert.equal(parseLaunch(text, null, AFTER), null);
  });
});

describe("parseLaunch: always-v2 report name shape", () => {
  const repo = "/repo";

  test("a wave-shaped name is never a launch (no legacy fallback in loop-pi)", () => {
    const text = "You are the root. Write codex/report-2026-09-25-wave5.md now.";
    assert.equal(parseLaunch(text, repo, AFTER), null);
  });

  test("the loop number comes only from the -loopN.md suffix", () => {
    const text = "You are the root. Write codex/report-wave9-2026-09-25-loop5.md now.";
    assert.equal(parseLaunch(text, repo, AFTER)!.loop, 5);
  });
});

describe("parseLaunch: bare launch-file path", () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loop-continuation-"));
    repo = join(tmp, "repo");
    mkdirSync(join(repo, "codex"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("a bare launch file path resolves and reads through", () => {
    const launchPath = join(repo, "codex", "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "You are the root. Write codex/report-2026-09-24-loop47.md as the terminal action.\n");
    const result = parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER);
    assert.ok(result);
    assert.equal(result!.report, join(repo, "codex/report-2026-09-24-loop47.md"));
    assert.equal(result!.loop, 47);
  });

  test("a backtick-wrapped bare launch file path still resolves", () => {
    const launchPath = join(repo, "codex", "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "You are the root. Write codex/report-2026-09-24-loop47.md now.\n");
    const result = parseLaunch("`codex/launch-2026-09-24-loop47.txt`", repo, AFTER);
    assert.ok(result);
  });

  test("a missing bare launch file is not a launch", () => {
    assert.equal(parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER), null);
  });

  test("a bare path with the wrong basename is not a launch", () => {
    const other = join(repo, "codex", "notes.txt");
    writeFileSync(other, "You are the root. Write codex/report-2026-09-24-loop47.md.\n");
    assert.equal(parseLaunch("codex/notes.txt", repo, AFTER), null);
  });

  test("a launch file outside any codex/ dir needs an absolute report", () => {
    const outside = join(tmp, "scratch");
    mkdirSync(outside, { recursive: true });
    const launchPath = join(outside, "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "You are the root. Write codex/report-2026-09-24-loop47.md now.\n");
    assert.equal(parseLaunch(launchPath, outside, AFTER), null);
  });

  test("a launch file outside codex/ with an absolute report is a launch", () => {
    const outside = join(tmp, "scratch");
    mkdirSync(outside, { recursive: true });
    const absReport = join(outside, "codex", "report-2026-09-24-loop47.md");
    const launchPath = join(outside, "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, `You are the root. Write ${absReport} now.\n`);
    const result = parseLaunch(launchPath, outside, AFTER);
    assert.ok(result);
    assert.equal(result!.report, absReport);
  });

  test("parseLaunch always reads live content (no internal caching)", () => {
    const launchPath = join(repo, "codex", "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "You are the root. Write codex/report-2026-09-24-loop47.md now.\n");
    const first = parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER);
    writeFileSync(launchPath, "You are the root. Write codex/report-2026-09-24-loop48.md now.\n");
    const second = parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER);
    assert.equal(first!.loop, 47);
    assert.equal(second!.loop, 48);
  });

  test("a pasted launch with no cwd keeps a relative report instead of failing", () => {
    const text = "You are the root. Write codex/report-2026-09-25-loop5.md now.";
    const result = parseLaunch(text, null, AFTER);
    assert.ok(result);
    assert.equal(result!.report, "codex/report-2026-09-25-loop5.md");
  });

  test("the readFile injection point is used for a bare launch file", () => {
    const launchPath = join(repo, "codex", "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "garbage that is not a launch\n");
    let sawPath: string | null = null;
    const result = parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER, (path) => {
      sawPath = path;
      return "You are the root. Write codex/report-2026-09-24-loop47.md now.\n";
    });
    assert.equal(sawPath, launchPath);
    assert.equal(result!.loop, 47);
  });

  test("a read_file that throws is not a launch, never an exception", () => {
    const launchPath = join(repo, "codex", "launch-2026-09-24-loop47.txt");
    writeFileSync(launchPath, "irrelevant\n");
    const result = parseLaunch("codex/launch-2026-09-24-loop47.txt", repo, AFTER, () => {
      throw new Error("bad");
    });
    assert.equal(result, null);
  });
});
