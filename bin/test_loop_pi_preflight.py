#!/usr/bin/env python3
"""Table-driven tests for loop-pi-preflight. Stdlib unittest,
runnable as `python3 -m unittest bin.test_loop_pi_preflight -v` from `pi/`, or
directly as a script. Builds scratch git repos under a temp dir; never touches
~/.pi, ~/.loop-pi-personal, or this checkout.
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "loop-pi-preflight")

C3_AGENTS = [
    "worker",
    "composer",
    "senior",
    "senior-escalation",
    "reviewer",
    "scout",
]


def run_git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True)


def init_repo(repo):
    os.makedirs(repo, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def commit_all(repo, message="init"):
    subprocess.run(["git", "-C", repo, "add", "--", "."], check=True)
    subprocess.run(["git", "-C", repo, "commit", "-q", "-m", message, "--", "."], check=True)


def write_c3_agent_dir(agent_dir, names=None):
    names = C3_AGENTS if names is None else names
    for name in names:
        write(
            os.path.join(agent_dir, "agents", f"{name}.md"),
            f"---\nname: {name}\ndescription: test\n---\n\nSystem prompt.\n",
        )


def run_preflight(repo, agent_dir=None, extra_args=(), extra_env=None):
    env = dict(os.environ)
    env.update(extra_env or {})
    if agent_dir is not None:
        env["PI_CODING_AGENT_DIR"] = agent_dir
    else:
        env.pop("PI_CODING_AGENT_DIR", None)
    return subprocess.run([sys.executable, SCRIPT, repo, *extra_args], capture_output=True, text=True, env=env, timeout=30)


class LoopPiPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loop-pi-preflight-test-")
        self.repo = os.path.join(self.tmp, "repo")
        self.agent_dir = os.path.join(self.tmp, "agentdir")
        init_repo(self.repo)
        write(os.path.join(self.repo, ".gitignore"), ".pi/\n")
        write(os.path.join(self.repo, "README.md"), "hello\n")
        commit_all(self.repo)
        write_c3_agent_dir(self.agent_dir)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_clean_repo_passes(self):
        result = run_preflight(self.repo, self.agent_dir)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_git_dir_fails(self):
        bare_dir = os.path.join(self.tmp, "not-a-repo")
        os.makedirs(bare_dir)
        result = run_preflight(bare_dir, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a git checkout", result.stderr)

    def test_git_worktree_target_is_accepted(self):
        # A linked worktree's `.git` is a FILE (a "gitdir: <path>" pointer),
        # never a directory; the preflight must accept it as a git checkout
        # rather than rejecting it via a bare os.path.isdir(".git") check.
        worktree = os.path.join(self.tmp, "worktree")
        subprocess.run(["git", "-C", self.repo, "worktree", "add", "-q", worktree, "-b", "wt-branch"], check=True)
        self.assertTrue(os.path.isfile(os.path.join(worktree, ".git")), "fixture assumption: worktree .git is a file")
        # The worktree already inherits the .gitignore committed in setUp.
        result = run_preflight(worktree, self.agent_dir)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pi_settings_json_present_fails(self):
        write(os.path.join(self.repo, ".pi", "settings.json"), "{}")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/settings.json", result.stderr)

    def test_pi_system_md_present_fails(self):
        write(os.path.join(self.repo, ".pi", "SYSTEM.md"), "# system\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/SYSTEM.md", result.stderr)

    def test_pi_extensions_present_fails(self):
        write(os.path.join(self.repo, ".pi", "extensions", "evil.ts"), "export default () => {};\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/extensions/", result.stderr)

    def test_pi_agents_present_fails(self):
        write(os.path.join(self.repo, ".pi", "agents", "evil.md"), "---\nname: evil\n---\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/agents/", result.stderr)

    def test_legacy_dot_agents_md_present_fails(self):
        write(os.path.join(self.repo, ".agents", "evil.md"), "---\nname: evil\n---\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy .agents/*.md", result.stderr)

    def test_dot_pi_not_gitignored_fails(self):
        os.remove(os.path.join(self.repo, ".gitignore"))
        subprocess.run(["git", "-C", self.repo, "rm", "-q", "--cached", ".gitignore"], check=True)
        subprocess.run(["git", "-C", self.repo, "commit", "-q", "-m", "remove gitignore", "--", ".gitignore"], check=True)
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not gitignore .pi/", result.stderr)

    def test_dirty_checkout_fails(self):
        write(os.path.join(self.repo, "README.md"), "changed\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a clean checkout", result.stderr)

    def test_untracked_file_is_dirty_too(self):
        write(os.path.join(self.repo, "untracked.txt"), "x\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a clean checkout", result.stderr)

    def test_missing_agent_dir_env_fails(self):
        result = run_preflight(self.repo, agent_dir=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PI_CODING_AGENT_DIR is not set", result.stderr)

    def test_agent_outside_c3_fails(self):
        write_c3_agent_dir(self.agent_dir, names=C3_AGENTS + ["mapper"])
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside the C3 set", result.stderr)
        self.assertIn("mapper", result.stderr)

    def test_missing_c3_agent_fails(self):
        shutil.rmtree(os.path.join(self.agent_dir, "agents"))
        write_c3_agent_dir(self.agent_dir, names=[n for n in C3_AGENTS if n != "senior-escalation"])
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing", result.stderr)
        self.assertIn("senior-escalation", result.stderr)

    def test_multiple_failures_are_all_reported(self):
        write(os.path.join(self.repo, ".pi", "settings.json"), "{}")
        write(os.path.join(self.repo, "untracked.txt"), "x\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/settings.json", result.stderr)
        self.assertIn("not a clean checkout", result.stderr)


STUB_NODE = """#!{python}
import json, os, sys
state = os.environ["STUB_DIR"]
argv = sys.argv[1:]
with open(os.path.join(state, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps({{"argv": argv, "offline": os.environ.get("PI_OFFLINE"),
                         "agent_dir": os.environ.get("PI_CODING_AGENT_DIR")}}) + "\\n")
def read(name):
    with open(os.path.join(state, name)) as fh:
        return fh.read()
if argv[1:] == ["update", "--models"]:
    open(os.path.join(state, "refreshed"), "w").close()
    code = int(read("refresh_exit"))
    if code:
        sys.stderr.write("refresh went wrong\\n")
    sys.exit(code)
if argv[1:] == ["--list-models"]:
    refreshed = os.path.exists(os.path.join(state, "refreshed"))
    sys.stderr.write("Warning: noise on stderr openai/ghost-model\\n")
    sys.stdout.write(read("after.txt" if refreshed else "before.txt"))
    sys.exit(0)
sys.exit(9)
"""

TABLE_HEADER = "provider  model          context  max-out  thinking  images\n"


def table(*ids):
    return TABLE_HEADER + "".join(f"{i.split('/')[0]}  {i.split('/', 1)[1]}  400K  128K  yes  yes\n" for i in ids)


class EnabledModelsTests(unittest.TestCase):
    ENABLED = ["openai/gpt-6.2-sol", "openai/gpt-6.1-terra:high"]

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loop-pi-preflight-models-")
        self.repo = os.path.join(self.tmp, "repo")
        self.agent_dir = os.path.join(self.tmp, "agentdir")
        self.state = os.path.join(self.tmp, "state")
        os.makedirs(self.state)
        init_repo(self.repo)
        write(os.path.join(self.repo, ".gitignore"), ".pi/\n")
        commit_all(self.repo)
        write_c3_agent_dir(self.agent_dir)
        self.node = os.path.join(self.tmp, "node")
        write(self.node, STUB_NODE.format(python=sys.executable))
        os.chmod(self.node, 0o755)
        self.set_enabled(self.ENABLED)
        self.set_stub(before=table("openai/gpt-6.2-sol", "openai/gpt-6.1-terra"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def set_enabled(self, enabled):
        settings = {} if enabled is None else {"enabledModels": enabled}
        write(os.path.join(self.agent_dir, "settings.json"), json.dumps(settings))

    def set_stub(self, before, after=None, refresh_exit=0):
        write(os.path.join(self.state, "before.txt"), before)
        write(os.path.join(self.state, "after.txt"), before if after is None else after)
        write(os.path.join(self.state, "refresh_exit"), str(refresh_exit))

    def calls(self):
        path = os.path.join(self.state, "calls.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as fh:
            return [json.loads(line) for line in fh]

    def run_check(self, with_stub=True):
        args = ["--node", self.node, "--pi-cli", "/fake/pi/cli.js"] if with_stub else []
        return run_preflight(self.repo, self.agent_dir, args, {"STUB_DIR": self.state})

    def test_all_models_listed_passes_without_refresh(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([c["argv"][1:] for c in calls], [["--list-models"]])
        self.assertEqual(calls[0]["offline"], "1")
        self.assertEqual(calls[0]["agent_dir"], self.agent_dir)

    def test_missing_model_present_after_refresh_passes(self):
        self.set_stub(before=table("openai/gpt-6.1-terra"),
                      after=table("openai/gpt-6.1-terra", "openai/gpt-6.2-sol"))
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        steps = [c["argv"][1:] for c in self.calls()]
        self.assertEqual(steps, [["--list-models"], ["update", "--models"], ["--list-models"]])
        refresh = self.calls()[1]
        self.assertIsNone(refresh["offline"])
        self.assertEqual(refresh["agent_dir"], self.agent_dir)

    def test_missing_model_after_refresh_fails_and_names_it(self):
        self.set_stub(before=table("openai/gpt-6.1-terra"))
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("openai/gpt-6.2-sol", result.stderr)
        self.assertNotIn("openai/gpt-6.1-terra,", result.stderr)
        self.assertIn("pi update --models", result.stderr)
        self.assertEqual(sum(c["argv"][1:] == ["update", "--models"] for c in self.calls()), 1)

    def test_every_thinking_suffix_pi_accepts_is_stripped(self):
        for level in ("off", "minimal", "low", "medium", "high", "xhigh", "max"):
            with self.subTest(level=level):
                self.set_enabled([f"openai/gpt-6.2-sol:{level}"])
                result = self.run_check()
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_provider_with_no_listed_models_is_skipped_not_refused(self):
        # pi lists only models it has a credential for: a home with no sign-in for the provider
        # prints a "No models available" line and no rows, which says nothing about the catalogue.
        self.set_stub(before="No models available. Use /login to log into a provider via OAuth or API key. See:\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no credential for provider openai", result.stderr)
        self.assertEqual([c["argv"][1:] for c in self.calls()], [["--list-models"]])

    def test_failed_refresh_is_reported_when_models_stay_missing(self):
        self.set_stub(before=table("openai/gpt-6.1-terra"), refresh_exit=1)
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("openai/gpt-6.2-sol", result.stderr)
        self.assertIn("refresh failed", result.stderr)
        self.assertIn("refresh went wrong", result.stderr)

    def test_failed_refresh_is_not_a_failure_when_models_resolve(self):
        self.set_stub(before=table("openai/gpt-6.1-terra"),
                      after=table("openai/gpt-6.1-terra", "openai/gpt-6.2-sol"), refresh_exit=1)
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_without_node_and_cli_the_check_is_skipped(self):
        self.set_stub(before=table("openai/gpt-6.1-terra"))
        result = self.run_check(with_stub=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertIn("skipping the enabledModels check", result.stderr)

    def test_no_enabled_models_is_skipped(self):
        for enabled in (None, []):
            with self.subTest(enabled=enabled):
                self.set_enabled(enabled)
                result = self.run_check()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()


class AgentSetParity(unittest.TestCase):
    """The preflight, the installer and the shipped agent files must name the same agents, or every
    launch after an install fails its preflight."""

    @staticmethod
    def load(name, path):
        loader = importlib.machinery.SourceFileLoader(name, path)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def test_preflight_installer_and_agent_files_agree(self):
        root = os.path.dirname(HERE)
        preflight = self.load("loop_pi_preflight_parity", SCRIPT)
        installer = self.load("loop_pi_install_parity", os.path.join(HERE, "loop-pi-install"))
        agents = os.path.join(root, "home", "agents")
        files = {name[:-3] for name in os.listdir(agents) if name.endswith(".md")}
        self.assertEqual(set(preflight.C3_AGENTS), files)
        self.assertEqual(set(installer.AGENT_SET), files)
        self.assertEqual(set(C3_AGENTS), files)
