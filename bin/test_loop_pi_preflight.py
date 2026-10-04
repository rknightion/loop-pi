#!/usr/bin/env python3
"""Table-driven tests for loop-pi-preflight. Stdlib unittest,
runnable as `python3 -m unittest bin.test_loop_pi_preflight -v` from `pi/`, or
directly as a script. Builds scratch git repos under a temp dir; never touches
~/.pi, ~/.loop-pi-personal, or this checkout.
"""
import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "loop-pi-preflight")

C3_AGENTS = [
    "mapper",
    "mapper-deep",
    "gate-runner",
    "lane-worker",
    "lane-worker-push",
    "lane-worker-low",
    "lane-worker-low-push",
    "lane-worker-retry",
    "lane-worker-retry-push",
    "complex-worker",
    "complex-worker-push",
    "reviewer",
    "reviewer-high",
    "security-reviewer",
    "rescue-sol",
    "rescue-astra",
    "ops",
    "ops-probe",
    "triager",
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


def run_preflight(repo, agent_dir=None):
    env = dict(os.environ)
    if agent_dir is not None:
        env["PI_CODING_AGENT_DIR"] = agent_dir
    else:
        env.pop("PI_CODING_AGENT_DIR", None)
    return subprocess.run([sys.executable, SCRIPT, repo], capture_output=True, text=True, env=env, timeout=30)


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
        write_c3_agent_dir(self.agent_dir, names=C3_AGENTS + ["scout"])
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside the C3 set", result.stderr)
        self.assertIn("scout", result.stderr)

    def test_missing_c3_agent_fails(self):
        shutil.rmtree(os.path.join(self.agent_dir, "agents"))
        write_c3_agent_dir(self.agent_dir, names=[n for n in C3_AGENTS if n != "rescue-astra"])
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing", result.stderr)
        self.assertIn("rescue-astra", result.stderr)

    def test_multiple_failures_are_all_reported(self):
        write(os.path.join(self.repo, ".pi", "settings.json"), "{}")
        write(os.path.join(self.repo, "untracked.txt"), "x\n")
        result = run_preflight(self.repo, self.agent_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".pi/settings.json", result.stderr)
        self.assertIn("not a clean checkout", result.stderr)


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
