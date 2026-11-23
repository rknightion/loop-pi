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
# Also reports the directory it was started in.
ECHO_CWD = 'printf "%s %s" "${0##*/}" "$(pwd -P)"; for a in "$@"; do printf " %s" "$a"; done; echo\n'
# A uv that behaves like the real one when asked from a hostile directory: it would hand back that
# directory's .venv python (or VIRTUAL_ENV's) if it were ever started there or given that environment.
UV_STUB = (
    'args="$*"\n'
    'if [ "${1:-}" = "--directory" ]; then cd "$2"; shift 2; elif [ -n "${UV_WORKING_DIR:-}" ]; then cd "$UV_WORKING_DIR"; fi\n'
    'echo "$PWD|VIRTUAL_ENV=${VIRTUAL_ENV-unset}|$args" >> "$UV_LOG"\n'
    'case "$2" in\n'
    'find)\n'
    '  if [ -n "${HOSTILE_PYTHON:-}" ]; then echo "$HOSTILE_PYTHON"\n'
    '  elif [ -n "${VIRTUAL_ENV:-}" ]; then echo "$VIRTUAL_ENV/bin/python"\n'
    '  elif [ -x ./.venv/bin/python ]; then echo "$PWD/.venv/bin/python"\n'
    '  elif [ -n "${NEED_INSTALL:-}" ] && [ ! -e "$NEED_INSTALL" ]; then exit 2\n'
    '  else echo "$STUB_PYTHON"; fi ;;\n'
    'install) if [ -n "${NEED_INSTALL:-}" ]; then : > "$NEED_INSTALL"; fi ;;\n'
    'esac\n'
)
FIND_ARGS = "--directory / python find --no-project --no-config --no-python-downloads 3.15"


def hostile_directory(directory, marker):
    """A repository directory that would run a marker-writing python if anything used its .venv."""
    os.makedirs(os.path.join(directory, ".venv", "bin"), exist_ok=True)
    with open(os.path.join(directory, ".venv", "pyvenv.cfg"), "w") as handle:
        handle.write("home = /nowhere\n")
    with open(os.path.join(directory, "uv.toml"), "w") as handle:
        handle.write("this is [not valid toml\n")
    stub(os.path.join(directory, ".venv", "bin"), "python", f'echo hostile > "{marker}"\n')


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

    def run_older(self, script, path_dir, cwd=None, extra=None):
        env = {"PATH": path_dir, "HOME": path_dir, **(extra or {})}
        return subprocess.run([sys.executable, "-I", "-c", DRIVER, os.path.join(HERE, script)],
                              capture_output=True, text=True, env=env, cwd=cwd, timeout=60)

    def test_reruns_under_python_3_15_on_path(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                stub(tmp, "python3.15", ECHO_NAME)
                result = self.run_older(name, tmp)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), f"python3.15 {os.path.join(HERE, name)} --probe")

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_refuses_with_instructions_when_nothing_provides_3_15(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                result = self.run_older(name, tmp)
                self.assertEqual(result.returncode, 1)
                self.assertIn("needs Python 3.15 or later and found 3.14.0", result.stderr)
                self.assertIn("uv python install 3.15", result.stderr)

    def uv_setup(self, tmp, **extra):
        bin_dir = os.path.join(tmp, "bin")
        os.makedirs(bin_dir)
        stub(bin_dir, "uv", UV_STUB)
        os.makedirs(os.path.join(tmp, "good"))
        good = stub(os.path.join(tmp, "good"), "py315", ECHO_CWD)
        log = os.path.join(tmp, "uv.log")
        return bin_dir, log, {"UV_LOG": log, "STUB_PYTHON": good, **extra}

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_uv_only_resolves_from_a_neutral_directory_then_the_tool_keeps_the_callers_cwd(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                caller = os.path.join(tmp, "caller")
                os.makedirs(caller)
                bin_dir, log, extra = self.uv_setup(tmp)
                result = self.run_older(name, bin_dir, cwd=caller, extra=extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), f"py315 {os.path.realpath(caller)} {os.path.join(HERE, name)} --probe")
                with open(log) as handle:
                    self.assertEqual(handle.read().splitlines(), ["/|VIRTUAL_ENV=|" + FIND_ARGS])

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_installs_a_managed_3_15_with_config_off_when_none_is_found(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                bin_dir, log, extra = self.uv_setup(tmp, NEED_INSTALL=os.path.join(tmp, "installed"))
                result = self.run_older(name, bin_dir, cwd=tmp, extra=extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith("py315 "), result.stdout)
                with open(log) as handle:
                    self.assertEqual(handle.read().splitlines(), [
                        "/|VIRTUAL_ENV=|" + FIND_ARGS,
                        "/|VIRTUAL_ENV=|--directory / python install --no-config 3.15",
                        "/|VIRTUAL_ENV=|" + FIND_ARGS,
                    ])

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_hostile_working_directory_and_virtual_env_never_run(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                hostile = os.path.join(tmp, "hostile")
                marker = os.path.join(tmp, "marker")
                hostile_directory(hostile, marker)
                bin_dir, log, extra = self.uv_setup(tmp, VIRTUAL_ENV=os.path.join(hostile, ".venv"))
                result = self.run_older(name, bin_dir, cwd=hostile, extra=extra)
                self.assertFalse(os.path.exists(marker), "the hostile .venv python ran")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), f"py315 {os.path.realpath(hostile)} {os.path.join(HERE, name)} --probe")

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_hostile_uv_working_dir_cannot_move_uv_out_of_the_neutral_directory(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                hostile = os.path.join(tmp, "hostile")
                marker = os.path.join(tmp, "marker")
                hostile_directory(hostile, marker)
                bin_dir, log, extra = self.uv_setup(tmp, UV_WORKING_DIR=hostile)
                result = self.run_older(name, bin_dir, cwd=hostile, extra=extra)
                self.assertFalse(os.path.exists(marker), "the hostile .venv python ran")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith("py315 "), result.stdout)
                with open(log) as handle:
                    self.assertEqual(handle.read().splitlines(), ["/|VIRTUAL_ENV=|" + FIND_ARGS])

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_dot_or_empty_path_entry_never_runs_a_file_from_the_callers_directory(self):
        for name in ENTRY_POINTS:
            for entry in (".", ""):
                for template in ("{e}:{d}", "{d}:{e}", "{d}:{e}:{d}"):
                    with self.subTest(name=name, entry=entry, template=template), tempfile.TemporaryDirectory() as tmp:
                        hostile = os.path.join(tmp, "hostile")
                        os.makedirs(hostile)
                        marker = os.path.join(tmp, "marker")
                        for tool in ("python3.15", "uv"):
                            stub(hostile, tool, f'echo hostile > "{marker}"\n')
                        empty = os.path.join(tmp, "empty")
                        os.makedirs(empty)
                        path = template.format(e=entry, d=empty)
                        result = self.run_older(name, path, cwd=hostile)
                        self.assertFalse(os.path.exists(marker), "a file from the caller's directory ran")
                        self.assertEqual(result.returncode, 1, result.stderr)
                        self.assertIn("needs Python 3.15 or later", result.stderr)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_an_interpreter_inside_a_dot_venv_is_refused_even_if_uv_names_it(self):
        for name in ENTRY_POINTS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                hostile = os.path.join(tmp, "hostile")
                marker = os.path.join(tmp, "marker")
                hostile_directory(hostile, marker)
                bin_dir, log, extra = self.uv_setup(tmp, HOSTILE_PYTHON=os.path.join(hostile, ".venv", "bin", "python"))
                result = self.run_older(name, bin_dir, cwd=hostile, extra=extra)
                self.assertFalse(os.path.exists(marker), "the hostile .venv python ran")
                self.assertEqual(result.returncode, 1)
                self.assertIn("needs Python 3.15 or later", result.stderr)


class GitHooks(unittest.TestCase):
    def run_hook(self, hook, args, tmp, stubs, extra=None, path_entry=None, only_git=False):
        repo = os.path.join(tmp, "repo")
        if not os.path.isdir(os.path.join(repo, ".git")):
            subprocess.run(["git", "init", "-q", repo], check=True)
        bin_dir = os.path.join(tmp, "stubs")
        os.makedirs(bin_dir, exist_ok=True)
        for name, body in stubs.items():
            stub(bin_dir, name, body)
        path = os.pathsep.join([bin_dir, os.path.dirname(shutil.which("git")), "/usr/bin", "/bin"])
        if only_git:  # nothing else on PATH, so no python3 anywhere
            git_dir = os.path.join(tmp, "git-only")
            os.makedirs(git_dir)
            os.symlink(shutil.which("git"), os.path.join(git_dir, "git"))
            path = os.pathsep.join([bin_dir, git_dir])
        system = os.pathsep.join(path.split(os.pathsep)[1:])
        if shutil.which("python3.15", path=system):
            self.skipTest("a python3.15 is installed outside the scratch PATH")
        if "uv" not in stubs and shutil.which("uv", path=system):
            self.skipTest("a uv is installed outside the scratch PATH")
        if path_entry is not None:
            path = path_entry + os.pathsep + path
        return subprocess.run(["/bin/sh", os.path.join(ROOT, "hooks", hook), *args], cwd=repo, capture_output=True,
                              text=True, env={"PATH": path, "HOME": tmp, **(extra or {})}, timeout=60)

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
                    "uv": 'case "$*" in "' + FIND_ARGS + '") echo ' + found + " ;; *) exit 9 ;; esac\n",
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
    def test_a_hostile_repository_never_steers_uv_or_runs(self):
        for hook, args in HOOKS:
            for hostile_path in (False, True):
                with self.subTest(hook=hook, uv_names_the_venv=hostile_path), tempfile.TemporaryDirectory() as tmp:
                    repo = os.path.join(tmp, "repo")
                    marker = os.path.join(tmp, "marker")
                    hostile_directory(repo, marker)
                    extra = {"UV_LOG": os.path.join(tmp, "uv.log"), "STUB_PYTHON": os.path.join(tmp, "stubs", "py315"),
                             "VIRTUAL_ENV": os.path.join(repo, ".venv")}
                    if hostile_path:
                        extra["HOSTILE_PYTHON"] = os.path.join(repo, ".venv", "bin", "python")
                    result = self.run_hook(hook, args, tmp, {"uv": UV_STUB, "py315": ECHO_CWD, "python3": ECHO_NAME}, extra)
                    self.assertFalse(os.path.exists(marker), "the hostile .venv python ran")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    # A refused .venv path falls through to python3: the scan still runs.
                    self.assertTrue(result.stdout.startswith("python3 " if hostile_path else "py315 "), result.stdout)
                    with open(extra["UV_LOG"]) as handle:
                        self.assertEqual(handle.read().splitlines(), ["/|VIRTUAL_ENV=|" + FIND_ARGS])

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_hostile_uv_working_dir_cannot_move_uv_out_of_the_neutral_directory(self):
        for hook, args in HOOKS:
            with self.subTest(hook), tempfile.TemporaryDirectory() as tmp:
                repo = os.path.join(tmp, "repo")
                marker = os.path.join(tmp, "marker")
                hostile_directory(repo, marker)
                extra = {"UV_LOG": os.path.join(tmp, "uv.log"), "STUB_PYTHON": os.path.join(tmp, "stubs", "py315"),
                         "UV_WORKING_DIR": repo}
                result = self.run_hook(hook, args, tmp, {"uv": UV_STUB, "py315": ECHO_CWD, "python3": ECHO_NAME}, extra)
                self.assertFalse(os.path.exists(marker), "the hostile .venv python ran")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.startswith("py315 "), result.stdout)
                with open(extra["UV_LOG"]) as handle:
                    self.assertEqual(handle.read().splitlines(), ["/|VIRTUAL_ENV=|" + FIND_ARGS])

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_dot_or_empty_path_entry_never_runs_a_file_from_the_repository(self):
        for hook, args in HOOKS:
            for entry in (".", ""):
                with self.subTest(hook=hook, entry=entry), tempfile.TemporaryDirectory() as tmp:
                    repo = os.path.join(tmp, "repo")
                    marker = os.path.join(tmp, "marker")
                    os.makedirs(repo)
                    for tool in ("python3.15", "python3", "uv"):
                        stub(repo, tool, f'echo hostile > "{marker}"\n')
                    result = self.run_hook(hook, args, tmp, {"python3": ECHO_NAME}, path_entry=entry)
                    self.assertFalse(os.path.exists(marker), "a file from the repository ran")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(result.stdout.startswith("python3 "), result.stdout)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_without_any_absolute_python3_the_hook_stops_instead_of_running_one_from_the_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = os.path.join(tmp, "repo")
            marker = os.path.join(tmp, "marker")
            os.makedirs(repo)
            stub(repo, "python3", f'echo hostile > "{marker}"\n')
            result = self.run_hook("pre-commit", [], tmp, {}, path_entry=".", only_git=True)
            self.assertFalse(os.path.exists(marker), "a file from the repository ran")
            self.assertEqual(result.returncode, 1)
            self.assertIn("cannot scan", result.stderr)

    @unittest.skipIf(any(os.access(path, os.X_OK) for path in HOMEBREW), "a Homebrew python3.15 is installed")
    def test_a_uv_that_finds_nothing_falls_through_to_python3(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_hook("pre-commit", [], tmp, {"uv": "exit 2\n", "python3": ECHO_NAME})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result.stdout.startswith("python3 "), result.stdout)


if __name__ == "__main__":
    unittest.main()
