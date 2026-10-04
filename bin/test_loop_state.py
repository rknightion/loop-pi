#!/usr/bin/env python3
"""Tests for loop-state. Stdlib unittest, runnable as `python3 -m unittest bin.test_loop_state`
from the repo root. Every test drives the CLI as a subprocess against a scratch repo."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "loop-state")

OPEN = ["open", "goal_sha256=" + "a" * 64, "tier=routine", "root=llm", "root_model=m", 'envelope=["T1","T2"]']


def load_cli():
    """bin/loop-state as a module, to render digest detail levels a small log never reaches."""
    import importlib.machinery
    import importlib.util
    loader = importlib.machinery.SourceFileLoader("loop_state_cli", SCRIPT)
    spec = importlib.util.spec_from_loader("loop_state_cli", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def run(*args, stdin=None):
    return subprocess.run(
        [sys.executable, SCRIPT, *args], input=stdin, capture_output=True, text=True, timeout=60
    )


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = os.path.realpath(self.tmp.name)
        os.makedirs(os.path.join(self.repo, "codex"))
        self.log = os.path.join(self.repo, "codex", "state-x-loop1.jsonl")

    def append(self, *args, ok=True, **kw):
        r = run("append", self.log, *args, **kw)
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def events(self):
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def seed(self):
        self.append(*OPEN)
        self.append("admit", "task=T1", "source=envelope", 'owned=["a/**"]', "accept=ok")
        self.append("admit", "task=T2", "source=loop-created", "owned=b.txt", "accept=ok")


class ValidationTests(Base):
    def reject(self, *args, needle):
        before = self.events() if os.path.exists(self.log) else []
        r = self.append(*args, ok=False)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn(needle, r.stderr)
        after = self.events() if os.path.exists(self.log) else []
        self.assertEqual(after, before, "a rejected event must not be written")

    def test_valid_event_of_every_type(self):
        self.seed()
        self.append("dispatch", "lane=L1", "task=T1", "agent=lane-worker", "run=r1", "base=abc", "model=m")
        self.append(
            "return", "lane=L1", "run=r1", "status=partial", "sha=null", "landed=false", "exit=null",
            'coderabbit={"ran":true,"major":0,"unreviewed":1}', 'questions=["why?"]',
        )
        self.append("gate", "scope=composed", "sha=abc", "cmd=just check", "exit=0")
        self.append("accept", "task=T1", "accepted=false", "reason=needs work")
        self.append("park", "task=T1", "reason=waiting", "needs=owner", "until=2026-10-04T00:00:00Z")
        self.append("land", "task=T2", "sha=abc", "gate=just check", "mode=after-green", "ci=123")
        self.append("revert", "sha=abc", "reverted_by=def", "reason=ci-red", "task=T2")
        self.append("judgement", "text=fine", "task=T1")
        self.append("close", "reason=nothing-admissible")
        self.assertEqual([e["seq"] for e in self.events()], list(range(1, 13)))
        self.assertEqual(sum(1 for _ in self.events()), 12)

    def test_missing_required_field(self):
        self.reject("admit", "task=T1", "source=envelope", "owned=x", needle="missing required field accept")

    def test_enum_violations(self):
        self.reject(*OPEN[:2], "tier=sloppy", *OPEN[3:], needle="tier must be one of")
        self.reject("park", "task=T", "reason=r", "needs=whenever", needle="needs must be one of")
        self.reject("revert", "sha=a", "reverted_by=b", "reason=because", needle="reason must be one of")
        self.reject("close", "reason=bored", needle="reason must be one of")
        self.reject("return", "lane=L", "run=r", "status=done", needle="status must be one of")

    def test_type_violations(self):
        self.reject("gate", "scope=lane", "sha=a", "cmd=c", "exit=zero", needle="exit must be an integer")
        self.reject("accept", "task=T", "accepted=maybe", "reason=r", needle="accepted must be true or false")
        self.reject(*OPEN[:5], "envelope=T1", needle="envelope must be a list of strings")
        self.reject(
            "return", "lane=L", "run=r", "status=complete", "coderabbit={}", needle="coderabbit must be"
        )

    def test_unknown_field_and_reserved_fields(self):
        self.reject("close", "reason=budget", "colour=red", needle="unknown field colour")
        self.reject("close", "reason=budget", "seq=9", needle="seq is set by loop-state")
        self.reject("close", "reason=budget", "ts=now", needle="ts is set by loop-state")

    def test_numeric_looking_strings_stay_strings(self):
        self.append("dispatch", "lane=1", "task=2", "agent=a", "run=123456", "base=1234567")
        e = self.events()[0]
        self.assertEqual((e["lane"], e["task"], e["run"], e["base"]), ("1", "2", "123456", "1234567"))

    def test_judgement_limit(self):
        self.append("judgement", "text=" + "x" * 2048)
        self.reject("judgement", "text=" + "x" * 2049, needle="over 2048 bytes")

    def test_bad_ev_and_bad_kv(self):
        self.reject("nope", needle="ev must be one of")
        self.reject("close", "reason", needle="expected k=v")

    def test_envelope_fields_set_by_tool(self):
        self.append(*OPEN, "--by", "dispatcher")
        e = self.events()[0]
        self.assertEqual((e["v"], e["seq"], e["by"], e["ev"]), (1, 1, "dispatcher", "open"))
        self.assertRegex(e["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.append("close", "reason=budget")
        self.assertEqual(self.events()[1]["by"], "root")
        self.reject("close", "reason=budget", "--by", "nobody", needle="by must be one of")

    def test_json_on_stdin(self):
        self.append(stdin=json.dumps({"ev": "close", "reason": "owner-stop"}))
        self.assertEqual(self.events()[0]["reason"], "owner-stop")
        r = self.append(stdin='{"ev":"close"}', ok=False)
        self.assertEqual(r.returncode, 2)
        r = self.append(stdin="not json", ok=False)
        self.assertEqual(r.returncode, 2)
        r = self.append(stdin='{"ev":"close","reason":"budget","seq":4}', ok=False)
        self.assertEqual(r.returncode, 2)


class ConcurrencyTests(Base):
    def test_two_processes_append_without_gaps_or_interleaving(self):
        n = 25
        script = (
            "import subprocess,sys\n"
            "for i in range(%d):\n"
            "    subprocess.run([sys.executable, %r, 'append', %r, 'judgement', 'text=' + sys.argv[1] + str(i)], check=True, stdout=subprocess.DEVNULL)\n"
        ) % (n, SCRIPT, self.log)
        procs = [subprocess.Popen([sys.executable, "-c", script, tag]) for tag in ("a", "b")]
        for p in procs:
            self.assertEqual(p.wait(timeout=120), 0)
        events = self.events()
        self.assertEqual([e["seq"] for e in events], list(range(1, 2 * n + 1)))
        self.assertEqual(len({e["text"] for e in events}), 2 * n)
        self.assertEqual(run("check", self.log).returncode, 0)


class PreGreenTests(Base):
    LAND = ["land", "task=T1", "sha=abc", "gate=just check", "mode=pre-green"]

    def loop_md(self, **over):
        keys = {"tier": "routine", "release-on-push": "no", "deploy-on-push": "no"}
        keys.update(over)
        body = "# Loop: demo\n" + "".join("%s: %s\n" % kv for kv in keys.items()) + "\n## Traps\nrelease-on-push: yes\n"
        with open(os.path.join(self.repo, "LOOP.md"), "w", encoding="utf-8") as fh:
            fh.write(body)

    def test_refuses_without_loop_md(self):
        r = self.append(*self.LAND, ok=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn("LOOP.md", r.stderr)
        self.assertFalse(os.path.exists(self.log))

    def test_refuses_each_unmet_key(self):
        for key, value in (("tier", "guarded"), ("release-on-push", "yes"), ("deploy-on-push", "yes")):
            self.loop_md(**{key: value})
            r = self.append(*self.LAND, ok=False)
            self.assertEqual(r.returncode, 2, key)
            self.assertIn("`%s:" % key, r.stderr)
        self.assertFalse(os.path.exists(self.log))

    def test_refuses_baseline_red(self):
        self.loop_md(**{"baseline-red": "T9 - main fails the lint leg"})
        r = self.append(*self.LAND, ok=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn("`baseline-red", r.stderr)
        self.assertFalse(os.path.exists(self.log))

    def test_accepts_eligible_repo_and_ignores_after_green(self):
        self.loop_md(**{"release-on-push": "no"})
        self.append(*self.LAND)
        self.assertEqual(self.events()[0]["mode"], "pre-green")
        self.loop_md(tier="guarded")
        self.append("land", "task=T2", "sha=abc", "gate=g", "mode=after-green")
        self.assertEqual(len(self.events()), 2)

    def test_log_outside_codex_dir_is_refused(self):
        self.loop_md()
        r = run("append", os.path.join(self.repo, "state.jsonl"), *self.LAND)
        self.assertEqual(r.returncode, 2)
        self.assertIn("codex", r.stderr)


class CheckTests(Base):
    def test_valid_log_passes(self):
        self.seed()
        self.assertEqual(run("check", self.log).returncode, 0)

    def write_lines(self, lines):
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    def test_first_error_is_reported_with_line(self):
        self.seed()
        with open(self.log, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        e = json.loads(lines[1])
        e["seq"] = 5
        lines[1] = json.dumps(e)
        lines[2] = "garbage"
        self.write_lines(lines)
        r = run("check", self.log)
        self.assertEqual(r.returncode, 1)
        self.assertIn("line 2", r.stderr)
        self.assertIn("seq 5 follows 1", r.stderr)
        self.assertNotIn("line 3", r.stderr)

    def test_schema_violation_in_log(self):
        self.write_lines([json.dumps({"v": 1, "seq": 1, "ts": "2026-10-03T00:00:00Z", "ev": "close", "by": "root"})])
        r = run("check", self.log)
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing required field reason", r.stderr)

    def test_bad_ts_and_by(self):
        base = {"v": 1, "seq": 1, "ts": "yesterday", "ev": "close", "by": "root", "reason": "budget"}
        self.write_lines([json.dumps(base)])
        self.assertIn("ts must be", run("check", self.log).stderr)
        base.update(ts="2026-10-03T00:00:00Z", by="me")
        self.write_lines([json.dumps(base)])
        self.assertIn("by must be", run("check", self.log).stderr)

    def test_missing_log(self):
        self.assertEqual(run("check", self.log).returncode, 1)

    def test_append_refuses_a_corrupt_tail(self):
        # A tail that is not a torn event (no newline, not even an object start) is foreign; refuse.
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("garbage")
        r = self.append("close", "reason=budget", ok=False)
        self.assertEqual(r.returncode, 2)
        self.assertIn("repair", r.stderr)
        # So is a complete last line that is not an event.
        with open(self.log, "w", encoding="utf-8") as fh:
            fh.write("garbage\n")
        self.assertEqual(self.append("close", "reason=budget", ok=False).returncode, 2)

    def test_a_torn_trailing_line_is_skipped_and_the_log_goes_on(self):
        self.seed()
        with open(self.log, "a", encoding="utf-8") as fh:
            fh.write('{"v":1,"seq":4,"ts":"2026-10-03T00:00:00Z","ev":"jud')
        r = self.append("judgement", "text=after the tear")
        self.assertIn("torn", r.stderr)
        self.assertEqual(r.stdout.strip(), "seq=4")
        with open(self.log, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        self.assertTrue(lines[3].endswith('"ev":"jud'), "the torn bytes stay where they were")
        self.assertEqual(json.loads(lines[4])["text"], "after the tear")
        self.append("close", "reason=budget")
        self.assertEqual(run("check", self.log).returncode, 0, run("check", self.log).stderr)
        self.assertIn("1 unreadable lines", run("digest", self.log).stdout)

    def test_an_unterminated_complete_last_event_is_kept(self):
        self.seed()
        with open(self.log, "rb") as fh:
            data = fh.read()
        with open(self.log, "wb") as fh:
            fh.write(data.rstrip(b"\n"))
        self.assertEqual(self.append("close", "reason=budget").stdout.strip(), "seq=4")
        self.assertEqual([e["seq"] for e in self.events()], [1, 2, 3, 4])
        self.assertEqual(run("check", self.log).returncode, 0)

    def test_check_still_fails_when_a_torn_line_hides_a_lost_event(self):
        self.seed()
        with open(self.log, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        lines[1] = lines[1][:20]
        self.write_lines(lines)
        r = run("check", self.log)
        self.assertEqual(r.returncode, 1)
        self.assertIn("line 3", r.stderr)


class DigestTests(Base):
    def digest(self, *extra):
        r = run("digest", self.log, *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_folds_task_state(self):
        self.seed()
        self.append("admit", "task=T3", "source=envelope", "owned=c", "accept=ok")
        self.append("admit", "task=T4", "source=envelope", "owned=d", "accept=ok")
        self.append("admit", "task=T5", "source=envelope", "owned=e", "accept=ok")
        self.append("dispatch", "lane=L1", "task=T1", "agent=lane-worker", "run=r1", "base=b", "deadline=2026-10-03T12:00:00Z")
        self.append("dispatch", "lane=L2", "task=T3", "agent=lane-worker", "run=r2", "base=b")
        self.append("return", "lane=L2", "run=r2", "status=complete", "sha=" + "c" * 40)
        self.append("accept", "task=T3", "accepted=true", "reason=ok")
        self.append("park", "task=T4", "reason=needs a human", "needs=owner")
        self.append("land", "task=T5", "sha=" + "d" * 40, "gate=g", "mode=after-green")
        text = self.digest()
        self.assertIn("goal " + "a" * 64, text)
        self.assertIn("tier routine", text)
        self.assertIn("## Live lanes (1)", text)
        self.assertIn("- L1 task T1 run r1 deadline 2026-10-03T12:00:00Z", text)
        self.assertIn("- T1: dispatched lane=L1 run=r1", text)
        self.assertIn("- T3: accepted", text)
        self.assertIn("- T4: parked needs=owner", text)
        self.assertIn("- T5: landed sha=" + "d" * 12, text)

        self.assertIn("## Admissible (1)\nT2", text)
        self.assertEqual(
            json.loads(self.digest("--json")),
            {"live_lanes": 1, "open_tasks": 2, "admissible": ["T2"], "parked": ["T4"]},
        )

    def test_landed_task_whose_run_failed_shows_its_status(self):
        self.seed()
        self.append("dispatch", "lane=L1", "task=T1", "agent=lane-worker", "run=r1", "base=b")
        self.append("return", "lane=L1", "run=r1", "status=failed", "landed=true", "sha=" + "e" * 40)
        text = self.digest()
        self.assertIn("- T1: landed:failed sha=" + "e" * 12, text)
        mod = load_cli()
        st = mod.fold(self.log)
        self.assertIn("- T1 landed:failed", mod.render_digest(st, [], 1))
        self.assertIn("- T1 landed:failed", mod.render_digest(st, [], 2), "a size-limited digest still shows it")
        self.assertNotIn("T1", self.digest("--json").split('"admissible"')[1].split("]")[0])

    def test_failed_return_and_rejection_make_a_task_admissible_again(self):
        self.seed()
        self.append("dispatch", "lane=L1", "task=T1", "agent=a", "run=r1", "base=b")
        self.append("return", "lane=L1", "run=r1", "status=failed")
        self.append("dispatch", "lane=L2", "task=T2", "agent=a", "run=r2", "base=b")
        self.append("return", "lane=L2", "run=r2", "status=complete")
        j = json.loads(self.digest("--json"))
        self.assertEqual(j["live_lanes"], 0)
        self.assertEqual(j["admissible"], ["T1"])
        self.append("accept", "task=T2", "accepted=false", "reason=wrong")
        self.assertEqual(json.loads(self.digest("--json"))["admissible"], ["T1", "T2"])

    def test_revert_reopens_a_landed_task(self):
        self.seed()
        self.append("land", "task=T1", "sha=" + "e" * 40, "gate=g", "mode=after-green")
        self.append("revert", "sha=" + "e" * 40, "reverted_by=" + "f" * 40, "reason=ci-red")
        text = self.digest()
        self.assertIn("- T1: reverted", text)
        self.assertEqual(json.loads(self.digest("--json"))["admissible"], ["T1", "T2"])

    def test_close_and_last_gate_shown(self):
        self.seed()
        self.append("gate", "scope=composed", "sha=" + "9" * 40, "cmd=c", "exit=1")
        self.append("close", "reason=blocked")
        text = self.digest()
        self.assertIn("closed: blocked", text)
        self.assertIn("last gate: composed " + "9" * 12 + " exit 1", text)

    def test_only_last_five_judgements(self):
        self.seed()
        for i in range(7):
            self.append("judgement", "text=judgement-number-%d" % i)
        text = self.digest()
        self.assertNotIn("judgement-number-1\n", text)
        for i in range(2, 7):
            self.assertIn("judgement-number-%d" % i, text)

    def test_truncation_drops_oldest_judgements_before_task_detail(self):
        self.append(*OPEN)
        for i in range(10):
            self.append("admit", "task=T%d" % i, "source=envelope", "owned=x", "accept=ok")
        for i in range(5):
            self.append("judgement", "text=" + ("%d" % i) * 390)
        full = self.digest()
        self.assertLessEqual(len(full.encode("utf-8")), 4096)
        self.assertIn("- T0: admitted", full)
        self.assertIn("4" * 100, full)
        # Add enough task detail that the judgements alone no longer fit.
        for i in range(10, 70):
            self.append("park", "task=T%d" % i, "reason=" + "r" * 200, "needs=defect")
        text = self.digest()
        self.assertLessEqual(len(text.encode("utf-8")), 4096)
        self.assertNotIn("0" * 100, text, "oldest judgement goes first")
        self.assertIn("## Admissible", text)
        self.assertIn("## Live lanes", text)

    def test_truncation_reduces_task_detail_last(self):
        self.append(*OPEN)
        for i in range(300):
            self.append("admit", "task=Task-number-%d" % i, "source=envelope", "owned=x", "accept=ok")
        text = self.digest()
        self.assertLessEqual(len(text.encode("utf-8")), 4096)
        self.assertIn("goal " + "a" * 64, text)
        self.assertIn("## Admissible (300)", text)

    def test_json_digest_on_empty_open_log(self):
        self.append(*OPEN)
        self.assertEqual(
            json.loads(self.digest("--json")),
            {"live_lanes": 0, "open_tasks": 0, "admissible": [], "parked": []},
        )

    def test_missing_log_exits_1(self):
        r = run("digest", self.log)
        self.assertEqual(r.returncode, 1)

    def test_a_gate_runner_dispatch_is_a_live_lane_not_a_task(self):
        self.seed()
        self.append("dispatch", "lane=L5", "task=T1,T2", "agent=gate-runner", "run=r5", "base=b")
        j = json.loads(self.digest("--json"))
        self.assertEqual(j["live_lanes"], 1)
        self.assertEqual(j["admissible"], ["T1", "T2"])
        self.append("return", "lane=L5", "run=r5", "status=failed", "exit=1")
        j = json.loads(self.digest("--json"))
        self.assertEqual(j, {"live_lanes": 0, "open_tasks": 2, "admissible": ["T1", "T2"], "parked": []})
        self.assertNotIn("T1,T2", self.digest())

    def test_a_gate_exit_may_be_null(self):
        self.seed()
        self.append("gate", "scope=composed", "sha=" + "9" * 40, "cmd=c", "exit=null")
        self.assertIsNone(self.events()[-1]["exit"])
        self.assertIn("exit null", self.digest())

    def test_digest_tolerates_a_bad_line(self):
        self.seed()
        with open(self.log, "a", encoding="utf-8") as fh:
            fh.write("garbage\n")
        text = self.digest()
        self.assertIn("1 unreadable lines", text)


if __name__ == "__main__":
    unittest.main()
