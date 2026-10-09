# loop-pi

pi extensions, home template and installer for long-running fan-out loops. `README.md` describes
the pieces; `extensions/SEAMS.md` is the contract between the extensions. Change a seam there
first, then in every extension it touches.

## Task interface

`just check` is the gate: run it before every commit. `just setup` installs dependencies and the
git hooks.

## Task tracking

This repository has no task board and does not use GitHub Issues for planned work: the maintainer
tracks it on a private board. Never initialise a Backlog board here, and never write a private task
id into a file, commit message or pull request.

## Leak gate

This repository is public and must never carry a private hostname, address, tenant or account id,
person's name or email, customer or organisation name, internal task id, credential or credential
path. `bin/leak-scan` enforces that against two lists: the committed generic shapes in
`leak-patterns.public.txt`, and a private term list that is never committed (locally at
`~/.config/leak-scan/loop-pi.txt`, in CI the `LEAK_TERMS` secret, hashed).

- Never commit with `--no-verify` and never push with `--no-verify`. The `pre-commit`,
  `commit-msg` and `pre-push` hooks are the gate, and `just check` fails when any of them is
  missing or differs from `hooks/`.
- Never set `core.hooksPath` in this repository.
- A scan with no term source, an empty list or a shallow clone exits 2. That is the gate working:
  fix the source, never bypass it. `--public-only` exists for fork pull requests in CI only.
- A finding prints only `path:line: label`. Remove the text; never add an exemption for a real
  identifier, and never loosen a pattern in `leak-patterns.public.txt` to get green.
- Build secret-shaped test strings at run time (see `bin/test_leak_scan.py`) rather than writing
  them into a file.
- Binary files are refused unless `leak-scan.binary-allow` names them. Keep that list short.

## Tests

- Tests never call a live model. They drive real pi processes against the scripted `faux`
  provider in `extensions/test-support/` with a fresh temporary `PI_CODING_AGENT_DIR`, and never
  touch `~/.pi` or an installed loop home.
- `rules.test.ts` pins the guard's verdict on every recorded lane block in
  `extensions/loop-guard/fixtures/`. A change that flips one of those verdicts is a behaviour
  change: say so in the commit and update the fixture's expectation deliberately.
- The pi and pi-subagents versions are pinned exactly in `package.json`. A bump is its own change,
  with the full test run and a note of what the extension API changed.

## Recovery changes

Recovery depends on the pinned agent loop refusing to execute tools from failed assistant
responses and native retry preserving earlier completed history. Exercise the real Responses
stream and a side-effecting local tool when changing this boundary; helper-only classification
checks do not establish it. Hosted tools, protected history and operator cancellation remain
separate boundaries. Automatic wakes must preserve notices without resetting the outage budget.
