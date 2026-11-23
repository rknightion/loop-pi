#!/usr/bin/env python3
"""Tests for the Python 3.15 floor: the re-run block in the bin entry points and the git hooks'
interpreter choice. Stdlib unittest, runnable as `python3 -m unittest bin.test_python_floor` from
the repo root. The older interpreter is simulated by patching `sys.version_info` in a child
process, and the interpreters on offer are stub scripts on a scratch PATH."""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENTRY_POINTS = ("loop-gate-lock", "loop-pi-audit", "loop-pi-install", "loop-pi-preflight", "loop-state", "leak-terms-hash")
HOOKS = (("pre-commit", []), ("commit-msg", ["message-file"]), ("pre-push", []))
HOMEBREW = ("/opt/homebrew/bin/python3.15", "/home/linuxbrew/.linuxbrew/bin/python3.15")
BLOCK = re.compile(r"^# python-floor: begin.*?^# python-floor: end$", re.S | re.M)

# Runs a bin script as __main__ in an interpreter that reports itself as 3.14.
DRIVER = (
    "import runpy, sys\n"
    "sys.version_info = (3, 14, 0, 'final', 0)\n"
    "sys.version = '3.14.0 (simulated)'\n"
    "script = sys.argv[1]\n"
    "sys.argv = [script, '--probe']\n"
    "runpy.run_path(script, run_name='__main__')\n"
)


def stub(directory, name, body):
    path = os.path.join(directory, name)
    with open(path, "w") as handle:
        handle.write("#!/bin/sh\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


ECHO_NAME = 'printf "%s" "${0##*/}"; for a in "$@"; do printf " %s" "$a"; done; echo\n'


class EntryPointBlock(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(HERE, name)) as handle:
            return handle.read()

    def test_every_entry_point_carries_the_same_block(self):
        blocks = {name: BLOCK.findall(self.read(name)) for name in ENTRY_POINTS}
        for name, found in blocks.items():
            self.assertEqual(len(found), 1, name)
        self.assertEqual(len({found[0] for found in blocks.values()}), 1, "blocks differ between entry points")
        self.assertIn("(3, 15)", blocks[ENTRY_POINTS[0]][0])

    def test_leak_scan_stays_version_agnostic(self):
        # The git hooks run it; refusing on an older python would refuse commits on that host.
        self.assertNotIn("python-floor", self.read("leak-scan"))

    def run_older(self, script, path_dir):
        env = {"PATH": path_dir, "HOME": path_dir}
        return subprocess.run([sys.executable, "-I", "-c", DRIVER, os.path.join(HERE, script)],
                              capture_output=True, text=True, env=env, timeout=60)

    def test_reruns_under_python_3_15_on_path(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                stub(tmp, "python3.15", ECHO_NAME)
                result = self.run_older(name, tmp)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), f"python3.15 {os.path.join(HERE, name)} --probe")

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_falls_back_to_uv_then_refuses_with_instructions(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                result = self.run_older(name, tmp)
                self.assertEqual(result.returncode, 1)
                self.assertIn("needs Python 3.15 or later and found 3.14.0", result.stderr)
                self.assertIn("uv python install 3.15", result.stderr)
                stub(tmp, "uv", ECHO_NAME)
                result = self.run_older(name, tmp)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(),
                                 f"uv run --no-project --python 3.15 python {os.path.join(HERE, name)} --probe")


class GitHooks(unittest.TestCase):
    def run_hook(self, hook, args, tmp, stubs):
        repo = os.path.join(tmp, "repo")
        if not os.path.isdir(repo):
            subprocess.run(["git", "init", "-q", repo], check=True)
        bin_dir = os.path.join(tmp, "stubs")
        os.makedirs(bin_dir, exist_ok=True)
        for name, body in stubs.items():
            stub(bin_dir, name, body)
        path = os.pathsep.join([bin_dir, os.path.dirname(shutil.which("git")), "/usr/bin", "/bin"])
        system = os.pathsep.join(path.split(os.pathsep)[1:])
        if shutil.which("python3.15", path=system):
            self.skipTest("a python3.15 is installed outside the scratch PATH")
        if "uv" not in stubs and shutil.which("uv", path=system):
            self.skipTest("a uv is installed outside the scratch PATH")
        return subprocess.run(["sh", os.path.join(ROOT, "hooks", hook), *args], cwd=repo, capture_output=True,
                              text=True, env={"PATH": path, "HOME": tmp}, timeout=60)

    def expected_tail(self, hook, args):
        return {"pre-commit": " --staged", "commit-msg": " --message " + (args[0] if args else ""),
                "pre-push": " --history"}[hook]

    def test_prefers_python_3_15(self):
        for hook, args in HOOKS:
            with self.subTest(hook), tempfile.TemporaryDirectory() as tmp:
                result = self.run_hook(hook, args, tmp, {"python3.15": ECHO_NAME, "python3": ECHO_NAME})
                self.assertEqual(result.returncode, 0, result.stderr)
                line = result.stdout.strip()
                self.assertTrue(line.startswith("python3.15 ") and "/bin/leak-scan" in line, line)
                self.assertTrue(line.endswith(self.expected_tail(hook, args).rstrip()), line)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_uses_a_python_3_15_uv_already_has(self):
        for hook, args in HOOKS:
            with self.subTest(hook), tempfile.TemporaryDirectory() as tmp:
                found = os.path.join(tmp, "stubs", "uv-managed-python")
                result = self.run_hook(hook, args, tmp, {
                    "uv": 'case "$*" in "python find --no-python-downloads 3.15") echo ' + found + " ;; *) exit 9 ;; esac\n",
                    "uv-managed-python": ECHO_NAME,
                    "python3": ECHO_NAME,
                })
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith("uv-managed-python "), result.stdout)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_without_python_3_15_runs_the_scan_on_python3_and_does_not_refuse(self):
        for hook, args in HOOKS:
            with self.subTest(hook), tempfile.TemporaryDirectory() as tmp:
                result = self.run_hook(hook, args, tmp, {"python3": ECHO_NAME})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith("python3 "), result.stdout)
                self.assertTrue(result.stdout.strip().endswith(self.expected_tail(hook, args).rstrip()), result.stdout)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_uv_that_finds_nothing_falls_through_to_python3(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_hook("pre-commit", [], tmp, {"uv": "exit 2\n", "python3": ECHO_NAME})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result.stdout.startswith("python3 "), result.stdout)


if __name__ == "__main__":
    unittest.main()
