#!/usr/bin/env python3
"""Drive one command on a pseudo-terminal for a test. Not itself a test.

argv[1] is a JSON object: {"argv": [...], "steps": [{"wait": regex|null, "send": text|null,
"timeout": seconds}], "out": path}. Each step first waits until the output so far matches `wait`
(a Python regex over the output decoded as UTF-8), then types `send`. The whole output is written
to `out` at the end, and the exit status is 0 only when every wait matched. The device-attributes
query (CSI c) is answered so a TUI's terminal negotiation completes. The environment is inherited.
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

config = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(config["argv"][0], config["argv"])

output = bytearray()
answered = 0


def pump(deadline, pattern=None):
    global answered
    while time.time() < deadline:
        if pattern is not None and re.search(pattern, output.decode("utf-8", "replace")):
            return True
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        output.extend(data)
        while output.count(b"\x1b[c") > answered:
            answered += 1
            os.write(fd, b"\x1b[?62;22c")
    return pattern is None


ok = True
for step in config["steps"]:
    timeout = float(step.get("timeout", 20))
    if step.get("wait") is not None and not pump(time.time() + timeout, step["wait"]):
        ok = False
        break
    text = step.get("send")
    if text:
        time.sleep(0.3)
        for char in text:
            os.write(fd, char.encode("utf-8"))
            time.sleep(0.01)
pump(time.time() + 0.5)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
with open(config["out"], "wb") as handle:
    handle.write(bytes(output))
sys.exit(0 if ok else 1)
