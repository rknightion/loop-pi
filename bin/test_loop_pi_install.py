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
        self.assertIn("--provider openai --model gpt-6.1-sol --thinking medium", complete)
        # Some OpenAI-compatible proxies never acknowledge a request whose tool list changed mid-conversation.
        self.assertIn("--exclude-tools subagents_enable,bg_wait ", complete)

    def test_lane_worktrees_is_a_root_extension_and_its_absence_is_reported_not_fatal(self):
        entry = "lane-worktrees/index.ts"
        self.assertIn(entry, m.ROOT_EXTENSIONS)
        self.assertNotIn(entry, m.LANE_EXTENSIONS + m.DISPATCH_EXTENSIONS)
        prefix = fake_prefix(self.tmp)
        self.assertIn(entry, m.missing_extensions(prefix))
        for rel in m.ROOT_EXTENSIONS + m.LANE_EXTENSIONS + m.DISPATCH_EXTENSIONS:
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

    def test_loop_status_is_root_only_so_lanes_and_the_dispatcher_set_no_status(self):
        entry = "loop-status/index.ts"
        self.assertIn(entry, m.ROOT_EXTENSIONS)
        self.assertNotIn(entry, m.LANE_EXTENSIONS)
        self.assertNotIn(entry, m.DISPATCH_EXTENSIONS)
        prefix = fake_prefix(self.tmp)
        self.assertEqual(m.missing_extensions(prefix).count(entry), 1)
        manifest = {"label": "x", "missing_extensions": []}
        root = m.launcher_text(prefix, self.tmp / "h", "/usr/bin/node", manifest, "loop-pi", "loop-pi-install")
        dispatcher = m.dispatch_launcher_text(prefix, self.tmp / "h", "/usr/bin/node", manifest, "loop-pi-dispatch",
                                              "loop-pi-install")
        flag = f"--extension '{prefix}/extensions/{entry}'"
        self.assertIn(flag, root)
        self.assertNotIn(flag, dispatcher)
        rels = {rel for rel, _ in m.source_files()}
        self.assertIn(f"extensions/{entry}", rels)
        self.assertFalse(any(rel.startswith("extensions/loop-status/") and "test" in rel.rsplit("/", 1)[1] for rel in rels))

    def test_ops_probe_is_in_the_installed_agent_set(self):
        self.assertIn("ops-probe", m.AGENT_SET)
        prefix = fake_prefix(self.tmp)
        agents = prefix / "home/agents"
        agents.mkdir(parents=True)
        for name in m.AGENT_SET - {"ops-probe"}:
            (agents / f"{name}.md").write_text("---\nname: x\n---\n")
        with self.assertRaises(m.InstallError) as ctx:
            m.check_agent_set(prefix)
        self.assertIn("ops-probe", str(ctx.exception))

    def agent_file(self, front_extra: str, body: str = "body\n") -> str:
        return f"---\nname: a\nmodel: openai/gpt-6-luna\n{front_extra}---\n{body}"

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

    def test_mapper_routes_survive_a_scratch_overlay_install(self):
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
        for name, model, thinking in (
            ("mapper-deep", "gpt-6.1-sol", "medium"),
            ("mapper", "gpt-6-luna", "medium"),
        ):
            source = (m.SRC / "home/agents" / f"{name}.md").read_text()
            installed = (tgt.home / "agents" / f"{name}.md").read_text()
            for text in (source, installed):
                front = text.split("---", 2)[1].splitlines()
                self.assertIn(f"model: openai/{model}", front)
                self.assertIn(f"thinking: {thinking}", front)
        smoke = (m.SRC / "extensions/test-support/smoke-overlay/home/agents/mapper-deep.md").read_text()
        # The offline smoke overlay must stay on its scripted provider, not a live model.
        self.assertIn("model: faux/faux-1", smoke.split("---", 2)[1].splitlines())
        self.assertIn("thinking: medium", smoke.split("---", 2)[1].splitlines())
        self.assertEqual(m.drift(prefix, tgt, "/usr/bin/node"), [])

    def test_the_variant_is_recorded_in_the_home_receipt(self):
        prefix = fake_prefix(self.tmp)
        tgt = target(self.tmp, variant="fast")
        apply(prefix, tgt)
        self.assertEqual(json.loads((tgt.home / m.HOME_MANIFEST).read_text())["variant"], "fast")
        plain = target(self.tmp, name=".loop-pi-plain")
        apply(prefix, plain)
        self.assertNotIn("variant", json.loads((plain.home / m.HOME_MANIFEST).read_text()))

    def test_root_route_and_family_come_from_settings(self):
        agents = {"loopPi": {"modelFamily": {"provider": "example", "pattern": "^m7-[a-z]+$", "name": "m7"},
                             "rootRoute": {"provider": "example", "model": "m7-large", "thinking": "high"}}}
        prefix = fake_prefix(self.tmp, settings=agents)
        text = m.launcher_text(prefix, self.tmp / "h", "/usr/bin/node", {"label": "x", "missing_extensions": []},
                               "loop-pi", "x")
        self.assertIn("--provider example --model m7-large --thinking high", text)
        (prefix / "home/agents").mkdir()
        (prefix / "home/agents/mapper.md").write_text("---\nname: mapper\nmodel: example/m7-small\n---\n")
        m.check_model_family(prefix)
        (prefix / "home/agents/mapper.md").write_text("---\nname: mapper\nmodel: openai/gpt-6-sol\n---\n")
        with self.assertRaisesRegex(m.InstallError, "mapper"):
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
        (prefix / "home/agents/scout.md").write_text("---\n")
        with self.assertRaises(m.InstallError):
            m.check_agent_set(prefix)

    def test_every_agent_and_the_root_run_the_default_family_only(self):
        prefix = fake_prefix(self.tmp)
        (prefix / "home/agents").mkdir()
        for name in m.AGENT_SET:
            (prefix / "home/agents" / f"{name}.md").write_text("---\nname: x\nmodel: openai/gpt-6-luna\n---\n")
        m.check_model_family(prefix)
        (prefix / "home/agents/mapper.md").write_text("---\nname: mapper\nmodel: openai/gpt-5.6-luna\n---\n")
        with self.assertRaisesRegex(m.InstallError, "mapper"):
            m.check_model_family(prefix)
        (prefix / "home/agents/mapper.md").write_text("---\nname: mapper\n---\nmodel: openai/gpt-6-luna\n")
        with self.assertRaisesRegex(m.InstallError, "mapper"):
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
            for route, expected in (({}, "medium"), ({"thinking": "high"}, "high")):
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


LANE_RETURN_V2 = """```lane-return
{"v":2,"lane":"<id>","status":"complete|partial|blocked|failed","sha":"<full>|null","landed":true|false,
 "base":"<full SHA>","check":"<exact command>","exit":<int>|null,"tail":"<last <= 40 lines>",
 "ci":"<run id>|null","coderabbit":{"ran":true|false,"major":<n>,"unreviewed":<n>}|null,
 "questions":["..."]}
```"""


class AgentReturnContractTests(unittest.TestCase):
    """Every lane agent carries the lane-return v2 block itself: an overlay replaces
    home/lane-policy.md at install time, so the policy cannot be where the contract lives. The
    triager returns a `triage` block instead, which its own file defines."""

    def test_every_lane_agent_carries_the_lane_return_v2_block(self):
        agents = sorted((HERE.parent / "home/agents").glob("*.md"))
        self.assertTrue(agents)
        for path in agents:
            text = path.read_text()
            self.assertNotIn("Return exactly:", text, path.name)
            if path.stem == "triager":
                self.assertNotIn("```lane-return", text, path.name)
                continue
            self.assertEqual(text.count(LANE_RETURN_V2), 1, f"{path.name} lacks the exact lane-return v2 block")


if __name__ == "__main__":
    unittest.main()
