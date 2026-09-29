#!/usr/bin/env python3
"""Sample PreToolUse guard for tests and as an example of the loop-guard hook contract.

loop-guard runs `python3 <home>/scripts/backlog-guard.py` with a JSON payload on stdin:
{"hookEventName": "PreToolUse", "toolName": ..., "toolInput": {...}, "cwd": ...}. A deny is exit 0
with hookSpecificOutput.permissionDecision == "deny" on stdout; anything else allows. This sample
denies two Backlog.md mistakes: a section-replacing flag (--notes, --plan, --final-summary) on
`backlog task edit`, and a hand edit of a CLI-owned backlog/ directory. It fails open on input it
cannot parse, like the guards it stands in for.
"""
import json
import re
import shlex
import sys

REPLACING = {"--notes": "--append-notes", "--plan": "--append-plan", "--final-summary": "--append-final-summary"}
CLI_OWNED = re.compile(r"(^|/)backlog/(tasks|drafts|docs|decisions|milestones|completed|archive)/", re.IGNORECASE)


def deny(reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": reason}}))
    sys.exit(0)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    tool, data = payload.get("toolName"), payload.get("toolInput") or {}
    if tool == "bash":
        try:
            words = shlex.split(str(data.get("command", "")))
        except ValueError:
            return
        if words[:3] == ["backlog", "task", "edit"]:
            for word in words[3:]:
                flag = word.split("=", 1)[0]
                if flag in REPLACING:
                    deny(f"{flag} replaces the whole section; use {REPLACING[flag]}")
    elif tool in ("edit", "write"):
        path = str(data.get("path") or data.get("file_path") or "")
        if CLI_OWNED.search(path):
            deny(f"{path} is CLI-owned; change it through the backlog CLI")


if __name__ == "__main__":
    main()
