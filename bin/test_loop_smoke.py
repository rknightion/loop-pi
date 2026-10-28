"""Installed-build loop smoke. Run: python3 -m unittest bin.test_loop_smoke.

Only the provider and GitHub release-list process edge are fake. The installer,
launcher, subagents, guards, continuation, local git remote and audit are real.
All homes, builds, sessions and repositories are disposable; no credentials used.
"""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import tempfile
import threading
import time
import unittest

SRC = Path(__file__).resolve().parents[1]


class Rpc:
    def __init__(self, command, cwd, env):
        self.events = []
        self.incoming = queue.Queue()
        self.errors = []
        self.proc = subprocess.Popen(command, cwd=cwd, env=env, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        def read_events():
            for line in self.proc.stdout:
                try:
                    self.incoming.put(json.loads(line))
                except ValueError:
                    self.errors.append(line)
        def read_errors():
            self.errors.extend(self.proc.stderr)
        self.threads = [threading.Thread(target=read_events), threading.Thread(target=read_errors)]
        for thread in self.threads:
            thread.start()

    def send(self, **command):
        self.proc.stdin.write(json.dumps(command) + '\n')
        self.proc.stdin.flush()

    def wait(self, predicate, reason, start=0, timeout=30):
        deadline = time.monotonic() + timeout
        while True:
            for event in self.events[start:]:
                if predicate(event):
                    return event
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f'{reason}: timed out; stderr={"".join(self.errors)[-3000:]}')
            try:
                self.events.append(self.incoming.get(timeout=remaining))
            except queue.Empty:
                raise AssertionError(f'{reason}: timed out; stderr={"".join(self.errors)[-3000:]}')

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        for thread in self.threads:
            thread.join(timeout=5)
        self.proc.stdout.close()
        self.proc.stderr.close()
        return self.proc.returncode


def wait_for_runners(root, timeout=30):
    """A detached pi-subagents runner (`subagent-runner-bootstrap.js`, reparented to init) can still
    be writing under this tree for about a second after the root exits; on Linux removing the tree
    then failed with "Directory not empty" every time. Wait for every live process whose command
    line names this tree, then kill any left, so the removal does not race them. Identity comes from
    the current process table only (never a recorded pid, which may be reused), and zombies are
    skipped since they hold no files."""
    root = str(root)
    me = os.getpid()
    def live():
        listing = subprocess.run(['ps', '-axww', '-o', 'pid=,stat=,command='], capture_output=True, text=True, timeout=10).stdout
        pids = set()
        for line in listing.splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3 and not fields[1].startswith('Z') and root in fields[2] and int(fields[0]) != me:
                pids.add(int(fields[0]))
        return pids
    started = time.monotonic()
    waiting = live()
    deadline = started + timeout
    while live() and time.monotonic() < deadline:
        time.sleep(.2)
    left = live()
    print(f'processes under the smoke tree at root exit: {len(waiting)}; waited {time.monotonic() - started:.1f}s', flush=True)
    for pid in left:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return left


class InstalledLoopSmoke(unittest.TestCase):
    def test_installed_loop(self):
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix='loop-smoke-') as temporary:
            tmp = Path(temporary).resolve()
            home, data, bins, repo, remote = [tmp / name for name in ('home', 'data', 'bin', 'repo', 'remote')]
            repo.mkdir()
            bins.mkdir()
            # No inherited provider keys, pi homes, git configuration or gh auth.
            env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'TMPDIR') if key in os.environ}
            env.update(HOME=str(tmp), XDG_CONFIG_HOME=str(tmp / 'config'),
                       GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                       PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0')
            # Local bare remotes have no GitHub releases. Mock only that subprocess boundary.
            gh = bins / 'gh'
            gh.write_text('#!/bin/sh\nif [ "$1 $2" = "release list" ]; then echo "[]"; else exit 2; fi\n')
            gh.chmod(0o755)
            env['PATH'] = str(bins) + os.pathsep + env['PATH']

            def run(*command, cwd=repo, timeout=120):
                result = subprocess.run(command, cwd=cwd, env=env, text=True,
                                        capture_output=True, timeout=timeout)
                self.assertEqual(result.returncode, 0, f'{command}: {result.stdout}\n{result.stderr}')
                return result.stdout.strip()

            def git(*args, cwd=repo):
                return run('git', *args, cwd=cwd, timeout=15)

            git('init', '-b', 'main')
            git('init', '--bare', str(remote))
            git('config', 'user.name', 'export')
            git('config', 'user.email', 'export@example.com')
            git('config', 'commit.gpgsign', 'false')
            (repo / '.gitignore').write_text('.pi/\ncodex/\n')
            git('add', '.gitignore')
            git('commit', '-m', 'fixture')
            git('remote', 'add', 'origin', str(remote))
            git('push', 'origin', 'main')
            initial = git('rev-parse', 'HEAD')
            faux = SRC / 'extensions/test-support/faux-extension.ts'
            run('python3', str(SRC / 'bin/loop-pi-install'), '--home', str(home),
                '--data', str(data), '--bin', str(bins), '--overlay',
                str(SRC / 'extensions/test-support/smoke-overlay'), '--launcher', 'loop-pi-smoke',
                '--var', f'FAUX_EXTENSION={faux}', cwd=SRC, timeout=180)
            script = tmp / 'script.json'
            def tool(name, **args):
                return {'name': name, 'args': args}
            report = 'codex/closeout-smoke-loop1.md'
            # loop-continuation arms only a launch whose charter is in this repository (v3 S1).
            (repo / 'codex').mkdir(exist_ok=True)
            (repo / 'codex/charter-smoke-loop1.md').write_text(
                '# Charter: smoke loop1\n\nharness: pi\nroot: sol / medium\nlanes: 2\nstanding: none\n\n'
                '## First wave\n\n| Task | Scope | Route | Note |\n|---|---|---|---|\n| SMOKE-1 | x | worker | |\n')
            report_body = '# Closeout: smoke loop1 · Charter: ' + '0' * 64 + '\n\n'
            report_body += '\n\n'.join(section + '\nSmoke complete.' for section in (
                '## Landed', '## Parked', '## For ratification', '## Notes')) + '\n'
            script.write_text(json.dumps({'rules': [
                {'match': 'SMOKE_ROOT_GUARD', 'once': True, 'toolCalls': [tool('bash', command='git push --force origin main')]},
                {'match': '^Task: Lane: smoke[^\\n]*\\nSMOKE_DENIED_CHILD$', 'once': True, 'toolCalls': [tool('bash', command='git commit --allow-empty -m denied')]},
                {'match': '^Task: Lane: smoke[^\\n]*\\nLanding: returns candidate\\nSMOKE_LANDING_CHILD$', 'once': True, 'delayMs': 1500, 'toolCalls': [tool('bash', command='git commit --allow-empty -m landing')]},
                {'match': r'^\[\S+ .*\] (denied|landing)', 'once': False, 'toolCalls': [tool('bash', command='git push origin main')]},
                {'match': 'SMOKE_SPAWN_DENIED', 'once': True, 'toolCalls': [tool('subagent', agent='worker', task='Lane: smoke · Task: T-1 · Tier: routine\nSMOKE_DENIED_CHILD', async_=True)]},
                {'match': 'SMOKE_SPAWN_LANDING', 'once': True, 'toolCalls': [tool('subagent', agent='worker', task='Lane: smoke · Task: T-1 · Tier: routine\nLanding: returns candidate\nSMOKE_LANDING_CHILD', worktree=True, async_=True)]},
                {'match': 'SMOKE_ROOT_PUSH', 'once': True, 'toolCalls': [tool('bash', command='git push origin main')]},
                # The armed launch now opens a state log, so the one nudge is the close-out one. The nudge
                # reaches the model inside loop-state's <loop_pi_notice> marker, so its heading follows a newline.
                {'match': '(?:^|\n)## Turn endings|(?:^|\n)## No lane is live', 'once': True, 'toolCalls': [tool('write', path=report, content=report_body)]},
                {'match': 'Successfully wrote', 'text': 'Smoke report is written.'},
                # The faux model reads only the latest message: an idle root's turn starts on the completion notice.
                {'match': r'completed|Completed|finished', 'text': 'The child returned; work is still owed.'},
                {'match': '.*', 'text': 'PAUSED: waiting for the smoke child'},
            ]}).replace('"async_":', '"async":'))
            env['LOOP_PI_FAUX_SCRIPT'] = str(script)
            rpc = Rpc([str(bins / 'loop-pi-smoke'), '--mode', 'rpc', '--extension', str(faux)], repo, env)
            try:
                rpc.send(id='commands', type='get_commands')
                reply = rpc.wait(lambda e: e.get('id') == 'commands', 'step 1 launcher RPC')
                self.assertTrue(reply.get('success'), reply)
                runs = list((home / 'runs').glob('*/audit-before.json'))
                self.assertEqual(len(runs), 1, 'step 1 launcher audit snapshot')
                run_dir = runs[0].parent
                print('step 1: installed launcher, preflight, audit-before and RPC OK', flush=True)
                rpc.send(type='prompt', message='SMOKE_ROOT_GUARD')
                blocked = rpc.wait(lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'bash', 'step 2 root guard')
                self.assertTrue(blocked.get('isError'), 'step 2 root guard did not deny force push')
                self.assertIn('loop-guard', json.dumps(blocked))
                rpc.wait(lambda e: e.get('type') == 'agent_end', 'root guard turn ends')
                print('step 2: root force push denied by loop-guard', flush=True)

                def spawn(marker):
                    index = len(rpc.events)
                    rpc.send(type='prompt', message=marker)
                    launch = rpc.wait(lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'subagent', 'background child launch', index)
                    self.assertFalse(launch.get('isError', False), launch)
                    rpc.wait(lambda e: e.get('type') == 'agent_end', 'root yields after launch', index)
                    return index

                def child_push(message):
                    deadline = time.monotonic() + 35
                    while time.monotonic() < deadline:
                        for path in (home / 'sessions').rglob('session.jsonl'):
                            text = path.read_text()
                            if message not in text:
                                continue
                            for line in text.splitlines():
                                try:
                                    entry = json.loads(line).get('message', {})
                                except ValueError:
                                    continue
                                if entry.get('role') == 'toolResult' and entry.get('toolName') == 'bash' and ('lanes never push' in json.dumps(entry) or 'To ' in json.dumps(entry)):
                                    return entry
                        time.sleep(.1)
                    self.fail(f'child session push result missing: {message}')

                spawn('SMOKE_SPAWN_DENIED')
                denial = child_push('SMOKE_DENIED_CHILD')
                self.assertTrue(denial.get('isError'), 'step 3 lane pushed')
                self.assertIn('lanes never push', json.dumps(denial))
                self.assertEqual(git('rev-parse', 'refs/heads/main', cwd=remote), initial)
                self.assertNotEqual(git('rev-parse', 'HEAD'), initial, 'step 3 lane must commit before denied push')
                self.assertEqual(git('log', '-1', '--format=%s'), 'denied')
                rpc.wait(lambda e: e.get('type') == 'message_end' and e.get('message', {}).get('customType') == 'subagent-notify', 'denied child completion wake')
                # Wait for the wake-started turn to finish before the next user prompt.
                rpc.wait(lambda e: e.get('type') == 'agent_end', 'denied wake turn', len(rpc.events) - 1)
                print('step 3: async lane committed; required guard denied its push; remote unchanged', flush=True)
                index = spawn(f'You are the campaign root. Report {report}. SMOKE_SPAWN_LANDING')
                refused = child_push('SMOKE_LANDING_CHILD')
                self.assertTrue(refused.get('isError'), 'step 4 lane pushed')
                self.assertIn('lanes never push', json.dumps(refused))
                # A governed implementation lane runs in a retained worktree on its own branch, so its commit is
                # a candidate: the shared checkout stays on the step 3 commit until the root lands the branch.
                self.assertEqual(git('log', '-1', '--format=%s'), 'denied')
                lane_branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/loop/').split()
                self.assertEqual(len(lane_branches), 1, lane_branches)
                self.assertEqual(git('log', '-1', '--format=%s', lane_branches[0]), 'landing')
                git('merge', '--ff-only', lane_branches[0])
                landed = git('rev-parse', 'HEAD')
                self.assertNotEqual(landed, initial)
                self.assertEqual(git('log', '-1', '--format=%s'), 'landing')
                self.assertEqual(git('rev-parse', 'refs/heads/main', cwd=remote), initial)
                print('step 4: a second async lane committed; its push was refused too; remote unchanged', flush=True)
                notify = rpc.wait(lambda e: e.get('type') == 'message_end' and e.get('message', {}).get('customType') == 'subagent-notify', 'step 5 completion wake disabled', index)
                notify_index = rpc.events.index(notify)
                # pi-subagents 0.80.0+: the notice itself starts the idle root's run; no user-role wake prompt exists.
                settled = max(i for i in range(index, notify_index) if rpc.events[i].get('type') == 'agent_end')
                between = rpc.events[settled + 1:notify_index]
                self.assertTrue(any(e.get('type') == 'agent_start' for e in between), 'step 5 completion did not start a root turn')
                self.assertFalse(any(e.get('type') == 'message_start' and e.get('message', {}).get('role') in ('user', 'assistant') for e in between))
                rpc.wait(lambda e: e.get('type') == 'message_start' and e.get('message', {}).get('role') == 'assistant', 'step 5 root answered the notice', notify_index)
                print('step 5: subagent-notify automatically starts next root turn', flush=True)
                rpc.wait(lambda e: e.get('type') == 'entry_appended' and e.get('entry', {}).get('customType') == 'loop-continuation', 'step 6 continuation nudge disabled', notify_index)
                written = rpc.wait(lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'write', 'step 7 report write', notify_index)
                self.assertFalse(written.get('isError', False), written)
                rpc.wait(lambda e: e.get('type') == 'agent_settled', 'step 7 clean settle', rpc.events.index(written))
                nudges = [e for e in rpc.events[index:] if e.get('type') == 'entry_appended' and e.get('entry', {}).get('customType') == 'loop-continuation']
                self.assertEqual(len(nudges), 1, 'step 6 exactly one nudge')
                self.assertTrue((repo / report).is_file())
                print('steps 6-7: exactly one continuation nudge, report written, no further nudge', flush=True)
                push = len(rpc.events)
                rpc.send(type='prompt', message='SMOKE_ROOT_PUSH')
                pushed = rpc.wait(lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'bash', 'step 7b root push', push)
                self.assertFalse(pushed.get('isError', False), pushed)
                rpc.wait(lambda e: e.get('type') == 'agent_settled', 'step 7b settle', push)
                self.assertEqual(git('rev-parse', 'refs/heads/main', cwd=remote), landed)
                print('step 7b: the root alone pushed the lane commit', flush=True)
            finally:
                code = rpc.close()
                left = wait_for_runners(tmp)
            self.assertEqual(code, 0, 'step 7 launcher exits cleanly')
            self.assertEqual(left, set(), 'async runners outlived the root by more than 30 s')
            output = run(str(bins / 'loop-pi-audit'), 'closeout', '--run-dir', str(run_dir))
            before = json.loads(runs[0].read_text())['repos'][str(repo)]['remotes']['origin']['refs']
            after = json.loads((run_dir / 'audit-after.json').read_text())['repos'][str(repo)]['remotes']['origin']['refs']
            changes = [ref for ref in set(before) | set(after) if before.get(ref) != after.get(ref)]
            self.assertEqual(changes, ['refs/heads/main'], output)
            self.assertEqual(after['refs/heads/main'], landed)
            print('step 8: audit records exactly one remote ref change, matching the root-pushed commit', flush=True)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 300, 'installed smoke exceeds five minutes')
        print(f'installed loop smoke: {elapsed:.2f}s, no secrets', flush=True)


if __name__ == '__main__':
    unittest.main()
