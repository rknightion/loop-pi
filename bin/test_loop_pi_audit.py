#!/usr/bin/env python3
"""Table-driven tests for loop-pi-audit. Stdlib unittest,
runnable as `python3 -m unittest bin.test_loop_pi_audit -v` from `pi/`, or
directly as a script. Builds scratch git repos with a local bare "remote"
(file-path, no network) under a temp dir.
"""
import hashlib
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
SCRIPT = os.path.join(HERE, "loop-pi-audit")
GIT = "/usr/bin/git" if sys.platform == "darwin" else shutil.which("git")


def git(repo, *args, check=True):
    return subprocess.run([GIT, "-C", repo, *args], capture_output=True, text=True, check=check, timeout=60)


def init_repo_with_remote(tmp, name):
    remote = os.path.join(tmp, f"{name}-remote.git")
    repo = os.path.join(tmp, name)
    subprocess.run([GIT, "init", "--bare", "-q", remote], check=True, timeout=60)
    os.makedirs(repo)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "test")
    with open(os.path.join(repo, "f.txt"), "w", encoding="utf-8") as fh:
        fh.write("hi\n")
    git(repo, "add", "--", "f.txt")
    git(repo, "commit", "-q", "-m", "init", "--", "f.txt")
    git(repo, "branch", "-M", "main")
    git(repo, "remote", "add", "origin", remote)
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/main")
    return repo, remote


def run_audit(*args, env_overrides=None):
    env = {k: v for k, v in os.environ.items() if k != "LOOP_PI_RUN_DIR"}
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, env=env, timeout=60)


def make_bin_without_gh(tmp):
    """A PATH directory that has `git` (symlinked from the real one) but no `gh`."""
    fake_bin = os.path.join(tmp, "fake-bin")
    os.makedirs(fake_bin, exist_ok=True)
    real_git = GIT
    assert real_git, "git must be on PATH to build this fixture"
    os.symlink(real_git, os.path.join(fake_bin, "git"))
    return fake_bin


def make_bin_with_gh_stub(tmp, releases_json="[]", name="fake-bin-gh-ok"):
    """A PATH directory with real `git` and a stub `gh` that always succeeds
    for `gh release list --json ... --limit 1000`, returning `releases_json`.

    None of these scratch repos have a real GitHub remote, so the real `gh`
    binary always fails `gh release list` here ("none of the git remotes
    configured for this repository point to a known GitHub host"), which
    would make every releases comparison in this suite spuriously
    "unavailable" and, a fail-closed violation. This stub
    keeps releases genuinely comparable so tests can pin ref/tag behaviour
    without also pinning "not a real GitHub repo" as a releases violation;
    the dedicated releases-unavailable test below still uses
    make_bin_without_gh() to exercise that path directly.
    """
    fake_bin = os.path.join(tmp, name)
    os.makedirs(fake_bin, exist_ok=True)
    real_git = GIT
    assert real_git, "git must be on PATH to build this fixture"
    os.symlink(real_git, os.path.join(fake_bin, "git"))
    gh_stub = os.path.join(fake_bin, "gh")
    with open(gh_stub, "w", encoding="utf-8") as fh:
        # `echo` is a shell builtin, so this never depends on anything else
        # being on the deliberately narrowed PATH this stub is used under.
        fh.write(f"#!/bin/sh\necho '{releases_json}'\n")
    os.chmod(gh_stub, 0o755)
    return fake_bin


def snapshot(out_path, *repos, env_overrides=None):
    result = run_audit("snapshot", "--out", out_path, *repos, env_overrides=env_overrides)
    assert result.returncode == 0, result.stderr
    return result


class DuplicateRemoteTests(unittest.TestCase):
    """Two snapshot paths that read the same unchanged remote URL, through the CLI against a real
    bare remote."""

    def two_paths(self, tmp):
        first, remote = init_repo_with_remote(tmp, "first")
        git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
        second = os.path.join(tmp, "second")
        subprocess.run([GIT, "clone", "--no-local", "-q", remote, second], check=True, timeout=60)
        git(second, "config", "user.email", "someone@example.com")
        git(second, "config", "user.name", "someone")
        return first, second

    def test_an_unaccounted_move_is_reported_under_every_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.two_paths(tmp)
            env = {"PATH": make_bin_with_gh_stub(tmp)}
            before, after = (os.path.join(tmp, f"{phase}.json") for phase in ("before", "after"))
            snapshot(before, *paths, env_overrides=env)
            git(paths[0], "commit", "--allow-empty", "-q", "-m", "advance")
            git(paths[0], "push", "-q", "origin", "main")
            snapshot(after, *paths, env_overrides=env)
            result = run_audit("compare", before, after, env_overrides=env)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            moves = [line for line in result.stdout.splitlines() if "ref moved: refs/heads/main " in line]
            self.assertEqual(len(moves), 2, result.stdout)
            for path in paths:
                self.assertTrue(any(f"[{path}]" in line and "[UNGRANTED]" in line for line in moves))

    def test_an_accounted_move_on_a_shared_endpoint_is_reported_once(self):
        # A backlog-only commit is accounted for under both paths; the identical GRANTED line for
        # the second path reading the same URL is not repeated.
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.two_paths(tmp)
            env = {"PATH": make_bin_with_gh_stub(tmp)}
            before, after = (os.path.join(tmp, f"{phase}.json") for phase in ("before", "after"))
            snapshot(before, *paths, env_overrides=env)
            os.makedirs(os.path.join(paths[0], "backlog"))
            with open(os.path.join(paths[0], "backlog", "task.md"), "w", encoding="utf-8") as fh:
                fh.write("task\n")
            git(paths[0], "add", "--", "backlog/task.md")
            git(paths[0], "commit", "-q", "-m", "task", "--", "backlog/task.md")
            git(paths[0], "push", "-q", "origin", "main")
            snapshot(after, *paths, env_overrides=env)
            log = os.path.join(tmp, "push-log.jsonl")
            open(log, "w", encoding="utf-8").close()
            result = run_audit("compare", before, after, "--push-log", log, env_overrides=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            moves = [line for line in result.stdout.splitlines() if "ref moved: refs/heads/main " in line]
            self.assertEqual(len(moves), 1, result.stdout)
            self.assertIn("[GRANTED]", moves[0])
            self.assertNotIn("UNGRANTED", result.stdout)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loop-pi-audit-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_records_remote_refs_and_local_tags(self):
        repo, _remote = init_repo_with_remote(self.tmp, "repoA")
        git(repo, "tag", "v1")
        git(repo, "push", "-q", "origin", "v1")

        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo)
        with open(out) as fh:
            data = json.load(fh)

        entry = data["repos"][repo]
        self.assertIn("origin", entry["remotes"])
        self.assertTrue(entry["remotes"]["origin"]["available"])
        self.assertIn("refs/heads/main", entry["remotes"]["origin"]["refs"])
        self.assertIn("refs/tags/v1", entry["remotes"]["origin"]["refs"])
        self.assertTrue(entry["tags"]["available"])
        self.assertIn("refs/tags/v1", entry["tags"]["tags"])

    def test_snapshot_gh_unavailable_is_recorded_as_unavailable_never_empty(self):
        repo, _remote = init_repo_with_remote(self.tmp, "repoB")
        fake_bin = make_bin_without_gh(self.tmp)
        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo, env_overrides={"PATH": fake_bin})
        with open(out) as fh:
            data = json.load(fh)
        releases = data["repos"][repo]["releases"]
        self.assertFalse(releases["available"])
        self.assertIn("reason", releases)
        self.assertNotIn("releases", releases)

    def test_snapshot_non_github_remote_records_releases_as_not_applicable_without_gh(self):
        # A repository whose only remote is a non-GitHub host (Forgejo) has no GitHub
        # releases to audit: gh must not be asked, and the snapshot must not fail.
        repo, _remote = init_repo_with_remote(self.tmp, "repoForge")
        git(repo, "remote", "set-url", "origin", "ssh://git@forge.example.org/rob/repoForge.git")
        fake_bin = make_bin_without_gh(self.tmp)
        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo, env_overrides={"PATH": fake_bin, "GIT_SSH_COMMAND": "false"})
        with open(out) as fh:
            data = json.load(fh)
        entry = data["repos"][repo]
        self.assertTrue(entry["releases"]["available"])
        self.assertEqual(entry["releases"]["releases"], [])
        self.assertIn("no GitHub remote", entry["releases"]["note"])

    def test_snapshot_repo_with_no_remotes(self):
        repo = os.path.join(self.tmp, "lonely")
        os.makedirs(repo)
        git(repo, "init", "-q")
        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo)
        with open(out) as fh:
            data = json.load(fh)
        self.assertEqual(data["repos"][repo]["remotes"], {})


    def test_an_insteadof_alias_that_expands_to_github_still_uses_gh(self):
        repo, _remote = init_repo_with_remote(self.tmp, "repoAlias")
        git(repo, "remote", "set-url", "origin", "gh:rknightion/example.git")
        git(repo, "config", "url.git@github.com:.insteadOf", "gh:")
        fake_bin = make_bin_without_gh(self.tmp)
        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo, env_overrides={"PATH": fake_bin, "GIT_SSH_COMMAND": "false"})
        with open(out) as fh:
            data = json.load(fh)
        releases = data["repos"][repo]["releases"]
        self.assertFalse(releases["available"])
        self.assertIn("gh is not installed", releases["reason"])

    def test_a_github_push_url_behind_a_non_github_fetch_url_still_uses_gh(self):
        repo, _remote = init_repo_with_remote(self.tmp, "repoPush")
        git(repo, "remote", "set-url", "origin", "ssh://git@forge.example.org/rob/repoPush.git")
        git(repo, "remote", "set-url", "--push", "origin", "git@github.com:rknightion/example.git")
        fake_bin = make_bin_without_gh(self.tmp)
        out = os.path.join(self.tmp, "snap.json")
        snapshot(out, repo, env_overrides={"PATH": fake_bin, "GIT_SSH_COMMAND": "false"})
        with open(out) as fh:
            data = json.load(fh)
        releases = data["repos"][repo]["releases"]
        self.assertFalse(releases["available"])
        self.assertIn("gh is not installed", releases["reason"])

    def test_a_github_enterprise_host_configured_in_gh_still_uses_gh(self):
        repo, _remote = init_repo_with_remote(self.tmp, "repoGhe")
        git(repo, "remote", "set-url", "origin", "git@ghe.example.org:team/example.git")
        gh_config = os.path.join(self.tmp, "gh-config")
        os.makedirs(gh_config)
        with open(os.path.join(gh_config, "hosts.yml"), "w") as fh:
            fh.write("github.com:\n    user: someone\nghe.example.org:\n    user: someone\n")
        fake_bin = make_bin_without_gh(self.tmp)
        out = os.path.join(self.tmp, "snap.json")
        env = {"PATH": fake_bin, "GIT_SSH_COMMAND": "false", "GH_CONFIG_DIR": gh_config}
        snapshot(out, repo, env_overrides=env)
        with open(out) as fh:
            data = json.load(fh)
        releases = data["repos"][repo]["releases"]
        self.assertFalse(releases["available"])
        self.assertIn("gh is not installed", releases["reason"])


class RemoteHostTests(unittest.TestCase):
    def test_remote_host_parses_network_urls_and_leaves_local_paths_to_gh(self):
        import importlib.machinery
        import importlib.util
        loader = importlib.machinery.SourceFileLoader("loop_pi_audit", SCRIPT)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        cases = {
            "git@github.com:rknightion/loop-pi.git": "github.com",
            "https://github.com/rknightion/loop-pi.git": "github.com",
            "ssh://git@forgejo.example.net:2222/rob/agents.git": "forgejo.example.net",
            "https://forgejo.example.net/rob/agents.git": "forgejo.example.net",
            "/tmp/some/bare.git": None,
            "file:///tmp/some/bare.git": None,
        }
        for url, host in cases.items():
            self.assertEqual(mod.remote_host(url), host, url)


class CompareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loop-pi-audit-cmp-test-")
        self.repo, self.remote = init_repo_with_remote(self.tmp, "repo")
        # Real `gh` always fails `gh release list` against these scratch
        # repos (no real GitHub remote), which makes
        # releases "unavailable" a fail-closed violation (see
        # test_releases_unavailable_on_one_side_is_unverified_and_fails_closed
        # below). Snapshotting through a stub `gh` keeps every other test in
        # this class free to pin ref/tag behaviour without also tripping that
        # violation.
        self.gh_bin = make_bin_with_gh_stub(self.tmp)
        self.before = os.path.join(self.tmp, "before.json")
        snapshot(self.before, self.repo, env_overrides={"PATH": self.gh_bin})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _snapshot_after(self):
        after = os.path.join(self.tmp, "after.json")
        snapshot(after, self.repo, env_overrides={"PATH": self.gh_bin})
        return after

    def test_no_changes_exits_zero(self):
        after = self._snapshot_after()
        result = run_audit("compare", self.before, after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no remote changes detected", result.stdout)

    def test_added_branch_ungranted_exits_one(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "feature commit")
        git(self.repo, "push", "-q", "origin", "feature")
        after = self._snapshot_after()

        result = run_audit("compare", self.before, after)
        self.assertEqual(result.returncode, 1)
        self.assertIn("refs/heads/feature", result.stdout)
        self.assertIn("added", result.stdout)
        self.assertIn("UNGRANTED", result.stdout)

    def test_moved_ref_detected(self):
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "move main forward")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()

        result = run_audit("compare", self.before, after)
        self.assertEqual(result.returncode, 1)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("moved", result.stdout)

    def test_deleted_tag_detected(self):
        git(self.repo, "tag", "v1")
        git(self.repo, "push", "-q", "origin", "v1")
        mid = os.path.join(self.tmp, "mid.json")
        # Through the gh stub like every other snapshot: with the real gh the
        # mid snapshot's releases are unavailable, which fails the compare on
        # its own and would hide a tag deletion wrongly treated as covered.
        snapshot(mid, self.repo, env_overrides={"PATH": self.gh_bin})

        git(self.repo, "push", "-q", "origin", "--delete", "v1")
        git(self.repo, "tag", "-d", "v1")
        after = self._snapshot_after()

        result = run_audit("compare", mid, after)
        self.assertEqual(result.returncode, 1)
        self.assertIn("refs/tags/v1", result.stdout)
        self.assertIn("deleted", result.stdout)

    def test_pull_refs_are_foreign(self):
        # GitHub recomputes refs/pull/<n>/merge whenever the base moves, so it
        # is foreign, as is the synthesised head ref.
        git(self.repo, "push", "-q", "origin", "HEAD:refs/pull/7/merge")
        git(self.repo, "push", "-q", "origin", "HEAD:refs/pull/7/head")
        before = os.path.join(self.tmp, "before-pull.json")
        snapshot(before, self.repo, env_overrides={"PATH": self.gh_bin})
        with open(before) as fh:
            refs = json.load(fh)["repos"][self.repo]["remotes"]["origin"]["refs"]
        self.assertIn("refs/pull/7/merge", refs)
        self.assertIn("refs/pull/7/head", refs)

        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "base moved")
        git(self.repo, "push", "-q", "-f", "origin", "HEAD:refs/pull/7/merge")
        git(self.repo, "push", "-q", "origin", "HEAD:refs/pull/8/merge")
        after = self._snapshot_after()

        result = run_audit("compare", before, after)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/pull/7/merge", result.stdout)
        self.assertIn("refs/pull/8/merge", result.stdout)
        self.assertIn("FOREIGN", result.stdout)

        git(self.repo, "push", "-q", "-f", "origin", "HEAD:refs/pull/7/head")
        after_head = os.path.join(self.tmp, "after-head.json")
        snapshot(after_head, self.repo, env_overrides={"PATH": self.gh_bin})
        result = run_audit("compare", after, after_head)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/pull/7/head", result.stdout)
        self.assertIn("FOREIGN", result.stdout)

    def _push_log(self, *entries):
        """A push log at a fixed path holding `(old, new)` ranges for origin's main."""
        path = os.path.join(self.tmp, "push-log.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for old, new in entries:
                fh.write(json.dumps({"repo": self.repo, "remote": "origin", "ref": "refs/heads/main",
                                     "old": old, "new": new}) + "\n")
        return path

    def _head(self):
        return git(self.repo, "rev-parse", "HEAD").stdout.strip()

    def test_derived_head_follows_main_and_legacy_snapshot_is_readable(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        snapshot(self.before, self.repo, env_overrides={"PATH": self.gh_bin})
        with open(self.before) as fh:
            legacy = json.load(fh)
        legacy["repos"][self.repo]["remotes"]["origin"].pop("symrefs", None)
        with open(self.before, "w") as fh:
            json.dump(legacy, fh)
        old = self._head()
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "advance")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()
        result = run_audit("compare", self.before, after, "--push-log", self._push_log((old, self._head())))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("GRANTED derived HEAD", result.stdout)
        self.assertNotIn("UNGRANTED", result.stdout)
        # Without the push log the same move, and HEAD with it, is not accounted for.
        denied = run_audit("compare", self.before, after)
        self.assertEqual(denied.returncode, 1)
        self.assertIn("UNGRANTED derived HEAD", denied.stdout)

    def test_head_retarget_same_object_is_ungranted(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        git(self.repo, "push", "-q", "origin", "HEAD:refs/heads/other")
        snapshot(self.before, self.repo, env_overrides={"PATH": self.gh_bin})
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/other")
        after = self._snapshot_after()
        for extra in ([], ["--push-log", self._push_log()]):
            with self.subTest(extra=extra):
                denied = run_audit("compare", self.before, after, *extra)
                self.assertEqual(denied.returncode, 1, denied.stdout + denied.stderr)
                self.assertIn("UNGRANTED derived HEAD", denied.stdout)

    def test_snapshot_records_head_symref(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        after = self._snapshot_after()
        with open(after) as fh:
            remote = json.load(fh)["repos"][self.repo]["remotes"]["origin"]
        self.assertEqual(remote["symrefs"]["HEAD"], "refs/heads/main")

    def test_annotated_tag_and_its_peel_are_ungranted(self):
        git(self.repo, "tag", "-a", "v2", "-m", "release")
        git(self.repo, "push", "-q", "origin", "v2")
        after = self._snapshot_after()
        denied = run_audit("compare", self.before, after)
        self.assertEqual(denied.returncode, 1, denied.stdout + denied.stderr)
        for ref in ("refs/tags/v2 ", "refs/tags/v2^{} "):
            self.assertTrue(any(f"remote 'origin' ref added: {ref}" in line and "[UNGRANTED]" in line
                                for line in denied.stdout.splitlines()), denied.stdout)
        self.assertIn("tag added: refs/tags/v2 ", denied.stdout)

    def test_releases_unavailable_on_one_side_is_unverified_and_fails_closed(self):
        # Releases unreadable on either side means the audit
        # cannot prove no ungranted release change occurred, so it must fail
        # closed (non-zero, and never print the "every remote change is
        # covered" success line) rather than silently skip the comparison.
        fake_bin = make_bin_without_gh(self.tmp)
        before_no_gh = os.path.join(self.tmp, "before_no_gh.json")
        snapshot(before_no_gh, self.repo, env_overrides={"PATH": fake_bin})
        after = self._snapshot_after()  # working gh stub: releases genuinely available

        result = run_audit("compare", before_no_gh, after)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("releases", result.stdout)
        self.assertIn("unavailable", result.stdout)
        self.assertNotIn("every remote change is accounted for", result.stdout)

    def test_remote_unavailable_on_one_side_is_unverified_and_fails_closed(self):
        # Hand-crafted snapshots: a remote's ls-remote failed on one side.
        # This does not need a real repo on disk because compare only reads
        # the snapshot JSON for this branch (it never re-touches the remote).
        before_path = os.path.join(self.tmp, "before_remote_unavail.json")
        after_path = os.path.join(self.tmp, "after_remote_unavail.json")
        with open(before_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "repos": {
                        "fake-repo": {
                            "remotes": {"origin": {"available": False, "reason": "git ls-remote origin timed out"}},
                            "tags": {"available": True, "tags": {}},
                            "releases": {"available": True, "releases": []},
                        }
                    }
                },
                fh,
            )
        with open(after_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "repos": {
                        "fake-repo": {
                            "remotes": {"origin": {"available": True, "refs": {"refs/heads/main": "a" * 40}}},
                            "tags": {"available": True, "tags": {}},
                            "releases": {"available": True, "releases": []},
                        }
                    }
                },
                fh,
            )
        result = run_audit("compare", before_path, after_path)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ls-remote unavailable on one side", result.stdout)

    def test_repo_missing_from_after_snapshot_is_unverified_and_fails_closed(self):
        # A repo dropped from the closeout snapshot entirely (crashed audit
        # run, wrong repo list, ...) must not be silently treated as "no
        # remotes, nothing to check": that would hide every change made to it.
        after = self._snapshot_after()
        with open(after, encoding="utf-8") as fh:
            after_data = json.load(fh)
        del after_data["repos"][self.repo]
        with open(after, "w", encoding="utf-8") as fh:
            json.dump(after_data, fh)

        result = run_audit("compare", self.before, after)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("missing", result.stdout.lower())

    def test_logged_fast_forward_move_exits_zero(self):
        old = self._head()
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "fast-forward move")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()

        result = run_audit("compare", self.before, after, "--push-log", self._push_log((old, self._head())))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("[GRANTED]", result.stdout)
        self.assertNotIn("NON-FAST-FORWARD", result.stdout)
        self.assertIn("every remote change is accounted for", result.stdout)

    def test_non_fast_forward_move_is_a_violation_even_when_logged(self):
        # Rewrite history (force push) instead of moving main forward.
        old = self._head()
        git(self.repo, "commit", "-q", "--amend", "-m", "rewritten")
        git(self.repo, "push", "-q", "--force", "origin", "main")
        after = self._snapshot_after()

        logged = run_audit("compare", self.before, after, "--push-log", self._push_log((old, self._head())))
        self.assertEqual(logged.returncode, 1, logged.stdout + logged.stderr)
        self.assertIn("refs/heads/main", logged.stdout)
        self.assertIn("NON-FAST-FORWARD (granted, but blocked)", logged.stdout)
        unlogged = run_audit("compare", self.before, after)
        self.assertEqual(unlogged.returncode, 1, unlogged.stdout + unlogged.stderr)
        self.assertIn("NON-FAST-FORWARD UNGRANTED", unlogged.stdout)

    def test_moved_ref_fetch_failure_is_unverified_and_fails_closed(self):
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "move main forward")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()

        # The remote becomes unreachable between the after-snapshot and the
        # compare call, so the compare-time fetch used to verify fast-forward
        # ancestry fails: this must be reported as unverified, not silently
        # skipped.
        shutil.rmtree(self.remote)

        result = run_audit("compare", self.before, after)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("UNVERIFIED", result.stdout)


class RunDirTests(unittest.TestCase):
    """Per-run audit (`begin`/`add`/`closeout`): each loop keeps its snapshots in its own run dir,
    so concurrent runs never share a before-snapshot."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loop-pi-audit-run-test-")
        self.repo, self.remote = init_repo_with_remote(self.tmp, "repo")
        self.gh_bin = make_bin_with_gh_stub(self.tmp)
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.env = {"PATH": self.gh_bin, "LOOP_PI_RUN_DIR": self.run_dir}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def push_new_branch(self, repo, name):
        git(repo, "push", "-q", "origin", f"HEAD:refs/heads/{name}")

    def test_closeout_compares_against_the_run_dirs_own_before_snapshot(self):
        result = run_audit("begin", self.repo, env_overrides=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.run_dir, "audit-before.json")))
        clean = run_audit("closeout", env_overrides=self.env)
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.run_dir, "audit-after.json")))
        self.push_new_branch(self.repo, "stray")
        dirty = run_audit("closeout", env_overrides=self.env)
        self.assertEqual(dirty.returncode, 1, dirty.stdout + dirty.stderr)
        self.assertIn("refs/heads/stray", dirty.stdout)

    def test_add_brings_a_second_repo_into_the_run(self):
        other, _ = init_repo_with_remote(self.tmp, "other")
        run_audit("begin", self.repo, env_overrides=self.env)
        added = run_audit("add", other, env_overrides=self.env)
        self.assertEqual(added.returncode, 0, added.stderr)
        self.push_new_branch(other, "stray")
        result = run_audit("closeout", env_overrides=self.env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refs/heads/stray", result.stdout)

    def test_add_never_replaces_a_repos_first_before_snapshot(self):
        run_audit("begin", self.repo, env_overrides=self.env)
        self.push_new_branch(self.repo, "stray")
        again = run_audit("add", self.repo, env_overrides=self.env)
        self.assertEqual(again.returncode, 0, again.stderr)
        result = run_audit("closeout", env_overrides=self.env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refs/heads/stray", result.stdout)

    def test_begin_refuses_a_repo_it_cannot_fully_read(self):
        env = {**self.env, "PATH": make_bin_without_gh(self.tmp)}
        result = run_audit("begin", self.repo, env_overrides=env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "audit-before.json")))

    def test_closeout_without_a_run_dir_is_an_error(self):
        env = {k: v for k, v in os.environ.items() if k != "LOOP_PI_RUN_DIR"}
        result = subprocess.run([sys.executable, SCRIPT, "closeout"], capture_output=True, text=True,
                                env=env, timeout=60)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)


class RemovedOptionTests(unittest.TestCase):
    def test_compare_and_closeout_reject_the_removed_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            for option in ("--grants", "--grants-sha256", "--ops", "--ops-sha256"):
                for argv in (["compare", os.path.join(tmp, "before.json"), os.path.join(tmp, "after.json")],
                             ["closeout", "--run-dir", tmp]):
                    with self.subTest(command=argv[0], option=option):
                        result = run_audit(*argv, option, os.path.join(tmp, "x.json"))
                        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                        self.assertIn(f"unrecognized arguments: {option}", result.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "audit-after.json")))


class ProtoDefaultBranchTests(unittest.TestCase):
    """With the run dir's `loop-pi-proto` marker, or protocol evidence retained in a snapshot, a move
    of the default branch is accounted for only by the push log or `backlog/`-only commits."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="loop-pi-audit-proto-test-"))
        self.repo, self.remote = init_repo_with_remote(self.tmp, "repo")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.other = os.path.join(self.tmp, "other")
        subprocess.run([GIT, "clone", "--no-local", "-q", self.remote, self.other], check=True, timeout=60)
        git(self.other, "config", "user.email", "someone@example.com")
        git(self.other, "config", "user.name", "someone")
        self.gh_bin = make_bin_with_gh_stub(self.tmp)
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.env = {"PATH": self.gh_bin, "LOOP_PI_RUN_DIR": self.run_dir}
        self.log_path = os.path.join(self.run_dir, "push-log.jsonl")
        self.begun = False

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def proto(self):
        with open(os.path.join(self.run_dir, "loop-pi-proto"), "w", encoding="utf-8") as fh:
            fh.write("2\n")

    def begin(self):
        self.assertEqual(run_audit("begin", self.repo, env_overrides=self.env).returncode, 0)

    def head(self, repo):
        return git(repo, "rev-parse", "HEAD").stdout.strip()

    def commit(self, repo, name, message="c", env=None, author=None):
        path = os.path.join(repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(message + "\n")
        git(repo, "add", "--", name)
        cmd = [GIT, "-C", repo, "commit", "-q", "-m", message]
        if author:
            cmd += ["--author", author]
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})
        return self.head(repo)

    def logged_push(self, repo, old, new, ref="refs/heads/main", log_repo=None):
        git(repo, "push", "-q", "origin", f"{new}:{ref}")
        entry = {"v": 1, "ts": "2026-10-04T00:00:00Z", "actor": "lane", "agent": "lane-worker", "lane": "L1",
                 "repo": log_repo or self.repo, "remote": "origin", "ref": ref, "old": old, "new": new}
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def closeout(self, *extra):
        return run_audit("closeout", *extra, env_overrides=self.env)

    def note_names(self, result, sha):
        """The commit-by-commit verdict ran: a `note:` line names the unaccounted commit."""
        return any(" note: " in line and f"commit {sha[:12]} " in line for line in result.stdout.splitlines())

    def ready(self):
        self.proto()
        self.begin()
        self.start = self.head(self.repo)

    def test_a_logged_push_accounts_for_the_default_branch_move(self):
        self.ready()
        c1 = self.commit(self.repo, "f.txt", "one")
        c2 = self.commit(self.repo, "f.txt", "two")
        self.logged_push(self.repo, self.start, c2)
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("GRANTED derived HEAD", result.stdout)
        self.assertNotIn("UNGRANTED", result.stdout)
        self.assertTrue(c1)

    def test_receipt_cannot_follow_a_changed_snapshot_endpoint(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, c)
        twin = os.path.join(self.tmp, "twin.git")
        subprocess.run([GIT, "init", "--bare", "-q", twin], check=True, timeout=60)
        git(self.repo, "push", "-q", twin, "main")
        git(twin, "symbolic-ref", "HEAD", "refs/heads/main")
        git(self.repo, "remote", "set-url", "origin", twin)
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(c[:12], result.stdout)
        self.assertIn("UNGRANTED", result.stdout)

    def test_receipt_remote_is_required_valid_and_exactly_scoped(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, c)
        with open(self.log_path, encoding="utf-8") as fh:
            original = json.loads(fh.read())
        for remote in (None, "", " origin", "origin\n", ["origin"], {"name": "origin"}, "mirror", "--all", "a:b"):
            with self.subTest(remote=remote):
                entry = {**original, "remote": remote}
                if remote is None:
                    entry.pop("remote")
                with open(self.log_path, "w", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry) + "\n")
                result = self.closeout()
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(c[:12], result.stdout)
                self.assertIn("UNGRANTED", result.stdout)
        with open(self.log_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(original) + "\n")
        self.assertEqual(self.closeout().returncode, 0)

    def test_deleting_the_marker_cannot_downgrade_an_armed_snapshot(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, c)
        os.unlink(os.path.join(self.run_dir, "loop-pi-proto"))
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")
        unlogged = self.commit(self.other, "g.txt", "unlogged")
        git(self.other, "push", "-q", "origin", "main")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.note_names(result, unlogged), result.stdout)

    def test_arm_retains_pre_arm_snapshot_without_resnapshotting(self):
        self.begin()
        before_path = os.path.join(self.run_dir, "audit-before.json")
        with open(before_path, encoding="utf-8") as fh:
            original = json.load(fh)
        unlogged = self.commit(self.other, "g.txt", "unlogged before arm")
        git(self.other, "push", "-q", "origin", "main")
        self.proto()
        retained = run_audit("retain-protocol", env_overrides=self.env)
        self.assertEqual(retained.returncode, 0, retained.stdout + retained.stderr)
        with open(before_path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {**original, "protocol": 2})
        os.unlink(os.path.join(self.run_dir, "loop-pi-proto"))
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("UNGRANTED", result.stdout)
        self.assertTrue(self.note_names(result, unlogged), result.stdout)

    def test_protocol_retention_requires_marker_and_never_invents_a_snapshot(self):
        result = run_audit("retain-protocol", env_overrides=self.env)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("requires the armed protocol marker", result.stderr)
        self.proto()
        result = run_audit("retain-protocol", env_overrides=self.env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "audit-before.json")))

    def test_explicit_push_log_enforces_protocol_after_late_arm_marker_deletion(self):
        # The launcher takes the initial snapshot before continuation arms the root.
        self.begin()
        self.proto()
        unlogged = self.commit(self.other, "g.txt", "unlogged")
        git(self.other, "push", "-q", "origin", "main")
        os.unlink(os.path.join(self.run_dir, "loop-pi-proto"))
        legacy = self.closeout()
        self.assertEqual(legacy.returncode, 1, legacy.stdout + legacy.stderr)
        self.assertFalse(self.note_names(legacy, unlogged), legacy.stdout)
        result = self.closeout("--push-log", self.log_path)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("UNGRANTED", result.stdout)
        self.assertTrue(self.note_names(result, unlogged), result.stdout)

    def test_a_foreign_commit_between_two_logged_pushes_is_flagged(self):
        self.ready()
        b = self.commit(self.repo, "f.txt", "ours one")
        self.logged_push(self.repo, self.start, b)
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")
        foreign = self.commit(self.other, "g.txt", "foreign")
        git(self.other, "push", "-q", "origin", "main")
        git(self.repo, "pull", "-q", "--ff-only", "origin", "main")
        g = self.commit(self.repo, "f.txt", "ours two")
        self.logged_push(self.repo, foreign, g)
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("UNGRANTED", result.stdout)
        self.assertIn(foreign[:12], result.stdout)
        self.assertNotIn(b[:12], result.stdout.split("note:")[-1])

    def test_an_unlogged_commit_after_the_last_push_is_flagged(self):
        self.ready()
        b = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, b)
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")
        late = self.commit(self.other, "g.txt", "late")
        git(self.other, "push", "-q", "origin", "main")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(late[:12], result.stdout)

    def test_a_backlog_only_commit_passes_and_a_mixed_one_does_not(self):
        self.ready()
        task = self.commit(self.other, "backlog/tasks/x.md", "task note")
        git(self.other, "push", "-q", "origin", "main")
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        self.assertTrue(task)
        # A commit touching backlog/ and anything else is not backlog-only.
        os.makedirs(os.path.join(self.other, "backlog"), exist_ok=True)
        with open(os.path.join(self.other, "backlog", "y.md"), "w", encoding="utf-8") as fh:
            fh.write("y\n")
        with open(os.path.join(self.other, "code.txt"), "w", encoding="utf-8") as fh:
            fh.write("z\n")
        git(self.other, "add", "--", "backlog/y.md", "code.txt")
        git(self.other, "commit", "-q", "-m", "mixed")
        git(self.other, "push", "-q", "origin", "main")
        again = self.closeout()
        self.assertEqual(again.returncode, 1, again.stdout + again.stderr)

    def test_explicit_push_log_path_is_used(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, c)
        elsewhere = os.path.join(self.tmp, "elsewhere.jsonl")
        os.rename(self.log_path, elsewhere)
        self.assertEqual(self.closeout().returncode, 1)
        result = self.closeout("--push-log", elsewhere)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_push_logged_for_an_independent_clone_accounts_for_nothing(self):
        self.ready()
        c = self.commit(self.other, "f.txt", "clone work")
        self.logged_push(self.other, self.start, c, log_repo=self.other)
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(c[:12], result.stdout)

    def test_compare_keeps_snapshot_protocol_without_run_dir(self):
        self.ready()
        self.commit(self.other, "backlog/tasks/x.md", "task note")
        git(self.other, "push", "-q", "origin", "main")
        self.assertEqual(self.closeout().returncode, 0)
        before = os.path.join(self.run_dir, "audit-before.json")
        after = os.path.join(self.run_dir, "audit-after.json")
        # Without protocol evidence this backlog-only move would be UNGRANTED.
        result = run_audit("compare", before, after, env_overrides=self.env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        self.assertIn("no push log", result.stderr)

    def test_a_push_logged_for_another_repo_or_ref_accounts_for_nothing(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, self.start, c, log_repo=os.path.join(self.tmp, "elsewhere"))
        self.assertEqual(self.closeout().returncode, 1)

    def test_other_branches_are_not_accounted_for_by_the_push_log(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "feature")
        self.logged_push(self.repo, None, c, ref="refs/heads/feature")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(any("ref added: refs/heads/feature " in line and "[UNGRANTED]" in line
                            for line in result.stdout.splitlines()), result.stdout)

    def test_without_protocol_evidence_a_logged_default_branch_move_is_ungranted(self):
        self.begin()
        start = self.head(self.repo)
        c = self.commit(self.repo, "f.txt", "ours")
        self.logged_push(self.repo, start, c)
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("UNGRANTED", result.stdout)
        self.assertNotIn(" note: ", result.stdout)


class AbsoluteEndpointTests(unittest.TestCase):
    def test_only_urls_naming_one_endpoint_everywhere_are_absolute(self):
        import importlib.machinery
        import importlib.util
        loader = importlib.machinery.SourceFileLoader("loop_pi_audit", SCRIPT)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        for url in ("git@github.com:o/r.git", "https://github.com/o/r.git", "ssh://git@h:2222/o/r.git", "/srv/git/r.git"):
            self.assertTrue(mod.absolute_endpoint(url), url)
        # Relative paths, and remote-helper addresses a helper may resolve per checkout.
        for url in ("../up.git", "./x:y", "~/up.git", "hg::../up.git", "ext::git %s", "foo::https://h/r"):
            self.assertFalse(mod.absolute_endpoint(url), url)


class AliasEndpointTests(unittest.TestCase):
    """Alias reconciliation: a second checkout whose remote URL is byte-identical to the
    canonical repository's receives only the canonical's journaled root-push ranges. Anything else
    (other URL spellings, changed endpoints, unjournaled watcher pushes, foreign commits) stays
    UNGRANTED. The remote is a real local bare repository; only snapshot URL text is rewritten for
    the URL-form controls."""

    commit = ProtoDefaultBranchTests.commit
    head = ProtoDefaultBranchTests.head
    proto = ProtoDefaultBranchTests.proto

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="loop-pi-audit-alias-test-"))
        self.repo, self.remote = init_repo_with_remote(self.tmp, "canonical")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.alias = os.path.join(self.tmp, getattr(self, "alias_name", "alias"))
        self.other = os.path.join(self.tmp, "other")
        for clone in (self.alias, self.other):
            subprocess.run([GIT, "clone", "--no-local", "-q", self.remote, clone], check=True, timeout=60)
            git(clone, "config", "user.email", "someone@example.com")
            git(clone, "config", "user.name", "someone")
        self.assertEqual(git(self.alias, "remote", "get-url", "origin").stdout,
                         git(self.repo, "remote", "get-url", "origin").stdout)
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.env = {"PATH": make_bin_with_gh_stub(self.tmp), "LOOP_PI_RUN_DIR": self.run_dir}
        self.log_path = os.path.join(self.run_dir, "push-log.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ready(self):
        self.proto()
        for verb, repo in (("begin", self.repo), ("add", self.alias)):
            result = run_audit(verb, repo, env_overrides=self.env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.start = self.head(self.repo)

    def journal(self, old, new, actor="root", repo=None, remote="origin"):
        entry = {"v": 1, "ts": "2026-10-13T00:00:00Z", "actor": actor, "agent": None, "lane": None,
                 "repo": repo or self.repo, "remote": remote, "ref": "refs/heads/main", "old": old, "new": new}
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")

    def root_push(self, old, new, **journal):
        git(self.repo, "push", "-q", "origin", f"{new}:refs/heads/main")
        self.journal(old, new, **journal)

    def closeout(self):
        return run_audit("closeout", "--push-log", self.log_path, env_overrides=self.env)

    def lines(self, result, repo):
        return "\n".join(line for line in result.stdout.splitlines() if line.startswith(f"[{repo}] "))

    def assert_alias_ungranted(self, result, *flagged):
        alias = self.lines(result, self.alias)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", alias)
        self.assertIn("[UNGRANTED]", alias)
        for sha in flagged:
            self.assertIn(f"commit {sha[:12]} ", alias)

    def test_byte_identical_alias_receives_the_journaled_root_push_range(self):
        self.ready()
        self.commit(self.repo, "f.txt", "one")
        c2 = self.commit(self.repo, "f.txt", "two")
        self.root_push(self.start, c2)
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        alias = self.lines(result, self.alias)
        self.assertIn("refs/heads/main", alias)
        self.assertIn("[GRANTED]", alias)
        self.assertIn("endpoint-equivalent", alias)
        self.assertIn(self.repo, alias)
        self.assertNotIn("UNGRANTED", result.stdout)

    def test_alias_grant_and_its_note_survive_when_the_canonical_reports_first(self):
        # The canonical path sorts first, so an identical GRANTED line is already seen; the alias's
        # line carries the endpoint-equivalent note and must still be printed.
        self.tearDown()
        self.alias_name = "zz-alias"
        self.setUp()
        self.assertLess(self.repo, self.alias)
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.root_push(self.start, c)
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        alias = self.lines(result, self.alias)
        self.assertIn("refs/heads/main", alias)
        self.assertIn("[GRANTED]", alias)
        self.assertIn("endpoint-equivalent", alias)

    def test_relative_remote_urls_are_never_endpoint_equivalent(self):
        # Two checkouts whose origin is the same relative text '../up.git' reach different repositories.
        # A root push to one is journaled; the same commit reaches the other only by an unjournaled push.
        roots = [os.path.join(self.tmp, side) for side in ("rel-a", "rel-b")]
        checkouts = [os.path.join(root, "wc") for root in roots]
        for root, checkout in zip(roots, checkouts):
            os.makedirs(root)
            bare = os.path.join(root, "up.git")
            subprocess.run([GIT, "clone", "--bare", "-q", self.remote, bare], check=True, timeout=60)
            git(bare, "symbolic-ref", "HEAD", "refs/heads/main")
            subprocess.run([GIT, "clone", "--no-local", "-q", bare, checkout], check=True, timeout=60)
            git(checkout, "remote", "set-url", "origin", "../up.git")
            git(checkout, "config", "user.email", "someone@example.com")
            git(checkout, "config", "user.name", "someone")
        self.assertEqual(git(checkouts[0], "remote", "get-url", "origin").stdout,
                         git(checkouts[1], "remote", "get-url", "origin").stdout)
        self.proto()
        for verb, repo in (("begin", checkouts[0]), ("add", checkouts[1])):
            result = run_audit(verb, repo, env_overrides=self.env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        start = self.head(checkouts[0])
        c = self.commit(checkouts[0], "f.txt", "root")
        git(checkouts[0], "push", "-q", "origin", "main")
        self.journal(start, c, repo=checkouts[0])
        git(checkouts[0], "push", "-q", os.path.join(roots[1], "up.git"), "main:refs/heads/main")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        other = self.lines(result, checkouts[1])
        self.assertIn("[UNGRANTED]", other)
        self.assertIn(f"commit {c[:12]} ", other)
        self.assertNotIn("endpoint-equivalent", other)
        self.assertIn("[GRANTED]", self.lines(result, checkouts[0]))

    def test_unjournaled_watcher_push_stays_ungranted_whatever_its_author_or_current_sha(self):
        self.ready()
        c1 = self.commit(self.repo, "f.txt", "root one")
        self.root_push(self.start, c1)
        # A watcher or subprocess publishes from the canonical checkout as the root's own identity:
        # same author, and the checkout's current SHA equals the remote afterwards. No journal entry.
        c2 = self.commit(self.repo, "f.txt", "watcher")
        git(self.repo, "push", "-q", "origin", "HEAD:refs/heads/main")
        self.assertEqual(self.head(self.repo), git(self.remote, "rev-parse", "refs/heads/main").stdout.strip())
        result = self.closeout()
        self.assert_alias_ungranted(result, c2)
        self.assertNotIn(f"commit {c1[:12]} ", self.lines(result, self.alias))
        canonical = self.lines(result, self.repo)
        self.assertIn("[UNGRANTED]", canonical)
        self.assertIn(f"commit {c2[:12]} ", canonical)

    def test_concurrent_foreign_commit_stays_ungranted_in_the_alias(self):
        self.ready()
        b = self.commit(self.repo, "f.txt", "root one")
        self.root_push(self.start, b)
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")
        foreign = self.commit(self.other, "g.txt", "foreign")
        git(self.other, "push", "-q", "origin", "main")
        git(self.repo, "pull", "-q", "--ff-only", "origin", "main")
        g = self.commit(self.repo, "f.txt", "root two")
        self.root_push(foreign, g)
        result = self.closeout()
        self.assert_alias_ungranted(result, foreign)
        alias = self.lines(result, self.alias)
        for covered in (b, g):
            self.assertNotIn(f"commit {covered[:12]} ", alias)

    def test_only_root_receipts_of_a_snapshotted_canonical_transfer(self):
        cases = {
            "lane receipt": {"actor": "lane"},
            "bot actor receipt": {"actor": "renovate[bot]"},
            "root creation receipt with old null": {"old": None},
            "receipt for an unsnapshotted clone": {"repo": None},
            "receipt for an unknown remote name": {"remote": "mirror"},
        }
        for label, override in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                self.ready()
                c = self.commit(self.repo, "f.txt", label)
                override = dict(override)
                if override.get("repo", "") is None:
                    override = {"repo": self.other}
                old = override.pop("old") if "old" in override else self.start
                self.root_push(old, c, **override)
                self.assert_alias_ungranted(self.closeout(), c)

    def test_a_changed_endpoint_on_either_side_does_not_transfer(self):
        for side in ("alias", "canonical"):
            with self.subTest(side):
                self.tearDown()
                self.setUp()
                self.ready()
                c = self.commit(self.repo, "f.txt", "ours")
                self.root_push(self.start, c)
                twin = os.path.join(self.tmp, "twin.git")
                subprocess.run([GIT, "clone", "--bare", "-q", self.remote, twin], check=True, timeout=60)
                git(self.alias if side == "alias" else self.repo, "remote", "set-url", "origin", twin)
                self.assert_alias_ungranted(self.closeout(), c)

    def test_url_equivalence_is_byte_exact(self):
        self.ready()
        c = self.commit(self.repo, "f.txt", "ours")
        self.root_push(self.start, c)
        self.assertEqual(self.closeout().returncode, 0)
        canonical_url = "ssh://git@example.com/o/r.git"
        cases = {
            "identical": (canonical_url, canonical_url, 0),
            "different SSH user": (canonical_url, "ssh://deploy@example.com/o/r.git", 1),
            "different scheme": (canonical_url, "https://example.com/o/r.git", 1),
            "scp-like spelling": (canonical_url, "git@example.com:o/r.git", 1),
            "missing .git suffix": (canonical_url, "ssh://git@example.com/o/r", 1),
            "host case": (canonical_url, "ssh://git@EXAMPLE.com/o/r.git", 1),
            "unrelated repository": (canonical_url, "ssh://git@example.com/o/other.git", 1),
            "alias endpoint changed during the run": (canonical_url, (canonical_url, "ssh://git@example.com/o/s.git"), 1),
        }
        sources = {side: os.path.join(self.run_dir, f"audit-{side}.json") for side in ("before", "after")}
        for label, (canonical, alias, expected) in cases.items():
            with self.subTest(label):
                rewritten = {}
                for index, side in enumerate(("before", "after")):
                    with open(sources[side], encoding="utf-8") as fh:
                        snap = json.load(fh)
                    snap["repos"][self.repo]["remotes"]["origin"]["url"] = canonical
                    snap["repos"][self.alias]["remotes"]["origin"]["url"] = alias[index] if isinstance(alias, tuple) else alias
                    rewritten[side] = os.path.join(self.tmp, f"{side}-rewritten.json")
                    with open(rewritten[side], "w", encoding="utf-8") as fh:
                        json.dump(snap, fh)
                result = run_audit("compare", rewritten["before"], rewritten["after"], "--run-dir", self.run_dir,
                                   "--push-log", self.log_path, env_overrides=self.env)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                if expected:
                    self.assert_alias_ungranted(result, c)
                    self.assertIn("[GRANTED]", self.lines(result, self.repo))


def load_audit_module():
    loader = importlib.machinery.SourceFileLoader("loop_pi_audit_under_test", SCRIPT)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class CharterAuthorityParsingTests(unittest.TestCase):
    """What the charter's `authority:` block grants. Only that block counts, and only a clause that
    names release-please without a negation."""

    @classmethod
    def setUpClass(cls):
        cls.audit = load_audit_module()

    CHARTER = (
        "# Charter: demo loop1\n\n"
        "aim:        ship it. Release-please is mentioned here but this is not authority.\n"
        "authority:\n"
        "  - Root lands every candidate on main of acme/widget and acme/gadget; lanes never push. "
        "Release through the repository's own release-please flow (a release-please merge is a standing release).\n"
        "  - Deploys under the standing grant.\n"
        "  - No closing of a release-please pull request.\n"
        "live:       release-please reads\n"
        "\n## First wave\n\nauthority: release-please everywhere\n"
    )

    def test_the_authority_block_is_read_and_nothing_outside_it(self):
        entries = self.audit.charter_authority_entries(self.CHARTER)
        self.assertEqual(len(entries), 3)
        self.assertTrue(entries[0].startswith("Root lands every candidate"))
        self.assertEqual(entries[2], "No closing of a release-please pull request.")

    def test_a_grant_needs_a_clause_naming_release_please_without_a_negation(self):
        grants = self.audit.release_grant_entries(self.CHARTER)
        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0]["slugs"], {"acme/widget", "acme/gadget"})

    def test_an_entry_naming_no_repository_names_none(self):
        grants = self.audit.release_grant_entries("authority:\n  - A release-please merge is a standing release.\n")
        self.assertEqual(grants, [{"slugs": set(), "paths": set()}])

    def test_a_wrapped_entry_is_judged_whole(self):
        wrapped = "authority:\n  - A release-please merge is a standing release,\n    except on acme/widget.\n  - Other.\n"
        self.assertEqual(self.audit.charter_authority_entries(wrapped),
                         ["A release-please merge is a standing release, except on acme/widget.", "Other."])
        self.assertEqual(self.audit.release_grant_entries(wrapped), [])
        scoped = "authority:\n  - Release through release-please\n    on acme/widget.\n"
        self.assertEqual(self.audit.release_grant_entries(scoped), [{"slugs": {"acme/widget"}, "paths": set()}])

    def test_a_negated_clause_in_the_same_entry_does_not_grant(self):
        self.assertEqual(self.audit.release_grant_entries("authority:\n  - Never merge a release-please pull request.\n"), [])

    def test_a_charter_that_no_longer_matches_its_frozen_digest_grants_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "charter.md")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(self.CHARTER)
            digest = hashlib.sha256(self.CHARTER.encode()).hexdigest()
            authority, why = self.audit.read_release_authority(path, digest)
            self.assertIsNone(why)
            self.assertEqual(len(authority["grants"]), 1)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("authority:\n  - release-please everything\n")
            authority, why = self.audit.read_release_authority(path, digest)
            self.assertIsNone(authority)
            self.assertIn("digest", why)
            self.assertIsNone(self.audit.read_release_authority(path, None)[0])


class ReleaseAuthorityTests(unittest.TestCase):
    """A release-please merge, its version tag, the release and the removal of the release branch on
    a repository the charter's authority names are GRANTED. The same changes without that grant, or
    for anything that does not have the release-please shape, stay UNGRANTED."""

    commit = ProtoDefaultBranchTests.commit
    head = ProtoDefaultBranchTests.head
    proto = ProtoDefaultBranchTests.proto

    RELEASE_BRANCH = "release-please--branches--main"
    AUTHORITY = "Release through the repository's own release-please flow (a release-please merge is a standing release)."

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="loop-pi-audit-release-test-"))
        self.repo, self.remote = init_repo_with_remote(self.tmp, "repo")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.other = os.path.join(self.tmp, "other")
        subprocess.run([GIT, "clone", "--no-local", "-q", self.remote, self.other], check=True, timeout=60)
        git(self.other, "config", "user.email", "bot@example.com")
        git(self.other, "config", "user.name", "bot")
        git(self.other, "push", "-q", "origin", f"HEAD:refs/heads/{self.RELEASE_BRANCH}")
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.log_path = os.path.join(self.run_dir, "push-log.jsonl")
        self.env = {"PATH": make_bin_with_gh_stub(self.tmp), "LOOP_PI_RUN_DIR": self.run_dir}
        self.after_path = None
        self.proto()
        self.assertEqual(run_audit("begin", self.repo, env_overrides=self.env).returncode, 0)
        self.start = self.head(self.repo)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def root_push(self, new):
        git(self.repo, "push", "-q", "origin", f"{new}:refs/heads/main")
        entry = {"v": 1, "ts": "2026-10-16T00:00:00Z", "actor": "root", "agent": None, "lane": None, "repo": self.repo,
                 "remote": "origin", "ref": "refs/heads/main", "old": self.start, "new": new}
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")

    def release(self, subject="chore(main): release 0.4.0 (#12)", manifest=True, tag="v0.4.0", tag_at=None, also=()):
        """What release-please does on merge: the squash commit, the version tag, the branch removal."""
        self.commit(self.other, ".release-please-manifest.json" if manifest else "CHANGELOG.md", subject)
        for path in ("CHANGELOG.md", "pyproject.toml", "src/pkg/__init__.py", *also):
            self.commit(self.other, path, subject)
            git(self.other, "reset", "-q", "--soft", "HEAD~1")
        git(self.other, "commit", "-q", "--amend", "-m", subject)
        sha = self.head(self.other)
        git(self.other, "push", "-q", "origin", "main")
        git(self.other, "tag", tag, tag_at or sha)
        git(self.other, "push", "-q", "origin", f"refs/tags/{tag}")
        git(self.other, "push", "-q", "origin", f":refs/heads/{self.RELEASE_BRANCH}")
        git(self.repo, "fetch", "-q", "--tags", "origin")
        return sha

    def flow(self, **release):
        self.root_push(self.commit(self.repo, "f.txt", "root work"))
        return self.release(**release)

    def charter(self, authority=None, folder=None, edit_after=False):
        folder = folder or os.path.join(self.tmp, "elsewhere")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "charter-demo-loop1.md")
        text = f"# Charter: demo loop1\n\nlanes:      1\nauthority:\n  - {authority or self.AUTHORITY}\nlive:       none\n"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        digest = hashlib.sha256(text.encode()).hexdigest()
        if edit_after:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("authority:\n  - release-please is granted everywhere\n")
        return ["--charter", path, "--charter-sha256", digest]

    def in_repo(self, **kwargs):
        """A charter in this repository's own codex/ folder, as a real run's is."""
        return self.charter(folder=os.path.join(self.repo, "codex"), **kwargs)

    def closeout(self, *extra):
        if self.after_path is None:
            listed = '[{"tagName":"v0.4.0","name":"v0.4.0","isDraft":false,"isPrerelease":false,"publishedAt":"2026-10-16T02:00:00Z"}]'
            self.after_path = make_bin_with_gh_stub(self.tmp, listed, "fake-bin-after")
        return run_audit("closeout", "--push-log", self.log_path, *extra,
                         env_overrides={**self.env, "PATH": self.after_path})

    def line(self, result, needle):
        return next(line for line in result.stdout.splitlines() if needle in line and " note: " not in line)

    def unaccounted_note(self, result, sha):
        return any(" note: " in line and f"commit {sha[:12]} is not in a logged push" in line for line in result.stdout.splitlines())

    def test_the_whole_release_flow_is_granted_when_the_charter_names_it(self):
        sha = self.flow()
        # The entry names no repository, so it covers the charter's own: this one.
        result = self.closeout(*self.in_repo())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        out = result.stdout
        self.assertIn(f"commit {sha[:12]} is a release-please merge", out)
        for needle in ("ref moved: refs/heads/main ", f"ref deleted: refs/heads/{self.RELEASE_BRANCH} ",
                       "ref added: refs/tags/v0.4.0 ", "tag added: refs/tags/v0.4.0 ", "release added: v0.4.0"):
            self.assertIn("[GRANTED]", self.line(result, needle), needle)

    def test_the_same_flow_without_a_charter_grant_stays_ungranted(self):
        sha = self.flow()
        # Built inside each subtest: every charter() call writes the same file.
        cases = {
            "no charter": lambda: [],
            "authority that does not name release-please": lambda: self.charter("Root lands every candidate on main."),
            "a negated release-please clause": lambda: self.charter("Never merge or close a release-please pull request."),
            "a negation on a wrapped continuation line": lambda: self.charter(
                "A release-please merge is a standing release,\n    except on this repository."),
            "a charter edited after arm": lambda: self.in_repo(edit_after=True),
            "an entry naming another repository": lambda: self.charter(f"{self.AUTHORITY} Applies to acme/other only."),
            "an unnamed entry in a charter outside this repository": lambda: self.charter(),
        }
        for label, make in cases.items():
            with self.subTest(label):
                extra = make()
                if label != "no charter":
                    self.assertTrue(any(a.endswith(".md") for a in extra))
                result = self.closeout(*extra)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                # Only the edited charter may fail the digest check; every other case is refused on its text.
                self.assertEqual("no longer matches" in result.stderr, label == "a charter edited after arm", result.stderr)
                self.assertTrue(self.unaccounted_note(result, sha), result.stdout)
                for needle in ("ref moved: refs/heads/main ", f"ref deleted: refs/heads/{self.RELEASE_BRANCH} ",
                               "ref added: refs/tags/v0.4.0 ", "tag added: refs/tags/v0.4.0 ", "release added: v0.4.0"):
                    self.assertIn("[UNGRANTED]", self.line(result, needle), needle)

    def test_a_charter_naming_the_repository_by_path_grants_it(self):
        sha = self.flow()
        result = self.closeout(*self.charter(f"{self.AUTHORITY} Applies to {self.repo}."))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"commit {sha[:12]} is a release-please merge", result.stdout)

    def test_a_charter_naming_the_repository_by_slug_grants_it(self):
        sha = self.flow()
        self.assertEqual(self.closeout().returncode, 1)
        rewritten = {}
        for side in ("before", "after"):
            with open(os.path.join(self.run_dir, f"audit-{side}.json"), encoding="utf-8") as fh:
                snap = json.load(fh)
            snap["repos"][self.repo]["remotes"]["origin"]["url"] = "https://github.com/Acme/Widget.git"
            rewritten[side] = os.path.join(self.tmp, f"{side}-slug.json")
            with open(rewritten[side], "w", encoding="utf-8") as fh:
                json.dump(snap, fh)
        for authority, expected in ((f"{self.AUTHORITY} Applies to acme/widget.", 0), (f"{self.AUTHORITY} Applies to acme/other.", 1)):
            with self.subTest(authority):
                result = run_audit("compare", rewritten["before"], rewritten["after"], "--run-dir", self.run_dir,
                                   "--push-log", self.log_path, *self.charter(authority), env_overrides=self.env)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                if expected == 0:
                    self.assertIn(f"commit {sha[:12]} is a release-please merge", result.stdout)

    def test_only_the_release_please_shape_is_covered(self):
        cases = {
            "a release subject that does not touch the manifest": dict(manifest=False),
            "a manifest change under an ordinary subject": dict(subject="feat: add a thing"),
            "a release commit that also changes source": dict(also=("src/pkg/server.py",)),
        }
        for label, release in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                sha = self.flow(**release)
                result = self.closeout(*self.in_repo())
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertTrue(self.unaccounted_note(result, sha), result.stdout)
                self.assertIn("[UNGRANTED]", self.line(result, "ref added: refs/tags/v0.4.0 "))
                self.assertIn("[UNGRANTED]", self.line(result, "release added: v0.4.0"))

    def test_files_the_parents_release_config_names_as_extra_files_are_covered(self):
        config = '{"packages": {".": {"extra-files": ["src/pkg/constants.py", {"type": "json", "path": "web/meta.json"}]}}}'
        self.commit(self.repo, "release-please-config.json", "x")
        with open(os.path.join(self.repo, "release-please-config.json"), "w", encoding="utf-8") as fh:
            fh.write(config)
        git(self.repo, "add", "--", "release-please-config.json")
        git(self.repo, "commit", "-q", "--amend", "-m", "configure releases")
        self.root_push(self.head(self.repo))
        sha = self.release(also=("src/pkg/constants.py", "web/meta.json"))
        result = self.closeout(*self.in_repo())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"commit {sha[:12]} is a release-please merge", result.stdout)

    def test_a_tag_must_point_at_the_accounted_release_merge(self):
        self.root_push(self.commit(self.repo, "f.txt", "root work"))
        sha = self.release(tag_at=self.start)
        result = self.closeout(*self.in_repo())
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"commit {sha[:12]} is a release-please merge", result.stdout)
        self.assertIn("[UNGRANTED]", self.line(result, "ref added: refs/tags/v0.4.0 "))
        self.assertIn("[UNGRANTED]", self.line(result, "release added: v0.4.0"))

    def test_removing_the_release_branch_needs_an_accounted_release_merge(self):
        self.root_push(self.commit(self.repo, "f.txt", "root work"))
        git(self.other, "push", "-q", "origin", f":refs/heads/{self.RELEASE_BRANCH}")
        result = self.closeout(*self.in_repo())
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[UNGRANTED]", self.line(result, f"ref deleted: refs/heads/{self.RELEASE_BRANCH} "))

    def test_a_non_release_commit_after_the_release_is_still_flagged(self):
        self.flow()
        late = self.commit(self.other, "g.txt", "unrelated late work")
        git(self.other, "push", "-q", "origin", "main")
        result = self.closeout(*self.in_repo())
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.unaccounted_note(result, late), result.stdout)


class ForeignSessionTests(unittest.TestCase):
    """A commit is FOREIGN, reported and not a violation, only when it names another harness session
    in its trailer block AND a logged root push was made on top of it. Either fact alone, a lane's
    receipt, or a push after the last logged one leaves it UNGRANTED."""

    commit = ProtoDefaultBranchTests.commit
    head = ProtoDefaultBranchTests.head
    proto = ProtoDefaultBranchTests.proto

    SESSION = "https://claude.ai/code/session_01ABC"
    TRAILER = f"fix: sibling work\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: {SESSION}\n"

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="loop-pi-audit-foreign-test-"))
        self.repo, self.remote = init_repo_with_remote(self.tmp, "repo")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        self.other = os.path.join(self.tmp, "other")
        subprocess.run([GIT, "clone", "--no-local", "-q", self.remote, self.other], check=True, timeout=60)
        git(self.other, "config", "user.email", "someone@example.com")
        git(self.other, "config", "user.name", "someone")
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.log_path = os.path.join(self.run_dir, "push-log.jsonl")
        self.env = {"PATH": make_bin_with_gh_stub(self.tmp), "LOOP_PI_RUN_DIR": self.run_dir}
        self.proto()
        self.assertEqual(run_audit("begin", self.repo, env_overrides=self.env).returncode, 0)
        self.start = self.head(self.repo)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sibling_commit(self, message):
        """A commit pushed to the remote by a clone the root does not control."""
        git(self.other, "pull", "-q", "--ff-only", "origin", "main")
        self.commit(self.other, "g.txt", "x")
        git(self.other, "commit", "-q", "--amend", "-m", message)
        git(self.other, "push", "-q", "origin", "main")
        return self.head(self.other)

    def root_pushes_on_top(self, sibling, actor="root"):
        git(self.repo, "pull", "-q", "--ff-only", "origin", "main")
        ours = self.commit(self.repo, "f.txt", "root work")
        git(self.repo, "push", "-q", "origin", "main")
        entry = {"v": 1, "ts": "2026-10-16T01:25:08Z", "actor": actor, "agent": None, "lane": None, "repo": self.repo,
                 "remote": "origin", "ref": "refs/heads/main", "old": sibling, "new": ours}
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        return ours

    def closeout(self):
        return run_audit("closeout", "--push-log", self.log_path, env_overrides=self.env)

    def unaccounted_note(self, result, sha):
        return any(" note: " in line and f"commit {sha[:12]} is not in a logged push" in line for line in result.stdout.splitlines())

    def test_a_commit_naming_another_session_that_the_root_pushed_on_top_of_is_foreign(self):
        sha = self.sibling_commit(self.TRAILER)
        ours = self.root_pushes_on_top(sha)
        result = self.closeout()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        moved = [line for line in result.stdout.splitlines() if "ref moved: refs/heads/main " in line and " note: " not in line]
        self.assertEqual(len(moved), 1)
        self.assertIn("[FOREIGN]", moved[0])
        self.assertTrue(any(f"commit {sha[:12]} is FOREIGN" in line and self.SESSION in line and f"{sha[:12]}..{ours[:12]}" in line
                            for line in result.stdout.splitlines()), result.stdout)
        self.assertIn("[FOREIGN derived HEAD]", result.stdout)

    def test_a_commit_that_does_not_name_another_session_stays_ungranted_under_a_root_push(self):
        cases = {
            "no trailer, whatever the author": "fix: sibling work\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
            "the same text in prose above the trailer block": f"fix: x\n\nClaude-Session: {self.SESSION}\n\nmore prose\n",
            "a lower-case lookalike": f"fix: x\n\nclaude-session: {self.SESSION}\n",
            "an empty value": "fix: x\n\nClaude-Session:\n",
        }
        for label, message in cases.items():
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                sha = self.sibling_commit(message)
                self.root_pushes_on_top(sha)
                result = self.closeout()
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertTrue(self.unaccounted_note(result, sha), result.stdout)
                self.assertNotIn("FOREIGN", result.stdout)

    def test_a_trailer_alone_grants_nothing(self):
        # Text anyone can write: an unlogged push naming a session, with no root push on top of it,
        # and one that arrives after the last logged push.
        sha = self.sibling_commit(self.TRAILER)
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.unaccounted_note(result, sha), result.stdout)
        self.assertNotIn("FOREIGN", result.stdout)

    def test_a_logged_push_that_is_not_the_roots_makes_nothing_foreign(self):
        sha = self.sibling_commit(self.TRAILER)
        self.root_pushes_on_top(sha, actor="lane")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.unaccounted_note(result, sha), result.stdout)

    def test_a_sibling_push_after_the_last_logged_push_stays_ungranted(self):
        first = self.sibling_commit(self.TRAILER)
        self.root_pushes_on_top(first)
        late = self.sibling_commit(f"fix: late sibling work\n\nClaude-Session: {self.SESSION}\n")
        result = self.closeout()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(self.unaccounted_note(result, late), result.stdout)
        self.assertFalse(self.unaccounted_note(result, first), result.stdout)
        self.assertIn(f"commit {first[:12]} is FOREIGN", result.stdout)


if __name__ == "__main__":
    unittest.main()
