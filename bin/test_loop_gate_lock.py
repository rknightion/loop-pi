#!/usr/bin/env python3
"""Exercise the public gate CLI with real subprocesses in linked worktrees."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import hashlib
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

CLI = Path(__file__).resolve().with_name("loop-gate-lock")
loader = importlib.machinery.SourceFileLoader("gate_lock", str(CLI))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)


class GateLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="loop-gate-test-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.name_prefix = self.base.name + "-"
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.git("init", "-q", cwd=self.repo)
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture" + chr(64) + "example.invalid",
                 "commit", "-q", "--allow-empty", "-m", "fixture", cwd=self.repo)
        self.other = self.base / "worktree"
        self.git("worktree", "add", "-q", "--detach", str(self.other), cwd=self.repo)
        self.env = {**os.environ, "LOOP_PI_GATE_LOCK_DIR": str(self.base / "locks"),
                    "LOOP_PI_RUN_DIR": "root-only", "LOOP_PI_REPO": "root-only"}
        self.children = []
        self.addCleanup(self.stop_children)

    def git(self, *args, cwd):
        subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, timeout=10)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=10)

    def declare(self, repo, name, command):
        (repo / "LOOP.md").write_text(f"# Loop\n## Mutexes\n- ordinary prose: advisory\n- gate: {self.name_prefix + name} | {command}\n")

    def spawn(self, repo, name):
        child = subprocess.Popen([sys.executable, str(CLI), self.name_prefix + name], cwd=repo, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def wait_file(self, path):
        deadline = time.monotonic() + 10
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(path.exists(), f"child did not reach {path}")

    def fixture_command(self, tag, *, exit_code=0, ignore_term=False):
        script = self.base / f"gate-{tag}.py"
        script.write_text(
            "import json, os, signal, sys, time\n"
            + ("signal.signal(signal.SIGTERM, signal.SIG_IGN)\n" if ignore_term else "")
            + f"base = {str(self.base)!r}\n"
            + "from pathlib import Path\n"
            + f"Path(base + '/{tag}-started').write_text(json.dumps(dict(os.environ)))\n"
            + "deadline = time.monotonic() + 15\n"
            + f"while not Path(base + '/{tag}-finish').exists() and time.monotonic() < deadline: time.sleep(0.01)\n"
            + f"sys.exit({exit_code})\n")
        return f"exec {shlex.quote(sys.executable)} {shlex.quote(str(script))}"

    def test_same_name_serializes_worktrees_and_failure_releases(self):
        self.declare(self.repo, "shared-heavy", self.fixture_command("first", exit_code=23))
        self.declare(self.other, "shared-heavy", self.fixture_command("second"))
        first = self.spawn(self.repo, "shared-heavy")
        self.wait_file(self.base / "first-started")
        second = self.spawn(self.other, "shared-heavy")
        time.sleep(0.3)
        self.assertFalse((self.base / "second-started").exists(), "same-name gates overlapped")
        (self.base / "first-finish").touch()
        out, err = first.communicate(timeout=10)
        self.assertEqual(first.returncode, 23, out + err)
        self.wait_file(self.base / "second-started")
        env = json.loads((self.base / "second-started").read_text())
        self.assertNotIn("LOOP_PI_RUN_DIR", env)
        self.assertNotIn("LOOP_PI_REPO", env)
        (self.base / "second-finish").touch()
        out, err = second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0, out + err)
        lock_path = m.account_lock_directory() / (hashlib.sha256((self.name_prefix + "shared-heavy").encode()).hexdigest() + ".lock")
        self.assertTrue(lock_path.is_file())
        self.assertFalse((self.base / "locks").exists(), "caller lock override was used")

    def test_caller_environment_cannot_split_lock_domain(self):
        self.declare(self.repo, "environment-domain", self.fixture_command("first"))
        self.declare(self.other, "environment-domain", self.fixture_command("second"))
        self.env.update(HOME=str(self.base / "home-first"), TMPDIR=str(self.base / "tmp-first"),
                        LOOP_PI_GATE_LOCK_DIR=str(self.base / "locks-first"))
        first = self.spawn(self.repo, "environment-domain")
        self.wait_file(self.base / "first-started")
        self.env.update(HOME=str(self.base / "home-second"), TMPDIR=str(self.base / "tmp-second"),
                        LOOP_PI_GATE_LOCK_DIR=str(self.base / "locks-second"))
        second = self.spawn(self.other, "environment-domain")
        time.sleep(0.3)
        self.assertFalse((self.base / "second-started").exists(), "caller environment split the production domain")
        (self.base / "first-finish").touch()
        first.communicate(timeout=10)
        self.wait_file(self.base / "second-started")
        (self.base / "second-finish").touch()
        second.communicate(timeout=10)
        self.assertEqual([first.returncode, second.returncode], [0, 0])

    def test_different_names_run_concurrently(self):
        for repo, tag in ((self.repo, "first"), (self.other, "second")):
            self.declare(repo, tag, self.fixture_command(tag))
            self.spawn(repo, tag)
        for tag in ("first", "second"):
            self.wait_file(self.base / f"{tag}-started")
        for tag in ("first", "second"):
            (self.base / f"{tag}-finish").touch()
        for child in self.children:
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, out + err)

    def test_signal_forwarding_keeps_lock_until_child_exits(self):
        self.declare(self.repo, "shared-heavy", self.fixture_command("first", ignore_term=True))
        self.declare(self.other, "shared-heavy", self.fixture_command("second"))
        first = self.spawn(self.repo, "shared-heavy")
        self.wait_file(self.base / "first-started")
        first.send_signal(signal.SIGTERM)
        second = self.spawn(self.other, "shared-heavy")
        time.sleep(0.3)
        self.assertIsNone(first.poll(), "supervisor exited before child finished")
        self.assertFalse((self.base / "second-started").exists(), "termination released lock early")
        (self.base / "first-finish").touch()
        first.communicate(timeout=10)
        self.assertEqual(first.returncode, 0)
        self.wait_file(self.base / "second-started")
        (self.base / "second-finish").touch()
        second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0)

    def test_child_signal_is_preserved(self):
        code = "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"
        command = f"exec {shlex.quote(sys.executable)} -c {shlex.quote(code)}"
        self.declare(self.repo, "signal-test", command)
        child = self.spawn(self.repo, "signal-test")
        child.communicate(timeout=10)
        self.assertEqual(child.returncode, -signal.SIGTERM)
        self.declare(self.repo, "signal-test", "exit 0")
        child = self.spawn(self.repo, "signal-test")
        child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0)

    def test_undeclared_name_does_not_execute_prose(self):
        (self.repo / "LOOP.md").write_text("## Mutexes\n- heavy: exit 0\n")
        child = self.spawn(self.repo, "heavy")
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 78, out + err)
        self.assertIn("not declared", err)


class LockPathSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gate-path-safety-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.patch = patch.object(m.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(self.home)))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.directory = self.home / ".local/state/loop-pi/gate-locks"
        self.directory.mkdir(parents=True, mode=0o700)
        self.filename = self.directory / (hashlib.sha256(b"safety").hexdigest() + ".lock")

    def test_private_regular_account_owned_path_is_accepted(self):
        fd = m.open_lock("safety")
        os.close(fd)
        self.assertEqual(self.filename.stat().st_mode & 0o777, 0o600)

    def test_symlink_parent_is_refused(self):
        self.directory.rmdir()
        self.directory.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(OSError):
            m.open_lock("safety")

    def test_unsafe_directory_permissions_are_refused(self):
        for directory, mode in ((self.directory, 0o755), (self.home / ".local", 0o777)):
            original = directory.stat().st_mode & 0o777
            directory.chmod(mode)
            try:
                with self.assertRaisesRegex(ValueError, "unsafe gate lock directory"):
                    m.open_lock("safety")
            finally:
                directory.chmod(original)

    def test_symlink_hardlink_fifo_and_unsafe_file_mode_are_refused(self):
        target = self.home / "sentinel"
        target.write_text("untouched")
        self.filename.symlink_to(target)
        with self.assertRaises(OSError):
            m.open_lock("safety")
        self.filename.unlink()
        target.chmod(0o600)
        os.link(target, self.filename)
        with self.assertRaisesRegex(ValueError, "links"):
            m.open_lock("safety")
        self.filename.unlink()
        os.mkfifo(self.filename, 0o600)
        with self.assertRaisesRegex(ValueError, "unsafe gate lock file"):
            m.open_lock("safety")
        self.filename.unlink()
        self.filename.touch(mode=0o600)
        self.filename.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "permissions"):
            m.open_lock("safety")
        self.assertEqual(target.read_text(), "untouched")

    def test_wrong_owner_is_refused(self):
        with patch.object(m.os, "fstat", return_value=SimpleNamespace(st_mode=0o40700, st_uid=os.getuid() + 1)):
            with self.assertRaisesRegex(ValueError, "owner"):
                m.validate_directory(0, account_owned=True)


class GrammarTests(unittest.TestCase):
    def test_only_explicit_unfenced_mutex_entries(self):
        text = "- gate: outside | false\n## Mutexes\n- plain prose\n```\n- gate: example | false\n```\n- gate: heavy | printf hello | wc -c\n### Detail\n- gate: other | true\n## End\n- gate: outside | false\n"
        self.assertEqual(m.parse_gates(text), {"heavy": "printf hello | wc -c", "other": "true"})

    def test_malformed_or_duplicate_entries_fail_closed(self):
        for entries in ("- gate: broken", "- gate: unsafe/name | true", "- gate: empty | ",
                        "- gate: a | true\n- gate: a | false", "- gate: a | true\n- gate: b | true"):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                m.parse_gates("## Mutexes\n" + entries)


if __name__ == "__main__":
    unittest.main()
