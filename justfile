set shell := ["bash", "-euo", "pipefail", "-c"]

python_tests := "bin.test_loop_pi_install bin.test_loop_pi_preflight bin.test_loop_pi_audit bin.test_leak_scan"

# List the recipes
default:
    @just --list

# Install npm dependencies and the leak-gate git hooks
setup:
    npm ci --ignore-scripts --no-audit --no-fund
    just hooks

# Format the justfile (the TypeScript and Python sources carry no formatter yet)
[group('dev')]
fmt:
    just --fmt

# Fail if the justfile is not formatted
[group('check')]
fmt-check:
    just --fmt --check

# Type-check the extensions and parse the Python tools
[group('check')]
lint:
    npx tsc --noEmit -p tsconfig.json
    python3 -c 'import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' bin/loop-pi-install bin/loop-pi-preflight bin/loop-pi-audit bin/leak-scan bin/leak-terms-hash

# Run the extension tests (faux provider, no live model) and the Python tool tests
[group('check')]
test:
    npm test
    python3 -m unittest {{ python_tests }}
    python3 -m unittest bin.test_loop_smoke

# The pre-commit gate: formatting, types, tests and the leak scan
[group('check')]
check: fmt-check lint test leak

# Install the leak-gate git hooks from hooks/
[group('dev')]
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "$(git config --get core.hooksPath || true)" ]; then echo "core.hooksPath is set; unset it" >&2; exit 1; fi
    dir="$(git rev-parse --git-path hooks)"
    mkdir -p "$dir"
    for hook in pre-commit commit-msg pre-push; do install -m 0755 "hooks/$hook" "$dir/$hook"; done

# Scan the tree and every reachable commit for forbidden terms; verify the installed hooks
[group('check')]
leak:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "$(git config --get core.hooksPath || true)" ]; then echo "core.hooksPath is set; unset it" >&2; exit 1; fi
    dir="$(git rev-parse --git-path hooks)"
    for hook in pre-commit commit-msg pre-push; do
      if ! cmp -s "hooks/$hook" "$dir/$hook" || [ ! -x "$dir/$hook" ]; then
        echo "hook $hook is missing or differs from hooks/$hook; run just setup" >&2
        exit 1
      fi
    done
    python3 bin/leak-scan --path .
    python3 bin/leak-scan --history
