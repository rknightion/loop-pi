#!/usr/bin/env python3
"""Tests for loop-pi-install. Stdlib unittest, runnable as
`python3 -m unittest bin.test_loop_pi_install -v` from the loop-pi source root."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader("loop_pi_install", str(HERE / "loop-pi-install"))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)


def fake_prefix(tmp: Path, missing=(), settings=None) -> Path:
    prefix = tmp / "data" / "0.87.1-abc"
    (prefix / "home/scripts").mkdir(parents=True)
    (prefix / "home/settings.json").write_text(json.dumps(settings) if settings is not None else
                                               '{"packages": ["{{PREFIX}}/node_modules/pi-subagents"], "h": "{{HOME}}"}')
    (prefix / "home/scripts/backlog-guard.py").write_text("#!/usr/bin/env python3\n")
    (prefix / "bin").mkdir()
    for name in m.CLI_TOOLS:
        (prefix / "bin" / name).write_text("#!/usr/bin/env python3\n")
    manifest = {"label": "0.87.1-abc", "missing_extensions": list(missing)}
    (prefix / m.BUILD_MANIFEST).write_text(json.dumps(manifest))
    return prefix


def target(tmp: Path, name: str = ".loop-pi-demo", **kwargs) -> "m.Target":
    return m.Target(tmp / name, tmp / "bin", kwargs.pop("launcher", "loop-pi"), **kwargs)


def apply(prefix: Path, tgt, node: str = "/usr/bin/node") -> None:
    for path, data, mode in m.drift(prefix, tgt, node):
        m.atomic_write(path, data, mode)


class NopushTests(unittest.TestCase):
    def test_wrapper_denies_all_network_push_protocols_but_keeps_local_git(self):
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-nopush-test-") as temporary:
            root = Path(temporary)
            env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
            env.update(HOME=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            def git(*args, wrapped=False):
                command = ([str(HERE / "loop-pi-nopush")] if wrapped else []) + ["git", *args]
                return subprocess.run(command, cwd=root, env=env, text=True,
                                      capture_output=True, timeout=15)
            def ok(*args, **kwargs):
                result = git(*args, **kwargs)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result.stdout.strip()
            ok("init", "-b", "main")
            ok("config", "user.name", "export")
            ok("config", "user.email", "export@example.com")
            ok("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
            for url in ("https://127.0.0.1:9/canary.git", "http://127.0.0.1:9/canary.git",
                        "ssh://127.0.0.1:9/canary.git", "git@127.0.0.1:canary.git",
                        "git://127.0.0.1:9/canary.git"):
                with self.subTest(url=url):
                    ok("remote", "add", "origin", url)
                    for destination in ("origin", url):
                        result = git("push", destination, "HEAD:refs/heads/main", wrapped=True)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("remote-loop-pi-push-denied", result.stderr)
                        self.assertNotIn("loop-guard", result.stderr)
                    ok("remote", "remove", "origin")
            remote = root / "remote.git"
            ok("init", "--bare", str(remote))
            ok("remote", "add", "local", str(remote))
            ok("push", "local", "main", wrapped=True)
            ok("fetch", "local", wrapped=True)
            self.assertEqual(ok("--git-dir", str(remote), "rev-parse", "main"), ok("rev-parse", "HEAD"))
            # Exec preserves arguments, exit status, and disables prompts; no shell string joining.
            result = subprocess.run([str(HERE / "loop-pi-nopush"), sys.executable, "-c",
                                     "import os,sys; assert os.environ['GIT_TERMINAL_PROMPT']=='0'; "
                                     "assert sys.argv[1:]==['a b', ';']; sys.exit(23)", "a b", ";"],
                                    env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 23, result.stderr)

    def test_wrapper_records_this_machines_boot_id_in_the_runner_config(self):
        import shutil
        import sys
        node = shutil.which("node")
        self.assertIsNotNone(node, "node is required to run the wrapper's config step")
        boot_module = (HERE.parent / "node_modules/pi-subagents/src/runs/background/boot-id.js").as_uri()
        expected = subprocess.run([node, "--input-type=module", "-e",
                                   f"import {{ currentBootId }} from {json.dumps(boot_module)};"
                                   " process.stdout.write(currentBootId() ?? '')"],
                                  capture_output=True, text=True, timeout=15, check=True).stdout
        self.assertTrue(expected, "pi-subagents reads a boot id on this platform")
        reader = "const fs=require('node:fs'); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))))"
        with tempfile.TemporaryDirectory(prefix="loop-pi-nopush-boot-") as temporary:
            root = Path(temporary)
            def run(config_name, payload, *, link=False):
                config = root / config_name
                if link:
                    target = root / "target.json"
                    target.write_text(payload)
                    config.symlink_to(target)
                else:
                    config.write_text(payload)
                    os.chmod(config, 0o600)
                result = subprocess.run([str(HERE / "loop-pi-nopush"), node, "-e", reader, str(config)],
                                        capture_output=True, text=True, timeout=15)
                return config, result
            config, result = run("async-cfg-abc.json", '{"id":"run-1","asyncDir":"/x"}')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"id": "run-1", "asyncDir": "/x", "bootId": expected})
            self.assertEqual(config.stat().st_mode & 0o777, 0o600, "the private config stays private")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["async-cfg-abc.json"], "no temporary file is left")
            _, result = run("async-cfg-keep.json", '{"id":"run-2","bootId":"recorded"}')
            self.assertEqual(json.loads(result.stdout)["bootId"], "recorded", "an existing boot id is never replaced")
            _, result = run("other.json", '{"id":"run-3"}')
            self.assertNotIn("bootId", json.loads(result.stdout), "only a pi-subagents runner config is touched")
            _, result = run("async-cfg-linked.json", '{"id":"run-4"}', link=True)
            self.assertNotIn("bootId", json.loads(result.stdout), "a symlinked config is left alone")
            # A config the step cannot parse still launches, with the runner's own exit status.
            bad = root / "async-cfg-bad.json"
            bad.write_text("{not json")
            result = subprocess.run([str(HERE / "loop-pi-nopush"), node, "-e", "process.exit(23)", str(bad)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 23, result.stderr)
            self.assertEqual(bad.read_text(), "{not json")
            if sys.platform == "darwin":
                # A failed replace leaves the config as it was and no temporary file behind.
                locked = root / "async-cfg-locked.json"
                locked.write_text('{"id":"run-5"}')
                subprocess.run(["chflags", "uchg", str(locked)], check=True, timeout=15)
                try:
                    result = subprocess.run([str(HERE / "loop-pi-nopush"), node, "-e", reader, str(locked)],
                                            capture_output=True, text=True, timeout=15)
                finally:
                    subprocess.run(["chflags", "nouchg", str(locked)], check=True, timeout=15)
                self.assertEqual(json.loads(result.stdout), {"id": "run-5"})
                self.assertEqual([p.name for p in root.iterdir() if p.name.endswith(".tmp")], [])

    def test_installed_wrapper_config_agent_set_and_drift_in_subprocess(self):
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-nopush-install-") as temporary:
            root = Path(temporary).resolve()
            env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
            env.update(HOME=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            (root / "sentinel").write_text("untouched")
            # Prebuild only the file-copy part in a fenced subprocess. The full candidate canary
            # separately drives npm ci, validation and the native runner on a scratch install.
            driver = '''
import importlib.machinery, importlib.util, json, shutil, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
files = m.source_files(); label = m.build_label(files, m.pins(), "the loop-pi home templates\\0loop-pi-install")
prefix = Path.home() / "data" / label
for rel, source in files:
    destination = prefix / rel; destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
m.render_policy(prefix, "the loop-pi home templates")
(prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
'''
            result = subprocess.run([sys.executable, "-c", driver, str(HERE / "loop-pi-install")],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            home = root / "pi"
            args = [sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(root),
                    "--home", str(home), "--data", str(root / "data"), "--bin", str(root / "bin"),
                    "--launcher", "loop-pi-test"]
            def install(*extra, expected=0):
                result = subprocess.run([*args, *extra], env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            install()
            wrapper = home / "bin/loop-pi-nopush"
            self.assertEqual(wrapper.read_bytes(), (HERE / "loop-pi-nopush").read_bytes())
            self.assertEqual(wrapper.stat().st_mode & 0o777, 0o755)
            receipt = json.loads((home / m.HOME_MANIFEST).read_text())
            self.assertIn("bin/loop-pi-nopush", receipt["files"])
            config = json.loads((home / "extensions/subagent/config.json").read_text())
            self.assertEqual(config["runnerLaunchers"], {"nopush": [str(wrapper)]})
            for path in (home / "agents").glob("*.md"):
                front = path.read_text().split("---", 2)[1].splitlines()
                # No push twins exist: every lane agent runs behind the wrapper, and none grants a push.
                self.assertFalse(path.stem.endswith("-push"), path.name)
                self.assertIn("launcher: nopush", front, path.name)
            install("--check")
            wrapper.write_text("drift\n")
            self.assertIn(str(wrapper), install("--check", expected=1).stdout)
            install()
            wrapper.chmod(0o644)
            self.assertIn(str(wrapper), install("--check", expected=1).stdout)
            install()
            install("--check")
            install("--bin", str(root.parent / "outside"), expected=2)
            self.assertEqual((root / "sentinel").read_text(), "untouched")


class AgentRetirementTests(unittest.TestCase):
    """Installing moves agent files the build no longer ships into a backup inside the home."""

    PREBUILD = '''
import importlib.machinery, importlib.util, json, shutil, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
files = m.source_files(); label = m.build_label(files, m.pins(), "the loop-pi home templates\\0loop-pi-install")
prefix = Path.home() / "data" / label
for rel, source in files:
    destination = prefix / rel; destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
m.render_policy(prefix, "the loop-pi home templates")
(prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
'''

    def test_install_backs_up_retired_agents_and_check_reports_them(self):
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-retire-") as temporary:
            root = Path(temporary).resolve()
            env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
            env.update(HOME=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            (root / "sentinel").write_text("untouched")
            built = subprocess.run([sys.executable, "-c", self.PREBUILD, str(HERE / "loop-pi-install")],
                                   env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            home = root / "pi"
            args = [sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(root),
                    "--home", str(home), "--data", str(root / "data"), "--bin", str(root / "bin"),
                    "--launcher", "loop-pi-test"]
            def install(*extra, expected=0):
                result = subprocess.run([*args, *extra], env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            install()
            shipped = {path.name: path.read_bytes() for path in (home / "agents").glob("*.md")}
            self.assertEqual(set(shipped), {f"{name}.md" for name in m.AGENT_SET})
            # Two retired agents (one was managed by the old receipt) and one unrelated file.
            (home / "agents/retired-one.md").write_text("retired one\n")
            (home / "agents/retired-two.md").write_text("retired two\n")
            (home / "agents/notes.txt").write_text("not an agent\n")
            stale = install("--check", expected=1).stdout
            self.assertIn(f"STALE: {home / 'agents/retired-one.md'}", stale)
            self.assertIn(f"STALE: {home / 'agents/retired-two.md'}", stale)
            self.assertNotIn("notes.txt", stale)
            self.assertTrue((home / "agents/retired-one.md").exists(), "--check writes nothing")
            output = install().stdout
            self.assertIn("retired", output)
            self.assertEqual({path.name for path in (home / "agents").glob("*.md")}, set(shipped))
            self.assertEqual((home / "agents/notes.txt").read_text(), "not an agent\n")
            for name, data in shipped.items():
                self.assertEqual((home / "agents" / name).read_bytes(), data)
            backups = sorted((home / "backups").glob("agents-*"))
            self.assertEqual(len(backups), 1, backups)
            self.assertEqual((backups[0] / "retired-one.md").read_text(), "retired one\n")
            self.assertEqual((backups[0] / "retired-two.md").read_text(), "retired two\n")
            install("--check")
            # Nothing retired, no new backup; a later retirement gets its own backup directory.
            install()
            self.assertEqual(len(sorted((home / "backups").glob("agents-*"))), 1)
            (home / "agents/old-reviewer.md").write_text("again\n")
            install()
            backups = sorted((home / "backups").glob("agents-*"))
            self.assertEqual(len(backups), 2, backups)
            self.assertEqual(sum((b / "old-reviewer.md").is_file() for b in backups), 1)
            self.assertEqual((root / "sentinel").read_text(), "untouched")

    def test_install_backs_up_retired_dispatcher_launchers_and_check_reports_them(self):
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-retire-launcher-") as temporary:
            root = Path(temporary).resolve()
            env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
            env.update(HOME=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
            built = subprocess.run([sys.executable, "-c", self.PREBUILD, str(HERE / "loop-pi-install")],
                                   env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            home, bins = root / "pi", root / "bin"
            args = [sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(root),
                    "--home", str(home), "--data", str(root / "data"), "--bin", str(bins), "--launcher", "loop-pi-test"]
            def install(*extra, expected=0):
                result = subprocess.run([*args, *extra], env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                return result
            install()
            self.assertEqual(sorted(p.name for p in bins.iterdir() if p.name.startswith("loop-pi-dispatch")), [],
                             "the installer no longer writes a dispatcher launcher")
            old = "#!/bin/sh\nexec node pi.js -p --no-tools --provider loop-dispatch --model idle \"$@\"\n"
            (bins / "loop-pi-dispatch").write_text(old)
            (bins / "loop-pi-dispatch-fast").write_text(old)
            (bins / "loop-pi-test-dispatch").write_text(old)
            (bins / "loop-pi-dispatch-notes").write_text("someone else's script\n")
            stale = install("--check", expected=1).stdout
            for name in ("loop-pi-dispatch", "loop-pi-dispatch-fast", "loop-pi-test-dispatch"):
                self.assertIn(f"STALE: {bins / name} is a retired dispatcher launcher", stale)
            self.assertNotIn("loop-pi-dispatch-notes", stale)
            self.assertTrue((bins / "loop-pi-dispatch").exists(), "--check writes nothing")
            output = install().stdout
            self.assertIn("retired", output)
            left = sorted(p.name for p in bins.iterdir() if "dispatch" in p.name)
            self.assertEqual(left, ["loop-pi-dispatch-notes"], "an unrelated file is never moved")
            backups = sorted((home / "backups").glob("launchers-*"))
            self.assertEqual(len(backups), 1, backups)
            self.assertEqual(sorted(p.name for p in backups[0].iterdir()),
                             ["loop-pi-dispatch", "loop-pi-dispatch-fast", "loop-pi-test-dispatch"])
            self.assertEqual((backups[0] / "loop-pi-dispatch").read_text(), old)
            install("--check")
            install()
            self.assertEqual(len(sorted((home / "backups").glob("launchers-*"))), 1, "nothing to retire, no new backup")

    def test_external_managed_agents_are_never_retired(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/agents").mkdir()
        (prefix / "home/agents/worker.md").write_text("---\nname: worker\n---\n")
        tgt = target(self.tmp, external=("agents/mine.md",))
        (tgt.home / "agents").mkdir(parents=True)
        for name in ("worker.md", "mine.md", "gone.md"):
            (tgt.home / "agents" / name).write_text("x\n")
        plan = set(m.home_plan(prefix, tgt.home, {}))
        self.assertEqual(m.retired_agents(tgt.home, plan, tgt.external), ["agents/gone.md"])
        self.assertEqual(m.retired_agents(tgt.home, plan), ["agents/gone.md", "agents/mine.md"])

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)


class ScratchContainmentTests(unittest.TestCase):
    """Public CLI negatives; every escape target still belongs to this disposable fixture."""

    def escape_fixture(self, location):
        import hashlib
        import sys
        retained = os.environ.get("LOOP_PI_SCRATCH_EVIDENCE")
        temporary = tempfile.TemporaryDirectory(prefix="scratch-containment-", dir=retained)
        parent = Path(temporary.name).resolve()
        if retained:
            temporary._finalizer.detach()
        scratch, outside = parent / "scratch", parent / "outside"
        scratch.mkdir(); outside.mkdir()
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
        env.update(HOME=str(scratch), XDG_CONFIG_HOME=str(scratch / "config"),
                   GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0")
        for directory in (scratch, outside):
            (directory / "sentinel").write_text("untouched")
        # Only prepare copied source/manifest bytes in a fenced child, as in NopushTests.
        # Installation/refusal itself always goes through the actual public CLI subprocess.
        prepare = r'''
import importlib.machinery, importlib.util, json, shutil, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
files = m.source_files(); label = m.build_label(files, m.pins(), "the loop-pi home templates\0loop-pi-install")
if sys.argv[2] != "staging":
    prefix = Path.home() / "data" / label
    for rel, source in files:
        target = prefix / rel; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    m.render_policy(prefix, "the loop-pi home templates")
    (prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
print(label)
'''
        result = subprocess.run([sys.executable, "-c", prepare, str(HERE / "loop-pi-install"), location],
                                cwd=parent, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        label = result.stdout.strip()
        escape = outside / "redirected"
        escape.mkdir()
        # Every negative prevents npm/network even if containment regresses.
        tools = scratch / "tools"
        tools.mkdir()
        npm = tools / "npm"
        npm.write_text('#!/bin/sh\necho called > "$HOME/npm-called"\nexit 91\n')
        npm.chmod(0o755)
        env["PATH"] = str(tools) + os.pathsep + env.get("PATH", "")
        home = scratch / "pi"
        home.mkdir()
        if location == "staging":
            link = scratch / "data" / f".staging-{label}"
            self.assertFalse((scratch / "data" / label).exists())
        elif location == "ancestor":
            link = scratch / "planned"
            home = link / "missing" / "pi"
        else:
            link = home / ("agents" if location in ("broken", "unreadable") else location)
            name = "worker.md" if location == "agents" else "loop-pi-nopush"
            (escape / name).write_text("outside managed sentinel")
        link.parent.mkdir(parents=True, exist_ok=True)
        if location == "unreadable":
            link.mkdir(mode=0o000)
        else:
            link.symlink_to(scratch / "missing-target" if location == "broken" else escape,
                            target_is_directory=True)
        def hashes(directory):
            # Whole inventory without following links: files, directory modes and link targets.
            inventory = {}
            def walk_error(error):
                inventory[str(Path(error.filename).relative_to(directory)) + "/error"] = error.errno
            for current, dirs, files in os.walk(directory, followlinks=False, onerror=walk_error):
                for name in dirs + files:
                    p = Path(current) / name
                    value = {"mode": oct(p.lstat().st_mode)}
                    if p.is_symlink():
                        value["link"] = os.readlink(p)
                    elif p.is_file():
                        value["sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
                    inventory[str(p.relative_to(directory))] = value
            return inventory
        before, before_inside = hashes(outside), hashes(scratch)
        sentinels = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (scratch / "sentinel", outside / "sentinel")}
        args = [sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(scratch),
                "--home", str(home), "--data", str(scratch / "data"), "--bin", str(scratch / "bin"),
                "--launcher", "loop-pi-test"]
        result = subprocess.run(args, cwd=parent, env=env, capture_output=True, text=True, timeout=30)
        after, after_inside = hashes(outside), hashes(scratch)
        proof = {"location": location, "command": args, "exit": result.returncode,
                 "stdout": result.stdout, "stderr": result.stderr, "beforeOutside": before,
                 "afterOutside": after, "beforeInside": before_inside, "afterInside": after_inside,
                 "targetedBoundary": str(link), "homeExistsBeforeCLI": location != "ancestor",
                 "sentinelHashes": sentinels,
                 "sentinelsIntact": all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h
                                       for p, h in sentinels.items()),
                 "npmCalled": (scratch / "npm-called").exists(), "hostedModelCalls": 0,
                 "networkCalls": 0}
        (parent / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
        try:
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            if location in ("broken", "unreadable"):
                self.assertIn("candidate destination topology cannot be checked", result.stderr)
                self.assertIn("[Errno 2]" if location == "broken" else "[Errno 13]", result.stderr)
                self.assertIn(str(scratch / "missing-target") if location == "broken" else str(link),
                              result.stderr)
            else:
                self.assertIn(f"candidate destination {link} escapes --scratch-root", result.stderr)
            self.assertEqual(after_inside, before_inside, "inside fixture inventory must not change")
            self.assertEqual(after, before, "outside fixture bytes must not change")
            self.assertTrue(proof["sentinelsIntact"])
            self.assertFalse(proof["npmCalled"], "refuse before npm side effects")
            self.assertFalse((scratch / "pi/tmp").exists(), "refuse before home setup")
        finally:
            if location == "unreadable":
                link.chmod(0o700)
            if not retained:
                temporary.cleanup()

    def test_interior_home_agents_escape_is_refused_before_writes(self):
        self.escape_fixture("agents")

    def test_interior_home_bin_escape_is_refused_before_writes(self):
        self.escape_fixture("bin")

    def test_derived_build_staging_escape_is_refused_before_copies(self):
        self.escape_fixture("staging")

    def test_missing_descendants_of_escaping_ancestor_are_refused(self):
        self.escape_fixture("ancestor")

    def test_broken_contained_link_is_not_a_planned_directory(self):
        self.escape_fixture("broken")

    def test_permission_error_is_not_ignored(self):
        self.escape_fixture("unreadable")


class NopushNativeCanary(unittest.TestCase):
    """No hosted model or mutable network remote: installed native runners against faux.

    Set LOOP_PI_NOPUSH_EVIDENCE to retain the scratch install and complete RPC/session
    transcript. The only attempted network push is the unreachable loopback control.
    """

    def test_scratch_installed_native_canary(self):
        import sys
        import time
        from bin.test_loop_smoke import Rpc
        retained = os.environ.get("LOOP_PI_NOPUSH_EVIDENCE")
        temporary = tempfile.TemporaryDirectory(prefix="nopush-canary-", dir=retained)
        root = Path(temporary.name).resolve()
        if retained:
            # Detach the cleanup finalizer only for explicitly retained evidence.
            temporary._finalizer.detach()
        home, data, bins, repo, run_dir, overlay = [root / name for name in
                                                  ("planned/homes/pi", "planned/builds/data", "planned/tools/bin",
                                                   "repo", "run", "overlay")]
        repo.mkdir(); run_dir.mkdir()
        (root / "sentinel").write_text("untouched")
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
        env.update(HOME=str(root), XDG_CONFIG_HOME=str(root / "config"),
                   GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0")
        transcript = root / "commands.log"
        def command(*args, cwd=repo, expected=0, timeout=30):
            result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
            with transcript.open("a") as log:
                log.write(json.dumps(list(args)) + f"\nexit={result.returncode}\n" + result.stdout + result.stderr + "\n")
            if expected is not None:
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            return result
        def git(*args, **kwargs):
            return command("git", *args, **kwargs).stdout.strip()
        faux = HERE.parent / "extensions/test-support/faux-extension.ts"
        agents = overlay / "home/agents"
        agents.mkdir(parents=True)
        for name in ("worker", "senior"):
            text = (HERE.parent / "home/agents" / f"{name}.md").read_text()
            text = text.replace("model: openai/gpt-6.1-sol", "model: faux/faux-1")
            text = text.replace("extensions:\n", f"extensions: []\nsubagentOnlyExtensions: {faux}\n")
            (agents / f"{name}.md").write_text(text)
        # The remaining agents also need to pass the installer's family check, but are never run.
        for path in (HERE.parent / "home/agents").glob("*.md"):
            if not (agents / path.name).exists():
                import re
                (agents / path.name).write_text(re.sub(r"(?m)^model: .*", "model: faux/faux-1", path.read_text()))
        (overlay / "home/settings.json").write_text(json.dumps({
            "enabledModels": ["faux/faux-1"], "subagents": {"agentExcludeDirs": ["~/.agents"]},
            "loopPi": {"modelFamily": {"provider": "faux", "pattern": "^faux-1$", "name": "faux"},
                       "rootRoute": {"provider": "faux", "model": "faux-1", "thinking": "off"}}}))
        git("init", "-b", "main")
        git("config", "user.name", "export"); git("config", "user.email", "export@example.com")
        git("config", "commit.gpgsign", "false")
        (repo / "push.sh").write_text("#!/bin/sh\nexec git push origin HEAD:refs/heads/main\n")
        (repo / "local.sh").write_text("#!/bin/sh\nset -eu\ngit fetch local\ngit push local HEAD:refs/heads/wrapped\n")
        for name in ("push.sh", "local.sh"):
            (repo / name).chmod(0o755)
        git("add", "--", "push.sh", "local.sh"); git("commit", "-m", "fixture")
        sha = git("rev-parse", "HEAD")
        git("remote", "add", "origin", "https://127.0.0.1:9/canary.git")
        local = root / "local.git"
        git("init", "--bare", str(local))
        git("remote", "add", "local", str(local))
        git("push", "local", "main")
        # Real subprocess install, including npm ci and the original runtime validations.
        command(sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(root),
                "--home", str(home), "--data", str(data), "--bin", str(bins), "--launcher", "loop-pi-canary",
                "--overlay", str(overlay), cwd=HERE.parent, timeout=240)
        # Recheck the genuine npm-built tree too: its internal .bin file links are legitimate.
        command(sys.executable, str(HERE / "loop-pi-install"), "--candidate-source", "--scratch-root", str(root),
                "--home", str(home), "--data", str(data), "--bin", str(bins), "--launcher", "loop-pi-canary",
                "--overlay", str(overlay), "--check", cwd=HERE.parent)
        prefix = data / json.loads((home / m.HOME_MANIFEST).read_text())["label"]
        (run_dir / "loop-pi-proto").write_text("2\n")
        env.update(PI_CODING_AGENT_DIR=str(home), PI_SUBAGENTS_TEMP_ROOT=str(home / "tmp"),
                   LOOP_PI_RUN_DIR=str(run_dir), LOOP_PI_REPO=str(repo))
        script = root / "script.json"
        env["LOOP_PI_FAUX_SCRIPT"] = str(script)
        def tool(name, **args):
            return {"name": name, "args": args}
        # An armed run only launches lanes whose first line is the brief header the state log parses.
        HEADER = "Lane: canary · Task: T-1 · Tier: routine\n"
        def spawn(agent, task, **options):
            return tool("subagent", agent=agent, task=task, **{"async": True, "worktree": False, **options})
        script.write_text(json.dumps({"rules": [
            {"match": "^CONTROL_ROOT$", "once": True, "toolCalls": [tool("bash", command="./push.sh", timeout=15)]},
            {"match": "^WRAPPED_ROOT$", "once": True, "toolCalls": [spawn("worker", HEADER + "WRAPPED_CHILD\nLanding: returns candidate")]},
            {"match": "^Task: Lane: canary[^\\n]*\\nWRAPPED_CHILD", "once": True, "toolCalls": [tool("bash", command="./push.sh", timeout=15)]},
            {"match": "^LOCAL_ROOT$", "once": True, "toolCalls": [spawn("worker", HEADER + "LOCAL_CHILD\nLanding: returns candidate")]},
            {"match": "^Task: Lane: canary[^\\n]*\\nLOCAL_CHILD", "once": True, "toolCalls": [tool("bash", command="./local.sh", timeout=15)]},
            {"match": "^GUARD_ROOT$", "once": True, "toolCalls": [spawn("worker", HEADER + "GUARD_CHILD\nLanding: returns candidate")]},
            {"match": "^Task: Lane: canary[^\\n]*\\nGUARD_CHILD", "once": True, "toolCalls": [tool("bash", command="git push local HEAD:refs/heads/forbidden", timeout=15)]},
            {"match": "^FOREGROUND_ROOT$", "once": True, "toolCalls": [spawn("senior", HEADER + "FOREGROUND_PARENT\nLanding: returns candidate\nDelegation: one local faux child")]},
            {"match": "^Task: Lane: canary[^\\n]*\\nFOREGROUND_PARENT", "once": True, "toolCalls": [spawn("worker", "FOREGROUND_CHILD\nLanding: returns candidate", **{"async": False})]},
            {"match": "^ASYNC_ROOT$", "once": True, "toolCalls": [spawn("senior", HEADER + "ASYNC_PARENT\nLanding: returns candidate\nDelegation: one local faux child")]},
            {"match": "^Task: Lane: canary[^\\n]*\\nASYNC_PARENT", "once": True, "toolCalls": [spawn("worker", "NESTED_CHILD\nLanding: returns candidate")]},
            {"match": "^Task: NESTED_CHILD", "once": True, "toolCalls": [tool("bash", command="./push.sh", timeout=15)]},
            {"match": "^ROOT_PUSH$", "once": True, "toolCalls": [tool("bash", command="git push local HEAD:refs/heads/rootpush", timeout=15)]},
            {"match": ".*", "text": "faux done"},
        ]}))
        node = m.node_binary()
        rpc = Rpc([node, str(prefix / m.PI_CLI), "--mode", "rpc", "--provider", "faux", "--model", "faux-1",
                   "--extension", str(faux), "--extension", str(prefix / "extensions/loop-guard/root.ts"),
                   "--exclude-tools", "subagents_enable,bg_wait,contact_supervisor"], repo, env)
        def prompt(marker):
            start = len(rpc.events)
            rpc.send(type="prompt", message=marker)
            end = rpc.wait(lambda e: e.get("type") == "tool_execution_end", marker, start)
            rpc.wait(lambda e: e.get("type") == "agent_settled", marker + " settle", start)
            return end
        def child_result(marker, tool_name="bash"):
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                for path in (home / "sessions").rglob("session.jsonl"):
                    text = path.read_text()
                    if marker not in text:
                        continue
                    for line in text.splitlines():
                        try:
                            message = json.loads(line).get("message", {})
                        except ValueError:
                            continue
                        if message.get("role") == "toolResult" and message.get("toolName") == tool_name:
                            return path, message
                time.sleep(.1)
            self.fail(f"native child result missing: {marker}")
        def terminal_runs():
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                statuses = [json.loads(p.read_text()) for p in (home / "tmp").rglob("status.json")]
                if statuses and all(s.get("state") in ("complete", "failed", "partial", "stopped", "rejected") for s in statuses):
                    return statuses
                time.sleep(.1)
            self.fail("native runs did not reach terminal states")
        def run_for_session(session):
            matches = [(p, json.loads(p.read_text())) for p in (home / "tmp").rglob("status.json")
                       if json.loads(p.read_text()).get("sessionFile") == str(session)]
            self.assertEqual(len(matches), 1, [str(p) for p, _ in matches])
            return matches[0]
        try:
            control = prompt("CONTROL_ROOT")
            control_text = json.dumps(control)
            self.assertTrue(control.get("isError"), control)
            self.assertRegex(control_text.lower(), "couldn't connect|connection refused|failed to connect")
            self.assertNotIn("loop-guard:", control_text)
            self.assertNotIn("remote-loop-pi-push-denied", control_text)
            print("CONTROL: committed ./push.sh reached unreachable loopback endpoint, not guard", flush=True)
            launch = prompt("WRAPPED_ROOT")
            self.assertFalse(launch.get("isError", False), launch)
            path, result = child_result("WRAPPED_CHILD")
            self.assertTrue(result.get("isError"), result)
            self.assertIn("remote-loop-pi-push-denied", json.dumps(result))
            statuses = terminal_runs()
            wrapped = [s for s in statuses if s.get("steps", [{}])[0].get("agent") == "worker"]
            self.assertTrue(wrapped, statuses)
            self.assertTrue(all(s.get("launcher", {}).get("name") == "nopush" for s in wrapped), wrapped)
            boot_module = (HERE.parent / "node_modules/pi-subagents/src/runs/background/boot-id.js").as_uri()
            boot = subprocess.run([node, "--input-type=module", "-e",
                                   f"import {{ currentBootId }} from {json.dumps(boot_module)};"
                                   " process.stdout.write(currentBootId() ?? '')"],
                                  capture_output=True, text=True, timeout=15, check=True).stdout
            self.assertTrue(boot and all(s.get("bootId") == boot for s in wrapped), wrapped)
            print("WRAPPED: unknown helper denial; native status launcher.name=nopush with this boot id", flush=True)
            prompt("LOCAL_ROOT")
            _, result = child_result("LOCAL_CHILD")
            self.assertFalse(result.get("isError"), result)
            self.assertEqual(git("--git-dir", str(local), "rev-parse", "wrapped"), sha)
            terminal_runs()
            print("LOCAL: wrapped child's script fetched and pushed local bare ref, exact SHA", flush=True)
            prompt("GUARD_ROOT")
            _, result = child_result("GUARD_CHILD")
            self.assertTrue(result.get("isError"), result)
            self.assertIn("lanes never push", json.dumps(result))
            self.assertNotEqual(command("git", "--git-dir", str(local), "rev-parse", "forbidden", expected=None).returncode, 0)
            terminal_runs()
            print("REQUIRED GUARD: wrapped child explicit push refused by required lane guard", flush=True)
            prompt("FOREGROUND_ROOT")
            parent_session, result = child_result("FOREGROUND_PARENT", "subagent")
            self.assertIn("wraps the background runner only", json.dumps(result))
            self.assertIn("launcher 'nopush'", json.dumps(result))
            self.assertNotIn("Nested subagent call blocked", json.dumps(result))
            self.assertNotIn("loop-guard:", json.dumps(result))
            self.assertTrue(result.get("isError"), result)
            terminal_runs()
            parent_status_path, _ = run_for_session(parent_session)
            parent_recovery = json.loads((parent_status_path.parent / "recovery-descriptor.json").read_text())
            self.assertEqual(parent_recovery["agent"], "senior")
            self.assertEqual(parent_recovery["maxSubagentDepth"], 2)
            print("NESTED FOREGROUND: senior async:false worker refused by native producer", flush=True)
            prompt("ASYNC_ROOT")
            parent_session, nested_launch = child_result("ASYNC_PARENT", "subagent")
            self.assertFalse(nested_launch.get("isError", False), nested_launch)
            nested_session, result = child_result("NESTED_CHILD")
            self.assertTrue(result.get("isError"), result)
            self.assertIn("remote-loop-pi-push-denied", json.dumps(result))
            self.assertNotIn("loop-guard:", json.dumps(result))
            statuses = terminal_runs()
            self.assertTrue(any(s.get("launcher", {}).get("name") == "nopush" for s in statuses))
            parent_status_path, parent_status = run_for_session(parent_session)
            parent_recovery = json.loads((parent_status_path.parent / "recovery-descriptor.json").read_text())
            self.assertEqual(parent_recovery["agent"], "senior")
            self.assertEqual(parent_recovery["maxSubagentDepth"], 2)
            nested_status_path, nested_status = run_for_session(nested_session)
            self.assertEqual(nested_status_path.parent.parent.parent.name, "nested-subagent-runs")
            # 0.79 keys retained session storage by the async status id so completed
            # children can be resumed. The nested event route still uses the launch id.
            # Read that identity from its native started event and route receipt, never
            # from the session directory or the nested child's output path.
            parent_session_root = Path(parent_recovery["sessionDir"]).parent
            self.assertEqual(parent_session_root.name, parent_status["runId"])
            started = []
            for event_path in (home / "tmp/nested-subagent-events").glob("*/events/*.json"):
                event = json.loads(event_path.read_text())
                if (event.get("type") == "subagent.nested.started"
                        and event.get("parentRunId") == parent_status["runId"]
                        and event.get("child", {}).get("id") == nested_status["runId"]):
                    route = json.loads((event_path.parent.parent / "route.json").read_text())
                    self.assertEqual(route["rootRunId"], event["rootRunId"])
                    self.assertEqual(route["capabilityToken"], event["capabilityToken"])
                    started.append(event)
            self.assertEqual(len(started), 1, "one native launch event binds the parent and nested child")
            parent_route_id = started[0]["rootRunId"]
            self.assertEqual(Path(parent_recovery["sessionFile"]), parent_session)
            self.assertEqual(parent_session.parent.parent, parent_session_root)
            def assert_nested_scope(route_id):
                self.assertEqual(nested_status_path, home / "tmp/nested-subagent-runs" /
                                 route_id / nested_status["runId"] / "status.json")
            assert_nested_scope(parent_route_id)
            # The former (wrong) outer-status identity and an unrelated root must fail.
            for wrong_id in (parent_status["runId"], "wrong-parent-root"):
                with self.assertRaises(AssertionError):
                    assert_nested_scope(wrong_id)
            with nested_session.open() as session_file:
                nested_header = json.loads(session_file.readline())
            self.assertEqual(nested_header["type"], "session")
            self.assertEqual(nested_header["parentSession"], str(parent_session))
            nested_recovery = json.loads((nested_status_path.parent / "recovery-descriptor.json").read_text())
            self.assertEqual(nested_recovery["maxSubagentDepth"], 2)
            self.assertEqual(nested_recovery["capabilityCeiling"]["allowedAgents"], parent_recovery["allowedAgents"])
            self.assertEqual(nested_status["steps"][0]["agent"], "worker")
            self.assertEqual(nested_status["launcher"]["name"], "nopush")
            print("NESTED ASYNC: fresh nested worker wrapper denied script push", flush=True)
            result = prompt("ROOT_PUSH")
            self.assertFalse(result.get("isError", False), result)
            self.assertEqual(git("--git-dir", str(local), "rev-parse", "rootpush"), sha)
            statuses = terminal_runs()
            receipts = [json.loads(line) for line in (run_dir / "push-log.jsonl").read_text().splitlines()]
            self.assertTrue(any(r.get("actor") == "root" and r.get("new") == sha
                                and r.get("ref") == "refs/heads/rootpush" for r in receipts), receipts)
            self.assertFalse(any(r.get("actor") == "lane" for r in receipts), receipts)
            # Every lane agent runs behind the wrapper: there is no push-granted, unwrapped twin.
            self.assertTrue(statuses and all(s.get("launcher", {}).get("name") == "nopush" for s in statuses), statuses)
            self.assertEqual((root / "sentinel").read_text(), "untouched")
            (root / "canary-receipt.json").write_text(json.dumps({"base": m.source_commit(HERE.parent),
                "fixtureSha": sha, "prefix": str(prefix), "statuses": statuses, "pushReceipts": receipts,
                "provider": "faux/faux-1", "networkOrigin": "https://127.0.0.1:9/canary.git",
                "sentinelIntact": True, "complexParentMaxDepth": parent_recovery["maxSubagentDepth"],
                "nestedParentRunId": parent_status["runId"], "nestedChildRunId": nested_status["runId"],
                "nestedParentRouteId": parent_route_id, "nestedParentSession": str(parent_session),
                "wrongParentIdentityControlsRejected": True,
                "nestedStatusPath": str(nested_status_path)}, indent=2) + "\n")
            print("ROOT PUSH: the root alone pushed a local bare ref, receipt matches fixture SHA, no lane receipt", flush=True)
            print(f"CANARY PASS: scratch install, full transcripts and receipt at {root}", flush=True)
        finally:
            code = rpc.close()
            (root / "rpc.jsonl").write_text("".join(json.dumps(e) + "\n" for e in rpc.events))
            (root / "rpc-stderr.log").write_text("".join(rpc.errors))
            print(f"native RPC exit={code}; scratch={root}", flush=True)
            if not retained:
                temporary.cleanup()


class GateCliTests(unittest.TestCase):
    def test_gate_wrapper_is_copied_installed_executable_and_drift_checked(self):
        self.assertIn("loop-gate-lock", m.CLI_TOOLS)
        self.assertIn("bin/loop-gate-lock", {rel for rel, _ in m.source_files()})
        with tempfile.TemporaryDirectory(prefix="loop-pi-gate-install-") as tmp:
            root = Path(tmp)
            prefix = fake_prefix(root)
            (prefix / "bin/loop-gate-lock").write_bytes((HERE / "loop-gate-lock").read_bytes())
            tgt = target(root)
            apply(prefix, tgt)
            installed = tgt.bin_dir / "loop-gate-lock"
            self.assertEqual(installed.read_bytes(), (HERE / "loop-gate-lock").read_bytes())
            self.assertTrue(os.access(installed, os.X_OK))
            self.assertFalse(m.drift(prefix, tgt, "/usr/bin/node"))
            installed.write_text("drift\n")
            self.assertIn(installed, [path for path, _, _ in m.drift(prefix, tgt, "/usr/bin/node")])


class NodeReceiptTests(unittest.TestCase):
    """Drive the installer only in a child process fenced by a disposable HOME."""

    def test_receipt_is_independent_of_path_and_explicit_node_wins(self):
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-node-test-") as tmp:
            env = {**os.environ, "HOME": tmp}
            env.pop("LOOP_PI_NODE", None)
            driver = r'''
import importlib.machinery, importlib.util, json, os, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
home = Path.home()
data, bins, target = home / "data", home / "bin", home / "pi"
print("HOME:", home, "destinations:", data, bins, target, flush=True)
assert str(home) == os.environ["HOME"]
(home / "sentinel").write_text("untouched")
a, b = home / "preferred-node", home / "other-node"
for path, version in ((a, "v24.1.0"), (b, "v24.2.0")):
    path.write_text("#!/bin/sh\necho " + version + "\n")
    path.chmod(0o755)
# Substitute only the fixed platform discovery list, never destinations or HOME.
m.NODE_CANDIDATES = (str(a), str(b))
path_a, path_b = home / "path-a", home / "path-b"
for directory, node in ((path_a, a), (path_b, b)):
    directory.mkdir()
    (directory / "node").symlink_to(node)
label = m.build_label(m.source_files(), m.pins(), "the loop-pi home templates\0loop-pi-install")
prefix = data / label
(prefix / "home").mkdir(parents=True)
(prefix / "home/settings.json").write_text("{}")
(prefix / "bin").mkdir()
for name in m.CLI_TOOLS:
    (prefix / "bin" / name).write_text("#!/bin/sh\n")
(prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
args = ["--home", str(target), "--bin", str(bins), "--data", str(data), "--launcher", "loop-pi"]
os.environ["PATH"] = str(path_a) + ":/usr/bin:/bin"
assert m.main(args) == 0
record = json.loads((target / m.HOME_MANIFEST).read_text())
assert record["node"] == {"path": str(a.resolve()), "version": "v24.1.0"}, record
original = (bins / "loop-pi").read_bytes()
for directory in (path_a, path_b):
    os.environ["PATH"] = str(directory) + ":/usr/bin:/bin"
    assert m.main(args + ["--check"]) == 0
# Even a changed preference list cannot silently replace the installed node.
m.NODE_CANDIDATES = (str(b), str(a))
assert m.main(args) == 0
assert (bins / "loop-pi").read_bytes() == original
os.environ["LOOP_PI_NODE"] = str(a)
assert m.main(args + ["--node", str(b)]) == 0
record = json.loads((target / m.HOME_MANIFEST).read_text())
assert record["node"] == {"path": str(b.resolve()), "version": "v24.2.0"}
assert m.main(args + ["--check", "--node", str(b)]) == 0
os.environ.pop("LOOP_PI_NODE")
b.write_text("#!/bin/sh\necho v24.3.0\n")
assert m.main(args + ["--check"]) == 1, "version drift must be reported"
assert m.main(args) == 0
receipt_bytes = (target / m.HOME_MANIFEST).read_bytes()
(target / m.HOME_MANIFEST).write_text("[]")
assert m.main(args + ["--check"]) == 2, "non-object receipts must be rejected"
(target / m.HOME_MANIFEST).write_bytes(receipt_bytes)
b.unlink()
assert m.main(args + ["--check"]) == 2, "missing recorded node must not fall back"
assert (home / "sentinel").read_text() == "untouched"
print("PASS: PATH-invariant check/reinstall; explicit override; version drift; missing node", flush=True)
'''
            result = subprocess.run([sys.executable, "-c", driver, str(HERE / "loop-pi-install")],
                                    env=env, capture_output=True, text=True, timeout=60)
            print(result.stdout, end="")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_cellar_node_without_matching_stable_link_refuses_install(self):
        import sys
        for mode in ("absent", "mismatched"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="loop-pi-node-refusal-") as tmp:
                root = Path(tmp).resolve()
                env = {key: os.environ[key] for key in ("PATH", "TMPDIR") if key in os.environ}
                env.update(HOME=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
                (root / "sentinel").write_text("untouched")
                node = root / "brew/Cellar/node/26.10.0_1/bin/node"
                node.parent.mkdir(parents=True)
                node.write_text("#!/bin/sh\necho v26.10.0\n")
                node.chmod(0o755)
                if mode == "mismatched":
                    other = root / "brew/Cellar/node/26.10.0_2/bin/node"
                    other.parent.mkdir(parents=True)
                    other.write_bytes(node.read_bytes())
                    other.chmod(0o755)
                    link = root / "brew/opt/node"
                    link.parent.mkdir(parents=True)
                    link.symlink_to(other.parent.parent)
                prepare = r'''
import importlib.machinery, importlib.util, json, shutil, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
files = m.source_files(); label = m.build_label(files, m.pins(), "the loop-pi home templates\0loop-pi-install")
prefix = Path.home() / "data" / label
for rel, source in files:
    destination = prefix / rel; destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
m.render_policy(prefix, "the loop-pi home templates")
(prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
'''
                setup = subprocess.run([sys.executable, "-I", "-c", prepare, str(HERE / "loop-pi-install")],
                                       cwd=root, env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(setup.returncode, 0, setup.stdout + setup.stderr)
                home, bins = root / "pi", root / "bin"
                result = subprocess.run([
                    sys.executable, "-I", str(HERE / "loop-pi-install"), "--candidate-source",
                    "--scratch-root", str(root), "--home", str(home), "--data", str(root / "data"),
                    "--bin", str(bins), "--launcher", "loop-pi-test", "--node", str(node),
                ], cwd=root, env=env, capture_output=True, text=True, timeout=30)
                # Include any unsafe receipt in the fail-first output, not just the exit status.
                receipt = home / ".loop-pi-managed.json"
                stored = receipt.read_text() if receipt.exists() else "no receipt"
                print(f"stable-link={mode} exit={result.returncode} receipt={stored}", flush=True)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("stable Homebrew node", result.stderr)
                self.assertFalse(home.exists(), "refusal must happen before writing the home")
                self.assertFalse(bins.exists(), "refusal must happen before writing launchers")
                self.assertEqual((root / "sentinel").read_text(), "untouched")

    def test_homebrew_node_survives_a_keg_revision_upgrade(self):
        # A Homebrew revision bump (26.10.0_1 -> _2) plus cleanup deletes the old Cellar path;
        # launchers must keep working, and only a same-major replacement may be adopted.
        import sys
        with tempfile.TemporaryDirectory(prefix="loop-pi-node-test-") as tmp:
            env = {**os.environ, "HOME": tmp}
            env.pop("LOOP_PI_NODE", None)
            driver = r'''
import importlib.machinery, importlib.util, json, os, shutil, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("installer", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
home = Path.home()
data, bins, target = home / "data", home / "bin", home / "pi"
brew = Path(os.path.realpath(home)) / "brew"  # macOS temp dirs sit behind /var -> /private/var
def keg(revision, version):
    node = brew / "Cellar/node" / revision / "bin/node"
    node.parent.mkdir(parents=True)
    node.write_text("#!/bin/sh\necho " + version + "\n")
    node.chmod(0o755)
    link = brew / "opt/node"
    if link.is_symlink():
        link.unlink()
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(Path("../Cellar/node") / revision)
    (brew / "bin").mkdir(exist_ok=True)
    if not (brew / "bin/node").is_symlink():
        (brew / "bin/node").symlink_to(Path("../Cellar/node") / revision / "bin/node")
    else:
        (brew / "bin/node").unlink()
        (brew / "bin/node").symlink_to(Path("../Cellar/node") / revision / "bin/node")
keg("26.10.0_1", "v26.10.0")
stable = str(brew / "opt/node/bin/node")
m.NODE_CANDIDATES = (str(brew / "bin/node"),)
label = m.build_label(m.source_files(), m.pins(), "the loop-pi home templates\0loop-pi-install")
prefix = data / label
(prefix / "home").mkdir(parents=True)
(prefix / "home/settings.json").write_text("{}")
(prefix / "bin").mkdir()
for name in m.CLI_TOOLS:
    (prefix / "bin" / name).write_text("#!/bin/sh\n")
(prefix / m.BUILD_MANIFEST).write_text(json.dumps({"label": label, "missing_extensions": []}))
args = ["--home", str(target), "--bin", str(bins), "--data", str(data), "--launcher", "loop-pi"]
assert m.main(args) == 0
record = json.loads((target / m.HOME_MANIFEST).read_text())
assert record["node"]["path"] == stable, record
assert "Cellar" not in (bins / "loop-pi").read_text()
# Revision upgrade and cleanup: _1 disappears, the keg link now points at _2.
keg("26.10.0_2", "v26.10.0")
shutil.rmtree(brew / "Cellar/node/26.10.0_1")
assert m.main(args + ["--check"]) == 0, "a revision upgrade must not break the home"
import subprocess
assert subprocess.run([str(bins / "loop-pi"), "--version"], capture_output=True).returncode == 0
# A receipt from before this fix names the vanished Cellar path: migrate to the same-major link.
record["node"]["path"] = str(brew / "Cellar/node/26.10.0_1/bin/node")
(target / m.HOME_MANIFEST).write_text(json.dumps(record))
assert m.main(args) == 0
assert json.loads((target / m.HOME_MANIFEST).read_text())["node"]["path"] == stable
# A different major behind the link is never adopted silently.
record["node"]["path"] = str(brew / "Cellar/node/26.10.0_1/bin/node")
(target / m.HOME_MANIFEST).write_text(json.dumps(record))
keg("27.0.0", "v27.0.0")
assert m.main(args) == 2, "a missing node must not migrate across a major version"
launch = subprocess.run([str(bins / "loop-pi"), "--version"], capture_output=True, text=True)
assert launch.returncode == 78 and "no longer node 26" in launch.stderr, launch
print("PASS: keg link recorded; revision upgrade survives; same-major migration only", flush=True)
'''
            result = subprocess.run([sys.executable, "-c", driver, str(HERE / "loop-pi-install")],
                                    env=env, capture_output=True, text=True, timeout=60)
            print(result.stdout, end="")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="loop-pi-install-test-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_home_update_renders_paths_and_never_touches_unmanaged_files(self):
        prefix = fake_prefix(self.tmp)
        tgt = target(self.tmp)
        tgt.home.mkdir()
        (tgt.home / "auth.json").write_text("SECRET")
        apply(prefix, tgt)
        settings = json.loads((tgt.home / "settings.json").read_text())
        self.assertEqual(settings, {"packages": [f"{prefix}/node_modules/pi-subagents"], "h": str(tgt.home)})
        self.assertEqual((tgt.home / "auth.json").read_text(), "SECRET")
        self.assertEqual((tgt.home / "scripts/backlog-guard.py").stat().st_mode & 0o777, 0o755)
        self.assertEqual(m.drift(prefix, tgt, "/usr/bin/node"), [])

    def test_a_template_carrying_auth_json_is_refused(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/auth.json").write_text("{}")
        with self.assertRaises(m.InstallError):
            m.home_plan(prefix, self.tmp / ".loop-pi-demo", {})

    def test_vars_render_and_reserved_names_are_refused(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/models.json").write_text('{"apiKey": "!cat {{USER_HOME}}/keys/{{CONTEXT}}/api_key"}')
        tgt = target(self.tmp, variables=m.parse_vars(["CONTEXT=team"]))
        paths = {path: data for path, data, _ in m.drift(prefix, tgt, "/usr/bin/node")}
        self.assertTrue(json.loads(paths[tgt.home / "models.json"])["apiKey"].endswith("/keys/team/api_key"))
        for bad in (["HOME=/x"], ["lower=x"], ["NOEQUALS"]):
            with self.assertRaises(m.InstallError):
                m.parse_vars(bad)

    def test_incomplete_build_launcher_runs_version_only(self):
        prefix = fake_prefix(self.tmp, missing=["loop-guard/root.ts"])
        home = self.tmp / ".loop-pi-demo"
        text = m.launcher_text(prefix, home, "/usr/bin/node", json.loads((prefix / m.BUILD_MANIFEST).read_text()),
                               "loop-pi", "loop-pi-install")
        self.assertTrue("--version" in text and "exit 78" in text and "--extension" not in text)
        complete = m.launcher_text(prefix, home, "/usr/bin/node", {"label": "x", "missing_extensions": []},
                                   "loop-pi", "someone else")
        self.assertEqual(complete.count("--extension"), len(m.ROOT_EXTENSIONS))
        self.assertIn("# Generated by someone else. Do not edit", complete)
        self.assertTrue("only --version runs" not in complete and "PI_SUBAGENT_WAIT_TOOL_ENABLED=false" in complete)
        self.assertIn("--provider openai --model gpt-6.1-sol --thinking high", complete)
        # Some OpenAI-compatible proxies never acknowledge a request whose tool list changed mid-conversation.
        self.assertIn("--exclude-tools subagents_enable,bg_wait,contact_supervisor ", complete)

    def test_lane_worktrees_is_a_root_extension_and_its_absence_is_reported_not_fatal(self):
        entry = "lane-worktrees/index.ts"
        self.assertIn(entry, m.ROOT_EXTENSIONS)
        self.assertNotIn(entry, m.LANE_EXTENSIONS)
        prefix = fake_prefix(self.tmp)
        self.assertIn(entry, m.missing_extensions(prefix))
        for rel in m.ROOT_EXTENSIONS + m.LANE_EXTENSIONS:
            stub = prefix / "extensions" / rel
            stub.parent.mkdir(parents=True, exist_ok=True)
            stub.write_text("export default () => {};\n")
        self.assertEqual(m.missing_extensions(prefix), [])
        home = self.tmp / ".loop-pi-demo"
        text = m.launcher_text(prefix, home, "/usr/bin/node", {"label": "x", "missing_extensions": []},
                               "loop-pi", "loop-pi-install")
        self.assertIn(f"--extension '{prefix}/extensions/{entry}'", text)
        # An absent entry in an incomplete build keeps the version-only launcher.
        absent = m.launcher_text(prefix, home, "/usr/bin/node", {"label": "x", "missing_extensions": [entry]},
                                 "loop-pi", "loop-pi-install")
        self.assertTrue("--version" in absent and "--extension" not in absent)

    def test_call_timing_is_installed_for_root_and_children_and_missing_is_reported_once(self):
        entry = "call-timing/index.ts"
        self.assertIn(entry, m.ROOT_EXTENSIONS)
        self.assertIn(entry, m.LANE_EXTENSIONS)
        rels = {rel for rel, _ in m.source_files()}
        self.assertIn(f"extensions/{entry}", rels)
        self.assertFalse(any(rel.startswith("extensions/call-timing/test-support/") for rel in rels))
        self.assertNotIn("extensions/call-timing/timing.test.ts", rels)
        prefix = fake_prefix(self.tmp)
        self.assertEqual(m.missing_extensions(prefix).count(entry), 1)
        text = m.launcher_text(prefix, self.tmp / "h", "/usr/bin/node",
                               {"label": "x", "missing_extensions": []}, "loop-pi", "loop-pi-install")
        self.assertIn(f"--extension '{prefix}/extensions/{entry}'", text)

    def test_loop_status_is_root_only_so_lanes_set_no_status(self):
        entry = "loop-status/index.ts"
        self.assertIn(entry, m.ROOT_EXTENSIONS)
        self.assertNotIn(entry, m.LANE_EXTENSIONS)
        prefix = fake_prefix(self.tmp)
        self.assertEqual(m.missing_extensions(prefix).count(entry), 1)
        manifest = {"label": "x", "missing_extensions": []}
        root = m.launcher_text(prefix, self.tmp / "h", "/usr/bin/node", manifest, "loop-pi", "loop-pi-install")
        self.assertIn(f"--extension '{prefix}/extensions/{entry}'", root)
        rels = {rel for rel, _ in m.source_files()}
        self.assertIn(f"extensions/{entry}", rels)
        self.assertFalse(any(rel.startswith("extensions/loop-status/") and "test" in rel.rsplit("/", 1)[1] for rel in rels))

    def test_the_installed_agent_set_is_the_v3_roster(self):
        self.assertEqual(m.AGENT_SET, {"worker", "senior", "senior-escalation", "reviewer", "scout"})
        prefix = fake_prefix(self.tmp)
        agents = prefix / "home/agents"
        agents.mkdir(parents=True)
        for name in m.AGENT_SET - {"scout"}:
            (agents / f"{name}.md").write_text("---\nname: x\n---\n")
        with self.assertRaises(m.InstallError) as ctx:
            m.check_agent_set(prefix)
        self.assertIn("scout", str(ctx.exception))

    def agent_file(self, front_extra: str, body: str = "body\n") -> str:
        return f"---\nname: a\nmodel: openai/gpt-6-astra\n{front_extra}---\n{body}"

    def test_lane_policy_is_appended_once_to_agents_without_global_context(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/agents").mkdir()
        (prefix / "home/lane-policy.md").write_text("# Lane policy\n\nrule one\n")
        (prefix / "home/agents/lane.md").write_text(self.agent_file("inheritGlobalContext: false\n"))
        (prefix / "home/agents/root-like.md").write_text(self.agent_file("inheritGlobalContext: true\n"))
        (prefix / "home/agents/silent.md").write_text(self.agent_file(""))
        plan = m.home_plan(prefix, self.tmp / ".loop-pi-demo", {})
        lane = plan["agents/lane.md"].decode()
        self.assertEqual(lane, self.agent_file("inheritGlobalContext: false\n")
                         + "\n" + m.LANE_POLICY_MARKER + "\n# Lane policy\n\nrule one\n")
        self.assertEqual(plan["agents/root-like.md"].decode(), self.agent_file("inheritGlobalContext: true\n"))
        self.assertEqual(plan["agents/silent.md"].decode(), self.agent_file(""))
        self.assertIn("lane-policy.md", plan, "the policy file itself is a managed home file")
        # Idempotent: appending to an already-appended file, even with a changed policy, leaves one copy.
        again = m.append_lane_policy(lane, "# Lane policy\n\nrule two\n")
        self.assertEqual(again.count(m.LANE_POLICY_MARKER), 1)
        self.assertTrue(again.endswith("rule two\n") and "rule one" not in again)
        self.assertEqual(m.append_lane_policy(again, "# Lane policy\n\nrule two\n"), again)

    def test_an_overlay_policy_replaces_the_default_in_the_build_and_reaches_the_agents(self):
        src = self.tmp / "src"
        (src / "home").mkdir(parents=True)
        (src / "home/lane-policy.md").write_text("default policy\n")
        overlay = self.tmp / "overlay"
        (overlay / "home").mkdir(parents=True)
        (overlay / "home/lane-policy.md").write_text("overlay policy\n")
        rels = [rel for rel, _ in m.source_files(src, overlay)]
        self.assertEqual(rels.count("home/lane-policy.md"), 2, "the overlay copy comes after the default and wins")
        self.assertEqual([p for r, p in m.source_files(src, overlay) if r == "home/lane-policy.md"][-1],
                         overlay / "home/lane-policy.md")

    def test_loop_state_is_installed_into_the_home_bin_only_when_the_build_has_it(self):
        prefix = fake_prefix(self.tmp)
        tgt = target(self.tmp)
        apply(prefix, tgt)
        self.assertFalse((tgt.home / "bin/loop-state").exists())
        (prefix / "bin/loop-state").write_text("#!/usr/bin/env python3\n")
        apply(prefix, tgt)
        self.assertEqual((tgt.home / "bin/loop-state").stat().st_mode & 0o777, 0o755)
        self.assertIn("bin/loop-state", json.loads((tgt.home / m.HOME_MANIFEST).read_text())["files"])
        self.assertFalse((self.tmp / "bin/loop-state").exists(), "not installed next to the launcher")
        self.assertEqual(m.drift(prefix, tgt, "/usr/bin/node"), [])

    def test_agent_routes_survive_a_scratch_overlay_install(self):
        prefix = fake_prefix(self.tmp)
        overlay = self.tmp / "overlay"
        (overlay / "home").mkdir(parents=True)
        (overlay / "home/settings.json").write_text('{"fixture": true}')
        # Use the real source/overlay copy order, rendering, drift and atomic install path.
        for rel, source in m.source_files(m.SRC, overlay):
            if rel.startswith("home/"):
                destination = prefix / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
        tgt = target(self.tmp, variant="fast")
        apply(prefix, tgt)
        # SEAMS S4: model and thinking per role, in the source file and in the installed copy.
        for name, model, thinking in (
            ("worker", "gpt-6.1-sol", "medium"),
            ("senior", "gpt-6.1-sol", "high"),
            ("senior-escalation", "gpt-6-astra", "high"),
            ("reviewer", "gpt-6.1-sol", "high"),
            ("scout", "gpt-6.1-sol", "low"),
        ):
            source = (m.SRC / "home/agents" / f"{name}.md").read_text()
            installed = (tgt.home / "agents" / f"{name}.md").read_text()
            for text in (source, installed):
                front = text.split("---", 2)[1].splitlines()
                self.assertIn(f"model: openai/{model}", front, name)
                self.assertIn(f"thinking: {thinking}", front, name)
        smoke_agents = m.SRC / "extensions/test-support/smoke-overlay/home/agents"
        self.assertEqual({path.stem for path in smoke_agents.glob("*.md")}, m.AGENT_SET)
        # The offline smoke overlay must stay on its scripted provider, not a live model.
        for path in smoke_agents.glob("*.md"):
            self.assertIn("model: faux/faux-1", path.read_text().split("---", 2)[1].splitlines(), path.name)
        self.assertEqual(m.drift(prefix, tgt, "/usr/bin/node"), [])

    def test_agent_tools_delegation_and_timeouts_follow_the_roster(self):
        def front(name):
            text = (m.SRC / "home/agents" / f"{name}.md").read_text()
            return dict(line.split(": ", 1) for line in text.split("---", 2)[1].splitlines() if ": " in line)
        write = "read, bash, edit, write, grep, find, ls, watch_process"
        read = "read, grep, find, ls, bash"
        expected = {
            "worker": (write, "14400000"),
            "senior": (write + ", subagent", "14400000"),
            "senior-escalation": (write, "14400000"),
            "reviewer": (read, "7200000"),
            "scout": (read, "3600000"),
        }
        for name, (tools, timeout) in expected.items():
            fields = front(name)
            self.assertEqual(fields["tools"], tools, name)
            self.assertEqual(fields["timeoutMs"], timeout, name)
            self.assertEqual(fields["async"], "true", name)
            self.assertEqual(fields["launcher"], "nopush", name)
            self.assertEqual(fields["inheritGlobalContext"], "false", name)
            # Only senior is a parent, and only of the three read/write leaves (depth 2).
            if name == "senior":
                self.assertEqual(fields["allowedAgents"], "scout, worker, reviewer")
                self.assertEqual(fields["maxSubagentDepth"], "2")
            else:
                self.assertNotIn("subagent", fields["tools"].split(", "), name)
                self.assertNotIn("allowedAgents", fields, name)

    def test_root_route_and_family_come_from_settings(self):
        agents = {"loopPi": {"modelFamily": {"provider": "example", "pattern": "^m7-[a-z]+$", "name": "m7"},
                             "rootRoute": {"provider": "example", "model": "m7-large", "thinking": "high"}}}
        prefix = fake_prefix(self.tmp, settings=agents)
        text = m.launcher_text(prefix, self.tmp / "h", "/usr/bin/node", {"label": "x", "missing_extensions": []},
                               "loop-pi", "x")
        self.assertIn("--provider example --model m7-large --thinking high", text)
        (prefix / "home/agents").mkdir()
        (prefix / "home/agents/scout.md").write_text("---\nname: scout\nmodel: example/m7-small\n---\n")
        m.check_model_family(prefix)
        (prefix / "home/agents/scout.md").write_text("---\nname: scout\nmodel: openai/gpt-6-sol\n---\n")
        with self.assertRaisesRegex(m.InstallError, "scout"):
            m.check_model_family(prefix)
        (prefix / "home/settings.json").write_text(json.dumps({"loopPi": {"rootRoute": {"model": "x; rm -rf /"}}}))
        with self.assertRaises(m.InstallError):
            m.root_route(prefix)

    def test_label_changes_with_any_copied_source(self):
        a = self.tmp / "a.ts"
        a.write_text("one")
        pin = {m.PI_PACKAGE: "0.87.1", m.SUBAGENTS_PACKAGE: "0.73.0"}
        first = m.build_label([("extensions/a.ts", a)], pin)
        a.write_text("two")
        self.assertNotEqual(m.build_label([("extensions/a.ts", a)], pin), first)
        self.assertTrue(first.startswith("0.87.1-"))

    def test_overlay_files_are_copied_after_the_templates_they_replace(self):
        src = self.tmp / "src"
        (src / "home").mkdir(parents=True)
        (src / "home/models.json").write_text("{}")
        (src / "home/settings.json").write_text("{}")
        overlay = self.tmp / "overlay"
        (overlay / "home").mkdir(parents=True)
        (overlay / "home/models.json").write_text('{"mine": 1}')
        (overlay / "home/settings.json").write_text('{"loopPi": {}}')
        (overlay / "scripts").mkdir()
        (overlay / "scripts/guard.py").write_text("")
        (overlay / "policy.md").write_text("policy")
        rels = [rel for rel, _ in m.source_files(src, overlay)]
        self.assertLess(rels.index("home/models.json"), len(rels) - 1 - rels[::-1].index("home/models.json"))
        self.assertIn("home/scripts/guard.py", rels)
        self.assertIn("overlay/home/settings.json", rels)
        self.assertIn("overlay/policy.md", rels)
        self.assertEqual(rels.count("home/settings.json"), 1, "the overlay settings merge, never replace")

    def test_overlay_settings_deep_merge_and_policy_append(self):
        staging = self.tmp / "staging"
        (staging / "home").mkdir(parents=True)
        (staging / "overlay/home").mkdir(parents=True)
        (staging / "home/settings.json").write_text(json.dumps({"subagents": {"disableBuiltins": True}, "a": 1}))
        (staging / "overlay/home/settings.json").write_text(json.dumps(
            {"subagents": {"agentExcludeDirs": ["~/x"]}, "loopPi": {"requiredHookScripts": ["g.py"]}}))
        (staging / "home/policy-header.md").write_text("# header\n")
        (staging / "overlay/policy.md").write_text("\n# more\n")
        m.apply_overlay_settings(staging)
        m.render_policy(staging, "my sources")
        self.assertEqual(json.loads((staging / "home/settings.json").read_text()),
                         {"subagents": {"disableBuiltins": True, "agentExcludeDirs": ["~/x"]}, "a": 1,
                          "loopPi": {"requiredHookScripts": ["g.py"]}})
        self.assertEqual((staging / "home/AGENTS.md").read_text(),
                         "<!-- GENERATED FILE: edit my sources, not this file. -->\n# header\n\n# more\n")
        self.assertFalse((staging / "home/policy-header.md").exists())

    def test_required_hook_scripts_must_be_in_the_build(self):
        prefix = fake_prefix(self.tmp, settings={"loopPi": {"requiredHookScripts": ["backlog-guard.py"]}})
        m.check_hook_scripts(prefix)
        (prefix / "home/settings.json").write_text(json.dumps({"loopPi": {"requiredHookScripts": ["staging-guard.py"]}}))
        with self.assertRaisesRegex(m.InstallError, "staging-guard.py"):
            m.check_hook_scripts(prefix)
        (prefix / "home/settings.json").write_text(json.dumps({}))
        m.check_hook_scripts(prefix)

    def test_external_managed_files_are_recorded_and_never_stale(self):
        prefix = fake_prefix(self.tmp)
        tgt = target(self.tmp, external=(".binding.json",))
        apply(prefix, tgt)
        record = json.loads((tgt.home / m.HOME_MANIFEST).read_text())
        self.assertIn(".binding.json", record["files"])
        self.assertFalse((tgt.home / ".binding.json").exists(), "the installer never writes an external file")
        plan = set(m.home_plan(prefix, tgt.home, {}))
        self.assertEqual(m.stale_managed(tgt.home, plan, tgt.external), [])
        self.assertEqual(m.stale_managed(tgt.home, plan), [".binding.json"])

    def fake_node(self, reply: str) -> str:
        node = self.tmp / "node"
        node.write_text(f"#!/bin/sh\nread line\necho '{reply}'\n")
        node.chmod(0o755)
        return str(node)

    def test_extension_smoke_requires_the_root_command(self):
        prefix = fake_prefix(self.tmp)
        good = json.dumps({"id": "smoke", "type": "response", "command": "get_commands", "success": True,
                           "data": {"commands": [{"name": "loop-closeout"}]}})
        m.smoke_extensions(prefix, self.fake_node(good), m.ROOT_EXTENSIONS)
        bad = json.dumps({"id": "smoke", "type": "response", "command": "get_commands", "success": True,
                          "data": {"commands": []}})
        with self.assertRaises(m.InstallError):
            m.smoke_extensions(prefix, self.fake_node(bad), m.ROOT_EXTENSIONS)
        failing = self.tmp / "failing-node"
        failing.write_text(f"#!/bin/sh\nread line\necho '{good}'\necho 'Error: Failed to load extension \"x\"' >&2\nexit 1\n")
        failing.chmod(0o755)
        with self.assertRaises(m.InstallError):
            m.smoke_extensions(prefix, str(failing), m.LANE_EXTENSIONS)

    def test_agent_set_must_be_exactly_the_loop_pi_set(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/agents").mkdir()
        for name in m.AGENT_SET:
            (prefix / "home/agents" / f"{name}.md").write_text("---\n")
        m.check_agent_set(prefix)
        (prefix / "home/agents/mapper.md").write_text("---\n")
        with self.assertRaises(m.InstallError):
            m.check_agent_set(prefix)

    def test_every_agent_and_the_root_run_the_default_family_only(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/agents").mkdir()
        for name in m.AGENT_SET:
            (prefix / "home/agents" / f"{name}.md").write_text("---\nname: x\nmodel: openai/gpt-6-astra\n---\n")
        m.check_model_family(prefix)
        (prefix / "home/agents/scout.md").write_text("---\nname: scout\nmodel: openai/gpt-5.6-luna\n---\n")
        with self.assertRaisesRegex(m.InstallError, "scout"):
            m.check_model_family(prefix)
        for refused in ("gpt-6-luna", "gpt-6-sol"):
            (prefix / "home/agents/scout.md").write_text(f"---\nname: scout\nmodel: openai/{refused}\n---\n")
            with self.assertRaisesRegex(m.InstallError, "scout", msg=refused):
                m.check_model_family(prefix)
        (prefix / "home/agents/scout.md").write_text("---\nname: scout\n---\nmodel: openai/gpt-6-astra\n")
        with self.assertRaisesRegex(m.InstallError, "scout"):
            m.check_model_family(prefix)

    def test_keys_pi_writes_into_settings_are_kept_not_reported_as_drift(self):
        prefix = fake_prefix(self.tmp)
        tgt = target(self.tmp)
        tgt.home.mkdir()
        apply(prefix, tgt)
        settings = json.loads((tgt.home / "settings.json").read_text())
        (tgt.home / "settings.json").write_text(json.dumps({**settings, "theme": "dark", "lastChangelogVersion": "0.87.1"}))
        self.assertEqual(m.drift(prefix, tgt, "/usr/bin/node"), [])
        (tgt.home / "settings.json").write_text(json.dumps({**settings, "theme": "dark", "h": "hand-edited"}))
        [(path, data, _)] = m.drift(prefix, tgt, "/usr/bin/node")
        self.assertEqual(path, tgt.home / "settings.json")
        self.assertEqual(json.loads(data), {**settings, "theme": "dark"})

    def test_a_runtime_key_the_template_sets_is_managed(self):
        home = self.tmp / ".loop-pi-demo"
        home.mkdir()
        (home / "settings.json").write_text('{"theme": "dark", "lastChangelogVersion": "0.87.1"}')
        merged = json.loads(m.keep_runtime_settings(b'{"theme": "light"}', home / "settings.json"))
        self.assertEqual(merged, {"theme": "light", "lastChangelogVersion": "0.87.1"})

    def test_launcher_name_is_a_plain_file_name(self):
        self.assertEqual(m.main(["--home", str(self.tmp / "h"), "--launcher", "../evil", "--check"]), 2)


class LauncherTests(unittest.TestCase):
    """Run the real launcher text over stub tools and a stub node."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="loop-pi-launcher-test-")
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_launcher(self, preflight_exit=0, args=(), cwd=None, audit_exit=0, name="loop-pi", settings=None):
        prefix = self.tmp / "data" / "0.87.1-abc"
        if not prefix.exists():
            fake_prefix(self.tmp, settings=settings)
        elif settings is not None:
            (prefix / "home/settings.json").write_text(json.dumps(settings))
        home = self.tmp / ".loop-pi-demo"
        home.mkdir(exist_ok=True)
        log = self.tmp / "log"
        (prefix / "bin/loop-pi-preflight").write_text(f'#!/bin/sh\necho "preflight $*" >> {log}\nexit {preflight_exit}\n')
        (prefix / "bin/loop-pi-audit").write_text(
            f'#!/bin/sh\necho "audit $* run=$LOOP_PI_RUN_DIR" >> {log}\ntouch "$LOOP_PI_RUN_DIR/.audit.lock"\n'
            f'[ {audit_exit} = 0 ] && touch "$LOOP_PI_RUN_DIR/audit-before.json"\nexit {audit_exit}\n')
        node = self.tmp / "node"
        node.write_text(f'#!/bin/sh\necho "node run=${{LOOP_PI_RUN_DIR:-none}} repo=${{LOOP_PI_REPO:-none}} args=$*" >> {log}\n')
        for path in (*(prefix / "bin").iterdir(), node):
            path.chmod(0o755)
        launcher = self.tmp / name
        launcher.write_text(m.launcher_text(prefix, home, str(node), {"label": "x", "missing_extensions": []},
                                            name, "loop-pi-install"))
        launcher.chmod(0o755)
        env = {**os.environ, "LOOP_PI_RUN_DIR": "/inherited", "LOOP_PI_REPO": "/inherited"}
        proc = subprocess.run([str(launcher), *args], cwd=cwd or self.tmp, capture_output=True, text=True, timeout=30,
                              env=env)
        return proc, (log.read_text().splitlines() if log.exists() else []), home

    def test_root_thinking_default_and_override_order_for_launcher_variants(self):
        # Names and home variants are operator-defined, not a fixed installer enum.
        for name in ("loop-pi", "loop-pi-fast", "loop-pi-custom", "custom-root"):
            for route, expected in (({}, "high"), ({"thinking": "medium"}, "medium")):
                with self.subTest(name=name, route=route):
                    proc, log, _ = self.run_launcher(
                        name=name, settings={"loopPi": {"rootRoute": route}},
                        args=("--thinking", "minimal", "-p", "hello"))
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    argv = log[-1].split("args=", 1)[1].split()
                    levels = [argv[i + 1] for i, value in enumerate(argv) if value == "--thinking"]
                    self.assertEqual(levels, [expected, "minimal"])
                    self.assertEqual(argv[-4:], ["--thinking", "minimal", "-p", "hello"])

    def git_repo(self) -> Path:
        repo = self.tmp / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        return repo

    def test_launcher_in_a_repo_preflights_and_snapshots_into_its_own_run_dir(self):
        repo = self.git_repo()
        proc, log, home = self.run_launcher(cwd=repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        run_dir = log[1].split("run=")[1]
        self.assertEqual(log[0], f"preflight {repo.resolve()}")
        self.assertTrue(log[1].startswith(f"audit begin {repo.resolve()}"))
        self.assertTrue(Path(run_dir).parent == home / "runs" and Path(run_dir, "audit-before.json").is_file())
        self.assertTrue(log[2].startswith(f"node run={run_dir} repo={repo.resolve()}"))
        _, log2, _ = self.run_launcher(cwd=repo)
        self.assertNotEqual(log2[-2].split("run=")[1], run_dir, "a concurrent start gets its own run dir")

    def test_launcher_refuses_when_preflight_fails(self):
        repo = self.git_repo()
        proc, log, _ = self.run_launcher(preflight_exit=1, cwd=repo)
        self.assertEqual(proc.returncode, 78)
        self.assertFalse(any(line.startswith(("audit", "node")) for line in log))

    def test_launcher_refuses_and_cleans_up_when_the_snapshot_fails(self):
        repo = self.git_repo()
        proc, log, home = self.run_launcher(audit_exit=1, cwd=repo)
        self.assertTrue(proc.returncode == 78 and "cannot take the audit snapshot" in proc.stderr)
        self.assertTrue(not any(line.startswith("node") for line in log) and list((home / "runs").iterdir()) == [])

    def test_launcher_plain_and_outside_a_repo_skip_the_run_setup(self):
        repo = self.git_repo()
        proc, log, _ = self.run_launcher(args=("--plain", "-p", "hi"), cwd=repo)
        self.assertTrue(proc.returncode == 0 and log == ["node run=none repo=none args=" + log[0].split("args=")[1]])
        self.assertTrue("--plain" not in log[0] and log[0].endswith("-p hi"))
        outside = self.tmp / "elsewhere"
        outside.mkdir()
        (self.tmp / "log").unlink()
        _, log, _ = self.run_launcher(cwd=outside)
        self.assertTrue(log[0].startswith("node run=none"))


LANE_RETURN_V3 = """```lane-return
{"v":3,"lane":"<id>","task":"<ID>","status":"complete|partial|blocked|failed",
 "base":"<full SHA>","worktree":"<abs path>","patch":"<abs path>","patch_sha256":"<hex>",
 "check":"<exact command>","exit":<int>|null,"tail":"<last lines, at most 40>",
 "coderabbit":{"ran":true|false,"major":<n>,"unreviewed":<n>}|null,
 "questions":["<short; details in return.md>"]}
```"""


class AgentReturnContractTests(unittest.TestCase):
    """Every agent carries the lane-return v3 block itself (SEAMS S5): an overlay replaces
    home/lane-policy.md at install time, so the policy cannot be where the contract lives. Each
    body stays short and points at the run's LANE.md."""

    def test_every_agent_carries_the_lane_return_v3_block(self):
        agents = sorted((HERE.parent / "home/agents").glob("*.md"))
        self.assertEqual({path.stem for path in agents}, m.AGENT_SET)
        for path in agents:
            text = path.read_text()
            self.assertNotIn("Return exactly:", text, path.name)
            self.assertEqual(text.count(LANE_RETURN_V3), 1, f"{path.name} lacks the exact lane-return v3 block")
            self.assertNotIn('"v":2', text, path.name)
            # loop-state's return cap reads these sentences: the whole serialized block must fit the
            # native preview, and the exact check is never abbreviated.
            self.assertRegex(text, r"serialized fenced block at most 1,800 UTF-16 code units\s+\(including fences,\s*newlines and JSON escapes\)", path.name)
            self.assertIn("never abbreviate the exact check", text, path.name)
            self.assertLessEqual(len(text.split("\n---\n", 1)[1].splitlines()), 40, f"{path.name} body is over 40 lines")

    def test_working_roles_point_at_lane_md_and_no_agent_names_a_push_right(self):
        for path in sorted((HERE.parent / "home/agents").glob("*.md")):
            text = path.read_text()
            self.assertIn("LANE.md", text, path.name)
            self.assertNotIn("push-granted", text, path.name)
            self.assertNotRegex(text, r"(?i)landing:\s*(lands-after-green|pushes branch)", path.name)


if __name__ == "__main__":
    unittest.main()
