#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Both hosted jobs must select the same exact Node version.
pin="$(awk '$1 == "node-version:" { print $2 }' .github/workflows/ci.yml | sort -u)"
if [[ ! "$pin" =~ ^\"([0-9]+\.[0-9]+\.[0-9]+)\"$ ]]; then
  printf '%s\n' 'Expected a single exact, double-quoted Node pin in .github/workflows/ci.yml' >&2
  exit 1
fi
node_version="${BASH_REMATCH[1]}"

if [[ "${1:-}" == setup ]]; then
  fnm install "$node_version" </dev/null
fi
exec fnm exec --using="$node_version" -- just "$@"
