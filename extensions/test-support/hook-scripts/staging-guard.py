#!/usr/bin/env python3
"""Sample PreToolUse guard for tests and as an example of the loop-guard hook contract.

Denies bulk staging (`git add -A`, `git add --all`, `git add .`, `git commit -a`) so a lane stages
explicit paths. Same payload and deny format as backlog-guard.py; fails open on unparseable input.
"""
import json
import shlex
import sys

BULK_ADD = {"-A", "--all", ".", "-u", "--update"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        words = shlex.split(str((payload.get("toolInput") or {}).get("command", "")))
    except ValueError:
        return
    if payload.get("toolName") != "bash" or words[:1] != ["git"]:
        return
    if (words[1:2] == ["add"] and BULK_ADD & set(words[2:])) or (
            words[1:2] == ["commit"] and ({"-a", "--all"} & set(words[2:]))):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "Stage explicit pathspecs (git add <file> ...); bulk staging is refused."}}))


if __name__ == "__main__":
    main()
