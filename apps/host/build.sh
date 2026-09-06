#!/usr/bin/env bash
# build.sh — 发布构建：shared 源码 vendored，产物完全自包含（无 workspace 依赖）
set -euo pipefail
cd "$(dirname "$0")"

bash scripts/vendor-shared.sh
npx tsc
git checkout -- src 2>/dev/null || true
rm -rf src/vendor

echo "build ok → dist/"
