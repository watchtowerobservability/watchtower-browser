#!/bin/sh
# Item 9 check. Run after `pnpm -C sdks/browser build`, with webpack 5 available (`npx -p webpack -p webpack-cli`).
# Passes when webpack bundles dist/index.js with no "Critical dependency" warning and emits the lazy
# chunks (instrument, replay, assist, ...) as split files instead of an always-rejecting empty context.
set -eu
cd "$(dirname "$0")"
out=$(npx --yes -p webpack@5 -p webpack-cli@5 webpack --config webpack.config.cjs 2>&1) || { echo "$out"; exit 1; }
echo "$out"
if echo "$out" | grep -q "Critical dependency"; then echo "FAIL: critical dependency warning"; exit 1; fi
n=$(ls out/*.js | wc -l)
if [ "$n" -lt 4 ]; then echo "FAIL: expected split lazy chunks, got $n file(s)"; exit 1; fi
echo "OK: $n chunks"
