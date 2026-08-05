#!/usr/bin/env bash
# FinPilot regression tests — validates the Apps Script domain logic with Node.
set -euo pipefail
cd "$(dirname "$0")"

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "== Copying .gs sources =="
for f in ../apps-script/*.gs; do
  cp "$f" "$BUILD/$(basename "$f" .gs).js"
done

echo "== Running tests =="
cp run-tests.js "$BUILD/run-tests.js"
node "$BUILD/run-tests.js"
