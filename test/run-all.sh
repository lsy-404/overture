#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Runs every suite under test/ and prints one line per file, then a summary.
# Exits non-zero if any suite fails, so it can gate a release.
#
#   ./test/run-all.sh              every suite
#   ./test/run-all.sh recipe       only test/recipe
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

filter="${1:-}"
pattern="test/*/*.test.ts"
[ -n "$filter" ] && pattern="test/$filter/*.test.ts"

# Suites that import .vue components need the SFC compiler; tsx cannot parse
# them. Their config lives beside them in test/frontend.
needs_vite_node() {
  grep -qE '^import .* from "[^"]*\.vue"' "$1"
}

pass=0; fail=0; failed=()
for f in $pattern; do
  [ -e "$f" ] || continue
  if needs_vite_node "$f"; then
    out=$(npx vite-node -c test/frontend/vite-node.config.mts "$f" 2>&1)
  else
    out=$(npx tsx "$f" 2>&1)
  fi
  if [ $? -eq 0 ]; then
    pass=$((pass + 1))
    echo "PASS  $f"
  else
    fail=$((fail + 1))
    failed+=("$f")
    echo "FAIL  $f"
    echo "$out" | sed 's/^/      /'
  fi
done

echo
echo "$pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
