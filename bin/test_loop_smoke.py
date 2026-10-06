"""Installed-build loop smoke. Run: python3 -m unittest bin.test_loop_smoke.

Only the provider and GitHub release-list process edge are fake. The installer,
launcher, subagents, guards, continuation, local git remote and audit are real.
All homes, builds, sessions and repositories are disposable; no credentials used.
"""
import json
import os
from pathlib import Path
import queue
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
            report = 'codex/report-smoke-loop1.md'
            # loop-continuation arms only a launch whose goal is in this repository (S3).
            (repo / 'codex').mkdir(exist_ok=True)
            (repo / 'codex/goal-smoke-loop1.md').write_text(
                '# Goal: smoke loop1\n## Run\ntier: routine\nroot: llm - smoke\nroot-model: openai/gpt-6.1-sol\n'
                '## Envelope\n| task | acceptance check | owned files | gate | landing | agent | tier |\n'
                '|---|---|---|---|---|---|---|\n| SMOKE-1 | smoke | x | true | lands-after-green | lane-worker-push | routine |\n')
            report_body = '# Loop: smoke loop1 · Goal: ' + '0' * 64 + '\n\n'
            report_body += '\n\n'.join(section + '\nSmoke complete.' for section in (
                '## Outcome', '## Evidence', '## Pending', '## Questions',
                '## Stalls and deaths', '## Tokens and wakeups')) + '\n'
            script.write_text(json.dumps({'rules': [
                {'match': 'SMOKE_ROOT_GUARD', 'once': True, 'toolCalls': [tool('bash', command='git push --force origin main')]},
                {'match': '^Task: SMOKE_DENIED_CHILD$', 'once': True, 'toolCalls': [tool('bash', command='git commit --allow-empty -m denied')]},
                {'match': '^Task: SMOKE_GRANTED_CHILD$', 'once': True, 'delayMs': 1500, 'toolCalls': [tool('bash', command='git commit --allow-empty -m granted')]},
                {'match': r'^\[main .*\] (denied|granted)', 'once': True, 'toolCalls': [tool('bash', command='git push origin main')]},
                {'match': 'SMOKE_SPAWN_DENIED', 'once': True, 'toolCalls': [tool('subagent', agent='lane-worker', task='SMOKE_DENIED_CHILD', async_=True)]},
                {'match': 'SMOKE_SPAWN_GRANTED', 'once': True, 'toolCalls': [tool('subagent', agent='lane-worker-push', task='SMOKE_GRANTED_CHILD', async_=True)]},
                # The armed launch now opens a state log, so the one nudge is the close-out one.
                {'match': '^## TURN ENDINGS|^close out:', 'once': True, 'toolCalls': [tool('write', path=report, content=report_body)]},
                {'match': 'Successfully wrote', 'text': 'Smoke report is written.'},
                # The faux model reads only the latest message: an idle root's turn starts on pi-subagents' wake line.
                {'match': r'completed|Completed|finished|^Subagent updates above\.$', 'text': 'The child returned; work is still owed.'},
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
                                if entry.get('role') == 'toolResult' and entry.get('toolName') == 'bash' and ('push requires' in json.dumps(entry) or 'To ' in json.dumps(entry)):
                                    return entry
                        time.sleep(.1)
                    self.fail(f'child session push result missing: {message}')

                spawn('SMOKE_SPAWN_DENIED')
                denial = child_push('SMOKE_DENIED_CHILD')
                self.assertTrue(denial.get('isError'), 'step 3 ungranted child pushed')
                self.assertIn('push requires a push-granted lane identity', json.dumps(denial))
                self.assertEqual(git('rev-parse', 'refs/heads/main', cwd=remote), initial)
                self.assertNotEqual(git('rev-parse', 'HEAD'), initial, 'step 3 lane must commit before denied push')
                self.assertEqual(git('log', '-1', '--format=%s'), 'denied')
                rpc.wait(lambda e: e.get('type') == 'message_end' and e.get('message', {}).get('customType') == 'subagent-notify', 'denied child completion wake')
                # Wait for the wake-started turn to finish before the next user prompt.
                rpc.wait(lambda e: e.get('type') == 'agent_end', 'denied wake turn', len(rpc.events) - 1)
                print('step 3: async ungranted lane committed; required guard denied push; remote unchanged', flush=True)
                index = spawn(f'You are the campaign root. Report {report}. SMOKE_SPAWN_GRANTED')
                pushed = child_push('SMOKE_GRANTED_CHILD')
                self.assertFalse(pushed.get('isError'), 'step 4 lane push grant disabled')
                granted = git('rev-parse', 'HEAD')
                self.assertNotEqual(granted, initial)
                self.assertEqual(git('log', '-1', '--format=%s'), 'granted')
                self.assertEqual(git('rev-parse', 'refs/heads/main', cwd=remote), granted)
                print('step 4: async granted lane committed and pushed its HEAD', flush=True)
                notify = rpc.wait(lambda e: e.get('type') == 'message_end' and e.get('message', {}).get('customType') == 'subagent-notify', 'step 5 completion wake disabled', index)
                notify_index = rpc.events.index(notify)
                # pi-subagents 0.76.1: the idle root's notice is appended, then its wake prompt starts the turn.
                settled = max(i for i in range(index, notify_index) if rpc.events[i].get('type') == 'agent_end')
                self.assertFalse(any(e.get('type') == 'message_start' and e.get('message', {}).get('role') == 'assistant' for e in rpc.events[settled + 1:notify_index]))
                wake = rpc.wait(lambda e: e.get('type') == 'message_start' and e.get('message', {}).get('role') == 'user' and 'Subagent updates above.' in json.dumps(e.get('message', {}).get('content')), 'step 5 wake prompt', notify_index)
                wake_index = rpc.events.index(wake)
                self.assertFalse(any(e.get('type') == 'message_start' and e.get('message', {}).get('role') == 'assistant' for e in rpc.events[notify_index:wake_index]))
                rpc.wait(lambda e: e.get('type') == 'agent_start', 'step 5 completion did not start a root turn', notify_index)
                print('step 5: subagent-notify automatically starts next root turn', flush=True)
                rpc.wait(lambda e: e.get('type') == 'entry_appended' and e.get('entry', {}).get('customType') == 'loop-continuation', 'step 6 continuation nudge disabled', notify_index)
                written = rpc.wait(lambda e: e.get('type') == 'tool_execution_end' and e.get('toolName') == 'write', 'step 7 report write', notify_index)
                self.assertFalse(written.get('isError', False), written)
                rpc.wait(lambda e: e.get('type') == 'agent_settled', 'step 7 clean settle', rpc.events.index(written))
                nudges = [e for e in rpc.events[index:] if e.get('type') == 'entry_appended' and e.get('entry', {}).get('customType') == 'loop-continuation']
                self.assertEqual(len(nudges), 1, 'step 6 exactly one nudge')
                self.assertTrue((repo / report).is_file())
                print('steps 6-7: exactly one continuation nudge, report written, no further nudge', flush=True)
            finally:
                code = rpc.close()
            self.assertEqual(code, 0, 'step 7 launcher exits cleanly')
            grants = tmp / 'grants.json'
            grants.write_text(json.dumps({str(repo): ['refs/heads/main']}))
            output = run(str(bins / 'loop-pi-audit'), 'closeout', '--run-dir', str(run_dir), '--grants', str(grants))
            before = json.loads(runs[0].read_text())['repos'][str(repo)]['remotes']['origin']['refs']
            after = json.loads((run_dir / 'audit-after.json').read_text())['repos'][str(repo)]['remotes']['origin']['refs']
            changes = [ref for ref in set(before) | set(after) if before.get(ref) != after.get(ref)]
            self.assertEqual(changes, ['refs/heads/main'], output)
            self.assertEqual(after['refs/heads/main'], granted)
            print('step 8: audit records exactly one remote ref change, matching granted lane commit', flush=True)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 300, 'installed smoke exceeds five minutes')
        print(f'installed loop smoke: {elapsed:.2f}s, no secrets', flush=True)


if __name__ == '__main__':
    unittest.main()
