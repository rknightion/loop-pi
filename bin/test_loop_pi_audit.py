#!/usr/bin/env python3
"""Table-driven tests for loop-pi-audit. Stdlib unittest,
runnable as `python3 -m unittest bin.test_loop_pi_audit -v` from `pi/`, or
directly as a script. Builds scratch git repos with a local bare "remote"
(file-path, no network) under a temp dir.
"""
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
    env = dict(os.environ)
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


def make_bin_with_gh_stub(tmp, releases_json="[]"):
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
    fake_bin = os.path.join(tmp, "fake-bin-gh-ok")
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
    def test_duplicate_grants_and_ungranted_moves(self):
        # Exercise snapshot and compare through the CLI against a real bare remote.
        for grant_paths in ((), (0,), (1,), (0, 1)):
            with self.subTest(grant_paths=grant_paths), tempfile.TemporaryDirectory() as tmp:
                first, remote = init_repo_with_remote(tmp, "first")
                git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
                second = os.path.join(tmp, "second")
                subprocess.run([GIT, "clone", "--no-local", "-q", remote, second],
                               check=True, timeout=60)
                paths = (first, second)
                env = {"PATH": make_bin_with_gh_stub(tmp)}
                before, after = (os.path.join(tmp, f"{phase}.json") for phase in ("before", "after"))
                snapshot(before, *paths, env_overrides=env)
                git(first, "commit", "--allow-empty", "-q", "-m", "advance")
                git(first, "push", "-q", "origin", "main")
                snapshot(after, *paths, env_overrides=env)
                grants = os.path.join(tmp, "grants.json")
                with open(grants, "w") as fh:
                    json.dump({paths[i]: ["refs/heads/main"] for i in grant_paths}, fh)
                result = run_audit("compare", before, after, "--grants", grants, env_overrides=env)
                self.assertEqual(result.returncode, 0 if grant_paths else 1, result.stdout + result.stderr)
                moves = [line for line in result.stdout.splitlines() if "ref moved: refs/heads/main " in line]
                self.assertEqual(len(moves), 1 if grant_paths else 2, result.stdout)
                if grant_paths:
                    self.assertIn("[GRANTED]", moves[0])
                    self.assertNotIn("UNGRANTED", result.stdout)
                else:
                    for path in paths:
                        self.assertTrue(any(f"[{path}]" in line and "[UNGRANTED]" in line for line in moves))

    def test_single_path_grant_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _ = init_repo_with_remote(tmp, "single")
            env = {"PATH": make_bin_with_gh_stub(tmp)}
            before, after = (os.path.join(tmp, f"{phase}.json") for phase in ("before", "after"))
            snapshot(before, repo, env_overrides=env)
            git(repo, "commit", "--allow-empty", "-q", "-m", "advance")
            git(repo, "push", "-q", "origin", "main")
            snapshot(after, repo, env_overrides=env)
            grants = os.path.join(tmp, "grants.json")
            with open(grants, "w") as fh:
                json.dump({repo: ["refs/heads/main"]}, fh)
            for granted in (False, True):
                result = run_audit("compare", before, after, *(["--grants", grants] if granted else []), env_overrides=env)
                self.assertEqual(result.returncode, 0 if granted else 1, result.stdout + result.stderr)
                self.assertEqual(result.stdout.count("ref moved: refs/heads/main "), 1)


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

    def test_added_branch_granted_exits_zero(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "feature commit")
        git(self.repo, "push", "-q", "origin", "feature")
        after = self._snapshot_after()

        grants = os.path.join(self.tmp, "grants.json")
        with open(grants, "w") as fh:
            json.dump({self.repo: ["refs/heads/feature"]}, fh)

        result = run_audit("compare", self.before, after, "--grants", grants)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/heads/feature", result.stdout)
        self.assertIn("GRANTED", result.stdout)
        self.assertNotIn("UNGRANTED", result.stdout)

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

    def test_pull_refs_are_foreign_unless_explicitly_granted(self):
        # GitHub recomputes refs/pull/<n>/merge whenever the base moves, so it
        # is foreign automation, as is the synthesised head ref.
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

    def _compare_with_grants(self, before, after, value):
        grants = os.path.join(self.tmp, "grants.json")
        with open(grants, "w") as fh:
            json.dump({self.repo: value}, fh)
        return run_audit("compare", before, after, "--grants", grants)

    def test_head_uses_target_grant_and_legacy_snapshot_is_readable(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        snapshot(self.before, self.repo, env_overrides={"PATH": self.gh_bin})
        with open(self.before) as fh:
            legacy = json.load(fh)
        legacy["repos"][self.repo]["remotes"]["origin"].pop("symrefs", None)
        with open(self.before, "w") as fh:
            json.dump(legacy, fh)
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "advance")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()
        result = self._compare_with_grants(self.before, after, ["refs/heads/main"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("UNGRANTED", result.stdout)
        # A standalone HEAD grant cannot authorize its ungranted target.
        denied = self._compare_with_grants(self.before, after, ["HEAD"])
        self.assertEqual(denied.returncode, 1)
        self.assertIn("UNGRANTED", denied.stdout)

    def test_head_retarget_same_object_requires_target_grant(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        git(self.repo, "push", "-q", "origin", "HEAD:refs/heads/other")
        snapshot(self.before, self.repo, env_overrides={"PATH": self.gh_bin})
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/other")
        after = self._snapshot_after()
        denied = self._compare_with_grants(self.before, after, ["refs/heads/main"])
        self.assertEqual(denied.returncode, 1, denied.stdout + denied.stderr)
        self.assertIn("UNGRANTED derived HEAD", denied.stdout)
        allowed = self._compare_with_grants(self.before, after,
                                            ["refs/heads/main", "refs/heads/other"])
        self.assertEqual(allowed.returncode, 0, allowed.stdout + allowed.stderr)
        self.assertIn("GRANTED derived HEAD", allowed.stdout)

    def test_snapshot_records_head_symref(self):
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        after = self._snapshot_after()
        with open(after) as fh:
            remote = json.load(fh)["repos"][self.repo]["remotes"]["origin"]
        self.assertEqual(remote["symrefs"]["HEAD"], "refs/heads/main")

    def test_annotated_tag_peel_uses_tag_grant(self):
        git(self.repo, "tag", "-a", "v2", "-m", "release")
        git(self.repo, "push", "-q", "origin", "v2")
        after = self._snapshot_after()
        result = self._compare_with_grants(self.before, after, ["refs/tags/v2"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/tags/v2^{}", result.stdout)
        denied = run_audit("compare", self.before, after)
        self.assertEqual(denied.returncode, 1)

    def test_explicit_automation_branch_grant_allows_rewrite_only_for_named_branch(self):
        ref = "refs/heads/release-please--branches--main"
        git(self.repo, "push", "-q", "origin", "HEAD:" + ref)
        before = os.path.join(self.tmp, "automation-before.json")
        snapshot(before, self.repo, env_overrides={"PATH": self.gh_bin})
        git(self.repo, "commit", "-q", "--amend", "-m", "rewrite automation")
        git(self.repo, "push", "-q", "--force", "origin", "HEAD:" + ref)
        after = self._snapshot_after()
        result = self._compare_with_grants(before, after, {
            "refs": [ref], "allow_non_fast_forward": [ref]})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("EXPECTED NON-FAST-FORWARD", result.stdout)
        denied = self._compare_with_grants(before, after, [ref])
        self.assertEqual(denied.returncode, 1)
        self.assertIn("NON-FAST-FORWARD", denied.stdout)

    def test_named_pull_ref_is_audited_not_foreign(self):
        ref = "refs/pull/9/head"
        git(self.repo, "push", "-q", "origin", "HEAD:" + ref)
        before = os.path.join(self.tmp, "pull-before.json")
        snapshot(before, self.repo, env_overrides={"PATH": self.gh_bin})
        git(self.repo, "commit", "-q", "--amend", "-m", "rewrite pull")
        git(self.repo, "push", "-q", "--force", "origin", "HEAD:" + ref)
        after = self._snapshot_after()
        result = self._compare_with_grants(before, after, [ref])
        self.assertEqual(result.returncode, 1)
        self.assertIn("NON-FAST-FORWARD", result.stdout)
        self.assertNotIn("FOREIGN", result.stdout)

    def test_grants_file_repo_key_must_match_exactly(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "feature commit")
        git(self.repo, "push", "-q", "origin", "feature")
        after = self._snapshot_after()

        grants = os.path.join(self.tmp, "grants.json")
        with open(grants, "w") as fh:
            json.dump({"/some/other/repo": ["refs/heads/feature"]}, fh)

        result = run_audit("compare", self.before, after, "--grants", grants)
        self.assertEqual(result.returncode, 1)
        self.assertIn("UNGRANTED", result.stdout)

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
        self.assertNotIn("every remote change is covered by a grant", result.stdout)

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

    def test_moved_ref_fast_forward_and_granted_exits_zero(self):
        with open(os.path.join(self.repo, "f.txt"), "a") as fh:
            fh.write("more\n")
        git(self.repo, "commit", "-q", "-am", "fast-forward move")
        git(self.repo, "push", "-q", "origin", "main")
        after = self._snapshot_after()

        grants = os.path.join(self.tmp, "grants.json")
        with open(grants, "w") as fh:
            # HEAD (the remote's symbolic default-branch pointer) moves
            # alongside main and needs its own grant; not the thing under test.
            json.dump({self.repo: ["refs/heads/main", "HEAD"]}, fh)

        result = run_audit("compare", self.before, after, "--grants", grants)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("GRANTED", result.stdout)
        self.assertNotIn("NON-FAST-FORWARD", result.stdout)

    def test_non_fast_forward_move_is_a_violation_even_when_granted(self):
        # Rewrite history (force push) instead of moving main forward.
        git(self.repo, "commit", "-q", "--amend", "-m", "rewritten")
        git(self.repo, "push", "-q", "--force", "origin", "main")
        after = self._snapshot_after()

        grants = os.path.join(self.tmp, "grants.json")
        with open(grants, "w") as fh:
            json.dump({self.repo: ["refs/heads/main"]}, fh)

        result = run_audit("compare", self.before, after, "--grants", grants)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", result.stdout)
        self.assertIn("NON-FAST-FORWARD", result.stdout)

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
    so concurrent loops never share a before-snapshot."""

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


class AutomationTests(unittest.TestCase):
    REF = "refs/heads/renovate/ubuntu-26.x"
    ACTOR = "rknightion-renovate[bot]"
    OLD = "8acbe4be3d6a8befc190d7da749644624342323b"
    MID = "2fdc7e7c824b008333936171625b831453646a23"
    NEW = "e477eecb22e1b97a83d6196eb63fd5da1e92b3e9"

    def activity(self, ref=None, old=None, new=None, actor=None):
        return {"ref": ref or self.REF, "before": self.OLD if old is None else old,
                "after": self.NEW if new is None else new, "timestamp": "2026-10-02T15:21:13Z",
                "activity_type": "force_push", "actor": {"login": actor or self.ACTOR}}

    def compare(self, entries, ref=None, old=None, new=None, items=None, unavailable=False):
        ref = ref or self.REF
        old = self.OLD if old is None else old
        new = self.NEW if new is None else new
        with tempfile.TemporaryDirectory() as tmp:
            repo = os.path.join(tmp, "repo")
            os.mkdir(repo)
            subprocess.run(["git", "init", "-q", repo], check=True)
            git(repo, "remote", "add", "origin", "https://github.com/export/audit-fixture.git")
            paths = []
            for label, sha, timestamp in (("before", old, "2026-10-02T14:00:00Z"),
                                          ("after", new, "2026-10-02T16:00:00Z")):
                refs = {ref: sha} if sha else {}
                path = os.path.join(tmp, label + ".json")
                with open(path, "w") as fh:
                    json.dump({"taken_at": timestamp, "repos": {repo: {
                        "remotes": {"origin": {"available": True, "refs": refs,
                                                "symrefs": {"HEAD": "refs/heads/trunk"}}},
                        "tags": {"available": True, "tags": {}},
                        "releases": {"available": True, "releases": []}}}}, fh)
                paths.append(path)
            grants = os.path.join(tmp, "grants.json")
            with open(grants, "w") as fh:
                json.dump({repo: {"automation": items if items is not None else [
                    {"ref_prefix": "refs/heads/renovate/", "actor": self.ACTOR}]}}, fh)
            fake = make_bin_with_gh_stub(tmp)
            with open(os.path.join(fake, "gh"), "w") as fh:
                fh.write("#!/bin/sh\n" + ("exit 1\n" if unavailable else
                         "printf '%s\\n' '" + json.dumps([entries]) + "'\n"))
            return run_audit("compare", *paths, "--grants", grants, env_overrides={"PATH": fake})

    def test_recorded_two_force_push_replay(self):
        entries = [self.activity(old=self.MID), self.activity(new=self.MID)]
        entries[1]["timestamp"] = "2026-10-02T14:20:31Z"
        result = self.compare(entries)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("automation", result.stdout)
        self.assertIn(self.ACTOR, result.stdout)

    def test_creation_and_deletion(self):
        zero = "0" * 40
        for old, new in (("", self.NEW), (self.OLD, "")):
            with self.subTest(old=old):
                result = self.compare([self.activity(old=old or zero, new=new or zero)], old=old, new=new)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_untrusted_or_missing_activity_fails(self):
        # The mixed-actor response is otherwise a complete, valid SHA chain.
        cases = ([self.activity(old=self.MID), self.activity(new=self.MID, actor="other")], [],
                 [self.activity(old=self.MID)], [self.activity(ref="refs/heads/other")])
        for entries in cases:
            with self.subTest(entries=entries):
                self.assertEqual(self.compare(entries).returncode, 1)
        self.assertEqual(self.compare([], unavailable=True).returncode, 1)

    def test_invalid_items_are_usage_errors(self):
        items = [{"ref": "refs/tags/v1", "actor": self.ACTOR},
                 {"ref_prefix": "refs/heads/", "actor": self.ACTOR},
                 {"ref_prefix": "refs/heads/renovate", "actor": self.ACTOR},
                 {"ref": self.REF}, {"ref": self.REF, "actor": self.ACTOR, "unknown": True},
                 {"ref": self.REF, "ref_prefix": "refs/heads/renovate/", "actor": self.ACTOR}]
        for item in items:
            with self.subTest(item=item):
                self.assertEqual(self.compare([], items=[item]).returncode, 2)

    def test_protected_and_ungranted_refs_fail(self):
        for ref in ("refs/heads/main", "refs/heads/trunk", "refs/tags/v1", "refs/heads/root"):
            with self.subTest(ref=ref):
                items = [{"ref": ref, "actor": self.ACTOR}] if not ref.startswith("refs/tags/") else [
                    {"ref_prefix": "refs/heads/renovate/", "actor": self.ACTOR}]
                result = self.compare([self.activity(ref=ref)], ref=ref,
                                      items=None if ref.endswith("root") else items)
                self.assertEqual(result.returncode, 1)

    def test_human_actor_grant_is_a_usage_error_even_with_matching_push_records(self):
        actor = "rknightion"
        for selector in ({"ref": self.REF}, {"ref_prefix": "refs/heads/renovate/"}):
            with self.subTest(selector=selector):
                result = self.compare([self.activity(actor=actor)],
                                      items=[{**selector, "actor": actor}])
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertNotIn("[automation actor=", result.stdout)

    def test_automation_actor_requires_a_nonempty_name_and_literal_bot_suffix(self):
        for actor in ("", "[bot]", "dependency", "dependency[BOT]", "dependency[bot]-other"):
            with self.subTest(actor=actor):
                result = self.compare([], items=[{"ref": self.REF, "actor": actor}])
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_exact_ref_only(self):
        item = {"ref": self.REF, "actor": self.ACTOR}
        self.assertEqual(self.compare([self.activity()], items=[item]).returncode, 0)
        other = self.REF + "-other"
        self.assertEqual(self.compare([self.activity(ref=other)], ref=other, items=[item]).returncode, 1)


if __name__ == "__main__":
    unittest.main()
