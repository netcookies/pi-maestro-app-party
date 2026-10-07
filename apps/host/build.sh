#!/usr/bin/env bash
# build.sh — release build: Desktop contracts and canonical SDK protocol are vendored.
# The resulting dist has no workspace runtime dependency and never includes the SDK client.
set -euo pipefail
cd "$(dirname "$0")"

# Always restore source imports, including when tsc fails. cleanup-vendor.sh never
# uses git checkout, so unrelated uncommitted source remains untouched.
trap 'bash scripts/cleanup-vendor.sh' EXIT
bash scripts/vendor-shared.sh
# 必须先清空 dist：tsc 不会删除已从 src 移除的模块的旧产物
rm -rf dist
npx tsc

echo "build ok → dist/"
